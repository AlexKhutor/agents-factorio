// A replaced file is moved over the old one; a hold by another process
// (EPERM, EACCES, EBUSY on Windows) is waited out for a bounded time, while any
// other failure, or a hold that outlasts the bound, is reported unchanged.

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { moveOver } from "../src/host/move-over.mjs";

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const fail = (code) => Object.assign(new Error(code), { code });

/** A rename that fails with the given codes first, then succeeds; a clock moved by sleep alone. */
function scripted(codes) {
  let clock = 0;
  const calls = [];
  const waits = [];
  return {
    calls, waits,
    options: {
      renameImpl: async (from, to) => {
        calls.push([from, to]);
        const code = codes[calls.length - 1];
        if (code !== undefined) throw fail(code);
      },
      now: () => clock,
      sleep: async (ms) => { waits.push(ms); clock += ms; },
    },
  };
}

{
  const run = scripted(["EPERM", "EBUSY", "EACCES"]);
  let error = null;
  await moveOver("a.tmp", "a", run.options).catch((caught) => { error = caught; });
  check("short-lock-is-waited-out",
    error === null && run.calls.length === 4 && run.waits.join(",") === "10,20,40"
      && run.calls.every(([from, to]) => from === "a.tmp" && to === "a"),
    { error: error?.code ?? null, calls: run.calls.length, waits: run.waits });
}

{
  const run = scripted(["ENOENT"]);
  let error = null;
  await moveOver("a.tmp", "a", run.options).catch((caught) => { error = caught; });
  check("other-error-not-retried", error?.code === "ENOENT" && run.calls.length === 1 && run.waits.length === 0,
    { error: error?.code ?? null, calls: run.calls.length });
}

{
  const run = scripted(Array.from({ length: 1000 }, () => "EPERM"));
  let error = null;
  await moveOver("a.tmp", "a", { ...run.options, retryForMs: 2_000 }).catch((caught) => { error = caught; });
  const waited = run.waits.reduce((sum, ms) => sum + ms, 0);
  check("long-lock-is-time-limited",
    error?.code === "EPERM" && waited <= 2_000 && run.calls.length < 20 && Math.max(...run.waits) === 200,
    { error: error?.code ?? null, waited, calls: run.calls.length });
}

{
  const folder = await mkdtemp(path.join(os.tmpdir(), "atlas-move-over-"));
  try {
    const target = path.join(folder, "world.json");
    await writeFile(target, "old", "utf8");
    await writeFile(`${target}.new.tmp`, "new", "utf8");
    await moveOver(`${target}.new.tmp`, target);
    const left = await readdir(folder);
    check("file-replaced-whole", (await readFile(target, "utf8")) === "new" && left.join() === "world.json",
      { left });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "move-over",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
