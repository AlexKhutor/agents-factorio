// Every operation the window names must exist in the accepted kit.
//
// The readiness panel and the allowlist speak about backend operations by id.
// An id the kit does not know can never be advertised, so a capability looked up
// by an invented name stays "not announced" forever - an honest-looking but
// false report. The kit's own capability catalog, reached only through the
// accepted-delivery loader, is the reference.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAcceptedKit } from "../src/host/kit.mjs";
import { ALLOWED_OPERATIONS, EXPECTED_CAPABILITIES } from "../src/host/operations.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};

const kit = await loadAcceptedKit({ applicationRoot: PROJECT_ROOT });
const testing = await kit.loadTesting();
const catalog = testing.DEFAULT_FAKE_APPLICATION_CAPABILITIES;
const entries = [
  ...Object.values(catalog.surface.operations).flat(),
  ...catalog.providerOperations.definitions,
];
const kinds = new Map(entries.map((entry) => [entry.operation.operationId, entry.resourceKinds ?? []]));
const contracts = new Map(entries.map((entry) => [entry.operation.operationId, entry.binding?.contractId ?? null]));

{
  const unknown = Object.keys(ALLOWED_OPERATIONS).filter((id) => !kinds.has(id));
  check("allowed-operations-are-in-kit", unknown.length === 0, { unknown });
}

{
  const unknown = EXPECTED_CAPABILITIES.flatMap((capability) => capability.operations
    .filter((id) => !kinds.has(id)).map((id) => `${capability.capabilityId}: ${id}`));
  check("expected-names-only-kit-operations", unknown.length === 0, { unknown });
}

{
  // Kit v0.15.0 gives the agent's workspace its own operations. Each one the
  // window reads is bound, in the kit's catalog, to the contract whose schema
  // the host checks it against (src/host/agent-workspace.mjs).
  const wanted = {
    "query.agent-conversation.resolve": "application-agent-conversation",
    "query.agent-conversation.read": "application-agent-conversation",
    "query.project-workspace.list": "application-project-workspace",
    "query.project-workspace.read": "application-project-workspace",
    "query.agent-artifacts.list": "application-agent-artifacts",
    "query.agent-artifacts.read": "application-agent-artifacts",
    "query.agent-events.read": "application-agent-events",
    // Kit v0.16.1: the hash-guarded file save and the atomic project copy.
    "mutation.project-workspace.save": "application-project-workspace-save",
    "mutation.memory.project.copy": "application-project-copy",
  };
  const problems = Object.entries(wanted)
    .filter(([id, contract]) => !Object.hasOwn(ALLOWED_OPERATIONS, id) || contracts.get(id) !== contract)
    .map(([id, contract]) => `${id}: expected ${contract}, kit has ${contracts.get(id) ?? "nothing"}`);
  check("workspace-read-by-its-own-kit-contracts", problems.length === 0, { problems });
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "contract",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
