// A check of the layout store.
//
// The geometry is a drawing, but the notes and roles in the same file are the person's work.
// So: a broken file is reported, not “fixed”; a refused write does not
// touch what is saved; the last good version stays as a backup; and the fixture
// and the controller never share one desk.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createLayoutStore, emptyLayout, environmentKey, validateLayout,
} from "../src/host/layout-store.mjs";

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-layout-test-"));
const store = createLayoutStore({ directory, environment: "test" });

const layout = {
  ...emptyLayout(),
  projects: {
    "test-project": {
      x: 120, y: -40, width: 380, height: 260, symbol: "TP", accent: "green",
      role: "core", note: "my note",
    },
  },
  quarters: { "test-project": { "test-quarter": { x: 14, y: 46, width: 162, height: 98 } } },
  agents: { "test-agent": { x: 18, y: 48, note: "keep an eye on it" } },
  view: { x: 10, y: 20, scale: 0.8, scopeProjectId: "test-project", scopeQuarterId: null },
};

{
  const first = await store.read();
  check("no-file-means-empty-not-broken",
    first.ok === true && first.data.status === "empty"
      && Object.keys(first.data.layout.projects).length === 0,
    first);
}

{
  const saved = await store.write(layout);
  const back = await store.read();
  const project = back.ok ? back.data.layout.projects["test-project"] : null;
  check("saved-layout-comes-back-unchanged",
    saved.ok === true && back.ok === true && back.data.status === "loaded"
      && project.x === 120 && project.symbol === "TP"
      && project.role === "core" && project.note === "my note"
      && back.data.layout.agents["test-agent"].note === "keep an eye on it"
      && back.data.layout.view.scale === 0.8
      && back.data.layout.view.scopeProjectId === "test-project",
    { saved, back });
}

{
  // The second write makes a backup; after the main file is broken, the person
  // gets the previous version, not an empty desk.
  await store.write({ ...layout, agents: { "test-agent": { x: 30, y: 60, note: "second version" } } });
  await writeFile(store.file, "{ this is not json", "utf8");
  const recovered = await store.read();
  check("broken-file-recovered-from-backup",
    recovered.ok === true && recovered.data.status === "recovered"
      && recovered.data.source === "backup"
      && recovered.data.reasonCode === "unparsable"
      && typeof recovered.data.layout.agents["test-agent"].note === "string",
    recovered);
}

{
  const fixtureStore = createLayoutStore({ directory, environment: "fixture" });
  await fixtureStore.write({
    ...emptyLayout(), agents: { "test-agent": { x: 1, y: 1, note: "this is the fixture" } },
  });
  const live = await store.read();
  const fixture = await fixtureStore.read();
  check("fixture-and-controller-do-not-share-desk",
    fixture.data.layout.agents["test-agent"].note === "this is the fixture"
      && live.data.layout.agents["test-agent"].note !== "this is the fixture"
      && environmentKey({ mode: "dev-fixture" }) === "fixture"
      && environmentKey({ mode: "live", workspaceRootSha256: "a".repeat(64) }) === `live-${"a".repeat(16)}`
      && environmentKey({ mode: "live" }) === "unconfigured",
    { live: live.data.layout.agents, fixture: fixture.data.layout.agents });
}

{
  const badId = validateLayout({
    ...emptyLayout(), projects: { "../escape": { x: 0, y: 0, width: 200, height: 200 } },
  });
  const badBox = validateLayout({
    ...emptyLayout(), projects: { ok: { x: 0, y: 0, width: 5, height: 200 } },
  });
  const infinite = validateLayout({
    ...emptyLayout(), agents: { ok: { x: Number.POSITIVE_INFINITY, y: 0 } },
  });
  const farAway = validateLayout({ ...emptyLayout(), agents: { ok: { x: 10_000_000, y: 0 } } });
  check("ids-and-geometry-limited",
    badId === "project_id_invalid" && badBox === "project_box_invalid"
      && infinite === "agent_point_invalid" && farAway === "agent_point_invalid",
    { badId, badBox, infinite, farAway });
}

{
  const longNote = validateLayout({
    ...emptyLayout(), agents: { ok: { x: 0, y: 0, note: "n".repeat(5000) } },
  });
  const longRole = validateLayout({
    ...emptyLayout(), agents: { ok: { x: 0, y: 0, role: "\u0440".repeat(80) } },
  });
  const badView = validateLayout({ ...emptyLayout(), view: { x: 0, y: 0, scale: 99 } });
  const badScope = validateLayout({
    ...emptyLayout(), view: { x: 0, y: 0, scale: 1, scopeProjectId: "../escape" },
  });
  check("notes-and-view-limited",
    longNote === "agent_note_invalid" && longRole === "agent_role_invalid"
      && badView === "view_invalid" && badScope === "view_scope_invalid",
    { longNote, longRole, badView, badScope });
}

{
  // The size of an HQ resized by its corner: a share of the standard one, 40-150 %.
  const project = (hqScale) => ({ ...emptyLayout(), projects: { p: { x: 0, y: 0, width: 300, height: 300, hqScale } } });
  const good = validateLayout(project(0.55));
  const tooBig = validateLayout(project(2));
  const notNumber = validateLayout(project("small"));
  const agent = (scale) => validateLayout({ ...emptyLayout(), agents: { a: { x: 50, y: 50, scale } } });
  check("hq-and-agent-size-limited",
    good === null && tooBig === "project_hq_scale_invalid" && notNumber === "project_hq_scale_invalid"
      && agent(0.5) === null && agent(0.1) === "agent_scale_invalid" && agent("big") === "agent_scale_invalid",
    { good, tooBig, notNumber, small: agent(0.5), tiny: agent(0.1) });
}

{
  const good = validateLayout({
    ...emptyLayout(), agents: { ok: { x: 0, y: 0, skills: ["log analysis", "migrations"] } },
  });
  const notAList = validateLayout({
    ...emptyLayout(), agents: { ok: { x: 0, y: 0, skills: "log analysis" } },
  });
  const tooMany = validateLayout({
    ...emptyLayout(), agents: { ok: { x: 0, y: 0, skills: Array.from({ length: 40 }, (_, i) => `s${i}`) } },
  });
  const tooLong = validateLayout({
    ...emptyLayout(), agents: { ok: { x: 0, y: 0, skills: ["n".repeat(80)] } },
  });
  const empty = validateLayout({
    ...emptyLayout(), agents: { ok: { x: 0, y: 0, skills: [""] } },
  });
  check("skills-are-list-of-short-strings",
    good === null && notAList === "agent_skills_invalid" && tooMany === "agent_skills_invalid"
      && tooLong === "agent_skills_invalid" && empty === "agent_skills_invalid",
    { good, notAList, tooMany, tooLong, empty });
}

{
  const longSymbol = validateLayout({
    ...emptyLayout(), projects: { ok: { x: 0, y: 0, width: 200, height: 200, symbol: "ABCD" } },
  });
  const unknownAccent = validateLayout({
    ...emptyLayout(), projects: { ok: { x: 0, y: 0, width: 200, height: 200, accent: "neon" } },
  });
  check("styling-limited",
    longSymbol === "project_symbol_invalid" && unknownAccent === "project_accent_invalid",
    { longSymbol, unknownAccent });
}

{
  const many = { ...emptyLayout(), agents: {} };
  for (let index = 0; index < 2100; index += 1) many.agents[`agent-${index}`] = { x: 0, y: 0 };
  const rejected = await store.write(many);
  check("layout-does-not-grow-without-limit",
    validateLayout(many) === "too_many_nodes"
      && rejected.ok === false && rejected.error.reasonCode === "too_many_nodes",
    rejected);
}

{
  await store.write(layout);
  await store.write({ schemaVersion: 1, projects: { bad: { x: "x" } }, quarters: {}, agents: {} });
  const back = await store.read();
  check("refused-write-does-not-spoil-saved-one",
    back.ok === true && back.data.layout.projects["test-project"].x === 120,
    back);
}

{
  // Several writes at once (quick undo and redo): each one is saved,
  // none finds its temporary file already renamed, and the file holds the last one.
  const writes = [1, 2, 3, 4, 5].map((x) => store.write({
    ...emptyLayout(), projects: { "test-project": { x: x * 100, y: 0, width: 200, height: 200 } },
  }));
  const results = await Promise.all(writes);
  const back = await store.read();
  check("back-to-back-writes-do-not-interfere",
    results.every((result) => result.ok === true) && back.ok === true
      && back.data.layout.projects["test-project"].x === 500,
    { results: results.map((result) => result.ok ? "ok" : result.error), last: back.data?.layout?.projects });
}

await rm(directory, { recursive: true, force: true });

const passed = cases.filter(({ status }) => status === "passed").length;
const report = {
  suite: "map-layout",
  status: passed === cases.length ? "passed" : "failed",
  caseCount: cases.length,
  passedCount: passed,
  failedCount: cases.length - passed,
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;
