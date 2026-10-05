import argparse
import hashlib
import json
import sqlite3
import sys


class MemoryFailure(Exception):
    pass


TABLES = {
    "memory_scopes", "memory_revisions", "memory_operations",
    "memory_write_grants", "memory_documents",
}
# Version 2 adds the agent scope: an agent's own memory, beside the project
# and the quarter it belongs to.
SCHEMA_VERSION = 2

SCOPES_TABLE = """CREATE TABLE {name} (
        scope_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('project','quarter','agent')),
        project_id TEXT NOT NULL,
        quarter_id TEXT,
        title TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
        CHECK ((kind='project' AND quarter_id IS NULL)
            OR (kind IN ('quarter','agent') AND quarter_id IS NOT NULL)))"""


def fail(code):
    raise MemoryFailure(code)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def value_sha256(value):
    return hashlib.sha256(encoded(value).encode("utf-8")).hexdigest()


def decoded_stored(value):
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        fail("memory_identity_conflict")


def present_tables(db):
    return {
        row[0] for row in db.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }


def scope_indexes(db):
    db.execute("""CREATE UNIQUE INDEX one_project_memory_scope
        ON memory_scopes(project_id) WHERE kind='project'""")
    db.execute("""CREATE UNIQUE INDEX one_quarter_memory_scope
        ON memory_scopes(project_id,quarter_id) WHERE kind='quarter'""")


def migrate_v1(db):
    # SQLite cannot change a CHECK constraint in place: the scope table is
    # rebuilt with the same rows. Foreign keys are off for this connection
    # (see main), and are verified before the transaction commits.
    db.execute(SCOPES_TABLE.format(name="memory_scopes_v2"))
    db.execute(
        "INSERT INTO memory_scopes_v2 "
        "SELECT scope_id,kind,project_id,quarter_id,title,current_revision FROM memory_scopes"
    )
    db.execute("DROP TABLE memory_scopes")
    db.execute("ALTER TABLE memory_scopes_v2 RENAME TO memory_scopes")
    scope_indexes(db)
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        fail("memory_unsupported_schema")
    db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")


def initialize(db):
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version not in (0, 1, SCHEMA_VERSION):
        fail("memory_unsupported_schema")
    if version in (1, SCHEMA_VERSION):
        if present_tables(db) != TABLES:
            fail("memory_unsupported_schema")
        if version == 1:
            migrate_v1(db)
        return
    existing = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchone()
    if existing is not None:
        fail("memory_unsupported_schema")
    db.execute(SCOPES_TABLE.format(name="memory_scopes"))
    scope_indexes(db)
    db.execute("""CREATE TABLE memory_revisions (
        scope_id TEXT NOT NULL REFERENCES memory_scopes(scope_id),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        content_sha256 TEXT NOT NULL,
        entries_json TEXT NOT NULL,
        author TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        PRIMARY KEY (scope_id,revision))""")
    db.execute("""CREATE TABLE memory_operations (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create','write')),
        request_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL)""")
    db.execute("""CREATE TABLE memory_write_grants (
        command_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL REFERENCES memory_scopes(scope_id),
        expected_revision INTEGER NOT NULL,
        content_sha256 TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        authorized_at_utc TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL,
        consumed_operation_id TEXT UNIQUE,
        consumed_at_utc TEXT)""")
    db.execute("""CREATE TABLE memory_documents (
        key TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        value_json TEXT NOT NULL)""")
    db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")


def verify_hash(payload, fields):
    expected = value_sha256({field: payload[field] for field in fields})
    if payload.get("requestSha256") != expected:
        fail("memory_invalid_input")


def operation_replay(db, operation_id, kind, request_sha256):
    row = db.execute(
        "SELECT operation_kind,request_sha256,result_json FROM memory_operations WHERE operation_id=?",
        (operation_id,),
    ).fetchone()
    if row is None:
        return None
    if row[0] != kind or row[1] != request_sha256:
        fail("memory_operation_conflict")
    return decoded_stored(row[2])


def scope_record(db, scope_id):
    row = db.execute(
        "SELECT scope_id,kind,project_id,quarter_id,title,current_revision "
        "FROM memory_scopes WHERE scope_id=?",
        (scope_id,),
    ).fetchone()
    if row is None:
        fail("memory_scope_not_found")
    return row


def scope_dto(db, scope, requested_revision=None):
    selected = scope[5] if requested_revision is None else requested_revision
    row = db.execute(
        "SELECT content_sha256,entries_json,author,updated_at_utc "
        "FROM memory_revisions WHERE scope_id=? AND revision=?",
        (scope[0], selected),
    ).fetchone()
    if row is None:
        fail("memory_revision_not_found")
    entries = decoded_stored(row[1])
    if value_sha256(entries) != row[0]:
        fail("memory_identity_conflict")
    return {
        "schemaVersion": 1,
        "scopeId": scope[0],
        "kind": scope[1],
        "projectId": scope[2],
        "quarterId": scope[3],
        "title": scope[4],
        "revision": selected,
        "sha256": row[0],
        "entries": entries,
        "author": row[2],
        "updatedAtUtc": row[3],
    }


def scope_metadata(dto):
    return {key: value for key, value in dto.items() if key != "entries"}


def create_scope(db, payload):
    fields = ("scopeId", "kind", "projectId", "quarterId", "title", "operationId")
    verify_hash(payload, fields)
    replay = operation_replay(
        db, payload["operationId"], "create", payload["requestSha256"]
    )
    if replay is not None:
        return replay
    if payload["contentSha256"] != value_sha256([]):
        fail("memory_invalid_input")
    if db.execute(
        "SELECT 1 FROM memory_scopes WHERE scope_id=?", (payload["scopeId"],)
    ).fetchone() is not None:
        fail("memory_scope_conflict")
    if payload["kind"] == "project":
        logical = db.execute(
            "SELECT 1 FROM memory_scopes WHERE kind='project' AND project_id=?",
            (payload["projectId"],),
        ).fetchone()
    elif payload["kind"] == "agent":
        # An agent's memory belongs to an existing quarter; its own identity is
        # the scope ID, which the service derives from the agent ID.
        if db.execute(
            "SELECT 1 FROM memory_scopes "
            "WHERE kind='quarter' AND project_id=? AND quarter_id=?",
            (payload["projectId"], payload["quarterId"]),
        ).fetchone() is None:
            fail("memory_scope_not_found")
        logical = None
    else:
        parent = db.execute(
            "SELECT 1 FROM memory_scopes WHERE kind='project' AND project_id=?",
            (payload["projectId"],),
        ).fetchone()
        if parent is None:
            fail("memory_project_scope_required")
        logical = db.execute(
            "SELECT 1 FROM memory_scopes "
            "WHERE kind='quarter' AND project_id=? AND quarter_id=?",
            (payload["projectId"], payload["quarterId"]),
        ).fetchone()
    if logical is not None:
        fail("memory_scope_conflict")
    try:
        db.execute(
            "INSERT INTO memory_scopes VALUES (?,?,?,?,?,1)",
            (
                payload["scopeId"], payload["kind"], payload["projectId"],
                payload["quarterId"], payload["title"],
            ),
        )
        db.execute(
            "INSERT INTO memory_revisions VALUES (?,?,?,?,?,?)",
            (
                payload["scopeId"], 1, payload["contentSha256"], encoded([]),
                "system", payload["updatedAtUtc"],
            ),
        )
    except sqlite3.IntegrityError:
        fail("memory_scope_conflict")
    result = scope_dto(db, scope_record(db, payload["scopeId"]))
    db.execute(
        "INSERT INTO memory_operations VALUES (?,?,?,?)",
        (payload["operationId"], "create", payload["requestSha256"], encoded(result)),
    )
    return result


def copy_project(db, payload):
    fields = ("sourceProjectId", "targetProjectId", "targetProjectScopeId",
              "quarterScopeIds", "operationId")
    verify_hash(payload, fields)
    if payload["sourceProjectId"] == payload["targetProjectId"]:
        fail("memory_invalid_input")
    replay = operation_replay(
        db, payload["operationId"], "create", payload["requestSha256"]
    )
    if replay is not None:
        return replay
    rows = db.execute(
        "SELECT scope_id,kind,project_id,quarter_id,title,current_revision "
        "FROM memory_scopes WHERE project_id=? AND kind IN ('project','quarter') ORDER BY "
        "CASE kind WHEN 'project' THEN 0 ELSE 1 END, quarter_id,scope_id LIMIT 513",
        (payload["sourceProjectId"],),
    ).fetchall()
    if not rows or rows[0][1] != "project":
        fail("memory_project_scope_required")
    if len(rows) > 512 or len([row for row in rows if row[1] == "project"]) != 1:
        fail("memory_limit_exceeded")
    if db.execute("SELECT 1 FROM memory_scopes WHERE project_id=? LIMIT 1",
                  (payload["targetProjectId"],)).fetchone() is not None:
        fail("memory_scope_conflict")
    expected_quarters = {row[3] for row in rows if row[1] == "quarter"}
    if set(payload["quarterScopeIds"]) != expected_quarters:
        fail("memory_invalid_input")
    targets = [payload["targetProjectScopeId"], *payload["quarterScopeIds"].values()]
    if len(set(targets)) != len(targets):
        fail("memory_invalid_input")
    for target in targets:
        if db.execute("SELECT 1 FROM memory_scopes WHERE scope_id=?", (target,)).fetchone():
            fail("memory_scope_conflict")
    copied = []
    for row in rows:
        source = scope_dto(db, row)
        target = (payload["targetProjectScopeId"] if row[1] == "project"
                  else payload["quarterScopeIds"][row[3]])
        db.execute("INSERT INTO memory_scopes VALUES (?,?,?,?,?,1)",
                   (target, row[1], payload["targetProjectId"], row[3], row[4]))
        db.execute("INSERT INTO memory_revisions VALUES (?,?,?,?,?,?)",
                   (target, 1, source["sha256"], encoded(source["entries"]),
                    "system", payload["copiedAtUtc"]))
        copied.append({
            "sourceScopeId": row[0], "targetScopeId": target,
            "kind": row[1], "quarterId": row[3],
            "sourceRevision": source["revision"], "sourceSha256": source["sha256"],
            "targetRevision": 1, "targetSha256": source["sha256"],
        })
    result = {"schemaVersion": 1, "outcome": "complete",
              "sourceProjectId": payload["sourceProjectId"],
              "targetProjectId": payload["targetProjectId"],
              "operationId": payload["operationId"], "scopes": copied,
              "copiedAtUtc": payload["copiedAtUtc"]}
    db.execute("INSERT INTO memory_operations VALUES (?,?,?,?)",
               (payload["operationId"], "create", payload["requestSha256"], encoded(result)))
    return result


def read_scope(db, payload):
    return scope_dto(db, scope_record(db, payload["scopeId"]), payload["revision"])


def list_scopes(db, payload):
    parameters = []
    # Agents' own memories are read through their agents, not listed here.
    where = "WHERE kind IN ('project','quarter')"
    if payload["projectId"] is not None:
        where += " AND project_id=?"
        parameters.append(payload["projectId"])
    parameters.append(payload["limit"] + 1)
    rows = db.execute(
        "SELECT scope_id,kind,project_id,quarter_id,title,current_revision "
        f"FROM memory_scopes {where} "
        "ORDER BY project_id, CASE kind WHEN 'project' THEN 0 ELSE 1 END, "
        "quarter_id, scope_id LIMIT ?",
        tuple(parameters),
    ).fetchall()
    visible = rows[: payload["limit"]]
    return {
        "schemaVersion": 1,
        "scopes": [scope_metadata(scope_dto(db, row)) for row in visible],
        "truncated": len(rows) > len(visible),
    }


def authorize_write(db, payload):
    fields = ("commandId", "scopeId", "expectedRevision", "contentSha256", "requestedBy")
    verify_hash(payload, fields)
    row = db.execute(
        "SELECT request_sha256,result_json FROM memory_write_grants WHERE command_id=?",
        (payload["commandId"],),
    ).fetchone()
    if row is not None:
        if row[0] != payload["requestSha256"]:
            fail("memory_command_conflict")
        return decoded_stored(row[1])
    scope = scope_record(db, payload["scopeId"])
    if scope[5] != payload["expectedRevision"]:
        fail("memory_revision_conflict")
    result = {
        "schemaVersion": 1,
        "commandId": payload["commandId"],
        "scopeId": payload["scopeId"],
        "expectedRevision": payload["expectedRevision"],
        "contentSha256": payload["contentSha256"],
        "requestedBy": payload["requestedBy"],
        "authorizedAtUtc": payload["authorizedAtUtc"],
    }
    db.execute(
        "INSERT INTO memory_write_grants "
        "(command_id,scope_id,expected_revision,content_sha256,requested_by,"
        "authorized_at_utc,request_sha256,result_json) VALUES (?,?,?,?,?,?,?,?)",
        (
            payload["commandId"], payload["scopeId"], payload["expectedRevision"],
            payload["contentSha256"], payload["requestedBy"], payload["authorizedAtUtc"],
            payload["requestSha256"], encoded(result),
        ),
    )
    return result


def write_scope(db, payload):
    fields = (
        "scopeId", "expectedRevision", "entries", "operationId", "commandId", "actorId",
    )
    verify_hash(payload, fields)
    if value_sha256(payload["entries"]) != payload["contentSha256"]:
        fail("memory_invalid_input")
    replay = operation_replay(
        db, payload["operationId"], "write", payload["requestSha256"]
    )
    if replay is not None:
        return replay
    grant = db.execute(
        "SELECT scope_id,expected_revision,content_sha256,consumed_operation_id "
        "FROM memory_write_grants WHERE command_id=?",
        (payload["commandId"],),
    ).fetchone()
    if grant is None:
        fail("memory_authorization_required")
    if (
        grant[0] != payload["scopeId"]
        or grant[1] != payload["expectedRevision"]
        or grant[2] != payload["contentSha256"]
    ):
        fail("memory_authorization_mismatch")
    if grant[3] is not None:
        fail("memory_authorization_consumed")
    scope = scope_record(db, payload["scopeId"])
    if scope[5] != payload["expectedRevision"]:
        fail("memory_revision_conflict")
    next_revision = payload["expectedRevision"] + 1
    try:
        db.execute(
            "INSERT INTO memory_revisions VALUES (?,?,?,?,?,?)",
            (
                payload["scopeId"], next_revision, payload["contentSha256"],
                encoded(payload["entries"]), payload["actorId"], payload["updatedAtUtc"],
            ),
        )
        updated = db.execute(
            "UPDATE memory_scopes SET current_revision=? "
            "WHERE scope_id=? AND current_revision=?",
            (next_revision, payload["scopeId"], payload["expectedRevision"]),
        )
        if updated.rowcount != 1:
            fail("memory_revision_conflict")
        consumed = db.execute(
            "UPDATE memory_write_grants SET consumed_operation_id=?,consumed_at_utc=? "
            "WHERE command_id=? AND consumed_operation_id IS NULL",
            (payload["operationId"], payload["updatedAtUtc"], payload["commandId"]),
        )
        if consumed.rowcount != 1:
            fail("memory_authorization_consumed")
    except sqlite3.IntegrityError:
        fail("memory_revision_conflict")
    result = {
        "schemaVersion": 1,
        "operationId": payload["operationId"],
        "commandId": payload["commandId"],
        "scopeId": payload["scopeId"],
        "previousRevision": payload["expectedRevision"],
        "revision": next_revision,
        "sha256": payload["contentSha256"],
        # actorId is attribution only; the consumed control grant is write authority.
        "author": payload["actorId"],
        "updatedAtUtc": payload["updatedAtUtc"],
    }
    db.execute(
        "INSERT INTO memory_operations VALUES (?,?,?,?)",
        (payload["operationId"], "write", payload["requestSha256"], encoded(result)),
    )
    return result


def read_pair(db, payload):
    project = db.execute(
        "SELECT scope_id,kind,project_id,quarter_id,title,current_revision "
        "FROM memory_scopes WHERE kind='project' AND project_id=?",
        (payload["projectId"],),
    ).fetchone()
    quarter = db.execute(
        "SELECT scope_id,kind,project_id,quarter_id,title,current_revision "
        "FROM memory_scopes WHERE kind='quarter' AND project_id=? AND quarter_id=?",
        (payload["projectId"], payload["quarterId"]),
    ).fetchone()
    if project is None or quarter is None:
        fail("memory_scope_not_found")
    return {"project": scope_dto(db, project), "quarter": scope_dto(db, quarter)}


def read_scope_set(db, payload):
    scope_ids = payload["scopeIds"]
    if not isinstance(scope_ids, list) or len(scope_ids) > 128:
        fail("memory_invalid_input")
    scopes = []
    for scope_id in scope_ids:
        row = db.execute(
            "SELECT scope_id,kind,project_id,quarter_id,title,current_revision "
            "FROM memory_scopes WHERE scope_id=?",
            (scope_id,),
        ).fetchone()
        if row is not None:
            scopes.append(scope_dto(db, row))
    return {"schemaVersion": 1, "scopes": scopes}


def read_document(db, payload):
    row = db.execute(
        "SELECT revision,value_json FROM memory_documents WHERE key=?", (payload["key"],)
    ).fetchone()
    if row is None:
        return None
    return {"revision": row[0], "value": decoded_stored(row[1])}


def compare_and_swap_document(db, payload):
    row = db.execute(
        "SELECT revision FROM memory_documents WHERE key=?", (payload["key"],)
    ).fetchone()
    current = 0 if row is None else row[0]
    if current != payload["expectedRevision"]:
        return False
    next_revision = current + 1
    serialized = encoded(payload["value"])
    if row is None:
        db.execute(
            "INSERT INTO memory_documents VALUES (?,?,?)",
            (payload["key"], next_revision, serialized),
        )
    else:
        updated = db.execute(
            "UPDATE memory_documents SET revision=?,value_json=? "
            "WHERE key=? AND revision=?",
            (next_revision, serialized, payload["key"], current),
        )
        if updated.rowcount != 1:
            return False
    return True


READ_COMMANDS = {"read-scope", "list-scopes", "read-pair", "read-scope-set", "read-document"}
OPERATIONS = {
    "create-scope": create_scope,
    "copy-project": copy_project,
    "read-scope": read_scope,
    "list-scopes": list_scopes,
    "authorize-write": authorize_write,
    "write": write_scope,
    "read-pair": read_pair,
    "read-scope-set": read_scope_set,
    "read-document": read_document,
    "compare-and-swap-document": compare_and_swap_document,
}


MAX_PAYLOAD_BYTES = 524288


def run(database, command, payload):
    """One command in its own connection and transaction; an error rolls it back."""
    if command not in ("init", *OPERATIONS.keys()):
        fail("memory_invalid_input")
    if not isinstance(payload, dict):
        fail("memory_invalid_input")
    db = sqlite3.connect(database, timeout=10, isolation_level=None)
    try:
        # Initialization may rebuild the scope table; it checks foreign keys itself.
        db.execute("PRAGMA foreign_keys=OFF" if command == "init" else "PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=10000")
        db.execute("PRAGMA synchronous=FULL")
        if command == "init":
            db.execute("PRAGMA journal_mode=WAL")
        db.execute("BEGIN" if command in READ_COMMANDS else "BEGIN IMMEDIATE")
        try:
            if command == "init":
                initialize(db)
                result = {"schemaVersion": 1, "ready": True}
            else:
                if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
                    fail("memory_unsupported_schema")
                result = OPERATIONS[command](db, payload)
        except BaseException:
            db.rollback()
            raise
        db.commit()
        return result
    finally:
        db.close()


def error_code(error):
    if isinstance(error, MemoryFailure):
        return str(error)
    if isinstance(error, (KeyError, TypeError, ValueError, json.JSONDecodeError)):
        return "memory_invalid_input"
    return "memory_unavailable"


def serve(database):
    """
    One long-lived bridge: a JSON request per line on stdin
    ({"id", "command", "payload"}), a JSON answer per line on stdout. Starting
    Python for every call cost the Gateway most of its read time on Windows.
    """
    while True:
        line = sys.stdin.buffer.readline(MAX_PAYLOAD_BYTES + 4097)
        if not line:
            return
        ident = None
        try:
            if len(line) > MAX_PAYLOAD_BYTES + 4096:
                fail("memory_limit_exceeded")
            request = json.loads(line)
            ident = request.get("id") if isinstance(request, dict) else None
            if not isinstance(request, dict) or not isinstance(ident, int):
                fail("memory_invalid_input")
            answer = {"id": ident, "ok": True, "result": run(database, request.get("command"), request.get("payload", {}))}
        except Exception as error:
            answer = {"id": ident, "ok": False, "error": error_code(error)}
        sys.stdout.write(encoded(answer) + "\n")
        sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("command", nargs="?", choices=("init", *OPERATIONS.keys()))
    args = parser.parse_args()
    if args.serve:
        serve(args.database)
        return
    if args.command is None:
        fail("memory_invalid_input")
    raw = sys.stdin.buffer.read(MAX_PAYLOAD_BYTES + 1)
    if len(raw) > MAX_PAYLOAD_BYTES:
        fail("memory_limit_exceeded")
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
