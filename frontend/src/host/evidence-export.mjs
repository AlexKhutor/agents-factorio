// Writes one run's read journal to a folder the operator chose.
//
// The trusted host decides everything about the path: the renderer and the
// gateway never supply one. The chosen folder must be a real directory reached
// without a symbolic link or junction; inside it, a new folder named after the
// run is created and must not exist yet, so an earlier package is never
// overwritten. Files are created exclusively. A failed write is reported as a
// failure, and an incomplete or truncated journal says so in the package.

import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const RUN_ID = /^atlas-(fixture|live)-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;

// Stated in every package, so a reader knows what was left out on purpose.
const EXCLUDED = Object.freeze([
  "bearer token, endpoint, authorization headers and the descriptor body",
  "memory entry titles and texts, conversation text, prompts and interaction payloads",
  "error messages and stacks; only error codes, reason codes, status, retryable and phase",
  "cursors (only whether one was supplied)",
]);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const refuse = (code, reasonCode = null, extra = {}) => ({ ok: false, error: { code, reasonCode, ...extra } });

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function exportEvidence({ journal, baseDirectory, now = () => new Date() }) {
  if (journal === null || typeof journal !== "object" || !RUN_ID.test(journal.runId)) {
    return refuse("evidence_unavailable", "run_invalid");
  }
  if (typeof baseDirectory !== "string" || !path.isAbsolute(baseDirectory)) {
    return refuse("evidence_directory_invalid", "not_absolute");
  }
  const base = path.resolve(baseDirectory);
  let stat;
  try {
    stat = await lstat(base);
  } catch (error) {
    return refuse("evidence_directory_unavailable", error?.code ?? null);
  }
  if (stat.isSymbolicLink()) return refuse("evidence_path_reparse", "link");
  if (!stat.isDirectory()) return refuse("evidence_directory_invalid", "not_directory");
  let real;
  try {
    real = await realpath(base);
  } catch (error) {
    return refuse("evidence_directory_unavailable", error?.code ?? null);
  }
  // A link or junction anywhere along the way makes the real path differ.
  if (!samePath(real, base)) return refuse("evidence_path_reparse", "ancestor");

  const snapshot = journal.snapshot();
  const document = {
    format: "atlas-read-evidence/1",
    exportedAtUtc: now().toISOString(),
    header: snapshot.header,
    completeness: snapshot.completeness,
    truncation: snapshot.truncation,
    limits: snapshot.limits,
    excluded: EXCLUDED,
    notes: [
      "entries: reads made through the host gateway module, in start order",
      "requestId/correlationId: as returned by the kit in the result envelope; null when none came back",
      "dispatches: requests as this host saw them leave, with the ids it sent; not a gateway record",
      "capabilitySnapshots: operation statuses from discovery, separate from the calls; identical consecutive snapshots of one descriptor are one entry with seenCount and lastSeenUtc",
      "identity: the descriptor the call ran against, taken when the call started",
      "gatewayIdentities: every distinct descriptor seen in this run, with when it was first seen",
      "entryKind: read, receipt, mutation, approval or trusted-action; via: ui-ipc (a person in the window), capture (an unattended scene) or host-direct (a script)",
      "mutationOperationId and commandId: the ids the host minted for a change - not gateway request ids",
      "status: success, accepted, failure, uncertain (the outcome is unknown and must not be retried), not-attempted (nothing reached the gateway or the CLI) or in-progress",
    ],
    gatewayIdentities: snapshot.gatewayIdentities,
    capabilitySnapshots: snapshot.capabilitySnapshots,
    entries: snapshot.entries,
    dispatches: snapshot.dispatches,
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > EVIDENCE_MAX_BYTES) {
    return refuse("evidence_too_large", null, { bytes: Buffer.byteLength(text, "utf8") });
  }

  const folder = path.join(base, journal.runId);
  try {
    await mkdir(folder);
  } catch (error) {
    return error?.code === "EEXIST"
      ? refuse("evidence_exists", "run_folder_exists")
      : refuse("evidence_write_failed", error?.code ?? null, { written: [] });
  }
  const written = [];
  try {
    await writeFile(path.join(folder, "evidence.json"), text, { flag: "wx" });
    written.push("evidence.json");
    const sums = `${sha256(text)}  evidence.json\n`;
    await writeFile(path.join(folder, "SHA256SUMS"), sums, { flag: "wx" });
    written.push("SHA256SUMS");
    return {
      ok: true,
      data: {
        saved: true,
        runId: journal.runId,
        directoryName: journal.runId,
        files: [{ name: "evidence.json", sha256: sha256(text) }],
        sumsSha256: sha256(sums),
        complete: document.completeness.complete,
        truncated: document.completeness.truncated,
        inProgress: document.completeness.inProgress,
      },
    };
  } catch (error) {
    return refuse("evidence_write_failed", error?.code ?? null, { written });
  }
}
