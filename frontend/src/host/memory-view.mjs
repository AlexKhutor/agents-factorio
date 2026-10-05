// Builds the four-level view: World -> Project -> Quarter -> Agent.
//
// The projection itself comes from the kit (projectDesktopMemory), so joins,
// omissions and truncation stay exactly as the backend reports them. What this
// module adds is honest failure handling and the attention list - and attention
// is derived only from observed state, never invented.

// The kit's desktop projection is handed in by the caller from the verified
// kit (see kit.mjs); this module imports no kit file of its own.

/**
 * How many interaction reads may be in flight at once. They used to run one
 * after another - twenty-seven round trips on the fixture for every refresh of
 * the world. The gateway is local, but it is still one process serving the
 * whole desk, so the parallelism is bounded rather than unlimited.
 */
export const INTERACTION_READ_CONCURRENCY = 6;

/** Runs `task` over `items` with at most `limit` in flight; results keep input order. */
export async function mapBounded(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

function catalogOf(response) {
  if (!response.ok) return { status: "error", error: response.error };
  const { result } = response;
  if (result.outcome !== "succeeded") {
    return {
      status: "not-delivered",
      outcome: result.outcome,
      error: result.error ?? null,
    };
  }
  return { status: "delivered", output: result.output };
}

/**
 * Attention is what a person must look at, observed only:
 * a pending question, a recorded problem, or a failed/uncertain state.
 * Lifecycle alone is never "progress" and never implies completion.
 */
function attentionFor(projection, interactionsByAgent) {
  const items = [];
  for (const project of projection.projects) {
    for (const quarter of project.quarters) {
      for (const agent of quarter.agents) {
        const pending = interactionsByAgent.get(agent.agentId) ?? [];
        for (const record of pending) {
          items.push({
            kind: "interaction",
            agentId: agent.agentId,
            projectId: agent.projectId,
            quarterId: agent.quarterId,
            interactionId: record.interactionId ?? null,
            title: record.display?.title ?? null,
            interactionKind: record.display?.kind ?? null,
            state: record.state ?? null,
            requestedAtUtc: record.requestedAtUtc ?? null,
            deadlineAtUtc: record.deadlineAtUtc ?? null,
          });
        }
        // Captured attention from the catalog (Kit v0.15.0). Unavailable or
        // null counts say nothing, so they add nothing; they are never zero.
        const captured = agent.attention;
        if (captured?.availability === "available") {
          if (captured.recoveryRequired > 0) {
            items.push({
              kind: "recovery", agentId: agent.agentId, projectId: agent.projectId, quarterId: agent.quarterId,
              count: captured.recoveryRequired, observedAtUtc: captured.observedAtUtc,
            });
          }
          const reported = captured.pendingQuestions + captured.pendingApprovals;
          if (reported > pending.length) {
            items.push({
              kind: "captured-pending", agentId: agent.agentId, projectId: agent.projectId, quarterId: agent.quarterId,
              questions: captured.pendingQuestions, approvals: captured.pendingApprovals, visible: pending.length,
              observedAtUtc: captured.observedAtUtc,
            });
          }
        }
        if (agent.problemCode !== null) {
          items.push({
            kind: "problem",
            agentId: agent.agentId,
            projectId: agent.projectId,
            quarterId: agent.quarterId,
            problemCode: agent.problemCode,
          });
        }
        for (const [field, value] of [["state", agent.state], ["deliveryState", agent.deliveryState]]) {
          if (value === "failed" || value === "uncertain") {
            items.push({
              kind: "state",
              agentId: agent.agentId,
              projectId: agent.projectId,
              quarterId: agent.quarterId,
              field,
              value,
            });
          }
        }
      }
    }
  }
  return items;
}

const BINDING_FIELDS = Object.freeze(["projectId", "sourceId", "providerId", "threadId"]);

function pick(value, fields) {
  if (value === null || typeof value !== "object") return null;
  return Object.fromEntries(fields.filter((field) => field in value).map((field) => [field, value[field]]));
}

/**
 * The kit's desktop projection (v0.2.0) carries the profile and the captured
 * attention, but not the binding. The binding is joined back by agentId,
 * exactly as the catalog returned it - a field the catalog did not send stays
 * absent, it is never filled with a default. The profile is marked as what it
 * is: the requested profile, not a provider observation of the effort used.
 * The kit's projection object itself is not modified.
 */
function withCatalogIdentity(projection, agentsCatalog) {
  const byId = new Map((agentsCatalog?.agents ?? []).map((agent) => [agent.agentId, agent]));
  return {
    ...projection,
    projects: projection.projects.map((project) => ({
      ...project,
      quarters: project.quarters.map((quarter) => ({
        ...quarter,
        agents: quarter.agents.map((agent) => {
          const source = byId.get(agent.agentId);
          return {
            ...agent,
            profileSource: agent.profile === null || agent.profile === undefined ? null : "requested",
            binding: pick(source?.binding, BINDING_FIELDS),
            // The agent's role (feature, project-lead, quarter-lead,
            // coordinator) and the settings revision a role change must name:
            // the lead of a project or quarter is found by it.
            settings: pick(source?.settings, ["role", "revision"]),
          };
        }),
      })),
    })),
  };
}

/**
 * Reads both catalogs and projects them. Interaction reads are best effort: the
 * tree must still render when that operation is not advertised, and a missing
 * read is reported as missing rather than as "no questions pending".
 */
export async function buildWorldView(gateway, { desktop, withInteractions = true } = {}) {
  if (desktop === undefined || typeof desktop.projectDesktopMemory !== "function") {
    throw new TypeError("buildWorldView needs the verified kit's desktop module");
  }
  const [scopes, agents] = await Promise.all([
    gateway.run("query.memory.scopes.list", {}),
    gateway.run("query.memory.agents.list", {}),
  ]);
  const catalogs = { scopes: catalogOf(scopes), agents: catalogOf(agents) };
  if (catalogs.scopes.status !== "delivered" || catalogs.agents.status !== "delivered") {
    return { status: "unavailable", catalogs, projection: null, attention: [], interactions: null };
  }

  const project = (agentsOutput) => withCatalogIdentity(desktop.projectDesktopMemory({
    scopes: catalogs.scopes.output,
    agents: agentsOutput,
  }), agentsOutput);
  let projection;
  try {
    projection = project(catalogs.agents.output);
  } catch (error) {
    return {
      status: "invalid",
      catalogs,
      projection: null,
      attention: [],
      interactions: null,
      error: { code: error?.message ?? "desktop_memory_invalid_catalog", message: "Catalog projection failed" },
    };
  }

  const interactionsByAgent = new Map();
  let interactions = null;
  if (withInteractions) {
    interactions = { status: "delivered", perAgent: [] };
    // One read per agent, because the catalog does not carry a pending count
    // yet. The reads run in parallel; what is recorded stays in catalog order,
    // so the result is the same as it was when they ran one by one.
    const agents = projection.projects.flatMap((project) =>
      project.quarters.flatMap((quarter) => quarter.agents));
    const responses = await mapBounded(agents, INTERACTION_READ_CONCURRENCY,
      (agent) => gateway.run("query.agent-control.interactions", { agentId: agent.agentId, limit: 16 }));
    agents.forEach((agent, index) => {
      const catalog = catalogOf(responses[index]);
      if (catalog.status !== "delivered") {
        interactions.status = "partial";
        interactions.perAgent.push({ agentId: agent.agentId, ...catalog });
        return;
      }
      const records = catalog.output?.records ?? [];
      const pending = records.filter((record) => record.state === "awaiting-owner");
      interactionsByAgent.set(agent.agentId, pending);
      interactions.perAgent.push({
        agentId: agent.agentId,
        status: "delivered",
        recordCount: records.length,
        pendingCount: pending.length,
        // The recent page may be cut: then the visible records are not all of them.
        truncated: typeof catalog.output?.truncated === "boolean" ? catalog.output.truncated : null,
        omissionCount: Number.isSafeInteger(catalog.output?.omissionCount) ? catalog.output.omissionCount : null,
      });
    });

    // The catalog's captured attention was read before the questions. Read it
    // again, so the counts shown next to the questions are not older than them.
    const reread = catalogOf(await gateway.run("query.memory.agents.list", {}));
    catalogs.agentsAfterInteractions = reread.status === "delivered" ? { status: "delivered" } : reread;
    if (reread.status === "delivered") {
      try {
        projection = project(reread.output);
        catalogs.agents = reread;
      } catch (error) {
        catalogs.agentsAfterInteractions = {
          status: "invalid", error: { code: error?.message ?? "desktop_memory_invalid_catalog" },
        };
      }
    }
  }

  return {
    status: "ready",
    catalogs,
    projection,
    interactions,
    attention: attentionFor(projection, interactionsByAgent),
  };
}
