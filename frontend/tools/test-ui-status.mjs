// The UI pack's own status file: what an operator's status surface shows.
//
// The earlier way of watching the pack lost START, the current scene and EXIT:
// the state lived only in a shell chain started in the background, so the
// watcher saw nothing. The runner itself now writes its state to a file - run
// identity, command, source, phase, current scene and attempt, times and the
// final exit - and every write is atomic, so a reader never sees half a file.
// This suite checks that file without starting Electron.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunStatus } from "./ui-run-status.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const work = await mkdtemp(path.join(os.tmpdir(), "atlas-ui-status-"));
const file = path.join(work, "status.json");
const read = async () => JSON.parse(await readFile(file, "utf8"));
let clock = Date.parse("2026-09-25T10:00:00.000Z");
const now = () => new Date(clock);

const status = createRunStatus({
  file, runId: "ui-run-test", command: "npm run test:ui", source: { commit: "abc", projectVersion: "v0.0.0" },
  sceneNames: ["ui-a1", "ui-a2"], now,
});
status.prepare();
const ready = await read();
clock += 1000;
status.start();
const started = await read();
clock += 1000;
status.scene(0, "ui-a1", 1);
const first = await read();
clock += 5000;
status.heartbeat();
const beat = await read();
status.result("ui-a1", "passed");
status.scene(1, "ui-a2", 1);
status.result("ui-a2", "failed");
clock += 1000;
status.finish({ status: "failed", exitCode: 1 });
const done = await read();

check("ready-before-start-with-run-identity",
  ready.phase === "ready" && ready.runId === "ui-run-test" && ready.command === "npm run test:ui"
    && ready.source.commit === "abc" && ready.total === 2 && ready.startedAtUtc === null && ready.exitCode === null,
  ready);
check("start-and-current-scene-visible",
  started.phase === "running" && started.startedAtUtc === "2026-09-25T10:00:01.000Z"
    && first.current.name === "ui-a1" && first.current.index === 0 && first.current.attempt === 1
    && first.scenes[0].status === "running" && first.sequence > started.sequence,
  { started, first });
check("heartbeat-updates-freshness-and-elapsed-time",
  beat.updatedAtUtc === "2026-09-25T10:00:07.000Z" && beat.elapsedMs === 6000 && beat.sequence > first.sequence,
  beat);
check("result-exit-and-all-scenes",
  done.phase === "finished" && done.status === "failed" && done.exitCode === 1 && done.current === null
    && done.finishedAtUtc === "2026-09-25T10:00:08.000Z"
    && done.scenes.map((scene) => scene.status).join() === "passed,failed"
    && done.counts.passed === 1 && done.counts.failed === 1,
  done);

// The runner must write this file itself when asked, so that nothing depends
// on how the shell that started it passes variables around.
{
  const runner = await readFile(path.join(PROJECT_ROOT, "tools", "test-ui-scenes.mjs"), "utf8");
  check("runner-writes-status-itself",
    runner.includes("createRunStatus") && runner.includes("--status-file") && runner.includes(".finish(")
      && runner.includes(".heartbeat()"), null);
}

// The surface proves it is shown: each poll reports the page's visibility and
// focus, and the server keeps the latest polls for the operator to read.
{
  const { spawn } = await import("node:child_process");
  const port = 47000 + (process.pid % 900);
  const server = spawn(process.execPath, [path.join(PROJECT_ROOT, "tools", "ui-status-server.mjs"),
    "--status-file", file, "--port", String(port)], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => { server.stdout.once("data", resolve); setTimeout(resolve, 3000); });
  const base = `http://127.0.0.1:${port}`;
  let surface = null;
  try {
    await fetch(`${base}/status?page=p1&seq=1&visibility=hidden&focus=false`);
    await fetch(`${base}/status?page=p1&seq=2&visibility=visible&focus=true`);
    surface = await (await fetch(`${base}/surface`)).json();
  } catch (error) {
    surface = { error: String(error) };
  } finally {
    server.kill();
  }
  const last = surface?.polls?.[surface.polls.length - 1];
  check("surface-reports-visibility-and-focus",
    surface?.polls?.length === 2 && last.page === "p1" && last.seq === 2 && last.visibility === "visible"
      && last.focus === true && typeof last.atUtc === "string" && surface.polls[0].visibility === "hidden",
    surface);
}

await rm(work, { recursive: true, force: true });
const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "ui-status",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
