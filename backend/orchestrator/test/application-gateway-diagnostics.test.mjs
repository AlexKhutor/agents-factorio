import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gatewayFailureDiagnostic, persistGatewayFailureDiagnostic, captureGatewayFileFacts,
  persistGatewayAgentReadDiagnostic } from "../src/application-gateway-diagnostics.mjs";

test("failure file facts distinguish missing, file and directory without content or paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-file-facts-"));
  const file = path.join(root, "private-name");
  await writeFile(file, "private-body");
  const facts = await captureGatewayFileFacts(file, path.join(root, "absent"));
  assert.equal(facts.target.kind, "file");
  assert.equal(facts.temporary.code, "ENOENT");
  assert.equal(facts.parent.kind, "directory");
  assert.equal(typeof facts.target.mode, "number");
  assert.doesNotMatch(JSON.stringify(facts), /private|gateway-file-facts/);
});
import { ApplicationGatewayServer } from "../src/application-gateway-server.mjs";

test("heartbeat EPERM emits evidence but still terminalizes and removes descriptor", async () => {
  let writes = 0;
  let removed = false;
  const diagnostics = [];
  let finish;
  const terminal = new Promise((resolve) => { finish = resolve; });
  const server = new ApplicationGatewayServer({
    instanceId: "11111111-1111-4111-8111-111111111111",
    workspace: { projectId: "fixture", sourceId: "orchestrator-development", workspaceRootSha256: "a".repeat(64) },
    process: { processId: process.pid, startedAtUtc: new Date().toISOString(), executableSha256: "b".repeat(64) },
    descriptorStore: { publish: async () => {}, remove: async () => { removed = true; } },
    invokeApplication: async () => {}, readEvents: async () => {},
    heartbeatIntervalMs: 1000,
    writeStatus: async (value) => {
      if (value.terminal) { finish(); return; }
      if (++writes > 1) throw Object.assign(new Error("private"), {
        code: "EPERM", syscall: "rename", runtimeStage: "rename",
      });
    },
    writeDiagnostic: async (record) => { diagnostics.push(record); throw new Error("sink unavailable"); },
  });
  await server.start();
  let timer;
  try {
    await Promise.race([terminal, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("terminal timeout")), 4000);
    })]);
    assert.equal(server.status.lifecycle, "uncertain");
    assert.equal(server.status.failure.reasonCode, "observability_lost");
    assert.equal(removed, true);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].syscall, "rename");
  } finally {
    clearTimeout(timer);
    if (!server.status.terminal) await server.stop("fixture-cleanup");
  }
});

test("failure projection retains bounded phase/identity, never raw OS paths or messages", () => {
  const record = gatewayFailureDiagnostic({
    code: "EPERM", errno: -4048, syscall: "rename", runtimeStage: "rename", renameAttempts: 3,
    message: "secret",
    path: "private-path", dest: "private-dest", stack: "private-stack",
  }, { identity: { instanceId: "11111111-1111-4111-8111-111111111111",
    generation: 12, process: { processId: 42 } }, heartbeatAtUtc: "2026-09-22T14:58:49.545Z" },
  "2026-09-22T14:58:49.546Z");
  assert.equal(record.causeCode, "EPERM");
  assert.equal(record.errno, -4048);
  assert.equal(typeof record.runtime.osRelease, "string");
  assert.equal(record.runtimeStage, "rename");
  assert.equal(record.renameAttempts, 3);
  assert.equal(record.syscall, "rename");
  assert.equal(record.generation, 12);
  assert.equal(record.failedAtUtc, "2026-09-22T14:58:49.546Z");
  assert.doesNotMatch(JSON.stringify(record), /secret|private/);
  const unknown = gatewayFailureDiagnostic({ code: "secret", syscall: "secret", runtimeStage: "secret" },
    { identity: { instanceId: record.instanceId, generation: 12, process: { processId: 42 } } },
    record.failedAtUtc);
  assert.equal(unknown.causeCode, "unclassified");
  assert.equal(unknown.syscall, null);
  assert.equal(unknown.runtimeStage, null);
});

test("first failure survives repeat publication in an instance-specific non-rotating file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-failure-diagnostic-"));
  const record = { instanceId: "11111111-1111-4111-8111-111111111111", causeCode: "EPERM" };
  await persistGatewayFailureDiagnostic(root, record);
  await persistGatewayFailureDiagnostic(root, { ...record, causeCode: "EIO" });
  const names = await readdir(root);
  assert.deepEqual(names, [record.instanceId + ".failure.json"]);
  assert.equal(JSON.parse(await readFile(path.join(root, names[0]), "utf8")).causeCode, "EPERM");
  await assert.rejects(persistGatewayFailureDiagnostic(root, { instanceId: "../escape" }));
});

test("agent read failures preserve the first safe record separately from lifecycle evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-read-diagnostic-"));
  const instanceId = "11111111-1111-4111-8111-111111111111";
  const record = { schemaVersion: 1, component: "agent-conversation",
    operationId: "query.agent-conversation.read", phase: "provider-read",
    atUtc: "2026-09-23T09:40:00.000Z", reasonCode: "identity_mismatch",
    code: "source_unavailable", requestId: "req", correlationId: "corr",
    message: "private", stack: "private", content: "private" };
  await persistGatewayFailureDiagnostic(root, { instanceId, causeCode: "EPERM" });
  await persistGatewayAgentReadDiagnostic(root, instanceId, record);
  await persistGatewayAgentReadDiagnostic(root, instanceId, { ...record, reasonCode: "conflict" });
  const saved = JSON.parse(await readFile(path.join(root, instanceId + ".agent-read.failure.json"), "utf8"));
  assert.equal(saved.reasonCode, "identity_mismatch"); assert.equal(saved.requestId, "req");
  assert.doesNotMatch(JSON.stringify(saved), /private|stack|content/);
  assert.equal((await readdir(root)).length, 2);
  await assert.rejects(persistGatewayAgentReadDiagnostic(root, "../escape", record));
  await assert.rejects(persistGatewayAgentReadDiagnostic(root, instanceId, { ...record, phase: "private" }));
  await persistGatewayAgentReadDiagnostic(root, instanceId, { ...record, component: "project-workspace",
    operationId: "query.project-workspace.read", phase: "resource-read", reasonCode: "access_denied" });
  const resource = JSON.parse(await readFile(path.join(root, instanceId + ".project-workspace.failure.json"), "utf8"));
  assert.equal(resource.component, "project-workspace");
  assert.doesNotMatch(JSON.stringify(resource), /private|stack|content/);
  await assert.rejects(persistGatewayAgentReadDiagnostic(root, instanceId, { ...record, component: "../escape" }));
});
