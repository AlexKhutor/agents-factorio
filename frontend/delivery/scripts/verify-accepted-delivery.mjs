import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_LOCK = new URL("../contracts/accepted-delivery.v1.json", import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireValue(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
async function readInside(root, relative) {
  requireValue(typeof relative === "string" && relative.length > 0
    && !relative.includes("\\") && !relative.includes(":")
    && !path.isAbsolute(relative)
    && relative.split("/").every((part) => part && part !== "." && part !== ".."), "unsafe_path");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    requireValue(!(await lstat(current)).isSymbolicLink(), "linked_payload");
  }
  requireValue((await lstat(current)).isFile(), "payload_not_file");
  return readFile(current);
}

// Read-only artifact verification, not executor activation or runtime readiness.
export async function verifyAcceptedDelivery({ root, artifact, profile = "distribution", lockPath = DEFAULT_LOCK }) {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  requireValue(lock.schemaVersion === 1 && typeof lock.releaseId === "string", "unsupported_lock");
  requireValue(["frontend", "child-agent-kit"].includes(artifact), "unknown_artifact");
  requireValue(typeof root === "string" && root.length > 0, "root_required");
  const resolved = path.resolve(root);
  requireValue(!(await lstat(resolved)).isSymbolicLink(), "linked_root");
  const directory = await realpath(resolved);
  const pin = artifact === "frontend" ? lock.frontend : lock.childAgentKit;
  const installed = profile !== "distribution";
  requireValue(artifact !== "frontend" || !installed, "invalid_profile");
  requireValue(!installed || Object.hasOwn(pin.payloadSha256, profile), "invalid_profile");
  const manifestName = artifact === "frontend" ? "manifest.json"
    : installed ? ".orchestrator/kit-manifest.json" : "kit-manifest.json";
  const bytes = await readInside(directory, manifestName);
  requireValue(digest(bytes) === pin.manifestSha256, "manifest_hash_mismatch");
  const manifest = JSON.parse(bytes);
  requireValue(manifest.kitVersion === pin.version, "version_mismatch");
  requireValue(Array.isArray(manifest.files) && manifest.files.length > 0, "invalid_inventory");
  let entries;
  if (artifact === "frontend") {
    entries = manifest.files;
  } else {
    requireValue(manifest.taskContractVersion === pin.taskContractVersion
      && manifest.reportContractVersion === pin.reportContractVersion, "contract_mismatch");
    const exclusions = installed
      ? [...manifest.commonExcludedFiles, ...manifest.profiles[profile].excludedFiles] : [];
    entries = manifest.files.filter((name) => !exclusions.includes(name)).map((name) => ({ path: name }));
    if (installed) {
      const contract = JSON.parse(await readInside(directory, ".orchestrator/contract.json"));
      requireValue(contract.kitProfile === profile && contract.kitVersion === pin.version
        && contract.taskContractVersion === pin.taskContractVersion
        && contract.reportContractVersion === pin.reportContractVersion, "installed_contract_mismatch");
    }
  }
  requireValue(new Set(entries.map((entry) => entry.path)).size === entries.length, "duplicate_path");
  const inventory = [];
  for (const entry of entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const content = await readInside(directory, entry.path);
    const sha256 = digest(content);
    if (artifact === "frontend") {
      requireValue(sha256 === entry.sha256 && content.length === entry.bytes, "payload_hash_mismatch");
    }
    inventory.push({ path: entry.path, sha256 });
  }
  if (artifact !== "frontend") {
    requireValue(digest(JSON.stringify(inventory)) === pin.payloadSha256[profile], "payload_hash_mismatch");
  }
  return { status: "verified", releaseId: lock.releaseId, artifact, profile,
    version: pin.version, manifestSha256: pin.manifestSha256, filesChecked: inventory.length,
    runtimeReadiness: "not-checked", executorAcceptance: "not-checked" };
}

async function main(args) {
  const options = {};
  const names = { "--root": "root", "--artifact": "artifact", "--profile": "profile", "--lock": "lockPath" };
  try {
    for (let i = 0; i < args.length; i += 2) {
      requireValue(Object.hasOwn(names, args[i]) && args[i + 1]
        && !args[i + 1].startsWith("--") && !Object.hasOwn(options, names[args[i]]), "invalid_arguments");
      options[names[args[i]]] = args[i + 1];
    }
    console.log(JSON.stringify(await verifyAcceptedDelivery(options)));
  } catch (error) {
    console.log(JSON.stringify({ status: "rejected", reasonCode: error.code ?? "invalid_delivery" }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2));
}
