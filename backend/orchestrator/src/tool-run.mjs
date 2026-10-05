import { hostname } from "node:os";
import path from "node:path";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const MAX_STRING_LENGTH = 16_384;
const MAX_COLLECTION_ITEMS = 128;
const MAX_DEPTH = 10;

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function toSerializable(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_LENGTH) return value;
    const prefix = value.slice(0, 11_000);
    const suffix = value.slice(-4_000);
    return `${prefix}\n...<truncated ${value.length - 15_000} chars>...\n${suffix}`;
  }
  if (["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: toSerializable(value.stack, depth + 1, seen),
      code: value.code ?? null,
    };
  }
  if (depth >= MAX_DEPTH) return "<max-depth-exceeded>";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "<circular-reference>";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output = value
        .slice(0, MAX_COLLECTION_ITEMS)
        .map((item) => toSerializable(item, depth + 1, seen));
      if (value.length > MAX_COLLECTION_ITEMS) {
        output.push(`<truncated ${value.length - MAX_COLLECTION_ITEMS} items>`);
      }
      return output;
    }

    const output = {};
    const entries = Object.entries(value).slice(0, MAX_COLLECTION_ITEMS);
    for (const [key, item] of entries) {
      output[key] = toSerializable(item, depth + 1, seen);
    }
    if (Object.keys(value).length > MAX_COLLECTION_ITEMS) {
      output["<truncated_properties>"] = Object.keys(value).length - MAX_COLLECTION_ITEMS;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(toSerializable(value), null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function rotateOne(sourcePath, oldDirectory, runStamp) {
  if (!(await exists(sourcePath))) return { action: "missing", sourcePath };

  const extension = path.extname(sourcePath);
  const baseName = path.basename(sourcePath, extension);
  const destinationPath = path.join(oldDirectory, `${baseName}-${runStamp}${extension}`);
  try {
    await rename(sourcePath, destinationPath);
    return { action: "moved", sourcePath, destinationPath };
  } catch (moveError) {
    try {
      await copyFile(sourcePath, destinationPath);
      return {
        action: "copied-locked-source",
        sourcePath,
        destinationPath,
        warning: moveError.message,
      };
    } catch (copyError) {
      return {
        action: "failed",
        sourcePath,
        warning: `${moveError.message}; copy failed: ${copyError.message}`,
      };
    }
  }
}

export async function createToolRun({
  repoRoot,
  toolName,
  toolVersion,
  projectVersion,
  operation,
  parameters = {},
}) {
  const startedAt = new Date();
  const runId = randomUUID();
  const runStamp = timestampForPath(startedAt);
  const logsDirectory = path.join(repoRoot, "logs");
  const oldDirectory = path.join(logsDirectory, "old");
  await mkdir(oldDirectory, { recursive: true });

  const fixedLogPath = path.join(logsDirectory, `${toolName}.log`);
  const fixedReportPath = path.join(logsDirectory, `${toolName}.report.json`);
  const rotations = [
    await rotateOne(fixedLogPath, oldDirectory, runStamp),
    await rotateOne(fixedReportPath, oldDirectory, runStamp),
  ];
  const logPath = ["copied-locked-source", "failed"].includes(rotations[0].action)
    ? path.join(logsDirectory, `${toolName}-${runStamp}.log`)
    : fixedLogPath;
  const reportPath = ["copied-locked-source", "failed"].includes(rotations[1].action)
    ? path.join(logsDirectory, `${toolName}-${runStamp}.report.json`)
    : fixedReportPath;

  const report = {
    formatVersion: 1,
    runId,
    toolName,
    toolVersion,
    projectVersion,
    repoRoot,
    operation,
    parameters,
    startedAtUtc: startedAt.toISOString(),
    machine: {
      hostname: hostname(),
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      processId: process.pid,
    },
    rotations,
    events: [],
  };

  async function log(event, data = {}) {
    const record = {
      atUtc: new Date().toISOString(),
      event,
      data: toSerializable(data),
    };
    report.events.push(record);
    if (report.events.length > MAX_COLLECTION_ITEMS) report.events.shift();
    await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  await log("tool_started", { operation, parameters, rotations });

  return {
    logPath,
    reportPath,
    report,
    log,
    async finish(status, result = {}, error = null) {
      report.status = status;
      report.result = toSerializable(result);
      report.error = error ? toSerializable(error) : null;
      report.finishedAtUtc = new Date().toISOString();
      report.durationMs = Date.parse(report.finishedAtUtc) - startedAt.getTime();
      await log("tool_finished", { status, result, error });
      try {
        await writeJsonAtomic(reportPath, report);
      } catch (serializationError) {
        const fallback = {
          formatVersion: 1,
          runId,
          toolName,
          toolVersion,
          projectVersion,
          repoRoot,
          operation,
          status: "report-write-failed",
          startedAtUtc: report.startedAtUtc,
          finishedAtUtc: new Date().toISOString(),
          serializationError: toSerializable(serializationError),
          originalError: error ? toSerializable(error) : null,
        };
        await writeFile(reportPath, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
      }
      return { logPath, reportPath };
    },
  };
}

export async function readProjectVersions(repoRoot) {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "project-version.json"), "utf8"));
  return {
    projectVersion: manifest.projectVersion,
    componentVersions: manifest.componentVersions ?? {},
  };
}

export async function compactToolRunHistory({
  repoRoot,
  toolName,
  maxLooseFiles = 120,
  retainLooseFiles = 60,
  maxBundleBytes = 20 * 1024 * 1024,
} = {}) {
  if (!repoRoot || !toolName) throw new Error("Log compaction requires repoRoot and toolName");
  const oldDirectory = path.join(repoRoot, "logs", "old");
  const archiveDirectory = path.join(oldDirectory, "archives");
  await mkdir(archiveDirectory, { recursive: true });
  const entries = (await readdir(oldDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${toolName}-`))
    .map((entry) => entry.name)
    .sort();
  if (entries.length <= maxLooseFiles) return { archivedFiles: 0, archivePath: null };

  const candidates = entries.slice(0, Math.max(0, entries.length - retainLooseFiles));
  const records = [];
  let bytes = 0;
  for (const name of candidates) {
    const filePath = path.join(oldDirectory, name);
    const content = await readFile(filePath, "utf8");
    const size = Buffer.byteLength(content);
    if (records.length > 0 && bytes + size > maxBundleBytes) break;
    records.push({
      name,
      size,
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    });
    bytes += size;
  }
  if (records.length === 0) return { archivedFiles: 0, archivePath: null };

  const stamp = timestampForPath(new Date());
  const archiveName = `${toolName}-${stamp}-${records.length}.logbundle.jsonl.gz`;
  const archivePath = path.join(archiveDirectory, archiveName);
  const uncompressed = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const compressed = gzipSync(Buffer.from(uncompressed, "utf8"), { level: 9 });
  await writeFile(archivePath, compressed);
  const writtenArchive = await readFile(archivePath);
  const roundTrip = gunzipSync(writtenArchive);
  if (!roundTrip.equals(Buffer.from(uncompressed, "utf8"))) {
    await unlink(archivePath);
    throw new Error("Tool log archive failed gzip round-trip verification");
  }
  const manifest = {
    schemaVersion: 1,
    toolName,
    archiveFile: archiveName,
    archivedFiles: records.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    uncompressedSha256: createHash("sha256").update(uncompressed).digest("hex"),
    compressedSha256: createHash("sha256").update(writtenArchive).digest("hex"),
    createdAtUtc: new Date().toISOString(),
  };
  await writeJsonAtomic(`${archivePath}.manifest.json`, manifest);
  for (const record of records) await unlink(path.join(oldDirectory, record.name));
  return {
    archivedFiles: records.length,
    archivePath,
    compressedBytes: compressed.length,
    uncompressedBytes: Buffer.byteLength(uncompressed),
  };
}
