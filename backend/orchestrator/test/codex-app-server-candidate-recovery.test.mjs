import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import {
  reconcileCodexAppServerTurnStart,
} from "../src/codex-app-server-turn-start-reconciliation.mjs";

const FIXTURE = fileURLToPath(new URL(
  "./fixtures/fake-recovery-app-server.mjs", import.meta.url,
));
const THREAD_ID = "thread-candidate-recovery";
const CLIENT_MESSAGE_ID = "request-candidate-recovery";

function createClient(root, statePath) {
  return new CodexAppServerClient({
    command: process.execPath,
    args: [FIXTURE, statePath],
    cwd: root,
    requestTimeoutMs: 2_000,
    clientVersion: "candidate-recovery-test",
  });
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

test("candidate reconnect reaches useful data and reconciles one accepted mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "app-server-candidate-recovery-"));
  const statePath = path.join(root, "provider-state.json");
  await writeFile(statePath, `${JSON.stringify({
    threadId: THREAD_ID,
    updatedAt: "2026-09-03T00:00:00.000Z",
    turns: [],
    mutationCount: 0,
    dropFirstResponse: true,
  })}\n`, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  const writer = createClient(root, statePath);
  await writer.connect();
  const exited = once(writer, "exit");
  await assert.rejects(
    writer.startTurn(THREAD_ID, [{ type: "text", text: "private fixture body" }], {
      clientUserMessageId: CLIENT_MESSAGE_ID,
    }),
    (error) => error.code === "RPC_PROCESS_EXITED",
  );
  const [exit] = await exited;
  assert.equal(exit.code, 23);
  await writer.close();

  const restartStarted = performance.now();
  const reader = createClient(root, statePath);
  await reader.connect();
  const readyAt = performance.now();
  const catalog = await reader.listModels({ limit: 100, includeHidden: false });
  const firstUsefulAt = performance.now();
  assert.equal(catalog.data.length, 1);

  const reconciled = await reconcileCodexAppServerTurnStart({
    client: reader,
    requestId: CLIENT_MESSAGE_ID,
    threadId: THREAD_ID,
  });
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(reconciled.status, "matched");
  assert.equal(reconciled.turnId, "turn-recovery-1");
  assert.equal(reconciled.repeatsProviderAction, false);
  assert.equal(state.mutationCount, 1);
  assert.equal(state.turns.length, 1);
  assert.equal(JSON.stringify(reconciled).includes("private fixture body"), false);

  const metrics = {
    restartToFirstUsefulDataMs: rounded(firstUsefulAt - restartStarted),
    readyToFirstUsefulDataMs: rounded(firstUsefulAt - readyAt),
  };
  assert.ok(metrics.restartToFirstUsefulDataMs >= metrics.readyToFirstUsefulDataMs);
  assert.ok(metrics.readyToFirstUsefulDataMs >= 0);
  await reader.close();
  t.diagnostic(JSON.stringify({
    evidence: "a11-candidate-app-server-recovery",
    firstUsefulData: "model/list",
    mutationInvocations: state.mutationCount,
    reconciliation: reconciled.status,
    metrics,
  }));
});
