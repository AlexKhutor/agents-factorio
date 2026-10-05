import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PersistentSqliteBridge } from "../src/sqlite-bridge-server.mjs";

// A stand-in bridge script with the `--serve` protocol: "echo" answers,
// "fail" answers with an error code, "hang" never answers, "die" exits.
const SCRIPT = `
import json, sys, time
for line in sys.stdin:
    request = json.loads(line)
    command = request["command"]
    if command == "hang":
        time.sleep(30)
    if command == "die":
        sys.exit(3)
    answer = {"id": request["id"], "ok": command != "fail"}
    if command == "fail":
        answer["error"] = "memory_revision_conflict"
    else:
        answer["result"] = {"echo": request["payload"], "pid": __import__("os").getpid()}
    sys.stdout.write(json.dumps(answer) + "\\n")
    sys.stdout.flush()
`;

test("one bridge process answers in order, keeps error codes, and comes back after a hang or a crash", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "sqlite-bridge-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const script = path.join(folder, "bridge.py");
  await writeFile(script, SCRIPT, "utf8");
  const bridge = new PersistentSqliteBridge({ databasePath: path.join(folder, "db.sqlite"), bridgePath: script,
    timeoutMs: 1500, unavailableCode: "memory_unavailable" });
  t.after(() => bridge.close());

  const [first, second] = await Promise.all([bridge.invoke("echo", { n: 1 }), bridge.invoke("echo", { n: 2 })]);
  assert.deepEqual([first.echo.n, second.echo.n], [1, 2]);
  assert.equal(first.pid, second.pid, "the same process answers both");

  await assert.rejects(bridge.invoke("fail"), (error) => error.code === "CONTROL_STORE_BRIDGE_FAILED"
    && JSON.parse(error.stderr).error === "memory_revision_conflict");

  await assert.rejects(bridge.invoke("hang"), (error) => JSON.parse(error.stderr).error === "memory_unavailable");
  const afterHang = await bridge.invoke("echo", { n: 3 });
  assert.notEqual(afterHang.pid, first.pid, "a fresh process after the hang");

  await assert.rejects(bridge.invoke("die"), (error) => JSON.parse(error.stderr).error === "memory_unavailable");
  const afterCrash = await bridge.invoke("echo", { n: 4 });
  assert.equal(afterCrash.echo.n, 4);

  await bridge.close();
  await assert.rejects(bridge.invoke("echo"), (error) => JSON.parse(error.stderr).error === "memory_unavailable");
});
