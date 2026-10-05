#!/usr/bin/env python3
"""Transactional SQLite storage bridge for the serialized control queue."""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import sqlite3
import sys
import uuid
from pathlib import Path


FORMAT_VERSION = 4
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$")
ITEM_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,255}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
REPORT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
CONTROL_MODES = {"running", "paused", "draining", "emergency_stopped"}
ITEM_STATES = {
    "queued",
    "leased",
    "review_running",
    "decision_validating",
    "accepted",
    "reviewed",
    "integrating",
    "integrated",
    "waiting",
    "blocked",
    "cancelling",
    "cancelled",
    "stop_unconfirmed",
    "recovery_required",
    "failed",
}
ACTIVE_STATES = {
    "leased",
    "review_running",
    "decision_validating",
    "integrating",
    "cancelling",
    "recovery_required",
}
TERMINAL_STATES = {"accepted", "integrated", "cancelled", "failed"}
FINAL_STATES = TERMINAL_STATES | {"reviewed"}
RETRYABLE_STATES = {"cancelled", "failed", "recovery_required", "stop_unconfirmed"}
DECISIONS = {"accepted", "rejected", "deferred", "superseded"}
CORRECTION_EVIDENCE_KINDS = {
    "report-correction",
    "corrected-progress",
    "corrected-execution-summary",
}
AGENT_STATES = {
    "registered",
    "starting",
    "running",
    "waiting",
    "blocked",
    "cancellation_requested",
    "interrupted",
    "completed",
    "failed",
    "stop_unconfirmed",
    "stale",
}
WORKER_TASK_STATES = {
    "accepted",
    "running",
    "waiting",
    "blocked",
    "cancelling",
    "cancelled",
    "completed",
    "failed",
    "stop_unconfirmed",
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def parse_utc(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc)


def bounded_text(value: object, maximum: int = 2048) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if len(text) <= maximum else text[: maximum - 15] + "...<truncated>"


def json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_value(value: str | None, fallback: object) -> object:
    if not value:
        return fallback
    return json.loads(value)


def merge_report_correction_evidence(current: object, incoming: object, state: str) -> list:
    if not isinstance(current, list) or not isinstance(incoming, list):
        raise ValueError("Queue evidence must be an array")
    current_text = {json_text(entry) for entry in current}
    incoming_text = {json_text(entry) for entry in incoming}
    if len(incoming_text) != len(incoming):
        raise ValueError("Queue evidence cannot contain duplicate entries")
    if incoming_text.issubset(current_text):
        return current
    preserved = {json_text(entry) for entry in current}
    if not preserved.issubset(incoming_text):
        raise ValueError("Existing immutable report evidence cannot be removed or replaced")
    additions = [entry for entry in incoming if json_text(entry) not in current_text]
    addition_kinds = [entry.get("kind") for entry in additions if isinstance(entry, dict)]
    if (
        state not in ({"queued"} | RETRYABLE_STATES)
        or len(additions) != 3
        or set(addition_kinds) != CORRECTION_EVIDENCE_KINDS
        or len(set(addition_kinds)) != 3
    ):
        raise ValueError("Only one complete immutable report-correction evidence set may augment a queued report")
    existing_corrections = [
        entry for entry in current
        if isinstance(entry, dict) and entry.get("kind") in CORRECTION_EVIDENCE_KINDS
    ]
    if existing_corrections:
        raise ValueError("A different immutable report correction already exists")
    for entry in additions:
        if not isinstance(entry, dict):
            raise ValueError("Report-correction evidence entries must be objects")
        require_sha256(entry.get("sha256"), f"{entry.get('kind')} evidence sha256")
        if not isinstance(entry.get("path"), str) or not entry["path"]:
            raise ValueError("Report-correction evidence requires a path")
    return incoming


def agent_statistics(value: object | None) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("Agent statistics must be an object")
    if value and value.get("schemaVersion") != 1:
        raise ValueError("Agent statistics require schemaVersion 1")
    if len(json_text(value).encode("utf-8")) > 128 * 1024:
        raise ValueError("Agent statistics exceed the 128 KiB storage budget")
    return value


def merge_agent_statistics(current: object | None, incoming: object | None) -> dict:
    left = agent_statistics(current)
    right = agent_statistics(incoming)
    if not left:
        return right
    if not right:
        return left
    merged = dict(left)
    merged.update({key: value for key, value in right.items() if key not in {"tokens", "cost", "limitations", "timing"}})
    if right.get("tokens", {}).get("status") == "available" or not left.get("tokens"):
        merged["tokens"] = right.get("tokens")
    if right.get("cost", {}).get("status") == "estimated" or not left.get("cost"):
        merged["cost"] = right.get("cost")
    merged["timing"] = {
        **(left.get("timing") or {}),
        **{
            key: value
            for key, value in (right.get("timing") or {}).items()
            if value is not None
        },
    }
    merged["limitations"] = list(dict.fromkeys([
        *(left.get("limitations") or []),
        *(right.get("limitations") or []),
    ]))[:20]
    return agent_statistics(merged)


def require_id(value: object, label: str) -> str:
    text = str(value or "")
    if not ID_PATTERN.fullmatch(text):
        raise ValueError(f"Invalid {label}: {text!r}")
    return text


def require_item_id(value: object, label: str = "itemId") -> str:
    text = str(value or "")
    if not ITEM_ID_PATTERN.fullmatch(text):
        raise ValueError(f"Invalid {label}: {text!r}")
    return text


def require_sha256(value: object, label: str) -> str:
    text = str(value or "").lower()
    if not SHA256_PATTERN.fullmatch(text):
        raise ValueError(f"Invalid {label}")
    return text


def require_report_id(value: object) -> str:
    text = str(value or "")
    if not REPORT_ID_PATTERN.fullmatch(text):
        raise ValueError(f"Invalid reportId: {text!r}")
    return text


def read_payload() -> dict:
    content = sys.stdin.read()
    if not content.strip():
        return {}
    value = json.loads(content)
    if not isinstance(value, dict):
        raise ValueError("Command payload must be a JSON object")
    return value


def connect(database_path: str) -> sqlite3.Connection:
    resolved = Path(database_path).expanduser().resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(resolved), timeout=30, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=30000")
    return connection


def migrate(connection: sqlite3.Connection) -> None:
    previous_version = connection.execute("PRAGMA user_version").fetchone()[0]
    if previous_version > FORMAT_VERSION:
        raise RuntimeError(f"Unsupported control queue database version: {previous_version}")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS control_state (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          mode TEXT NOT NULL,
          reason TEXT,
          updated_at_utc TEXT NOT NULL
        );

        INSERT OR IGNORE INTO control_state(singleton_id, mode, reason, updated_at_utc)
        VALUES (1, 'running', NULL, '1970-01-01T00:00:00Z');

        CREATE TABLE IF NOT EXISTS queue_items (
          item_id TEXT PRIMARY KEY,
          report_key TEXT NOT NULL UNIQUE,
          source_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          report_id TEXT NOT NULL,
          title TEXT NOT NULL,
          report_status TEXT NOT NULL,
          report_sha256 TEXT NOT NULL,
          task_sha256 TEXT,
          source_revision TEXT NOT NULL,
          report_path TEXT NOT NULL,
          task_path TEXT,
          decision_path TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          dispatch_sequence INTEGER NOT NULL DEFAULT 0,
          dependencies_json TEXT NOT NULL DEFAULT '[]',
          plan_json TEXT NOT NULL DEFAULT '[]',
          blockers_json TEXT NOT NULL DEFAULT '[]',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          state TEXT NOT NULL,
          phase TEXT NOT NULL,
          current_action TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          final_decision TEXT,
          decision_reference TEXT,
          thread_id TEXT,
          turn_id TEXT,
          lease_token TEXT,
          lease_owner TEXT,
          lease_expires_at_utc TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at_utc TEXT NOT NULL,
          updated_at_utc TEXT NOT NULL,
          started_at_utc TEXT,
          finished_at_utc TEXT,
          UNIQUE(source_id, task_id)
        );

        CREATE INDEX IF NOT EXISTS idx_queue_state_order
          ON queue_items(state, priority DESC, dispatch_sequence ASC, created_at_utc ASC);

        CREATE TABLE IF NOT EXISTS agents (
          agent_id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          parent_agent_id TEXT,
          kind TEXT NOT NULL,
          role TEXT NOT NULL,
          provider TEXT,
          state TEXT NOT NULL,
          current_action TEXT NOT NULL DEFAULT '',
          last_completed TEXT,
          next_action TEXT,
          blockers_json TEXT NOT NULL DEFAULT '[]',
          thread_id TEXT,
          turn_id TEXT,
          can_interrupt INTEGER NOT NULL DEFAULT 0,
          started_at_utc TEXT,
          last_heartbeat_utc TEXT,
          statistics_json TEXT NOT NULL DEFAULT '{}',
          updated_at_utc TEXT NOT NULL,
          FOREIGN KEY(item_id) REFERENCES queue_items(item_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_agents_item ON agents(item_id);

        CREATE TABLE IF NOT EXISTS worker_tasks (
          source_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          title TEXT NOT NULL,
          state TEXT NOT NULL,
          phase TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          plan_json TEXT NOT NULL DEFAULT '[]',
          workflow_json TEXT NOT NULL DEFAULT '{}',
          timing_json TEXT NOT NULL DEFAULT '{}',
          blockers_json TEXT NOT NULL DEFAULT '[]',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          stop_events_json TEXT NOT NULL DEFAULT '[]',
          progress_sequence INTEGER NOT NULL DEFAULT 0,
          progress_sha256 TEXT NOT NULL,
          progress_path TEXT NOT NULL,
          started_at_utc TEXT,
          updated_at_utc TEXT NOT NULL,
          PRIMARY KEY(source_id, task_id)
        );

        CREATE TABLE IF NOT EXISTS worker_agents (
          agent_id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          parent_agent_id TEXT,
          kind TEXT NOT NULL,
          role TEXT NOT NULL,
          provider TEXT,
          state TEXT NOT NULL,
          current_action TEXT NOT NULL DEFAULT '',
          last_completed TEXT,
          next_action TEXT,
          blockers_json TEXT NOT NULL DEFAULT '[]',
          can_interrupt INTEGER NOT NULL DEFAULT 0,
          started_at_utc TEXT,
          last_heartbeat_utc TEXT,
          semantic_updated_at_utc TEXT,
          statistics_json TEXT NOT NULL DEFAULT '{}',
          updated_at_utc TEXT NOT NULL,
          FOREIGN KEY(source_id, task_id) REFERENCES worker_tasks(source_id, task_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_worker_agents_task ON worker_agents(source_id, task_id);

        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          at_utc TEXT NOT NULL,
          event_type TEXT NOT NULL,
          item_id TEXT,
          agent_id TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_events_item_sequence ON events(item_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_events_at ON events(at_utc);
        """
    )
    worker_task_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(worker_tasks)").fetchall()
    }
    if "workflow_json" not in worker_task_columns:
        connection.execute("ALTER TABLE worker_tasks ADD COLUMN workflow_json TEXT NOT NULL DEFAULT '{}'")
    if "timing_json" not in worker_task_columns:
        connection.execute("ALTER TABLE worker_tasks ADD COLUMN timing_json TEXT NOT NULL DEFAULT '{}'")
    worker_agent_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(worker_agents)").fetchall()
    }
    if "semantic_updated_at_utc" not in worker_agent_columns:
        connection.execute("ALTER TABLE worker_agents ADD COLUMN semantic_updated_at_utc TEXT")
    if "statistics_json" not in worker_agent_columns:
        connection.execute("ALTER TABLE worker_agents ADD COLUMN statistics_json TEXT NOT NULL DEFAULT '{}'")
    agent_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(agents)").fetchall()
    }
    if "statistics_json" not in agent_columns:
        connection.execute("ALTER TABLE agents ADD COLUMN statistics_json TEXT NOT NULL DEFAULT '{}'")
    connection.execute(f"PRAGMA user_version = {FORMAT_VERSION}")
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version != FORMAT_VERSION:
        raise RuntimeError(f"Unsupported control queue database version: {version}")


def add_event(
    connection: sqlite3.Connection,
    event_type: str,
    *,
    item_id: str | None = None,
    agent_id: str | None = None,
    payload: object | None = None,
    at_utc: str | None = None,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO events(at_utc, event_type, item_id, agent_id, payload_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (at_utc or utc_now(), event_type, item_id, agent_id, json_text(payload or {})),
    )
    return int(cursor.lastrowid)


def item_from_row(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {
        "itemId": row["item_id"],
        "reportKey": row["report_key"],
        "sourceId": row["source_id"],
        "taskId": row["task_id"],
        "reportId": row["report_id"],
        "title": row["title"],
        "reportStatus": row["report_status"],
        "reportSha256": row["report_sha256"],
        "taskSha256": row["task_sha256"],
        "sourceRevision": row["source_revision"],
        "reportPath": row["report_path"],
        "taskPath": row["task_path"],
        "decisionPath": row["decision_path"],
        "priority": row["priority"],
        "dispatchSequence": row["dispatch_sequence"],
        "dependencies": json_value(row["dependencies_json"], []),
        "plan": json_value(row["plan_json"], []),
        "blockers": json_value(row["blockers_json"], []),
        "evidence": json_value(row["evidence_json"], []),
        "state": row["state"],
        "phase": row["phase"],
        "currentAction": row["current_action"],
        "summary": row["summary"],
        "finalDecision": row["final_decision"],
        "decisionReference": row["decision_reference"],
        "threadId": row["thread_id"],
        "turnId": row["turn_id"],
        "leaseToken": row["lease_token"],
        "leaseOwner": row["lease_owner"],
        "leaseExpiresAtUtc": row["lease_expires_at_utc"],
        "attempts": row["attempts"],
        "error": row["error"],
        "createdAtUtc": row["created_at_utc"],
        "updatedAtUtc": row["updated_at_utc"],
        "startedAtUtc": row["started_at_utc"],
        "finishedAtUtc": row["finished_at_utc"],
    }


def agent_from_row(row: sqlite3.Row) -> dict:
    return {
        "agentId": row["agent_id"],
        "itemId": row["item_id"],
        "parentAgentId": row["parent_agent_id"],
        "kind": row["kind"],
        "role": row["role"],
        "provider": row["provider"],
        "state": row["state"],
        "currentAction": row["current_action"],
        "lastCompleted": row["last_completed"],
        "nextAction": row["next_action"],
        "blockers": json_value(row["blockers_json"], []),
        "threadId": row["thread_id"],
        "turnId": row["turn_id"],
        "canInterrupt": bool(row["can_interrupt"]),
        "startedAtUtc": row["started_at_utc"],
        "lastHeartbeatUtc": row["last_heartbeat_utc"],
        "statistics": json_value(row["statistics_json"], {}),
        "updatedAtUtc": row["updated_at_utc"],
    }


def event_from_row(row: sqlite3.Row) -> dict:
    return {
        "sequence": row["sequence"],
        "atUtc": row["at_utc"],
        "type": row["event_type"],
        "itemId": row["item_id"],
        "agentId": row["agent_id"],
        "data": json_value(row["payload_json"], {}),
    }


def worker_task_from_row(row: sqlite3.Row) -> dict:
    return {
        "sourceId": row["source_id"],
        "taskId": row["task_id"],
        "title": row["title"],
        "state": row["state"],
        "phase": row["phase"],
        "summary": json_value(row["summary_json"], {}),
        "plan": json_value(row["plan_json"], []),
        "workflow": json_value(row["workflow_json"], {}),
        "timing": json_value(row["timing_json"], {}),
        "blockers": json_value(row["blockers_json"], []),
        "evidence": json_value(row["evidence_json"], []),
        "stopEvents": json_value(row["stop_events_json"], []),
        "progressSequence": row["progress_sequence"],
        "progressSha256": row["progress_sha256"],
        "progressPath": row["progress_path"],
        "startedAtUtc": row["started_at_utc"],
        "updatedAtUtc": row["updated_at_utc"],
    }


def worker_agent_from_row(row: sqlite3.Row) -> dict:
    return {
        "agentId": row["agent_id"],
        "sourceId": row["source_id"],
        "taskId": row["task_id"],
        "parentAgentId": row["parent_agent_id"],
        "kind": row["kind"],
        "role": row["role"],
        "provider": row["provider"],
        "state": row["state"],
        "currentAction": row["current_action"],
        "lastCompleted": row["last_completed"],
        "nextAction": row["next_action"],
        "blockers": json_value(row["blockers_json"], []),
        "canInterrupt": bool(row["can_interrupt"]),
        "startedAtUtc": row["started_at_utc"],
        "lastHeartbeatUtc": row["last_heartbeat_utc"],
        "semanticUpdatedAtUtc": row["semantic_updated_at_utc"],
        "statistics": json_value(row["statistics_json"], {}),
        "updatedAtUtc": row["updated_at_utc"],
    }


def command_init(connection: sqlite3.Connection, _: dict) -> dict:
    control = connection.execute("SELECT * FROM control_state WHERE singleton_id = 1").fetchone()
    return {"formatVersion": FORMAT_VERSION, "mode": control["mode"]}


def command_enqueue(connection: sqlite3.Connection, payload: dict) -> dict:
    source_id = require_id(payload.get("sourceId"), "sourceId")
    task_id = require_id(payload.get("taskId"), "taskId")
    report_id = require_report_id(payload.get("reportId") or f"{task_id}-report")
    report_sha = require_sha256(payload.get("reportSha256"), "reportSha256")
    task_sha = payload.get("taskSha256")
    if task_sha:
        task_sha = require_sha256(task_sha, "taskSha256")
    item_id = payload.get("itemId") or f"{source_id}:{task_id}:{report_sha[:12]}"
    item_id = require_item_id(item_id)
    dependencies = [require_id(item, "dependency") for item in payload.get("dependencies", [])]
    now = utc_now()
    report_key = f"{source_id}:{task_id}:{report_sha}"

    connection.execute("BEGIN IMMEDIATE")
    try:
        existing_task = connection.execute(
            "SELECT * FROM queue_items WHERE source_id = ? AND task_id = ?",
            (source_id, task_id),
        ).fetchone()
        if existing_task:
            if existing_task["report_sha256"] != report_sha:
                raise ValueError(f"Task {source_id}/{task_id} already has a different immutable report")
            merged_evidence = merge_report_correction_evidence(
                json_value(existing_task["evidence_json"], []),
                payload.get("evidence", []),
                existing_task["state"],
            )
            if merged_evidence != json_value(existing_task["evidence_json"], []):
                connection.execute(
                    "UPDATE queue_items SET evidence_json = ?, updated_at_utc = ? WHERE item_id = ?",
                    (json_text(merged_evidence), now, existing_task["item_id"]),
                )
                add_event(
                    connection,
                    "queue.item_evidence_augmented",
                    item_id=existing_task["item_id"],
                    payload={"kinds": sorted(CORRECTION_EVIDENCE_KINDS)},
                    at_utc=now,
                )
                existing_task = connection.execute(
                    "SELECT * FROM queue_items WHERE item_id = ?", (existing_task["item_id"],)
                ).fetchone()
            connection.execute("COMMIT")
            return {"created": False, "item": item_from_row(existing_task)}

        connection.execute(
            """
            INSERT INTO queue_items(
              item_id, report_key, source_id, task_id, report_id, title,
              report_status, report_sha256, task_sha256, source_revision,
              report_path, task_path, decision_path, priority, dispatch_sequence,
              dependencies_json, plan_json, blockers_json, evidence_json,
              state, phase, current_action, summary, created_at_utc, updated_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item_id,
                report_key,
                source_id,
                task_id,
                report_id,
                bounded_text(payload.get("title") or task_id, 256),
                bounded_text(payload.get("reportStatus") or "completed", 32),
                report_sha,
                task_sha,
                bounded_text(payload.get("sourceRevision") or "unknown", 256),
                bounded_text(payload.get("reportPath") or "", 2048),
                bounded_text(payload.get("taskPath"), 2048),
                bounded_text(payload.get("decisionPath"), 2048),
                int(payload.get("priority", 0)),
                int(payload.get("dispatchSequence", 0)),
                json_text(dependencies),
                json_text(payload.get("plan", [])),
                json_text(payload.get("blockers", [])),
                json_text(payload.get("evidence", [])),
                "queued",
                "intake",
                "Waiting for serialized review",
                bounded_text(payload.get("summary") or "", 2048),
                now,
                now,
            ),
        )
        add_event(
            connection,
            "queue.item_enqueued",
            item_id=item_id,
            payload={"sourceId": source_id, "taskId": task_id, "reportSha256": report_sha},
            at_utc=now,
        )
        row = connection.execute("SELECT * FROM queue_items WHERE item_id = ?", (item_id,)).fetchone()
        connection.execute("COMMIT")
        return {"created": True, "item": item_from_row(row)}
    except Exception:
        connection.execute("ROLLBACK")
        raise


def dependencies_satisfied(connection: sqlite3.Connection, dependencies: list[str]) -> bool:
    for task_id in dependencies:
        row = connection.execute(
            "SELECT state, final_decision FROM queue_items WHERE task_id = ? ORDER BY created_at_utc DESC LIMIT 1",
            (task_id,),
        ).fetchone()
        if not row or row["state"] not in {"accepted", "reviewed", "integrated"} or row["final_decision"] != "accepted":
            return False
    return True


def command_claim(connection: sqlite3.Connection, payload: dict) -> dict:
    owner = bounded_text(payload.get("owner") or f"process-{os.getpid()}", 128)
    requested_source = payload.get("sourceId")
    requested_task = payload.get("taskId")
    if bool(requested_source) != bool(requested_task):
        raise ValueError("sourceId and taskId must be supplied together for a targeted claim")
    if requested_source:
        requested_source = require_id(requested_source, "sourceId")
        requested_task = require_id(requested_task, "taskId")
    lease_seconds = max(15, min(int(payload.get("leaseSeconds", 120)), 3600))
    now_dt = dt.datetime.now(dt.timezone.utc)
    now = now_dt.isoformat().replace("+00:00", "Z")
    expires = (now_dt + dt.timedelta(seconds=lease_seconds)).isoformat().replace("+00:00", "Z")

    connection.execute("BEGIN IMMEDIATE")
    try:
        control = connection.execute("SELECT * FROM control_state WHERE singleton_id = 1").fetchone()
        if control["mode"] != "running":
            connection.execute("COMMIT")
            return {"item": None, "reason": f"control-{control['mode']}"}
        placeholders = ",".join("?" for _ in ACTIVE_STATES)
        active = connection.execute(
            f"SELECT * FROM queue_items WHERE state IN ({placeholders}) ORDER BY updated_at_utc LIMIT 1",
            tuple(ACTIVE_STATES),
        ).fetchone()
        if active:
            connection.execute("COMMIT")
            return {"item": None, "reason": "active-review", "active": item_from_row(active)}

        if requested_source:
            candidates = connection.execute(
                """
                SELECT * FROM queue_items
                WHERE state = 'queued' AND source_id = ? AND task_id = ?
                ORDER BY priority DESC, dispatch_sequence ASC, created_at_utc ASC, item_id ASC
                """,
                (requested_source, requested_task),
            ).fetchall()
        else:
            candidates = connection.execute(
                """
                SELECT * FROM queue_items
                WHERE state = 'queued'
                ORDER BY priority DESC, dispatch_sequence ASC, created_at_utc ASC, item_id ASC
                """
            ).fetchall()
        selected = None
        for candidate in candidates:
            dependencies = json_value(candidate["dependencies_json"], [])
            if dependencies_satisfied(connection, dependencies):
                selected = candidate
                break
        if not selected:
            connection.execute("COMMIT")
            if requested_source:
                existing = connection.execute(
                    "SELECT state FROM queue_items WHERE source_id = ? AND task_id = ?",
                    (requested_source, requested_task),
                ).fetchone()
                reason = (
                    f"requested-item-{existing['state']}"
                    if existing
                    else "requested-item-not-found"
                )
                if candidates:
                    reason = "dependencies-not-ready"
            else:
                reason = "dependencies-not-ready" if candidates else "queue-empty"
            return {"item": None, "reason": reason}

        lease_token = str(uuid.uuid4())
        connection.execute(
            """
            UPDATE queue_items
            SET state = 'leased', phase = 'review-starting', current_action = ?,
                lease_token = ?, lease_owner = ?, lease_expires_at_utc = ?,
                attempts = attempts + 1, started_at_utc = COALESCE(started_at_utc, ?),
                updated_at_utc = ?
            WHERE item_id = ? AND state = 'queued'
            """,
            ("Starting serialized review", lease_token, owner, expires, now, now, selected["item_id"]),
        )
        add_event(
            connection,
            "queue.item_claimed",
            item_id=selected["item_id"],
            payload={"owner": owner, "leaseExpiresAtUtc": expires},
            at_utc=now,
        )
        claimed = connection.execute(
            "SELECT * FROM queue_items WHERE item_id = ?", (selected["item_id"],)
        ).fetchone()
        connection.execute("COMMIT")
        return {"item": item_from_row(claimed), "reason": "claimed"}
    except Exception:
        connection.execute("ROLLBACK")
        raise


def command_accept(connection: sqlite3.Connection, payload: dict) -> dict:
    source_id = require_id(payload.get("sourceId"), "sourceId")
    task_id = require_id(payload.get("taskId"), "taskId")
    report_sha = require_sha256(payload.get("reportSha256"), "reportSha256")
    evidence = payload.get("evidence") or []
    if not isinstance(evidence, list):
        raise ValueError("Acceptance evidence must be an array")
    acceptance_evidence = [entry for entry in evidence if isinstance(entry, dict) and entry.get("kind") == "acceptance"]
    if len(acceptance_evidence) != 1:
        raise ValueError("Deterministic acceptance requires exactly one acceptance evidence reference")
    require_sha256(acceptance_evidence[0].get("sha256"), "acceptance evidence sha256")
    summary = bounded_text(payload.get("summary") or "Deterministic acceptance passed", 2048)
    plan = payload.get("plan")
    now = utc_now()

    connection.execute("BEGIN IMMEDIATE")
    try:
        row = connection.execute(
            "SELECT * FROM queue_items WHERE source_id = ? AND task_id = ?",
            (source_id, task_id),
        ).fetchone()
        if not row:
            raise ValueError(f"Queue item does not exist: {source_id}/{task_id}")
        if row["report_sha256"] != report_sha:
            raise ValueError(f"Report SHA-256 changed for {source_id}/{task_id}")
        if row["state"] == "accepted" and row["final_decision"] == "accepted":
            connection.execute("COMMIT")
            return {"accepted": True, "idempotent": True, "item": item_from_row(row)}
        if row["state"] != "queued":
            raise ValueError(f"Queue item {source_id}/{task_id} cannot be accepted from state {row['state']}")
        control = connection.execute("SELECT mode FROM control_state WHERE singleton_id = 1").fetchone()
        if control["mode"] != "running":
            raise ValueError(f"Control is {control['mode']}; deterministic acceptance is not allowed")
        placeholders = ",".join("?" for _ in ACTIVE_STATES)
        active = connection.execute(
            f"SELECT item_id FROM queue_items WHERE state IN ({placeholders}) LIMIT 1",
            tuple(ACTIVE_STATES),
        ).fetchone()
        if active:
            raise ValueError(f"Another serialized operation is active: {active['item_id']}")
        if row["report_status"] != "completed":
            raise ValueError(f"Only a completed child report can be accepted, got {row['report_status']}")
        if json_value(row["blockers_json"], []):
            raise ValueError("A report with unresolved blockers cannot be accepted")
        dependencies = json_value(row["dependencies_json"], [])
        if not dependencies_satisfied(connection, dependencies):
            raise ValueError("Report dependencies are not ready for deterministic acceptance")
        completed_plan = plan if isinstance(plan, list) else [
            {**step, "state": "completed"}
            for step in json_value(row["plan_json"], [])
            if isinstance(step, dict)
        ]
        connection.execute(
            """
            UPDATE queue_items
            SET state = 'accepted', phase = 'complete', current_action = ?, summary = ?,
                final_decision = 'accepted', evidence_json = ?, plan_json = ?,
                lease_token = NULL, lease_owner = NULL, lease_expires_at_utc = NULL,
                finished_at_utc = COALESCE(finished_at_utc, ?), updated_at_utc = ?
            WHERE item_id = ? AND state = 'queued'
            """,
            (
                "Verified child report accepted without model review",
                summary,
                json_text(evidence),
                json_text(completed_plan),
                now,
                now,
                row["item_id"],
            ),
        )
        add_event(
            connection,
            "queue.item_accepted",
            item_id=row["item_id"],
            payload={
                "sourceId": source_id,
                "taskId": task_id,
                "reportSha256": report_sha,
                "method": "deterministic",
            },
            at_utc=now,
        )
        updated = connection.execute(
            "SELECT * FROM queue_items WHERE item_id = ?", (row["item_id"],)
        ).fetchone()
        connection.execute("COMMIT")
        return {"accepted": True, "idempotent": False, "item": item_from_row(updated)}
    except Exception:
        connection.execute("ROLLBACK")
        raise


PATCH_COLUMNS = {
    "phase": ("phase", lambda value: bounded_text(value, 64)),
    "currentAction": ("current_action", lambda value: bounded_text(value, 512)),
    "summary": ("summary", lambda value: bounded_text(value, 2048)),
    "threadId": ("thread_id", lambda value: bounded_text(value, 256)),
    "turnId": ("turn_id", lambda value: bounded_text(value, 256)),
    "error": ("error", lambda value: bounded_text(value, 2048)),
    "finalDecision": ("final_decision", lambda value: bounded_text(value, 32)),
    "decisionReference": ("decision_reference", lambda value: bounded_text(value, 2048)),
    "leaseExpiresAtUtc": ("lease_expires_at_utc", lambda value: bounded_text(value, 64)),
    "finishedAtUtc": ("finished_at_utc", lambda value: bounded_text(value, 64)),
    "plan": ("plan_json", json_text),
    "blockers": ("blockers_json", json_text),
    "evidence": ("evidence_json", json_text),
}


def command_transition(connection: sqlite3.Connection, payload: dict) -> dict:
    item_id = require_item_id(payload.get("itemId"))
    target = str(payload.get("toState") or "")
    if target not in ITEM_STATES:
        raise ValueError(f"Unsupported queue state: {target}")
    expected = payload.get("fromStates") or []
    if isinstance(expected, str):
        expected = [expected]
    if any(state not in ITEM_STATES for state in expected):
        raise ValueError("fromStates contains an unsupported state")
    patch = payload.get("patch") or {}
    lease_token = payload.get("leaseToken")
    now = utc_now()

    connection.execute("BEGIN IMMEDIATE")
    try:
        row = connection.execute("SELECT * FROM queue_items WHERE item_id = ?", (item_id,)).fetchone()
        if not row:
            raise ValueError(f"Queue item does not exist: {item_id}")
        if expected and row["state"] not in expected:
            raise ValueError(f"Queue item {item_id} is {row['state']}, expected one of {expected}")
        if lease_token and row["lease_token"] != lease_token:
            raise ValueError(f"Lease token does not own queue item {item_id}")

        assignments = ["state = ?", "updated_at_utc = ?"]
        values: list[object] = [target, now]
        for key, value in patch.items():
            if key not in PATCH_COLUMNS:
                raise ValueError(f"Unsupported transition patch field: {key}")
            column, converter = PATCH_COLUMNS[key]
            if key == "finalDecision" and value is not None and value not in DECISIONS:
                raise ValueError(f"Unsupported final decision: {value}")
            assignments.append(f"{column} = ?")
            values.append(converter(value))
        if target in TERMINAL_STATES or target in {"reviewed", "stop_unconfirmed"}:
            assignments.extend(
                [
                    "lease_token = NULL",
                    "lease_owner = NULL",
                    "lease_expires_at_utc = NULL",
                ]
            )
        if target in TERMINAL_STATES or target == "stop_unconfirmed":
            assignments.append("finished_at_utc = COALESCE(finished_at_utc, ?)")
            values.append(now)
        values.append(item_id)
        connection.execute(
            f"UPDATE queue_items SET {', '.join(assignments)} WHERE item_id = ?", tuple(values)
        )
        add_event(
            connection,
            "queue.state_changed",
            item_id=item_id,
            payload={"from": row["state"], "to": target, "patchKeys": sorted(patch.keys())},
            at_utc=now,
        )
        updated = connection.execute("SELECT * FROM queue_items WHERE item_id = ?", (item_id,)).fetchone()
        connection.execute("COMMIT")
        return {"item": item_from_row(updated)}
    except Exception:
        connection.execute("ROLLBACK")
        raise


def command_heartbeat(connection: sqlite3.Connection, payload: dict) -> dict:
    item_id = require_item_id(payload.get("itemId"))
    lease_token = payload.get("leaseToken")
    lease_seconds = max(15, min(int(payload.get("leaseSeconds", 120)), 3600))
    now_dt = dt.datetime.now(dt.timezone.utc)
    now = now_dt.isoformat().replace("+00:00", "Z")
    expires = (now_dt + dt.timedelta(seconds=lease_seconds)).isoformat().replace("+00:00", "Z")
    row = connection.execute("SELECT * FROM queue_items WHERE item_id = ?", (item_id,)).fetchone()
    if not row:
        raise ValueError(f"Queue item does not exist: {item_id}")
    if lease_token and row["lease_token"] != lease_token:
        raise ValueError(f"Lease token does not own queue item {item_id}")
    connection.execute(
        """
        UPDATE queue_items
        SET lease_expires_at_utc = ?, current_action = COALESCE(?, current_action), updated_at_utc = ?
        WHERE item_id = ?
        """,
        (expires, bounded_text(payload.get("currentAction"), 512), now, item_id),
    )
    add_event(
        connection,
        "queue.heartbeat",
        item_id=item_id,
        payload={"leaseExpiresAtUtc": expires},
        at_utc=now,
    )
    return {
        "item": item_from_row(
            connection.execute("SELECT * FROM queue_items WHERE item_id = ?", (item_id,)).fetchone()
        )
    }


def command_set_mode(connection: sqlite3.Connection, payload: dict) -> dict:
    mode = str(payload.get("mode") or "")
    if mode not in CONTROL_MODES:
        raise ValueError(f"Unsupported control mode: {mode}")
    reason = bounded_text(payload.get("reason"), 1024)
    now = utc_now()
    connection.execute("BEGIN IMMEDIATE")
    try:
        previous = connection.execute("SELECT * FROM control_state WHERE singleton_id = 1").fetchone()
        connection.execute(
            "UPDATE control_state SET mode = ?, reason = ?, updated_at_utc = ? WHERE singleton_id = 1",
            (mode, reason, now),
        )
        if mode == "emergency_stopped":
            placeholders = ",".join("?" for _ in ACTIVE_STATES)
            connection.execute(
                f"""
                UPDATE queue_items
                SET state = 'cancelling', phase = 'emergency-stop',
                    current_action = 'Emergency stop requested', updated_at_utc = ?
                WHERE state IN ({placeholders})
                """,
                (now, *ACTIVE_STATES),
            )
            connection.execute(
                """
                UPDATE agents
                SET state = 'cancellation_requested', current_action = 'Emergency stop requested',
                    updated_at_utc = ?
                WHERE state IN ('starting', 'running', 'waiting', 'blocked')
                """,
                (now,),
            )
            connection.execute(
                """
                UPDATE worker_tasks
                SET state = 'cancelling', phase = 'emergency-stop',
                    summary_json = ?, updated_at_utc = ?
                WHERE state IN ('accepted', 'running', 'waiting', 'blocked')
                """,
                (json_text({
                    "now": "Emergency stop requested",
                    "done": [],
                    "next": [],
                    "blockers": [reason or "Emergency stop requested"],
                }), now),
            )
            connection.execute(
                """
                UPDATE worker_agents
                SET state = 'cancellation_requested', current_action = 'Emergency stop requested',
                    updated_at_utc = ?
                WHERE state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                """,
                (now,),
            )
        add_event(
            connection,
            "control.mode_changed",
            payload={"from": previous["mode"], "to": mode, "reason": reason},
            at_utc=now,
        )
        connection.execute("COMMIT")
        return {"mode": mode, "reason": reason, "updatedAtUtc": now}
    except Exception:
        connection.execute("ROLLBACK")
        raise


def command_upsert_progress(connection: sqlite3.Connection, payload: dict) -> dict:
    source_id = require_id(payload.get("sourceId"), "sourceId")
    task_id = require_id(payload.get("taskId"), "taskId")
    state = str(payload.get("state") or "running")
    if state not in WORKER_TASK_STATES:
        raise ValueError(f"Unsupported worker task state: {state}")
    progress_sha = require_sha256(payload.get("progressSha256"), "progressSha256")
    progress_sequence = max(0, int(payload.get("sequence", 0)))
    summary = payload.get("summary") or {}
    if not isinstance(summary, dict):
        raise ValueError("Worker progress summary must be an object")
    agents = payload.get("agents") or []
    if not isinstance(agents, list) or len(agents) > 256:
        raise ValueError("Worker progress agents must be a bounded array")
    now = utc_now()
    updated = bounded_text(payload.get("updatedAtUtc") or now, 64)

    connection.execute("BEGIN IMMEDIATE")
    try:
        existing = connection.execute(
            "SELECT * FROM worker_tasks WHERE source_id = ? AND task_id = ?",
            (source_id, task_id),
        ).fetchone()
        if existing and int(existing["progress_sequence"]) > progress_sequence:
            connection.execute("COMMIT")
            return {"updated": False, "reason": "older-sequence", "task": worker_task_from_row(existing)}
        changed = not existing or existing["progress_sha256"] != progress_sha
        incoming_timing = payload.get("timing") or {}
        existing_timing = json_value(existing["timing_json"], {}) if existing else {}
        incoming_semantic_at = incoming_timing.get("semanticUpdatedAtUtc")
        semantic_changed = (
            changed
            and (
                not existing
                or not incoming_semantic_at
                or existing_timing.get("semanticUpdatedAtUtc") != incoming_semantic_at
            )
        )
        connection.execute(
            """
            INSERT INTO worker_tasks(
              source_id, task_id, title, state, phase, summary_json, plan_json,
              workflow_json, timing_json, blockers_json, evidence_json, stop_events_json, progress_sequence,
              progress_sha256, progress_path, started_at_utc, updated_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, task_id) DO UPDATE SET
              title = excluded.title,
              state = excluded.state,
              phase = excluded.phase,
              summary_json = excluded.summary_json,
              plan_json = excluded.plan_json,
              workflow_json = excluded.workflow_json,
              timing_json = excluded.timing_json,
              blockers_json = excluded.blockers_json,
              evidence_json = excluded.evidence_json,
              stop_events_json = excluded.stop_events_json,
              progress_sequence = excluded.progress_sequence,
              progress_sha256 = excluded.progress_sha256,
              progress_path = excluded.progress_path,
              started_at_utc = COALESCE(worker_tasks.started_at_utc, excluded.started_at_utc),
              updated_at_utc = excluded.updated_at_utc
            """,
            (
                source_id,
                task_id,
                bounded_text(payload.get("title") or task_id, 256),
                state,
                bounded_text(payload.get("phase") or "execution", 64),
                json_text(summary),
                json_text(payload.get("plan") or []),
                json_text(payload.get("workflow") or {}),
                json_text(payload.get("timing") or {}),
                json_text(payload.get("blockers") or summary.get("blockers") or []),
                json_text(payload.get("evidence") or []),
                json_text(payload.get("stopEvents") or []),
                progress_sequence,
                progress_sha,
                bounded_text(payload.get("progressPath") or "", 2048),
                bounded_text(payload.get("startedAtUtc"), 64),
                updated,
            ),
        )
        incoming_agent_ids = []
        for agent in agents:
            agent_id = require_id(agent.get("agentId"), "agentId")
            incoming_agent_ids.append(agent_id)
            agent_state = str(agent.get("state") or "running")
            if agent_state not in AGENT_STATES:
                raise ValueError(f"Unsupported worker agent state: {agent_state}")
            parent = agent.get("parentAgentId")
            if parent:
                parent = require_id(parent, "parentAgentId")
            existing_agent = connection.execute(
                "SELECT statistics_json FROM worker_agents WHERE agent_id = ?",
                (agent_id,),
            ).fetchone()
            statistics = merge_agent_statistics(
                json_value(existing_agent["statistics_json"], {}) if existing_agent else {},
                agent.get("statistics") if "statistics" in agent else {},
            )
            connection.execute(
                """
                INSERT INTO worker_agents(
                  agent_id, source_id, task_id, parent_agent_id, kind, role, provider,
                  state, current_action, last_completed, next_action, blockers_json,
                  can_interrupt, started_at_utc, last_heartbeat_utc, semantic_updated_at_utc,
                  statistics_json, updated_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET
                  source_id = excluded.source_id,
                  task_id = excluded.task_id,
                  parent_agent_id = excluded.parent_agent_id,
                  kind = excluded.kind,
                  role = excluded.role,
                  provider = excluded.provider,
                  state = CASE
                    WHEN worker_agents.state = 'cancellation_requested'
                     AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                    THEN worker_agents.state
                    ELSE excluded.state
                  END,
                  current_action = CASE
                    WHEN worker_agents.state = 'cancellation_requested'
                     AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                    THEN worker_agents.current_action
                    ELSE excluded.current_action
                  END,
                  last_completed = excluded.last_completed,
                  next_action = excluded.next_action,
                  blockers_json = excluded.blockers_json,
                  can_interrupt = excluded.can_interrupt,
                  started_at_utc = COALESCE(worker_agents.started_at_utc, excluded.started_at_utc),
                  last_heartbeat_utc = excluded.last_heartbeat_utc,
                  semantic_updated_at_utc = excluded.semantic_updated_at_utc,
                  statistics_json = excluded.statistics_json,
                  updated_at_utc = excluded.updated_at_utc
                """,
                (
                    agent_id,
                    source_id,
                    task_id,
                    parent,
                    bounded_text(agent.get("kind") or "primary", 32),
                    bounded_text(agent.get("role") or "child-project-agent", 128),
                    bounded_text(agent.get("provider"), 64),
                    agent_state,
                    bounded_text(agent.get("currentAction") or "", 512),
                    bounded_text(agent.get("lastCompleted"), 512),
                    bounded_text(agent.get("nextAction"), 512),
                    json_text(agent.get("blockers") or []),
                    1 if agent.get("canInterrupt") else 0,
                    bounded_text(agent.get("startedAtUtc"), 64),
                    bounded_text(agent.get("lastHeartbeatUtc") or updated, 64),
                    bounded_text(agent.get("semanticUpdatedAtUtc") or agent.get("updatedAtUtc") or updated, 64),
                    json_text(statistics),
                    bounded_text(agent.get("updatedAtUtc") or updated, 64),
                ),
            )
        if incoming_agent_ids:
            placeholders = ",".join("?" for _ in incoming_agent_ids)
            connection.execute(
                f"DELETE FROM worker_agents WHERE source_id = ? AND task_id = ? AND agent_id NOT IN ({placeholders})",
                (source_id, task_id, *incoming_agent_ids),
            )
        else:
            connection.execute(
                "DELETE FROM worker_agents WHERE source_id = ? AND task_id = ?",
                (source_id, task_id),
            )
        if semantic_changed:
            add_event(
                connection,
                "worker.progress_updated",
                payload={"sourceId": source_id, "taskId": task_id, "state": state, "sequence": progress_sequence},
                at_utc=incoming_semantic_at or updated,
            )
        row = connection.execute(
            "SELECT * FROM worker_tasks WHERE source_id = ? AND task_id = ?",
            (source_id, task_id),
        ).fetchone()
        connection.execute("COMMIT")
        return {
            "updated": changed,
            "semanticUpdated": semantic_changed,
            "reason": "stored",
            "task": worker_task_from_row(row),
        }
    except Exception:
        connection.execute("ROLLBACK")
        raise


def command_request_cancel(connection: sqlite3.Connection, payload: dict) -> dict:
    item_id = payload.get("itemId")
    task_id = payload.get("taskId")
    agent_id = payload.get("agentId")
    source_id = payload.get("sourceId")
    if source_id:
        source_id = require_id(source_id, "sourceId")
    target_agent = None
    worker_task = None
    worker_agent = None
    if item_id:
        item_id = require_item_id(item_id)
    elif task_id:
        task_id = require_id(task_id, "taskId")
        queue_rows = connection.execute(
            "SELECT item_id FROM queue_items WHERE task_id = ? AND (? IS NULL OR source_id = ?) ORDER BY created_at_utc DESC",
            (task_id, source_id, source_id),
        ).fetchall()
        if not source_id and len(queue_rows) > 1:
            raise ValueError(f"Task ID {task_id!r} is ambiguous; provide sourceId")
        row = queue_rows[0] if queue_rows else None
        item_id = row["item_id"] if row else None
        if not item_id:
            worker_rows = connection.execute(
                "SELECT * FROM worker_tasks WHERE task_id = ? AND (? IS NULL OR source_id = ?) ORDER BY updated_at_utc DESC",
                (task_id, source_id, source_id),
            ).fetchall()
            if not source_id and len(worker_rows) > 1:
                raise ValueError(f"Worker task ID {task_id!r} is ambiguous; provide sourceId")
            worker_task = worker_rows[0] if worker_rows else None
    elif agent_id:
        agent_id = require_id(agent_id, "agentId")
        target_agent = connection.execute("SELECT * FROM agents WHERE agent_id = ?", (agent_id,)).fetchone()
        item_id = target_agent["item_id"] if target_agent else None
        if not item_id:
            worker_agent = connection.execute(
                "SELECT * FROM worker_agents WHERE agent_id = ?", (agent_id,)
            ).fetchone()
            if worker_agent:
                worker_task = connection.execute(
                    "SELECT * FROM worker_tasks WHERE source_id = ? AND task_id = ?",
                    (worker_agent["source_id"], worker_agent["task_id"]),
                ).fetchone()
    else:
        raise ValueError("Cancellation requires itemId, taskId, or agentId")
    if not item_id and not worker_task:
        raise ValueError("Cancellation target does not exist")
    reason = bounded_text(payload.get("reason") or "Cancellation requested", 1024)
    now = utc_now()

    connection.execute("BEGIN IMMEDIATE")
    try:
        if worker_task:
            terminal_worker_states = {"cancelled", "completed", "failed"}
            if worker_agent:
                terminal_agent_states = {"interrupted", "completed", "failed", "stop_unconfirmed"}
                target_agent_state = (
                    worker_agent["state"]
                    if worker_agent["state"] in terminal_agent_states
                    else "cancellation_requested"
                )
                connection.execute(
                    """
                    UPDATE worker_agents SET state = ?, current_action = ?, updated_at_utc = ?
                    WHERE agent_id = ?
                    """,
                    (target_agent_state, reason, now, agent_id),
                )
                target_state = worker_task["state"]
            else:
                target_state = (
                    worker_task["state"]
                    if worker_task["state"] in terminal_worker_states
                    else "cancelling"
                )
                summary = json_value(worker_task["summary_json"], {})
                summary["now"] = reason
                connection.execute(
                    """
                    UPDATE worker_tasks
                    SET state = ?, phase = 'cancellation', summary_json = ?, updated_at_utc = ?
                    WHERE source_id = ? AND task_id = ?
                    """,
                    (
                        target_state,
                        json_text(summary),
                        now,
                        worker_task["source_id"],
                        worker_task["task_id"],
                    ),
                )
                connection.execute(
                    """
                    UPDATE worker_agents
                    SET state = 'cancellation_requested', current_action = ?, updated_at_utc = ?
                    WHERE source_id = ? AND task_id = ?
                      AND state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
                    """,
                    (reason, now, worker_task["source_id"], worker_task["task_id"]),
                )
            add_event(
                connection,
                "control.external_cancellation_requested",
                agent_id=agent_id,
                payload={
                    "scope": "agent" if agent_id else "task",
                    "sourceId": worker_task["source_id"],
                    "taskId": worker_task["task_id"],
                    "reason": reason,
                    "state": target_state,
                },
                at_utc=now,
            )
            connection.execute("COMMIT")
            return {
                "item": None,
                "external": True,
                "sourceId": worker_task["source_id"],
                "taskId": worker_task["task_id"],
                "agentId": agent_id,
                "state": target_state,
            }

        row = connection.execute("SELECT * FROM queue_items WHERE item_id = ?", (item_id,)).fetchone()
        if not row:
            raise ValueError(f"Queue item does not exist: {item_id}")
        if agent_id:
            if not target_agent:
                raise ValueError(f"Agent does not exist: {agent_id}")
            terminal_agent_states = {"interrupted", "completed", "failed", "stop_unconfirmed"}
            target_agent_state = (
                target_agent["state"]
                if target_agent["state"] in terminal_agent_states
                else "cancellation_requested"
            )
            connection.execute(
                """
                UPDATE agents SET state = ?, current_action = ?, updated_at_utc = ?
                WHERE agent_id = ?
                """,
                (target_agent_state, reason, now, agent_id),
            )
            target_state = row["state"]
        else:
            if row["state"] in TERMINAL_STATES:
                target_state = row["state"]
            elif row["state"] in {"queued", "waiting", "blocked"}:
                target_state = "cancelled"
            else:
                target_state = "cancelling"
            connection.execute(
                """
                UPDATE queue_items
                SET state = ?, phase = 'cancellation', current_action = ?, updated_at_utc = ?,
                    finished_at_utc = CASE WHEN ? = 'cancelled' THEN COALESCE(finished_at_utc, ?) ELSE finished_at_utc END
                WHERE item_id = ?
                """,
                (target_state, reason, now, target_state, now, item_id),
            )
            connection.execute(
                """
                UPDATE agents SET state = 'cancellation_requested', current_action = ?, updated_at_utc = ?
                WHERE item_id = ? AND state IN ('starting', 'running', 'waiting', 'blocked')
                """,
                (reason, now, item_id),
            )
        add_event(
            connection,
            "control.cancellation_requested",
            item_id=item_id,
            agent_id=agent_id,
            payload={"scope": "agent" if agent_id else "task", "reason": reason, "state": target_state},
            at_utc=now,
        )
        updated = connection.execute("SELECT * FROM queue_items WHERE item_id = ?", (item_id,)).fetchone()
        connection.execute("COMMIT")
        return {"item": item_from_row(updated), "agentId": agent_id}
    except Exception:
        connection.execute("ROLLBACK")
        raise


def command_retry(connection: sqlite3.Connection, payload: dict) -> dict:
    item_id = require_item_id(payload.get("itemId"))
    now = utc_now()
    connection.execute("BEGIN IMMEDIATE")
    try:
        control = connection.execute("SELECT mode FROM control_state WHERE singleton_id = 1").fetchone()
        if control["mode"] == "emergency_stopped":
            raise ValueError("Resume control before retrying an item")
        row = connection.execute("SELECT * FROM queue_items WHERE item_id = ?", (item_id,)).fetchone()
        if not row:
            raise ValueError(f"Queue item does not exist: {item_id}")
        if row["state"] not in RETRYABLE_STATES:
            raise ValueError(f"Queue item {item_id} is not retryable from state {row['state']}")
        connection.execute(
            """
            UPDATE queue_items
            SET state = 'queued', phase = 'retry-queued', current_action = 'Waiting for retry',
                thread_id = NULL, turn_id = NULL, lease_token = NULL, lease_owner = NULL,
                lease_expires_at_utc = NULL, error = NULL, final_decision = NULL,
                decision_reference = NULL, finished_at_utc = NULL, updated_at_utc = ?
            WHERE item_id = ?
            """,
            (now, item_id),
        )
        connection.execute("DELETE FROM agents WHERE item_id = ?", (item_id,))
        add_event(connection, "queue.item_retried", item_id=item_id, at_utc=now)
        updated = connection.execute("SELECT * FROM queue_items WHERE item_id = ?", (item_id,)).fetchone()
        connection.execute("COMMIT")
        return {"item": item_from_row(updated)}
    except Exception:
        connection.execute("ROLLBACK")
        raise


def command_finalize_stop(connection: sqlite3.Connection, payload: dict) -> dict:
    reason = bounded_text(payload.get("reason") or "Stop confirmation timed out", 1024)
    now = utc_now()
    connection.execute("BEGIN IMMEDIATE")
    try:
        queue_rows = connection.execute(
            "SELECT item_id FROM queue_items WHERE state = 'cancelling'"
        ).fetchall()
        connection.execute(
            """
            UPDATE queue_items
            SET state = 'stop_unconfirmed', phase = 'stopped', current_action = ?,
                lease_token = NULL, lease_owner = NULL, lease_expires_at_utc = NULL,
                finished_at_utc = COALESCE(finished_at_utc, ?), updated_at_utc = ?
            WHERE state = 'cancelling'
            """,
            (reason, now, now),
        )
        connection.execute(
            """
            UPDATE agents
            SET state = 'stop_unconfirmed', current_action = ?, can_interrupt = 0, updated_at_utc = ?
            WHERE state = 'cancellation_requested'
            """,
            (reason, now),
        )
        worker_rows = connection.execute(
            "SELECT source_id, task_id FROM worker_tasks WHERE state = 'cancelling'"
        ).fetchall()
        connection.execute(
            """
            UPDATE worker_tasks
            SET state = 'stop_unconfirmed', phase = 'stopped', updated_at_utc = ?
            WHERE state = 'cancelling'
            """,
            (now,),
        )
        connection.execute(
            """
            UPDATE worker_agents
            SET state = 'stop_unconfirmed', current_action = ?, can_interrupt = 0, updated_at_utc = ?
            WHERE state = 'cancellation_requested'
            """,
            (reason, now),
        )
        add_event(
            connection,
            "control.stop_confirmation_timed_out",
            payload={
                "reason": reason,
                "queueItems": [row["item_id"] for row in queue_rows],
                "workerTasks": [f"{row['source_id']}:{row['task_id']}" for row in worker_rows],
            },
            at_utc=now,
        )
        connection.execute("COMMIT")
        return {
            "queueItems": [row["item_id"] for row in queue_rows],
            "workerTasks": [f"{row['source_id']}:{row['task_id']}" for row in worker_rows],
            "reason": reason,
        }
    except Exception:
        connection.execute("ROLLBACK")
        raise


def command_recover(connection: sqlite3.Connection, _: dict) -> dict:
    now_dt = dt.datetime.now(dt.timezone.utc)
    now = now_dt.isoformat().replace("+00:00", "Z")
    recovered: list[dict] = []
    connection.execute("BEGIN IMMEDIATE")
    try:
        rows = connection.execute(
            """
            SELECT * FROM queue_items
            WHERE state IN ('leased', 'review_running', 'decision_validating', 'integrating', 'cancelling')
              AND lease_expires_at_utc IS NOT NULL
            """
        ).fetchall()
        for row in rows:
            expires = parse_utc(row["lease_expires_at_utc"])
            if not expires or expires > now_dt:
                continue
            if row["state"] == "leased" and not row["thread_id"]:
                target = "queued"
                action = "Recovered expired pre-turn lease"
            elif row["state"] == "cancelling":
                target = "stop_unconfirmed"
                action = "Cancellation lease expired without provider confirmation"
            else:
                target = "recovery_required"
                action = "Provider reconciliation required after lease expiry"
            connection.execute(
                """
                UPDATE queue_items
                SET state = ?, phase = 'recovery', current_action = ?, lease_token = NULL,
                    lease_owner = NULL, lease_expires_at_utc = NULL, updated_at_utc = ?
                WHERE item_id = ?
                """,
                (target, action, now, row["item_id"]),
            )
            add_event(
                connection,
                "queue.lease_recovered",
                item_id=row["item_id"],
                payload={"from": row["state"], "to": target},
                at_utc=now,
            )
            recovered.append({"itemId": row["item_id"], "from": row["state"], "to": target})
        connection.execute("COMMIT")
        return {"recovered": recovered}
    except Exception:
        connection.execute("ROLLBACK")
        raise


def command_upsert_agent(connection: sqlite3.Connection, payload: dict) -> dict:
    agent_id = require_id(payload.get("agentId"), "agentId")
    item_id = require_item_id(payload.get("itemId"))
    parent = payload.get("parentAgentId")
    if parent:
        parent = require_id(parent, "parentAgentId")
    state = str(payload.get("state") or "registered")
    if state not in AGENT_STATES:
        raise ValueError(f"Unsupported agent state: {state}")
    now = utc_now()
    started = payload.get("startedAtUtc") or (now if state in {"starting", "running"} else None)
    heartbeat = payload.get("lastHeartbeatUtc") or (now if state in {"starting", "running"} else None)
    existing_agent = connection.execute(
        "SELECT statistics_json FROM agents WHERE agent_id = ?",
        (agent_id,),
    ).fetchone()
    statistics = merge_agent_statistics(
        json_value(existing_agent["statistics_json"], {}) if existing_agent else {},
        payload.get("statistics") if "statistics" in payload else {},
    )
    connection.execute(
        """
        INSERT INTO agents(
          agent_id, item_id, parent_agent_id, kind, role, provider, state,
          current_action, last_completed, next_action, blockers_json,
          thread_id, turn_id, can_interrupt, started_at_utc,
          last_heartbeat_utc, statistics_json, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          item_id = excluded.item_id,
          parent_agent_id = COALESCE(excluded.parent_agent_id, agents.parent_agent_id),
          kind = excluded.kind,
          role = excluded.role,
          provider = excluded.provider,
          state = CASE
            WHEN agents.state = 'cancellation_requested'
             AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
            THEN agents.state
            ELSE excluded.state
          END,
          current_action = CASE
            WHEN agents.state = 'cancellation_requested'
             AND excluded.state IN ('registered', 'starting', 'running', 'waiting', 'blocked')
            THEN agents.current_action
            ELSE excluded.current_action
          END,
          last_completed = excluded.last_completed,
          next_action = excluded.next_action,
          blockers_json = excluded.blockers_json,
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          can_interrupt = excluded.can_interrupt,
          started_at_utc = COALESCE(agents.started_at_utc, excluded.started_at_utc),
          last_heartbeat_utc = excluded.last_heartbeat_utc,
          statistics_json = excluded.statistics_json,
          updated_at_utc = excluded.updated_at_utc
        """,
        (
            agent_id,
            item_id,
            parent,
            bounded_text(payload.get("kind") or "primary", 32),
            bounded_text(payload.get("role") or "worker", 128),
            bounded_text(payload.get("provider"), 64),
            state,
            bounded_text(payload.get("currentAction") or "", 512),
            bounded_text(payload.get("lastCompleted"), 512),
            bounded_text(payload.get("nextAction"), 512),
            json_text(payload.get("blockers", [])),
            bounded_text(payload.get("threadId"), 256),
            bounded_text(payload.get("turnId"), 256),
            1 if payload.get("canInterrupt") else 0,
            started,
            heartbeat,
            json_text(statistics),
            now,
        ),
    )
    add_event(
        connection,
        "agent.preview_updated",
        item_id=item_id,
        agent_id=agent_id,
        payload={"state": state, "currentAction": bounded_text(payload.get("currentAction") or "", 256)},
        at_utc=now,
    )
    row = connection.execute("SELECT * FROM agents WHERE agent_id = ?", (agent_id,)).fetchone()
    return {"agent": agent_from_row(row)}


def command_upsert_agent_statistics(connection: sqlite3.Connection, payload: dict) -> dict:
    agent_id = require_id(payload.get("agentId"), "agentId")
    incoming = agent_statistics(payload.get("statistics"))
    row = connection.execute("SELECT * FROM agents WHERE agent_id = ?", (agent_id,)).fetchone()
    if not row:
        raise ValueError(f"Agent does not exist: {agent_id}")
    merged = merge_agent_statistics(json_value(row["statistics_json"], {}), incoming)
    now = utc_now()
    connection.execute(
        "UPDATE agents SET statistics_json = ? WHERE agent_id = ?",
        (json_text(merged), agent_id),
    )
    add_event(
        connection,
        "agent.statistics_updated",
        item_id=row["item_id"],
        agent_id=agent_id,
        payload={
            "tokenStatus": merged.get("tokens", {}).get("status", "unavailable"),
            "costStatus": merged.get("cost", {}).get("status", "unavailable"),
        },
        at_utc=now,
    )
    updated = connection.execute("SELECT * FROM agents WHERE agent_id = ?", (agent_id,)).fetchone()
    return {"agent": agent_from_row(updated)}


def command_add_event(connection: sqlite3.Connection, payload: dict) -> dict:
    item_id = payload.get("itemId")
    agent_id = payload.get("agentId")
    if item_id:
        item_id = require_item_id(item_id)
    if agent_id:
        agent_id = require_id(agent_id, "agentId")
    event_type = bounded_text(payload.get("type") or "custom.event", 128)
    sequence = add_event(
        connection,
        event_type,
        item_id=item_id,
        agent_id=agent_id,
        payload=payload.get("data") or {},
    )
    return {"sequence": sequence}


def command_snapshot(connection: sqlite3.Connection, payload: dict) -> dict:
    event_limit = max(0, min(int(payload.get("eventLimit", 200)), 1000))
    control = connection.execute("SELECT * FROM control_state WHERE singleton_id = 1").fetchone()
    items = [item_from_row(row) for row in connection.execute(
        """
        SELECT * FROM queue_items
        ORDER BY
          CASE WHEN state IN ('leased','review_running','decision_validating','integrating','cancelling','recovery_required')
               THEN 0 WHEN state = 'queued' THEN 1 ELSE 2 END,
          priority DESC, dispatch_sequence ASC, created_at_utc ASC
        """
    ).fetchall()]
    agents = [agent_from_row(row) for row in connection.execute(
        "SELECT * FROM agents ORDER BY item_id, parent_agent_id, agent_id"
    ).fetchall()]
    worker_tasks = [worker_task_from_row(row) for row in connection.execute(
        "SELECT * FROM worker_tasks ORDER BY updated_at_utc DESC, source_id, task_id"
    ).fetchall()]
    worker_agents = [worker_agent_from_row(row) for row in connection.execute(
        "SELECT * FROM worker_agents ORDER BY source_id, task_id, parent_agent_id, agent_id"
    ).fetchall()]
    event_rows = connection.execute(
        "SELECT * FROM events ORDER BY sequence DESC LIMIT ?", (event_limit,)
    ).fetchall()
    events = [event_from_row(row) for row in reversed(event_rows)]
    sequence = connection.execute("SELECT COALESCE(MAX(sequence), 0) FROM events").fetchone()[0]
    counts: dict[str, int] = {}
    for item in items:
        counts[item["state"]] = counts.get(item["state"], 0) + 1
    return {
        "formatVersion": FORMAT_VERSION,
        "sequence": int(sequence),
        "control": {
            "mode": control["mode"],
            "reason": control["reason"],
            "updatedAtUtc": control["updated_at_utc"],
        },
        "counts": counts,
        "items": items,
        "agents": agents,
        "workerTasks": worker_tasks,
        "workerAgents": worker_agents,
        "events": events,
    }


def command_compact(connection: sqlite3.Connection, payload: dict) -> dict:
    retention_days = max(1, min(int(payload.get("retentionDays", 30)), 3650))
    archive_root = Path(str(payload.get("archiveRoot") or "")).expanduser().resolve()
    archive_root.mkdir(parents=True, exist_ok=True)
    cutoff_dt = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=retention_days)
    cutoff = cutoff_dt.isoformat().replace("+00:00", "Z")
    terminal_placeholders = ",".join("?" for _ in FINAL_STATES)
    rows = connection.execute(
        f"""
        SELECT events.* FROM events
        LEFT JOIN queue_items ON queue_items.item_id = events.item_id
        WHERE events.at_utc < ?
          AND (events.item_id IS NULL OR queue_items.state IN ({terminal_placeholders}))
        ORDER BY events.sequence
        """,
        (cutoff, *FINAL_STATES),
    ).fetchall()
    if not rows:
        return {"archivedEvents": 0, "cutoffUtc": cutoff, "archive": None}

    first_sequence = rows[0]["sequence"]
    last_sequence = rows[-1]["sequence"]
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    file_name = f"control-events-{first_sequence}-{last_sequence}-{stamp}.jsonl.gz"
    archive_path = archive_root / file_name
    digest = hashlib.sha256()
    with gzip.open(archive_path, "wt", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            line = json.dumps(event_from_row(row), ensure_ascii=False, separators=(",", ":")) + "\n"
            stream.write(line)
            digest.update(line.encode("utf-8"))
    compressed_hash = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    manifest = {
        "schemaVersion": 1,
        "archiveFile": file_name,
        "eventCount": len(rows),
        "firstSequence": first_sequence,
        "lastSequence": last_sequence,
        "uncompressedSha256": digest.hexdigest(),
        "compressedSha256": compressed_hash,
        "createdAtUtc": utc_now(),
    }
    manifest_path = archive_path.with_suffix(archive_path.suffix + ".manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            "DELETE FROM events WHERE sequence >= ? AND sequence <= ?",
            (first_sequence, last_sequence),
        )
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        archive_path.unlink(missing_ok=True)
        manifest_path.unlink(missing_ok=True)
        raise
    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return {
        "archivedEvents": len(rows),
        "cutoffUtc": cutoff,
        "archive": manifest,
    }


COMMANDS = {
    "init": command_init,
    "enqueue": command_enqueue,
    "claim": command_claim,
    "accept": command_accept,
    "transition": command_transition,
    "heartbeat": command_heartbeat,
    "set-mode": command_set_mode,
    "upsert-progress": command_upsert_progress,
    "request-cancel": command_request_cancel,
    "finalize-stop": command_finalize_stop,
    "retry": command_retry,
    "recover": command_recover,
    "upsert-agent": command_upsert_agent,
    "upsert-agent-statistics": command_upsert_agent_statistics,
    "add-event": command_add_event,
    "snapshot": command_snapshot,
    "compact": command_compact,
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    parser.add_argument("command", choices=sorted(COMMANDS))
    arguments = parser.parse_args()
    payload = read_payload()
    connection = connect(arguments.database)
    try:
        migrate(connection)
        result = COMMANDS[arguments.command](connection, payload)
        sys.stdout.write(json.dumps({"ok": True, "result": result}, ensure_ascii=False) + "\n")
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        sys.stderr.write(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False) + "\n")
        raise SystemExit(1)
