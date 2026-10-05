// A visible status surface for the UI pack: one local page, read in a browser.
//
//   node tools/ui-status-server.mjs --status-file <file> --port <port>
//
// It serves, on 127.0.0.1 only, a page that polls the runner's status file
// (tools/ui-run-status.mjs) every second and shows the run identity, command,
// source, phase, the current scene and attempt, when the state was last
// updated and how long ago, the elapsed time, every scene's result and the
// final exit. "Updated N s ago" turns red when a running pack stops writing,
// so a silent hang is visible rather than looking like progress. The page
// also shows its own poll time, which proves the surface itself is alive.
//
// Every poll reports the page's own visibility and focus
// (document.visibilityState, document.hasFocus()); the server keeps the latest
// polls and serves them at /surface. That is how readiness is proved: a page
// that is polling and reports itself visible, not an assumption that a window
// is on screen.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
};
const statusFile = argument("--status-file");
const port = Number(argument("--port") ?? "47631");
if (statusFile === null || !Number.isInteger(port)) {
  process.stderr.write("usage: node tools/ui-status-server.mjs --status-file <file> --port <port>\n");
  process.exit(2);
}

const polls = [];
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>UI pack · status</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:16px;background:#1b2017;color:#e4ecd2}
h1{font-size:18px;margin:0 0 8px}
table{border-collapse:collapse;margin-top:8px}
td,th{padding:3px 10px;border-bottom:1px solid #3d4636;text-align:left}
.k{color:#a9b998}.stale{color:#ff8a65;font-weight:700}.fresh{color:#9ccc65}
.passed{color:#9ccc65}.failed{color:#ff8a65}.running{color:#ffd54f}.pending{color:#8a9678}
#final{font-size:16px;font-weight:700;margin-top:8px}
</style></head><body>
<h1>UI pack on the fixture — run status</h1>
<div id="surface" class="k"></div>
<table id="facts"></table>
<div id="final"></div>
<table id="scenes"><thead><tr><th>#</th><th>scene</th><th>status</th><th>attempts</th></tr></thead><tbody></tbody></table>
<script>
const $ = (id) => document.getElementById(id);
const PAGE_ID = "page-" + Math.random().toString(16).slice(2, 10);
let seq = 0;
const row = (k, v, cls) => '<tr><td class="k">' + k + '</td><td' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</td></tr>';
const text = (value) => String(value ?? "—").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
async function poll() {
  const polled = new Date();
  $("surface").textContent = "surface alive: polled " + polled.toISOString();
  seq += 1;
  const visibility = document.visibilityState;
  const focus = document.hasFocus();
  $("surface").textContent += " · visibility " + visibility + " · focus " + (focus ? "yes" : "no");
  let s;
  try {
    s = await (await fetch("/status?page=" + PAGE_ID + "&seq=" + seq + "&visibility=" + visibility + "&focus=" + focus,
      { cache: "no-store" })).json();
  } catch { s = { phase: "status-unreadable" }; }
  if (s.phase === "no-status" || s.phase === "status-unreadable") {
    $("facts").innerHTML = row("phase", s.phase, "stale");
    document.title = "UI pack · " + s.phase;
    return;
  }
  const age = s.updatedAtUtc ? Math.round((polled - Date.parse(s.updatedAtUtc)) / 1000) : null;
  const stale = s.phase === "running" && age !== null && age > 5;
  const current = s.current ? (s.current.index + 1) + "/" + s.total + " " + s.current.name + " (attempt " + s.current.attempt + ")" : "—";
  $("facts").innerHTML = row("run", text(s.runId)) + row("command", text(s.command))
    + row("source", text(JSON.stringify(s.source))) + row("phase", text(s.phase)) + row("current scene", text(current))
    + row("started", text(s.startedAtUtc)) + row("updated", text(s.updatedAtUtc) + " (" + (age === null ? "—" : age + " s ago") + ")", stale ? "stale" : "fresh")
    + row("elapsed", s.elapsedMs === null ? "—" : Math.round(s.elapsedMs / 1000) + " s")
    + row("counts", "passed " + (s.counts.passed || 0) + " · failed " + (s.counts.failed || 0) + " · pending " + (s.counts.pending || 0) + " · running " + (s.counts.running || 0))
    + row("record #", text(s.sequence));
  $("final").textContent = s.phase === "finished" ? "RESULT: " + s.status + " · exit " + s.exitCode + " · " + s.finishedAtUtc
    : s.phase === "ready" ? "Ready to start: the run has not begun" : "Run in progress…";
  $("scenes").querySelector("tbody").innerHTML = s.scenes.map((scene, i) =>
    '<tr><td>' + (i + 1) + '</td><td>' + text(scene.name) + '</td><td class="' + scene.status + '">' + scene.status + '</td><td>' + scene.attempts + '</td></tr>').join("");
  document.title = "UI pack · " + s.phase + (s.phase === "finished" ? " · exit " + s.exitCode : "");
}
poll();
setInterval(poll, 1000);
</script></body></html>`;

createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/surface") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ polls }));
    return;
  }
  if (url.pathname === "/status") {
    if (url.searchParams.has("page")) {
      polls.push({
        atUtc: new Date().toISOString(),
        page: String(url.searchParams.get("page")).slice(0, 40),
        seq: Number(url.searchParams.get("seq")),
        visibility: String(url.searchParams.get("visibility")).slice(0, 20),
        focus: url.searchParams.get("focus") === "true",
      });
      while (polls.length > 30) polls.shift();
    }
    let body;
    try {
      body = await readFile(path.resolve(statusFile), "utf8");
    } catch {
      body = JSON.stringify({ phase: "no-status" });
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(body);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(PAGE);
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`ui status surface on http://127.0.0.1:${port}/ reading ${path.basename(statusFile)}\n`);
});
