// A projection of public metadata, never a replacement for backend authority.
export const DESKTOP_MEMORY_VERSION = "v0.2.0";
export const DESKTOP_LEVELS = Object.freeze(["world", "project", "quarter", "agent"]);
const pick = (value, keys) => value == null ? null
  : Object.fromEntries(keys.map((key) => [key, structuredClone(value[key] ?? null)]));

export function projectDesktopMemory({ scopes, agents }) {
  if (scopes?.schemaVersion !== 1 || !Array.isArray(scopes.scopes)
      || typeof scopes.truncated !== "boolean" || agents?.schemaVersion !== 1
      || !Number.isSafeInteger(agents.revision) || !Array.isArray(agents.agents)) {
    throw new TypeError("desktop_memory_invalid_catalog");
  }
  const projects = new Map(), quarters = new Map(), scopeIds = new Set(), agentIds = new Set();
  const omissions = [];
  const scopeView = (scope) => ({ scopeId: scope.scopeId, revision: scope.revision,
    sha256: scope.sha256, title: scope.title });
  const key = (projectId, quarterId) => JSON.stringify([projectId, quarterId]);
  for (const scope of scopes.scopes) {
    if (scopeIds.has(scope.scopeId)) throw new TypeError("desktop_memory_duplicate_scope");
    scopeIds.add(scope.scopeId);
    if (scope.kind === "project") {
      if (projects.has(scope.projectId)) throw new TypeError("desktop_memory_duplicate_project");
      projects.set(scope.projectId, { projectId: scope.projectId, memory: scopeView(scope), quarters: [] });
    } else if (scope.kind === "quarter") {
      const id = key(scope.projectId, scope.quarterId);
      if (quarters.has(id)) throw new TypeError("desktop_memory_duplicate_quarter");
      quarters.set(id, { projectId: scope.projectId, quarterId: scope.quarterId,
        memory: scopeView(scope), agents: [] });
    } else throw new TypeError("desktop_memory_invalid_scope_kind");
  }
  for (const quarter of quarters.values()) {
    const project = projects.get(quarter.projectId);
    if (project) project.quarters.push(quarter);
    else omissions.push({ kind: "quarter", id: quarter.quarterId, reason: "project_unavailable" });
  }
  for (const agent of agents.agents) {
    if (agentIds.has(agent.agentId)) throw new TypeError("desktop_memory_duplicate_agent");
    agentIds.add(agent.agentId);
    const quarter = quarters.get(key(agent.projectId, agent.quarterId));
    if (!quarter || !projects.has(agent.projectId)) {
      omissions.push({ kind: "agent", id: agent.agentId, reason: "membership_unavailable" });
      continue;
    }
    quarter.agents.push({ agentId: agent.agentId, projectId: agent.projectId,
      quarterId: agent.quarterId, state: agent.state, contentState: agent.contentState,
      deliveryState: agent.deliveryState, currentOperationId: agent.currentOperationId,
      lastOperation: structuredClone(agent.lastOperation ?? null),
      problemCode: agent.problemCode ?? null,
      requiredManifest: structuredClone(agent.requiredManifest),
      deliveredManifest: structuredClone(agent.deliveredManifest),
      profile: pick(agent.profile, ["provider", "model", "reasoningEffort", "fallbackPolicy"]),
      // Lifecycle and an operation ID do not prove task progress or completion.
      taskProgress: null, attention: pick(agent.attention, ["availability", "coverage",
        "sourceSequence", "sourceRevision", "pendingQuestions", "pendingApprovals", "recoveryRequired", "observedAtUtc"]) });
  }
  return { schemaVersion: 1, contractVersion: DESKTOP_MEMORY_VERSION,
    levels: [...DESKTOP_LEVELS], consistency: "independent-catalogs",
    agentRevision: agents.revision, truncated: scopes.truncated,
    omissions, projects: [...projects.values()] };
}

export function createDesktopMemoryFixture({ empty = false, withAgent = false } = {}) {
  const timestamp = "2026-09-18T00:00:00.000Z";
  const scope = (kind, scopeId, quarterId) => ({ schemaVersion: 1, scopeId, kind, projectId: "example-project",
    quarterId, title: kind === "project" ? "Example project" : "Example feature",
    revision: 1, sha256: "a".repeat(64), author: "fixture", updatedAtUtc: timestamp });
  const result = { scopes: { schemaVersion: 1, truncated: false, scopes: empty ? [] : [
    scope("project", "example-project-memory", null),
    scope("quarter", "example-quarter-memory", "example-quarter"),
  ] }, agents: { schemaVersion: 1, revision: 0, agents: [] } };
  if (withAgent && !empty) {
    const [project, quarter] = result.scopes.scopes.map(({ scopeId, revision, sha256 }) => ({ scopeId, revision, sha256 }));
    const manifest = { project, quarter, manifestHash: "b".repeat(64) };
    result.agents.revision = 1;
    result.agents.agents.push({ agentId: "example-agent", projectId: "example-project",
      quarterId: "example-quarter", operationId: "fixture-create", state: "active",
      profile: { provider: "fixture", model: "fixture-model", reasoningEffort: "max", fallbackPolicy: "deny" },
      binding: { projectId: "fixture-controller", sourceId: "fixture", providerId: "fixture", threadId: "fixture-thread" },
      assignedManifest: structuredClone(manifest), requiredManifest: manifest, deliveredManifest: null,
      currentOperationId: null, lastOperation: null, contentState: "empty", deliveryState: "pending",
      createdAtUtc: timestamp, archivedAtUtc: null, coverage: "captured-only" });
  }
  return result;
}
