#!/usr/bin/env python3
"""Read a serialized-control snapshot without changing its SQLite files."""

from __future__ import annotations

import argparse
import json
import runpy
import sqlite3
import sys
from pathlib import Path


sys.dont_write_bytecode = True

SUPPORTED_FORMAT_VERSION = 4
REQUIRED_COLUMNS = {
    "control_state": (
        "singleton_id", "mode", "reason", "updated_at_utc",
    ),
    "queue_items": (
        "item_id", "report_key", "source_id", "task_id", "report_id",
        "title", "report_status", "report_sha256", "task_sha256",
        "source_revision", "report_path", "task_path", "decision_path",
        "priority", "dispatch_sequence", "dependencies_json", "plan_json",
        "blockers_json", "evidence_json", "state", "phase",
        "current_action", "summary", "final_decision", "decision_reference",
        "thread_id", "turn_id", "lease_token", "lease_owner",
        "lease_expires_at_utc", "attempts", "error", "created_at_utc",
        "updated_at_utc", "started_at_utc", "finished_at_utc",
    ),
    "agents": (
        "agent_id", "item_id", "parent_agent_id", "kind", "role",
        "provider", "state", "current_action", "last_completed",
        "next_action", "blockers_json", "thread_id", "turn_id",
        "can_interrupt", "started_at_utc", "last_heartbeat_utc",
        "statistics_json", "updated_at_utc",
    ),
    "worker_tasks": (
        "source_id", "task_id", "title", "state", "phase", "summary_json",
        "plan_json", "workflow_json", "timing_json", "blockers_json",
        "evidence_json", "stop_events_json", "progress_sequence",
        "progress_sha256", "progress_path", "started_at_utc", "updated_at_utc",
    ),
    "worker_agents": (
        "agent_id", "source_id", "task_id", "parent_agent_id", "kind",
        "role", "provider", "state", "current_action", "last_completed",
        "next_action", "blockers_json", "can_interrupt", "started_at_utc",
        "last_heartbeat_utc", "semantic_updated_at_utc", "statistics_json",
        "updated_at_utc",
    ),
    "events": (
        "sequence", "at_utc", "event_type", "item_id", "agent_id",
        "payload_json",
    ),
}


class SnapshotReadError(RuntimeError):
    """A bounded, machine-readable snapshot source failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def load_store_contract() -> tuple[int, object]:
    store_path = Path(__file__).with_name("sqlite-control-store.py")
    contract = runpy.run_path(str(store_path), run_name="_sqlite_control_store")
    store_version = int(contract["FORMAT_VERSION"])
    if store_version != SUPPORTED_FORMAT_VERSION:
        raise SnapshotReadError(
            "CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED",
            f"Snapshot reader does not support store format {store_version}",
        )
    return SUPPORTED_FORMAT_VERSION, contract["command_snapshot"]


def read_payload() -> dict:
    content = sys.stdin.read()
    if not content.strip():
        return {}
    value = json.loads(content)
    if not isinstance(value, dict):
        raise SnapshotReadError(
            "CONTROL_SNAPSHOT_PAYLOAD_INVALID",
            "Snapshot options must be a JSON object",
        )
    return value


def connect_read_only(database_path: str) -> sqlite3.Connection:
    try:
        resolved = Path(database_path).expanduser().resolve(strict=True)
    except FileNotFoundError:
        raise SnapshotReadError(
            "CONTROL_SNAPSHOT_DATABASE_ABSENT",
            "Control store database does not exist",
        ) from None
    if not resolved.is_file():
        raise SnapshotReadError(
            "CONTROL_SNAPSHOT_DATABASE_ABSENT",
            "Control store database is not a regular file",
        )

    wal_exists = Path(f"{resolved}-wal").is_file()
    shm_exists = Path(f"{resolved}-shm").is_file()
    if wal_exists != shm_exists:
        raise SnapshotReadError(
            "CONTROL_SNAPSHOT_WAL_INCOMPLETE",
            "Control store WAL and SHM must either both exist or both be absent",
        )
    # Existing WAL indexes must be mapped read-only so reader marks cannot alter SHM.
    immutable = "&readonly_shm=1" if wal_exists else "&immutable=1"
    uri = f"{resolved.as_uri()}?mode=ro&cache=private{immutable}"
    connection = None
    try:
        connection = sqlite3.connect(
            uri,
            uri=True,
            timeout=0,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        query_only = connection.execute("PRAGMA query_only").fetchone()[0]
        if query_only != 1:
            connection.close()
            raise SnapshotReadError(
                "CONTROL_SNAPSHOT_READ_ONLY_UNAVAILABLE",
                "SQLite query-only mode could not be enabled",
            )
        return connection
    except SnapshotReadError:
        raise
    except sqlite3.Error as error:
        if connection is not None:
            connection.close()
        raise SnapshotReadError(
            "CONTROL_SNAPSHOT_OPEN_FAILED",
            f"Control store database could not be opened read-only: {error}",
        ) from error


def validate_schema(connection: sqlite3.Connection, expected_version: int) -> None:
    version = int(connection.execute("PRAGMA user_version").fetchone()[0])
    if version != expected_version:
        raise SnapshotReadError(
            "CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED",
            f"Unsupported control store schema version: {version}; expected {expected_version}",
        )

    tables = {
        row["name"]
        for row in connection.execute(
            "SELECT name FROM sqlite_schema WHERE type = 'table'"
        ).fetchall()
    }
    missing_tables = sorted(set(REQUIRED_COLUMNS) - tables)
    if missing_tables:
        raise SnapshotReadError(
            "CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED",
            f"Control store schema is missing tables: {', '.join(missing_tables)}",
        )

    missing_columns = []
    for table, required in REQUIRED_COLUMNS.items():
        columns = {
            row["name"]
            for row in connection.execute(f'PRAGMA table_info("{table}")').fetchall()
        }
        missing_columns.extend(
            f"{table}.{column}" for column in required if column not in columns
        )
    if missing_columns:
        raise SnapshotReadError(
            "CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED",
            f"Control store schema is missing columns: {', '.join(missing_columns)}",
        )

    control = connection.execute(
        "SELECT singleton_id FROM control_state WHERE singleton_id = 1"
    ).fetchone()
    if control is None:
        raise SnapshotReadError(
            "CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED",
            "Control store schema has no singleton control state",
        )


def read_snapshot(database_path: str, payload: dict) -> dict:
    expected_version, snapshot_command = load_store_contract()
    connection = connect_read_only(database_path)
    try:
        connection.execute("BEGIN")
        validate_schema(connection, expected_version)
        result = snapshot_command(connection, payload)
        if result.get("formatVersion") != expected_version:
            raise SnapshotReadError(
                "CONTROL_SNAPSHOT_SCHEMA_UNSUPPORTED",
                "Control snapshot format does not match the store schema",
            )
        return result
    finally:
        if connection.in_transaction:
            connection.rollback()
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    arguments = parser.parse_args()
    result = read_snapshot(arguments.database, read_payload())
    sys.stdout.write(json.dumps({"ok": True, "result": result}, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        code = getattr(error, "code", "CONTROL_SNAPSHOT_READ_FAILED")
        response = {"ok": False, "code": code, "error": str(error)}
        sys.stderr.write(json.dumps(response, ensure_ascii=False) + "\n")
        raise SystemExit(1)
