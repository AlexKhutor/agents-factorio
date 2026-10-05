import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { open, readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { writeProjectionAtomic } from "./control-read-model.mjs";

const INDEX_SCHEMA_VERSION = 1;
const MAX_RECORDS = 5_000;
const MAX_SESSION_FILES = 10_000;
const MAX_METADATA_BYTES = 256 * 1024;
const INLINE_MEDIA = /data:(?:image|audio|video)\//i;
const SERVICE_STATUSES = new Set([
  "starting",
  "running",
  "completed",
  "interrupted",
  "failed",
  "stop_unconfirmed",
  "migrated",
]);

function boundedText(value, maximum = 2_048) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (INLINE_MEDIA.test(text)) throw new Error("Service review metadata must not contain inline media");
  return text.length <= maximum ? text : `${text.slice(0, maximum - 15)}...<truncated>`;
}

function boundedProblems(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => boundedText(value, 512))
    .filter(Boolean))].slice(0, 20);
}

function relativeLocator(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || /^[a-z]:\//i.test(normalized)) {
    throw new Error(`${label} must be relative`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) throw new Error(`${label} escapes its root`);
  return normalized;
}

function normalizedReference(value, label) {
  if (!value) return null;
  const referencePath = relativeLocator(value.path, `${label}.path`);
  if (!referencePath) return null;
  const sha256 = value.sha256 ? String(value.sha256).toLowerCase() : null;
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label}.sha256 is invalid`);
  return { path: referencePath, sha256 };
}

function normalizedRawTrace(value = {}) {
  const locator = relativeLocator(value.locator, "rawTrace.locator");
  const sha256 = value.sha256 ? String(value.sha256).toLowerCase() : null;
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("rawTrace.sha256 is invalid");
  const bytes = value.bytes === null || value.bytes === undefined ? null : Number(value.bytes);
  if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0)) {
    throw new Error("rawTrace.bytes is invalid");
  }
  return {
    available: Boolean(value.available && locator),
    home: "reviewer-codex-home",
    locator,
    sha256,
    bytes,
    archiveState: ["live", "copied", "archived", "missing", "not-applicable"].includes(value.archiveState)
      ? value.archiveState
      : locator
        ? "live"
        : "missing",
  };
}

function normalizeRecord(record) {
  const serviceRunId = String(record.serviceRunId ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/.test(serviceRunId)) {
    throw new Error(`Invalid serviceRunId '${serviceRunId}'`);
  }
  const status = String(record.status ?? "starting");
  if (!SERVICE_STATUSES.has(status)) throw new Error(`Invalid service review status '${status}'`);
  const updatedAtUtc = record.updatedAtUtc ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(updatedAtUtc))) throw new Error("Service review updatedAtUtc is invalid");
  const attempt = record.attempt === null || record.attempt === undefined ? null : Number(record.attempt);
  if (attempt !== null && (!Number.isSafeInteger(attempt) || attempt < 0)) {
    throw new Error("Service review attempt is invalid");
  }
  const startedAtUtc = record.startedAtUtc ?? updatedAtUtc;
  const finishedAtUtc = record.finishedAtUtc ?? null;
  if (!Number.isFinite(Date.parse(startedAtUtc))) throw new Error("Service review startedAtUtc is invalid");
  if (finishedAtUtc && !Number.isFinite(Date.parse(finishedAtUtc))) {
    throw new Error("Service review finishedAtUtc is invalid");
  }
  return {
    serviceRunId,
    kind: "child-report-review",
    sourceId: boundedText(record.sourceId, 96),
    taskId: boundedText(record.taskId, 96),
    itemId: boundedText(record.itemId, 256),
    attempt,
    provider: boundedText(record.provider, 64) ?? "unknown",
    serviceName: boundedText(record.serviceName, 128),
    model: boundedText(record.model, 128),
    codexVersion: boundedText(record.codexVersion, 128),
    clientVersion: boundedText(record.clientVersion, 64),
    promptTemplateVersion: boundedText(record.promptTemplateVersion, 64),
    status,
    resultSummary: boundedText(record.resultSummary, 2_048),
    problems: boundedProblems(record.problems ?? []),
    report: normalizedReference(record.report, "report"),
    decision: normalizedReference(record.decision, "decision"),
    threadId: boundedText(record.threadId, 256),
    turnId: boundedText(record.turnId, 256),
    startedAtUtc,
    finishedAtUtc,
    rawTrace: normalizedRawTrace(record.rawTrace),
    updatedAtUtc,
  };
}

async function readIndex(indexPath) {
  try {
    const value = JSON.parse(await readFile(indexPath, "utf8"));
    if (value?.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(value.records)) {
      throw new Error(`Unsupported service review index at '${indexPath}'`);
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { schemaVersion: INDEX_SCHEMA_VERSION, generatedAtUtc: null, records: [] };
    }
    throw error;
  }
}

async function listSessionFiles(root) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(candidate);
      if (result.length > MAX_SESSION_FILES) {
        throw new Error(`Reviewer CODEX_HOME exceeds the ${MAX_SESSION_FILES} session-file scan budget`);
      }
    }
  }
  return result;
}

async function readSessionMetadata(filePath) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_METADATA_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
    const record = JSON.parse(firstLine);
    const payload = record?.type === "session_meta" ? record.payload : null;
    return payload ? {
      sessionId: payload.id ? String(payload.id) : null,
      cliVersion: payload.cli_version ? String(payload.cli_version) : null,
      modelProvider: payload.model_provider ? String(payload.model_provider) : null,
      createdAtUtc: payload.timestamp ? String(payload.timestamp) : null,
    } : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), bytes };
}

export function createServiceRunId() {
  return `review-${randomUUID()}`;
}

export async function locateCodexRollout(codexHome, threadId, {
  attempts = 5,
  retryDelayMs = 100,
} = {}) {
  if (!codexHome || !threadId) return normalizedRawTrace({ archiveState: "not-applicable" });
  const resolvedHome = path.resolve(codexHome);
  const sessionsRoot = path.join(resolvedHome, "sessions");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const files = await listSessionFiles(sessionsRoot);
    const likely = files.filter((filePath) => path.basename(filePath).includes(String(threadId)));
    const candidates = likely.length > 0 ? likely : files;
    for (const filePath of candidates) {
      const metadata = await readSessionMetadata(filePath);
      if (metadata?.sessionId !== String(threadId)) continue;
      const digest = await hashFile(filePath);
      return {
        available: true,
        home: "reviewer-codex-home",
        locator: path.relative(resolvedHome, filePath).replaceAll(path.sep, "/"),
        sha256: digest.sha256,
        bytes: digest.bytes,
        archiveState: "live",
        cliVersion: metadata.cliVersion,
        modelProvider: metadata.modelProvider,
        createdAtUtc: metadata.createdAtUtc,
      };
    }
    if (attempt + 1 < attempts) await delay(retryDelayMs);
  }
  return normalizedRawTrace({ archiveState: "missing" });
}

export class ServiceReviewRegistry {
  constructor({ indexPath, codexHome, maxRecords = MAX_RECORDS } = {}) {
    if (!indexPath) throw new Error("ServiceReviewRegistry requires indexPath");
    if (!codexHome) throw new Error("ServiceReviewRegistry requires reviewer codexHome");
    this.indexPath = path.resolve(indexPath);
    this.codexHome = path.resolve(codexHome);
    this.maxRecords = maxRecords;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    const current = await readIndex(this.indexPath);
    if (current.generatedAtUtc === null) await this.#write(current.records);
    return { schemaVersion: INDEX_SCHEMA_VERSION, recordCount: current.records.length };
  }

  async list({ sourceId, taskId, serviceRunId, limit = 500 } = {}) {
    const current = await readIndex(this.indexPath);
    return current.records
      .map(normalizeRecord)
      .filter((record) => !sourceId || record.sourceId === sourceId)
      .filter((record) => !taskId || record.taskId === taskId)
      .filter((record) => !serviceRunId || record.serviceRunId === serviceRunId)
      .sort((left, right) => Date.parse(right.updatedAtUtc) - Date.parse(left.updatedAtUtc))
      .slice(0, Math.max(1, Math.min(Number(limit) || 500, this.maxRecords)));
  }

  async get(serviceRunId) {
    return (await this.list({ serviceRunId, limit: 1 }))[0] ?? null;
  }

  async upsert(record) {
    const normalized = normalizeRecord(record);
    this.writeQueue = this.writeQueue.then(async () => {
      const current = await readIndex(this.indexPath);
      const records = current.records.filter((candidate) => candidate.serviceRunId !== normalized.serviceRunId);
      records.push(normalized);
      records.sort((left, right) => Date.parse(right.updatedAtUtc) - Date.parse(left.updatedAtUtc));
      await this.#write(records.slice(0, this.maxRecords));
    });
    await this.writeQueue;
    return normalized;
  }

  async patch(serviceRunId, patch) {
    const current = await this.get(serviceRunId);
    if (!current) throw new Error(`Unknown service review '${serviceRunId}'`);
    return this.upsert({ ...current, ...patch, serviceRunId, updatedAtUtc: new Date().toISOString() });
  }

  locateRawTrace(threadId, options) {
    return locateCodexRollout(this.codexHome, threadId, options);
  }

  async #write(records) {
    await writeProjectionAtomic(this.indexPath, {
      schemaVersion: INDEX_SCHEMA_VERSION,
      generatedAtUtc: new Date().toISOString(),
      records,
    });
  }
}
