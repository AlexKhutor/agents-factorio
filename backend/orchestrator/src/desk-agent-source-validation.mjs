import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Validates a controller source that is a desk agent (route claude-desk-agent):
// its registry entry, its coordination folder's child contract and its desk
// registration record. The controller's PowerShell source resolution runs it
// (orchestration_common.ps1); it has no imports so it installs as one file.

export const DESK_AGENT_ROUTE = "claude-desk-agent";
export const DESK_AGENT_PROFILE = "claude-desk";

function check(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }

async function readJson(file) {
  for (let cursor = file; cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
    const info = await lstat(cursor).catch(() => null);
    check(info !== null, "desk_source_missing_file");
    check(!info.isSymbolicLink(), "desk_source_linked_path");
  }
  const info = await lstat(file);
  check(info.isFile() && info.size <= 1024 * 1024, "desk_source_invalid_file");
  return JSON.parse(await readFile(file, "utf8"));
}

export async function validateDeskAgentSource(source, workspacePath) {
  check(source.providerRoute === DESK_AGENT_ROUTE && source.executionAdapter === DESK_AGENT_ROUTE
    && source.coordinationProfile === DESK_AGENT_PROFILE && source.executorState === "installed",
  "desk_source_route_mismatch");
  check(typeof source.deskAgentId === "string" && source.deskAgentId.length > 0, "desk_source_agent_missing");
  check(!source.workspaceLauncher && (source.workspaceRelativeSourceRoot ?? ".") === "."
    && source.taskInbox === ".orchestrator/tasks/inbox" && source.reportOutbox === ".orchestrator/reports/outbox",
  "desk_source_paths_mismatch");
  const contract = await readJson(path.join(workspacePath, ".orchestrator", "contract.json"));
  check(contract.sourceId === source.id && contract.kitProfile === DESK_AGENT_PROFILE
    && contract.executorState === "installed", "desk_source_contract_mismatch");
  const record = await readJson(path.join(workspacePath, ".orchestrator", "desk-agent.json"));
  check(record.schemaVersion === 1 && record.sourceId === source.id && record.agentId === source.deskAgentId,
    "desk_source_record_mismatch");
  return { status: "valid", routeId: DESK_AGENT_ROUTE, sourceId: source.id, agentId: record.agentId };
}

// Run as a program only under its own name: bundled into the Gateway runtime,
// import.meta.url is the bundle's and this block must stay silent.
if (process.argv[1] && path.basename(process.argv[1]) === "desk-agent-source-validation.mjs"
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [controlRoot, sourceId, workspacePath, ...rest] = process.argv.slice(2);
    check(!rest.length && path.isAbsolute(controlRoot) && path.isAbsolute(workspacePath), "desk_source_arguments");
    const registry = await readJson(path.join(controlRoot, "config", "source-registry.json"));
    const sources = registry.sources.filter((source) => source.id === sourceId);
    check(sources.length === 1, "desk_source_identity");
    process.stdout.write(`${JSON.stringify(await validateDeskAgentSource(sources[0], workspacePath))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "invalid", problem: error.code ?? "desk_source_invalid_document" })}\n`);
    process.exitCode = 1;
  }
}
