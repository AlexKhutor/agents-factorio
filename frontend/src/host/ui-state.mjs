// Which panels were open last time, and how the agent window is sized. Nothing else.
//
// Deliberately a separate, tiny file: if it is damaged, the person loses the
// memory of an open drawer, not their map, their notes or their roles. It never
// stores a navigation level - that is derived from the camera at render time.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { moveOver } from "./move-over.mjs";

// Watching (re-reading the world on its own) is on unless the person turned it
// off: a finished turn must show up on the map without pressing Refresh. The
// agent panel keeps the width the person dragged it to, and whether it was
// opened over the whole window.
const DEFAULTS = Object.freeze({
  attentionOpen: false, logOpen: false, trayOpen: false, watch: true,
  workspaceFull: false, workspaceWidth: null,
  // A message typed while the agent works is steered into its turn (Codex's
  // default) unless the person unticked Steer: then it waits for the turn's end.
  steer: true,
  // The agent window's text size and the zoom of its content, in percent.
  chatText: 100, chatZoom: 100,
});

// Whole percents only, within what the window offers.
const PERCENTS = Object.freeze({ chatText: [70, 150], chatZoom: [50, 150] });

function sanitize(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULTS };
  const result = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (key === "workspaceWidth") {
      if (Number.isInteger(value[key]) && value[key] >= 320 && value[key] <= 8000) result[key] = value[key];
    } else if (Object.hasOwn(PERCENTS, key)) {
      const [low, high] = PERCENTS[key];
      if (Number.isInteger(value[key]) && value[key] >= low && value[key] <= high) result[key] = value[key];
    } else if (typeof value[key] === "boolean") result[key] = value[key];
  }
  return result;
}

export function createUiStateStore({ directory }) {
  const file = path.join(directory, "ui-state.json");

  async function read() {
    try {
      return { ok: true, data: sanitize(JSON.parse(await readFile(file, "utf8"))) };
    } catch {
      // Missing or unreadable: defaults are correct, and there is nothing here
      // worth reporting as a failure.
      return { ok: true, data: { ...DEFAULTS } };
    }
  }

  async function write(value) {
    const state = sanitize(value);
    await mkdir(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), "utf8");
      await moveOver(temporary, file);
    } catch {
      await rm(temporary, { force: true });
      return { ok: false, error: { code: "ui_state_not_saved", reasonCode: "write_failed" } };
    }
    return { ok: true, data: state };
  }

  return { read, write, file };
}
