import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Which desk agents hold a controller task that was started and has not
// returned yet (no report submitted, not declined), from the return records
// of desk-tasks.mjs. Such an agent is not free even while no message runs:
// it stopped between messages, and the next step is the person's (a plan
// waiting for confirmation, say). Kept apart from desk-tasks.mjs so the
// memory service can read it without the controller's report modules.

export const DESK_TASK_INDEX_VERSION = "v0.1.0";
export const DESK_TASK_RETURNS_DIRECTORY = path.join(".project-local", "orchestration", "desk-task-returns");
const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * A reader of the open tasks of a controller: () => Map(agentId ->
 * { taskId, startedAtUtc }). It reads a record again only when its file
 * changed.
 */
export function createOpenDeskTaskReader(controllerRoot) {
  const directory = path.join(path.resolve(controllerRoot), DESK_TASK_RETURNS_DIRECTORY);
  const cache = new Map();
  return async function readOpenDeskTasks() {
    const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json"));
    for (const name of [...cache.keys()]) if (!names.includes(name)) cache.delete(name);
    const open = new Map();
    for (const name of names) {
      const file = path.join(directory, name);
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) {
        cache.delete(name);
        continue;
      }
      const stamp = `${info.mtimeMs}:${info.size}`;
      let entry = cache.get(name);
      if (entry?.stamp !== stamp) {
        let record = null;
        try { record = JSON.parse(await readFile(file, "utf8")); } catch { record = null; }
        entry = { stamp, record: record && typeof record === "object" ? { agentId: record.agentId,
          taskId: record.taskId, returnState: record.returnState, startedAtUtc: record.startedAtUtc ?? null } : null };
        cache.set(name, entry);
      }
      const record = entry.record;
      if (record?.returnState !== "waiting" || typeof record.agentId !== "string") continue;
      const known = open.get(record.agentId);
      if (!known || String(record.startedAtUtc) > String(known.startedAtUtc)) {
        open.set(record.agentId, { taskId: record.taskId, startedAtUtc: record.startedAtUtc });
      }
    }
    return open;
  };
}
