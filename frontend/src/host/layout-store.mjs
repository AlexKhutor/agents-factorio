// Where the map's geometry and the person's own annotations live.
//
// Positions and sizes are a drawing, but notes and roles are content a person
// typed and nobody else has a copy of. That makes this file user data, not a
// cache: it is written atomically, the previous version is kept, a damaged file
// is reported rather than repaired, and a rejected write never touches what is
// already saved.
//
// One file per environment. A fixture agent and a live agent can share an
// identifier, and their notes must never meet.

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { moveOver } from "./move-over.mjs";

const MAX_BYTES = 1_048_576;
const MAX_NODES = 2000;
const MAX_NOTE = 4096;
const MAX_ROLE = 64;
const MAX_SKILLS = 32;
const MAX_SKILL = 64;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ACCENTS = Object.freeze(["gold", "green", "amber", "red", "slate", "violet"]);

function finite(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value)
    && value >= minimum && value <= maximum;
}

function annotations(value) {
  if (value.note !== undefined
      && (typeof value.note !== "string" || value.note.length > MAX_NOTE)) return "note_invalid";
  if (value.role !== undefined
      && (typeof value.role !== "string" || value.role.length > MAX_ROLE)) return "role_invalid";
  // The skills a person plans for an agent. The backend knows nothing about
  // them yet, which is exactly why they are user content and are kept here.
  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills) || value.skills.length > MAX_SKILLS) return "skills_invalid";
    for (const skill of value.skills) {
      if (typeof skill !== "string" || skill.length === 0 || skill.length > MAX_SKILL) {
        return "skills_invalid";
      }
    }
  }
  return null;
}

function box(value, { minimumSize }) {
  if (value === null || typeof value !== "object") return "box_invalid";
  if (!finite(value.x, -100_000, 100_000) || !finite(value.y, -100_000, 100_000)
      || !finite(value.width, minimumSize, 8000) || !finite(value.height, minimumSize, 8000)) {
    return "box_invalid";
  }
  return annotations(value);
}

function point(value) {
  if (value === null || typeof value !== "object") return "point_invalid";
  if (!finite(value.x, -100_000, 100_000) || !finite(value.y, -100_000, 100_000)) {
    return "point_invalid";
  }
  // The size of an agent dragged by its corner: a share of the standard one (scene-core.js AGENT_SCALE).
  if (value.scale !== undefined && !finite(value.scale, 0.4, 1.5)) return "scale_invalid";
  return annotations(value);
}

function countNodes(layout) {
  let total = Object.keys(layout.projects).length + Object.keys(layout.agents).length;
  for (const quarters of Object.values(layout.quarters)) total += Object.keys(quarters).length;
  return total;
}

/**
 * The saved camera. It holds where the person was looking and what they had
 * navigated into - never a "level", which is derived from scale at render time
 * and therefore has no business being stored twice.
 */
function view(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return "view_invalid";
  if (!finite(value.x, -1_000_000, 1_000_000) || !finite(value.y, -1_000_000, 1_000_000)
      || !finite(value.scale, 0.01, 10)) return "view_invalid";
  for (const key of ["scopeProjectId", "scopeQuarterId"]) {
    const scope = value[key];
    if (scope !== undefined && scope !== null && !ID.test(scope)) return "view_scope_invalid";
  }
  return null;
}

export function validateLayout(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "not_an_object";
  if (value.schemaVersion !== 1) return "unsupported_schema_version";
  for (const key of ["projects", "quarters", "agents"]) {
    if (value[key] === null || typeof value[key] !== "object" || Array.isArray(value[key])) {
      return `${key}_invalid`;
    }
  }
  for (const [projectId, placement] of Object.entries(value.projects)) {
    if (!ID.test(projectId)) return "project_id_invalid";
    const problem = box(placement, { minimumSize: 120 });
    if (problem !== null) return `project_${problem}`;
    if (placement.symbol !== undefined
        && (typeof placement.symbol !== "string" || placement.symbol.length > 3)) {
      return "project_symbol_invalid";
    }
    if (placement.accent !== undefined && !ACCENTS.includes(placement.accent)) {
      return "project_accent_invalid";
    }
    // The size of an HQ dragged by its corner: a share of the standard one (scene-core.js HQ_SCALE).
    if (placement.hqScale !== undefined && !finite(placement.hqScale, 0.4, 1.5)) {
      return "project_hq_scale_invalid";
    }
  }
  for (const [projectId, quarters] of Object.entries(value.quarters)) {
    if (!ID.test(projectId)) return "quarter_project_id_invalid";
    if (quarters === null || typeof quarters !== "object") return "quarters_invalid";
    for (const [quarterId, placement] of Object.entries(quarters)) {
      if (!ID.test(quarterId)) return "quarter_id_invalid";
      const problem = box(placement, { minimumSize: 60 });
      if (problem !== null) return `quarter_${problem}`;
    }
  }
  for (const [agentId, placement] of Object.entries(value.agents)) {
    if (!ID.test(agentId)) return "agent_id_invalid";
    const problem = point(placement);
    if (problem !== null) return `agent_${problem}`;
  }
  const viewProblem = view(value.view);
  if (viewProblem !== null) return viewProblem;
  if (countNodes(value) > MAX_NODES) return "too_many_nodes";
  return null;
}

export function emptyLayout() {
  return { schemaVersion: 1, updatedAtUtc: null, projects: {}, quarters: {}, agents: {} };
}

/**
 * The environment a layout belongs to. Fixture and live never share a file, and
 * two controllers never share one either.
 */
export function environmentKey({ mode, workspaceRootSha256 = null }) {
  if (mode === "dev-fixture") return "fixture";
  if (typeof workspaceRootSha256 === "string" && /^[a-f0-9]{64}$/.test(workspaceRootSha256)) {
    return `live-${workspaceRootSha256.slice(0, 16)}`;
  }
  return "unconfigured";
}

export function createLayoutStore({ directory, environment = "unconfigured" }) {
  const folder = path.join(directory, "layouts");
  const file = path.join(folder, `${environment}.json`);
  const backup = `${file}.bak`;

  async function readFileIfValid(target) {
    let raw;
    try {
      raw = await readFile(target, "utf8");
    } catch {
      return { status: "missing" };
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) return { status: "invalid", reasonCode: "too_large" };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: "invalid", reasonCode: "unparsable" };
    }
    const problem = validateLayout(parsed);
    if (problem !== null) return { status: "invalid", reasonCode: problem };
    return { status: "loaded", layout: parsed };
  }

  async function read() {
    const primary = await readFileIfValid(file);
    if (primary.status === "loaded") {
      return { ok: true, data: { status: "loaded", environment, layout: primary.layout, source: "current" } };
    }
    if (primary.status === "missing") {
      return { ok: true, data: { status: "empty", environment, layout: emptyLayout(), source: "none" } };
    }
    // The current file is damaged. The previous good one is offered instead of
    // an empty desk: losing a person's notes silently is not acceptable.
    const fallback = await readFileIfValid(backup);
    if (fallback.status === "loaded") {
      return {
        ok: true,
        data: {
          status: "recovered", environment, layout: fallback.layout, source: "backup",
          reasonCode: primary.reasonCode,
        },
      };
    }
    return {
      ok: false,
      error: { code: "layout_invalid", reasonCode: primary.reasonCode, recoverable: false },
    };
  }

  // Writes go one after another, in the order they were asked: two at once
  // shared the temporary file, and the second found it already renamed away
  // (ENOENT after quick undo/redo). The last request is the one that stays.
  let queue = Promise.resolve();
  let sequence = 0;

  function write(layout) {
    const run = queue.then(() => writeNow(layout));
    queue = run.catch(() => undefined);
    return run;
  }

  async function writeNow(layout) {
    const problem = validateLayout(layout);
    if (problem !== null) {
      return { ok: false, error: { code: "layout_invalid", reasonCode: problem } };
    }
    const value = { ...layout, updatedAtUtc: new Date().toISOString() };
    const serialized = JSON.stringify(value, null, 1);
    if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
      return { ok: false, error: { code: "layout_invalid", reasonCode: "too_large" } };
    }
    await mkdir(folder, { recursive: true });
    // Keep the last good version, then replace by rename: a crash mid-write can
    // lose the newest change, never the file.
    await copyFile(file, backup).catch(() => undefined);
    sequence += 1;
    const temporary = `${file}.${process.pid}.${sequence}.tmp`;
    try {
      await writeFile(temporary, serialized, "utf8");
      await moveOver(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      return { ok: false, error: { code: "layout_not_saved", reasonCode: error?.code ?? "write_failed" } };
    }
    return { ok: true, data: { status: "saved", environment, updatedAtUtc: value.updatedAtUtc } };
  }

  return { read, write, file, environment };
}
