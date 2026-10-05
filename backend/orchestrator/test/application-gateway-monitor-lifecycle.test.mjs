import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApplicationGatewayLifecycle } from "../src/application-gateway-lifecycle.mjs";
import { ApplicationGatewayRuntimeFiles } from "../src/application-gateway-runtime.mjs";

test("fixture terminal Gateway closes its exact monitor and retains the transition log", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-monitor-terminal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new ApplicationGatewayRuntimeFiles({ repoRoot: root });
  const base = Date.now() - 5_000;
  const lifecycle = new ApplicationGatewayLifecycle({
    instanceId: "22222222-2222-4222-8222-222222222222",
    workspace: { projectId: "isolateVsCode", sourceId: "orchestrator-development",
      workspaceRootSha256: "1".repeat(64) },
    process: { processId: process.pid, startedAtUtc: new Date(base).toISOString(),
      executableSha256: "2".repeat(64) },
  });
  await files.writeStatus(lifecycle.markReady(new Date(base + 1000).toISOString()));
  const monitorId = "11111111-1111-4111-8111-111111111111";
  const cli = fileURLToPath(new URL("../src/application-gateway-cli.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, "watch", "--repo-root", root,
    "--project-id", "isolateVsCode", "--monitor-id", monitorId,
    "--refresh-ms", "250"], { stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  child.stderr?.on("data", (data) => chunks.push(data));
  await new Promise((resolve) => setTimeout(resolve, 350));
  lifecycle.requestStop("fixture-stop", new Date().toISOString());
  await files.writeStatus(lifecycle.markStopped(new Date(Date.now() + 1).toISOString()));
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill(); reject(new Error("fixture monitor did not close after terminal status"));
    }, 1800);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exit, 0, Buffer.concat(chunks).toString("utf8"));
  assert.equal(await files.readMonitor(), null);
  const log = await files.readMonitorLog(monitorId);
  assert.equal(log.events.at(-1).health, "gateway-terminal");
  assert.equal(log.events.at(-1).lifecycle, "stopped");
});

test("new monitor stays open over a previous terminal generation while awaiting Start", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-monitor-previous-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new ApplicationGatewayRuntimeFiles({ repoRoot: root });
  const lifecycle = new ApplicationGatewayLifecycle({
    instanceId: "33333333-3333-4333-8333-333333333333",
    workspace: { projectId: "isolateVsCode", sourceId: "orchestrator-development",
      workspaceRootSha256: "1".repeat(64) },
    process: { processId: 4100, startedAtUtc: "2026-08-30T21:00:00.000Z",
      executableSha256: "2".repeat(64) },
  });
  lifecycle.markReady("2026-08-30T21:00:01.000Z");
  lifecycle.requestStop("old-stop", "2026-08-30T21:00:02.000Z");
  await files.writeStatus(lifecycle.markStopped("2026-08-30T21:00:03.000Z"));
  const monitorId = "44444444-4444-4444-8444-444444444444";
  const cli = fileURLToPath(new URL("../src/application-gateway-cli.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, "watch", "--repo-root", root,
    "--project-id", "isolateVsCode", "--monitor-id", monitorId,
    "--refresh-ms", "250"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(child.exitCode, null, "previous terminal generation must not close a new monitor");
  assert.equal((await files.readMonitor())?.monitorId, monitorId);
});
