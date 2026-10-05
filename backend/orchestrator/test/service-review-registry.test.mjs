import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadConfiguration } from "../src/control-cli.mjs";
import { SerializedControlCycle } from "../src/control-cycle.mjs";
import { FakeReviewProvider } from "../src/control-review-provider.mjs";
import { ServiceReviewRegistry } from "../src/service-review-registry.mjs";
import { SqliteControlStore } from "../src/sqlite-control-store.mjs";

async function fixture(t, prefix = "service-review-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

function report(taskId) {
  return {
    sourceId: "worker-one",
    taskId,
    reportId: `${taskId}-report`,
    title: taskId,
    reportStatus: "completed",
    reportSha256: "a".repeat(64),
    taskSha256: "b".repeat(64),
    sourceRevision: "local-test-revision",
    reportPath: `knowledge/reports/${taskId}.md`,
    taskPath: `coordination/tasks/${taskId}.json`,
    decisionPath: `coordination/reviews/${taskId}/decision.json`,
    priority: 0,
    dispatchSequence: 0,
    dependencies: [],
    plan: [{ id: "review", title: "Review report", state: "pending" }],
    summary: "Waiting for review",
  };
}

test("reviewer configuration rejects the interactive CODEX_HOME", async (t) => {
  const root = await fixture(t, "service-review-config-");
  const configPath = path.join(root, "control-cycle.json");
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    controllerRoot: root,
    interactiveCodexHome: ".project-runtime/codex-home",
    provider: {
      type: "codex-app-server",
      codexHome: ".project-runtime/codex-home",
    },
  }, null, 2)}\n`, "utf8");
  await assert.rejects(loadConfiguration(configPath), /must differ from the interactive controller CODEX_HOME/);
});

test("real reviewer configuration requires an explicit project-local CODEX_HOME", async (t) => {
  const root = await fixture(t, "service-review-config-required-");
  const missingPath = path.join(root, "missing-home.json");
  await writeFile(missingPath, `${JSON.stringify({
    schemaVersion: 1,
    controllerRoot: root,
    provider: { type: "codex-app-server" },
  }, null, 2)}\n`, "utf8");
  await assert.rejects(loadConfiguration(missingPath), /requires an explicit isolated provider\.codexHome/);

  const escapingPath = path.join(root, "escaping-home.json");
  await writeFile(escapingPath, `${JSON.stringify({
    schemaVersion: 1,
    controllerRoot: root,
    provider: { type: "codex-app-server", codexHome: "../shared-codex-home" },
  }, null, 2)}\n`, "utf8");
  await assert.rejects(loadConfiguration(escapingPath), /must stay inside the controller workspace/);
});

test("reviewer configuration replaces a stale extension executable before queue claim", async (t) => {
  const root = await fixture(t, "service-review-command-migration-");
  const executablePath = path.join(
    root,
    ".project-runtime",
    "vscode-extensions",
    "openai.chatgpt-26.818.41705-win32-x64",
    "bin",
    "windows-x86_64",
    "codex.exe",
  );
  await mkdir(path.dirname(executablePath), { recursive: true });
  await writeFile(executablePath, "fixture", "utf8");
  const configPath = path.join(root, "control-cycle.json");
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    controllerRoot: root,
    interactiveCodexHome: ".project-runtime/codex-home",
    provider: {
      type: "codex-app-server",
      codexHome: ".project-runtime/reviewer-codex-home",
      command: path.join(
        root,
        ".project-runtime",
        "vscode-extensions",
        "openai.chatgpt-removed",
        "bin",
        "windows-x86_64",
        "codex.exe",
      ),
    },
  }, null, 2)}\n`, "utf8");

  const configuration = await loadConfiguration(configPath);
  assert.equal(configuration.provider.command, executablePath);
  assert.equal(configuration.provider.commandResolution, "project-local-discovery");
});

test("reviewer configuration fails before queue claim when no isolated executable exists", async (t) => {
  const root = await fixture(t, "service-review-command-missing-");
  const configPath = path.join(root, "control-cycle.json");
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    controllerRoot: root,
    interactiveCodexHome: ".project-runtime/codex-home",
    provider: {
      type: "codex-app-server",
      codexHome: ".project-runtime/reviewer-codex-home",
      command: path.join(root, ".project-runtime", "vscode-extensions", "removed", "codex.exe"),
    },
  }, null, 2)}\n`, "utf8");

  await assert.rejects(loadConfiguration(configPath), /unavailable before queue claim/);
});

test("model-free report operations do not require a reviewer executable", async (t) => {
  const root = await fixture(t, "model-free-report-config-");
  const configPath = path.join(root, "control-cycle.json");
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    controllerRoot: root,
    interactiveCodexHome: ".project-runtime/codex-home",
    provider: {
      type: "codex-app-server",
      codexHome: ".project-runtime/reviewer-codex-home",
      command: path.join(root, "missing", "codex.exe"),
    },
  }, null, 2)}\n`, "utf8");
  const configuration = await loadConfiguration(configPath, { requireProvider: false });
  assert.equal(configuration.provider.commandResolution, "not-required");
  assert.match(configuration.provider.command, /missing[\\/]codex\.exe$/);
});

test("service review registry locates and hashes one provider rollout", async (t) => {
  const root = await fixture(t, "service-review-rollout-");
  const codexHome = path.join(root, ".project-runtime", "reviewer-codex-home");
  const sessions = path.join(codexHome, "sessions", "2026", "08", "17");
  await mkdir(sessions, { recursive: true });
  const threadId = "019c1234-1111-7222-8333-123456789abc";
  const rolloutPath = path.join(sessions, `rollout-2026-08-17T12-00-00-${threadId}.jsonl`);
  const rolloutText = [
    JSON.stringify({ type: "session_meta", payload: {
      id: threadId,
      timestamp: "2026-08-17T12:00:00.000Z",
      cli_version: "0.147.0",
      model_provider: "openai",
    } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    "",
  ].join("\n");
  await writeFile(rolloutPath, rolloutText, "utf8");
  const registry = new ServiceReviewRegistry({
    indexPath: path.join(root, ".project-local", "orchestration", "service-review-index.v1.json"),
    codexHome,
  });
  await registry.initialize();
  const rawTrace = await registry.locateRawTrace(threadId, { attempts: 1 });
  assert.equal(rawTrace.available, true);
  assert.equal(rawTrace.locator, `sessions/2026/08/17/${path.basename(rolloutPath)}`);
  assert.equal(rawTrace.cliVersion, "0.147.0");
  assert.equal(rawTrace.sha256, createHash("sha256").update(rolloutText).digest("hex"));
});

test("serialized review publishes only a bounded diagnostic projection", async (t) => {
  const root = await fixture(t, "service-review-cycle-");
  const store = new SqliteControlStore({ databasePath: path.join(root, "control.db") });
  const registry = new ServiceReviewRegistry({
    indexPath: path.join(root, ".project-local", "orchestration", "service-review-index.v1.json"),
    codexHome: path.join(root, ".project-runtime", "reviewer-codex-home"),
  });
  const cycle = new SerializedControlCycle({
    store,
    provider: new FakeReviewProvider({ delayMs: 5 }),
    controllerRoot: root,
    projectionPath: path.join(root, "projection.json"),
    executionSummaryRoot: path.join(root, "summaries"),
    serviceReviewRegistry: registry,
    decisionValidator: async (item) => ({
      decision: {
        schemaVersion: 1,
        taskId: item.taskId,
        sourceId: item.sourceId,
        reportSha256: item.reportSha256,
        outcome: "accepted",
        summary: "Accepted from bounded diagnostic test",
        acceptanceChecks: [{ criterion: "test", status: "passed", evidence: "fixture" }],
        risks: ["One bounded risk"],
        requiredFollowUps: [],
        humanApprovalRequired: false,
        decisionDocument: null,
        decidedAtUtc: new Date().toISOString(),
      },
      decisionPath: path.join(root, "unused.json"),
      decisionReference: item.decisionPath,
      decisionSha256: "c".repeat(64),
    }),
  });
  await cycle.initialize();
  await cycle.enqueueReports([report("diagnostic-review")]);
  const result = await cycle.runOnce();
  const projected = result.projection.tasks.find((task) => task.taskId === "diagnostic-review");
  assert.equal(projected.diagnostics.status, "completed");
  assert.equal(projected.diagnostics.summary, "Accepted from bounded diagnostic test");
  assert.deepEqual(projected.diagnostics.problems, ["One bounded risk"]);
  assert.equal(projected.diagnostics.rawTraceAvailable, false);
  assert.equal(Object.hasOwn(projected.diagnostics, "threadId"), false);
  assert.equal(Object.hasOwn(projected.diagnostics, "rawTrace"), false);
  const projectedReviewAgents = result.projection.agents.filter((agent) => agent.taskId === "diagnostic-review");
  assert.ok(projectedReviewAgents.length > 0);
  for (const agent of projectedReviewAgents) {
    assert.deepEqual(agent.externalReferences, { threadId: null, turnId: null });
  }

  const records = await registry.list({ taskId: "diagnostic-review" });
  assert.equal(records.length, 1);
  assert.equal(records[0].threadId, "fake-thread-diagnostic-review");
  assert.equal(records[0].decision.sha256, "c".repeat(64));
  const persisted = JSON.parse(await readFile(registry.indexPath, "utf8"));
  assert.equal(persisted.records.length, 1);
});
