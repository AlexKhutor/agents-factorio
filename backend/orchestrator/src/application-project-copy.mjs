import { ApplicationContractError } from "./application-contract.mjs";

export const APPLICATION_PROJECT_COPY_VERSION = "v0.1.0";
export const APPLICATION_PROJECT_COPY_OPERATION = "mutation.memory.project.copy";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

function conflict() { throw new ApplicationContractError("conflict", "Project copy input is invalid"); }
function id(value) { if (typeof value !== "string" || !ID.test(value)) conflict(); return value; }
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== keys.length
      || keys.some((key) => !Object.hasOwn(value, key))) conflict();
}

function normalize(value) {
  exact(value, ["sourceProjectId", "targetProjectId", "targetProjectScopeId",
    "quarterScopeIds", "operationId"]);
  const sourceProjectId = id(value.sourceProjectId);
  const targetProjectId = id(value.targetProjectId);
  if (sourceProjectId === targetProjectId) conflict();
  if (!value.quarterScopeIds || typeof value.quarterScopeIds !== "object"
      || Array.isArray(value.quarterScopeIds)
      || Object.keys(value.quarterScopeIds).length > 511) conflict();
  const quarterScopeIds = Object.fromEntries(Object.entries(value.quarterScopeIds)
    .map(([quarterId, scopeId]) => [id(quarterId), id(scopeId)]));
  const targetProjectScopeId = id(value.targetProjectScopeId);
  if (new Set([targetProjectScopeId, ...Object.values(quarterScopeIds)]).size
      !== Object.keys(quarterScopeIds).length + 1) conflict();
  return { sourceProjectId, targetProjectId, targetProjectScopeId,
    quarterScopeIds, operationId: id(value.operationId) };
}

export function createApplicationProjectCopyHandler({ store } = {}) {
  if (!store || typeof store.copyProject !== "function") throw new TypeError("copyProject store is required");
  return async (request) => {
    const input = normalize(request?.input);
    try { return structuredClone(await store.copyProject(input)); }
    catch (error) {
      if (error instanceof ApplicationContractError) throw error;
      const code = error?.code;
      if (code === "memory_operation_conflict" || code === "memory_scope_conflict"
          || code === "memory_project_scope_required" || code === "memory_invalid_input") {
        throw new ApplicationContractError("conflict", "Project copy conflicts with memory state");
      }
      if (code === "memory_limit_exceeded") {
        throw new ApplicationContractError("conflict", "Project copy exceeds supported size");
      }
      throw new ApplicationContractError("source_unavailable", "Project copy result is unavailable");
    }
  };
}
