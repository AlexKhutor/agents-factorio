// Regression pack A1-A19: the real window, preload and renderer on the fixture.
//
// Each scene is one of the fixed CAPTURE_SCENES in src/host/main.mjs. It waits
// for the world to be read (not a fixed delay), drives the window through its
// own functions and pointer events, and returns the facts it checked; main.mjs
// writes them to a JSON file (--scene-result), and this runner reads facts, not
// pictures. The screenshot is kept beside it only for a person to look at.
//
// It runs a disposable copy of the application with its own user-data, so the
// owner's layouts are never touched. It opens windows on screen, so it is not
// part of `npm test`: run it with `npm run test:ui`. If an Atlas window is
// already open, the pack is skipped rather than risk that window.
//
// `--status-file <file>` (with `--run-id <id>`) makes the runner write its own
// state - phase, current scene and attempt, times, every result and the exit -
// to that file, for an operator's status surface (tools/ui-status-server.mjs).
// The runner writes it itself, so nothing depends on how a shell passes values.

import { execFile, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunStatus } from "./ui-run-status.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
};
const ELECTRON = path.join(PROJECT_ROOT, "node_modules", "electron", "dist",
  process.platform === "win32" ? "electron.exe" : "electron");
const SCENES = Object.freeze([
  ["ui-a1-fit-expand", "Fit at level 4, then spread out: the HQ is not on a quarter, the project grows"],
  ["ui-a2-world-level", "“Whole world”: level 4, projects do not overlap"],
  ["ui-a3-quarter-menu", "Entering a quarter from the context menu opens the quarter, the camera does not move"],
  ["ui-a4-identifier", "A wrong quarter ID is explained before the request"],
  ["ui-a5-zoom-closes-workspace", "Zooming out closes the workspace"],
  ["ui-a6-switch-agent", "A click on another agent at level 1 closes the window and selects that agent, the camera stays; a double click opens its window"],
  ["ui-a7-sheet-inspector", "The memory sheet does not lie over the inspector"],
  ["ui-a8-archived-send", "Sending to an archived agent is neither offered nor goes through"],
  ["ui-a9-live-chat", "Live conversation by the agent binding, with omissions and updates on events"],
  ["ui-a10-archive-and-unavailable", "An archived agent is read from the archive; an unavailable live read is named, not shown as empty"],
  ["ui-a11-project-files", "Project files: a folder on click, a file in pages of 64 KB"],
  ["ui-a12-artifacts", "An artifact is shown only if its hash matches the registered one"],
  ["ui-a13-attention-profile", "Attention without data is not zero; the profile is named as requested"],
  ["ui-a14-paste-mode", "Paste: the mode is chosen explicitly, agents are not copied"],
  ["ui-a15-file-search-edit-blocked", "Search in an open file; a partly read file cannot be edited; the second page of the same version"],
  // Without the fixture and without config/local.json in the copy: the window connects nowhere,
  // there is no world, and the scene checks how the configuration error is named.
  ["ui-a16-unconfigured-controller", "Without controller configuration: a clear error, not a single path", { fixture: false, needsWorld: false }],
  // A17, A18 and A19 confirm changes themselves - only on the fixture in capture mode
  // (AUTO_CONFIRM_SCENES in main.mjs).
  ["ui-a17-editor-save-conflict", "File edit: “not saved”, a conflict without losing the edit, a save by receipt"],
  ["ui-a18-copy-with-memory", "A project copy with memory in one operation: receipts per memory, no agents"],
  ["ui-a19-copy-target-choice", "The ID of the new copy is chosen before confirmation; a taken, invalid or source-equal ID writes nothing"],
  ["ui-a20-lead-chat-camera", "The quarter lead and project lead chat does not move the camera and does not close at world level; an agent chat zooms in"],
  ["ui-a21-corner-resize", "Quarter, HQ and agent resize by the corner; a released agent snaps to a grid crossing"],
  ["ui-a22-workspace-closes", "The agent window closes on a click outside it and with the level button at the bottom; a click on the agent does not close it"],
  ["ui-a23-folder-hold", "Agents hold the folder, not quarters: those that worked hold it for good, open ones without work - archive them, otherwise change it"],
  ["ui-a24-agent-name-taken", "An agent name is not reused: the form names a taken one (archived ones too) before sending; a lead gets the first free one"],
  ["ui-a25-chat-thinking-scale", "Thinking is its own block, not an action window; a running turn says what the agent is doing; font and scale of the agent window"],
  ["ui-a26-permission-mode", "Agent permission mode by the input field: the provider one is marked, Shift+Tab - the next one, “Bypass permissions” after confirmation"],
  ["ui-a27-copy-choices-usage-lead", "Chat text copies with Ctrl+C and is not redrawn under the selection; several choices of a question survive a refresh; the quota menu; the lead attention at the HQ"],
  ["ui-a28-tabs-keep-memory-document", "A world refresh does not rebuild a tab that does not use the catalog (the scroll stays); memory document: show, approve and write"],
  ["ui-a29-agent-commits", "Agent history in the “Files” tab: a folder without git offers to become a repository (with confirmation), then the agent commits"],
  ["ui-a30-archived-agent-off-map", "An archived agent leaves the map; “Archive” lists it and opens its conversation"],
]);

const atlasWindowOpen = () => new Promise((resolve) => {
  if (process.platform !== "win32") {
    resolve(false);
    return;
  }
  execFile("tasklist", ["/FI", "IMAGENAME eq electron.exe", "/FO", "CSV", "/NH"], { windowsHide: true },
    (error, stdout) => resolve(!error && /electron\.exe/i.test(String(stdout))));
});

function runScene(root, name, outDir, { fixture = true } = {}) {
  const png = path.join(outDir, `${name}.png`);
  const json = path.join(outDir, `${name}.json`);
  return new Promise((resolve) => {
    // The window must be shown: a hidden window is not composited, so the
    // camera gets no animation frames and the screenshot cannot be taken.
    const child = spawn(ELECTRON, [root, ...(fixture ? ["--dev-fixture"] : []), "--capture", png,
      "--capture-scene", name, "--scene-result", json], { stdio: "ignore" });
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on("close", async () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(await readFile(json, "utf8")));
      } catch {
        resolve(null);
      }
    });
  });
}

/** Which snapshot runs: commit, whether the tree is dirty, application version. */
function runSource() {
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: PROJECT_ROOT, encoding: "utf8", windowsHide: true }).trim();
    } catch {
      return null;
    }
  };
  let projectVersion = null;
  try {
    projectVersion = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "project-version.json"), "utf8")).projectVersion;
  } catch { /* stays null */ }
  const changed = git(["status", "--porcelain=v1"]);
  return {
    commit: git(["rev-parse", "HEAD"]), projectVersion,
    changedPaths: changed === null ? null : changed.split(String.fromCharCode(10)).filter((line) => line.trim() !== "").length,
  };
}

const statusFile = argument("--status-file");
const run = statusFile === null ? null : createRunStatus({
  file: path.resolve(statusFile),
  runId: argument("--run-id") ?? `ui-run-${process.pid}`,
  command: "npm run test:ui",
  source: runSource(),
  sceneNames: SCENES.map(([name]) => name),
});
run?.start();
// Keeps "updated" fresh on the status surface while one scene runs long.
const pulse = run === null ? null : setInterval(() => run.heartbeat(), 1000);

const cases = [];
let status = "passed";
if (await atlasWindowOpen()) {
  status = "skipped";
  cases.push({ caseId: "atlas-window-open", status: "skipped",
    detail: "An Electron window is already running; the pack does not run next to it." });
} else {
  const work = await mkdtemp(path.join(os.tmpdir(), "atlas-ui-scenes-"));
  const root = path.join(work, "app");
  const outDir = path.join(work, "out");
  await mkdir(outDir, { recursive: true });
  for (const part of ["src", "delivery", "vendor", "package.json", "project-version.json"]) {
    await cp(path.join(PROJECT_ROOT, part), path.join(root, part), { recursive: true });
  }
  for (const [index, [name, title, options = {}]] of SCENES.entries()) {
    let report = null;
    // A scene is repeated only when the rendering pipeline failed - no result,
    // or a capture that could not be taken (the GPU process was gone, and with
    // it the animation frames the camera needs) - never because its facts came
    // out wrong. The last attempt is reported as it is.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await rm(path.join(root, "user-data"), { recursive: true, force: true });
      run?.scene(index, name, attempt);
      report = await runScene(root, name, outDir, options);
      if (report !== null && report.capture === "written") break;
    }
    const passed = report !== null && (report.ready === true || options.needsWorld === false) && report.error === null
      && report.capture === "written" && report.result?.pass === true;
    cases.push({ caseId: name, title, status: passed ? "passed" : "failed", ...(passed ? {} : { detail: report }) });
    run?.result(name, passed ? "passed" : "failed");
  }
  await rm(work, { recursive: true, force: true });
  if (cases.some((item) => item.status === "failed")) status = "failed";
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "ui-scenes",
  status,
  passedCount: cases.filter((item) => item.status === "passed").length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = status === "failed" ? 1 : 0;
if (pulse !== null) clearInterval(pulse);
run?.finish({ status, exitCode: process.exitCode });
