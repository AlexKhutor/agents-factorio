// PROTOTYPE. What the direct bridge remembers, as plain JSON files in one folder.
//
//   world.json                 projects, quarters, agents, the two memories, the sends of each agent
//   transcripts/<hash>.json    one agent's turns and questions, as the desk shows them
//
// Every file is replaced whole: written beside itself and moved over, one
// write at a time per file, so a reader or a crash never sees half a file.
// There is one writer - the desk's own process.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { moveOver } from "../host/move-over.mjs";

const fileNameOf = (agentId) => `${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}.json`;

async function readJson(file, fallback) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback();
    throw error;
  }
  return JSON.parse(text);
}

export async function openDirectStore(dataDir) {
  const root = path.resolve(dataDir);
  const transcripts = path.join(root, "transcripts");
  await mkdir(transcripts, { recursive: true });

  const queues = new Map();
  /** Replaces a file, after every earlier write of the same file. */
  function write(file, value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const next = (queues.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, text, "utf8");
      await moveOver(temporary, file);
    });
    queues.set(file, next);
    return next;
  }

  const worldFile = path.join(root, "world.json");
  const world = await readJson(worldFile, () => ({ schemaVersion: 1, worldId: randomUUID(), projects: [], quarters: [], agents: [] }));
  if (world.schemaVersion !== 1) throw new Error("direct store: unknown world.json version");

  const loaded = new Map();
  return {
    root, world,
    saveWorld: () => write(worldFile, world),
    /** One agent's turns and questions; the same object for the life of the process. */
    async transcriptOf(agentId) {
      if (!loaded.has(agentId)) {
        loaded.set(agentId, await readJson(path.join(transcripts, fileNameOf(agentId)), () => ({ schemaVersion: 1, agentId, turns: [], interactions: [] })));
      }
      return loaded.get(agentId);
    },
    saveTranscript: (agentId) => (loaded.has(agentId) ? write(path.join(transcripts, fileNameOf(agentId)), loaded.get(agentId)) : Promise.resolve()),
  };
}
