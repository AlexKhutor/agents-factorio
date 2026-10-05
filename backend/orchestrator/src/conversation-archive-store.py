import argparse
import json
import sqlite3
import sys


class ArchiveFailure(Exception):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def initialize(db, project_id):
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version not in (0, 1, 2):
        raise ArchiveFailure("archive_unsupported_schema")
    if version == 0:
        if db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchone():
            raise ArchiveFailure("archive_unsupported_schema")
        db.execute("CREATE TABLE archive_meta (project_id TEXT NOT NULL)")
        db.execute("INSERT INTO archive_meta VALUES (?)", (project_id,))
        db.execute("""CREATE TABLE conversations (
            id TEXT PRIMARY KEY, binding TEXT NOT NULL)""")
        db.execute("""CREATE TABLE entries (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            record_id TEXT NOT NULL, content_sha256 TEXT NOT NULL,
            observed_at_utc TEXT NOT NULL, record TEXT NOT NULL)""")
        db.execute("CREATE INDEX entries_conversation ON entries(conversation_id, record_id, sequence)")
        db.execute("PRAGMA user_version=1")
    row = db.execute("SELECT project_id FROM archive_meta").fetchone()
    if row is None or row[0] != project_id:
        raise ArchiveFailure("archive_identity_conflict")
    if version < 2:
        db.execute("""CREATE TABLE import_checkpoints (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
            revision INTEGER NOT NULL, cursor TEXT, exhausted INTEGER NOT NULL)""")
        db.execute("PRAGMA user_version=2")


def check_scope(db, payload, create=False):
    identity = payload["conversationId"]
    binding = payload["binding"]
    if binding["projectId"] != payload["projectId"]:
        raise ArchiveFailure("archive_identity_conflict")
    serialized = encoded(binding)
    row = db.execute("SELECT binding FROM conversations WHERE id=?", (identity,)).fetchone()
    if row is not None and row[0] != serialized:
        raise ArchiveFailure("archive_identity_conflict")
    if row is None and create:
        db.execute("INSERT INTO conversations VALUES (?,?)", (identity, serialized))
    return identity


def append(db, payload):
    identity = check_scope(db, payload, create=True)
    record = payload["record"]
    latest = db.execute("""SELECT sequence, content_sha256, record FROM entries
        WHERE conversation_id=? AND record_id=? ORDER BY sequence DESC LIMIT 1""",
        (identity, record["recordId"])).fetchone()
    if latest is not None and latest[1] == payload["contentSha256"]:
        return {"conversationId": identity, "sequence": latest[0], "replay": True,
                "contentSha256": latest[1]}
    if latest is not None and (record["kind"] == "submission"
                               or json.loads(latest[2])["kind"] == "submission"):
        raise ArchiveFailure("archive_identity_conflict")
    cursor = db.execute("""INSERT INTO entries
        (conversation_id,record_id,content_sha256,observed_at_utc,record)
        VALUES (?,?,?,?,?)""", (identity, record["recordId"], payload["contentSha256"],
        payload["observedAtUtc"], encoded(record)))
    return {"conversationId": identity, "sequence": cursor.lastrowid,
            "replay": False, "contentSha256": payload["contentSha256"]}


def read_page(db, payload):
    identity = check_scope(db, payload)
    current = db.execute("SELECT COALESCE(MAX(sequence),0) FROM entries WHERE conversation_id=?",
                         (identity,)).fetchone()[0]
    revision = payload["revision"] if payload["revision"] is not None else current
    if revision > current or revision < 0 or payload["after"] > revision:
        raise ArchiveFailure("archive_invalid_cursor")
    rows = db.execute("""WITH versions AS (
        SELECT record_id, MIN(sequence) AS first_sequence, MAX(sequence) AS latest
        FROM entries WHERE conversation_id=? AND sequence<=? GROUP BY record_id)
        SELECT versions.first_sequence, entries.sequence, entries.content_sha256,
               entries.observed_at_utc, entries.record
        FROM versions JOIN entries ON entries.sequence=versions.latest
        WHERE versions.first_sequence>? ORDER BY versions.first_sequence LIMIT ?""",
        (identity, revision, payload["after"], payload["limit"] + 1)).fetchall()
    items = []
    size = 0
    for row in rows[:payload["limit"]]:
        item = {"firstSequence": row[0], "sequence": row[1], "contentSha256": row[2],
                "observedAtUtc": row[3], "record": json.loads(row[4])}
        item_size = len(encoded(item).encode("utf-8"))
        if items and size + item_size > 524288:
            break
        items.append(item)
        size += item_size
    return {"revision": revision, "items": items,
            "nextAfter": items[-1]["firstSequence"] if len(rows) > len(items) else None}


def import_state(db, payload):
    identity = check_scope(db, payload)
    row = db.execute("SELECT revision,cursor,exhausted FROM import_checkpoints WHERE conversation_id=?",
                     (identity,)).fetchone()
    return {"revision": row[0], "cursor": row[1], "exhausted": bool(row[2])} if row else {
        "revision": 0, "cursor": None, "exhausted": False}


def checkpoint_import(db, payload):
    current = import_state(db, payload)
    if current["revision"] != payload["expectedRevision"]:
        return False
    identity = check_scope(db, payload, create=True)
    db.execute("""INSERT INTO import_checkpoints VALUES (?,?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET
        revision=excluded.revision,cursor=excluded.cursor,exhausted=excluded.exhausted""",
        (identity, current["revision"] + 1, payload["nextCursor"], payload["nextCursor"] is None))
    return True


COMMANDS = ("init", "append", "read", "import-state", "checkpoint-import")
MAX_PAYLOAD_BYTES = 2097152


def run(database, command, payload):
    """One command in its own connection and transaction; an error rolls it back."""
    if command not in COMMANDS or not isinstance(payload, dict):
        raise ArchiveFailure("archive_invalid_input")
    db = sqlite3.connect(database, timeout=10)
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("BEGIN" if command in ("read", "import-state") else "BEGIN IMMEDIATE")
        try:
            if command == "init":
                initialize(db, payload["projectId"])
                result = {"schemaVersion": 1, "ready": True}
            else:
                if db.execute("PRAGMA user_version").fetchone()[0] != 2:
                    raise ArchiveFailure("archive_unsupported_schema")
                if db.execute("SELECT project_id FROM archive_meta").fetchone()[0] != payload["projectId"]:
                    raise ArchiveFailure("archive_identity_conflict")
                operation = {"append": append, "read": read_page,
                             "import-state": import_state, "checkpoint-import": checkpoint_import}[command]
                result = operation(db, payload)
        except BaseException:
            db.rollback()
            raise
        db.commit()
        return result
    finally:
        db.close()


def error_code(error):
    return str(error) if isinstance(error, ArchiveFailure) else "archive_unavailable"


def serve(database):
    """A long-lived bridge: a JSON request per line on stdin, a JSON answer per line on stdout."""
    while True:
        line = sys.stdin.buffer.readline(MAX_PAYLOAD_BYTES + 4097)
        if not line:
            return
        ident = None
        try:
            if len(line) > MAX_PAYLOAD_BYTES + 4096:
                raise ArchiveFailure("archive_invalid_input")
            request = json.loads(line)
            ident = request.get("id") if isinstance(request, dict) else None
            if not isinstance(request, dict) or not isinstance(ident, int):
                raise ArchiveFailure("archive_invalid_input")
            answer = {"id": ident, "ok": True, "result": run(database, request.get("command"), request.get("payload", {}))}
        except Exception as error:
            answer = {"id": ident, "ok": False, "error": error_code(error)}
        sys.stdout.write(encoded(answer) + "\n")
        sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("command", nargs="?", choices=COMMANDS)
    args = parser.parse_args()
    if args.serve:
        serve(args.database)
        return
    if args.command is None:
        raise ArchiveFailure("archive_invalid_input")
    raw = sys.stdin.buffer.read(MAX_PAYLOAD_BYTES + 1)
    if len(raw) > MAX_PAYLOAD_BYTES:
        raise ArchiveFailure("archive_invalid_input")
    result = run(args.database, args.command, json.loads(raw))
    print(encoded({"ok": True, "result": result}))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as error:
        print(encoded({"error": error_code(error)}), file=sys.stderr)
        sys.exit(1)
