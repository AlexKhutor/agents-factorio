// DEVELOPMENT ONLY. A local stand-in for the Application gateway.
//
// It exists so the renderer can be built while the installed gateway is not
// ready. It is loaded only under --dev-fixture, it opens no listener, it speaks
// the real transport shape so the real kit client is exercised unchanged, and
// every identity in it is synthetic. Nothing here is authority to send anything:
// the UI shows a permanent fixture banner whenever it is in use.

import { randomUUID } from "node:crypto";
import {
  INTERACTIONS, UNCERTAIN_AGENT, agent, fixtureWorld, manifest, scope, sha256,
} from "./fixture-world.mjs";
import {
  ARTIFACTS, FIXTURE_REVISION, PROJECT_FILES, conversationIdOf, conversationPage,
} from "./fixture-workspace.mjs";

// The fixture reads one example from the kit, through the verified kit handed
// in by the session (see src/host/kit.mjs): a fixture run is held to the same
// accepted delivery as a live one.

const CONTRACT_VERSION = "v0.1.0";
const CAPABILITY_VERSION = "v0.2.0";
const DISCOVERY_OPERATION_ID = "discovery.application.capabilities";

const IMPLEMENTED = Object.freeze({
  "query.memory.scopes.list": "query",
  "query.memory.scope.read": "query",
  "query.memory.agents.list": "query",
  "query.memory.agent.read": "query",
  "query.memory.agent.context": "query",
  "query.memory.agent.archive": "query",
  "query.agent-control.interactions": "query",
  "query.agent-conversation.resolve": "query",
  "query.agent-conversation.read": "query",
  "query.project-workspace.list": "query",
  "query.project-workspace.read": "query",
  "query.agent-artifacts.list": "query",
  "query.agent-artifacts.read": "query",
  "query.agent-events.read": "query",
  "mutation.project-workspace.save": "mutation",
  "mutation.memory.project.copy": "mutation",
  "receipt.memory.agent.send": "receipt-lookup",
  "mutation.memory.scope.create": "mutation",
  "mutation.memory.agent.create": "mutation",
  "mutation.memory.agent.send": "mutation",
  "mutation.memory.agent.close": "mutation",
  "approval.agent-control.respond": "approval",
  "mutation.agent-control.interrupt": "mutation",
  // Kit v0.21.0: steer or queue a message, take a queued one back, change the model, read the trace.
  "mutation.memory.agent.steer": "mutation",
  "mutation.memory.agent.unqueue": "mutation",
  "mutation.memory.agent.profile": "mutation",
  "query.memory.agent.trace": "query",
});

/** A trace as the backend keeps it (claude-code-session-journal.mjs), for the fixture's agents. */
function fixtureTrace(agentId, at) {
  const turnId = `fixture-turn-${agentId}`;
  const time = (seconds) => new Date(new Date(at).getTime() - (120 - seconds) * 1000).toISOString();
  return [
    { atUtc: time(0), turnId, type: "turn_started", model: "fixture-model", effort: "high",
      displayText: "Check the memory and make a table.",
      text: "Backend memory snapshot. Project rules take precedence over quarter details.\n"
        + "{\"manifest\":{\"manifestHash\":\"fixture\"},\"project\":[{\"title\":\"Goal\",\"text\":\"…\"}]}\n"
        + "Your role: lead of quarter core-q1 of project platform-core.\nUser task:\nCheck the memory and make a table." },
    { atUtc: time(2), turnId, type: "session", model: "fixture-model", cwd: "F:/fixture/project", claudeCodeVersion: "2.1.288" },
    { atUtc: time(6), turnId, type: "thinking", text: "First I will look at what is in the folder, then check the quarter memory." },
    { atUtc: time(9), turnId, type: "tool_use", toolUseId: "toolu_fixture_1", tool: "Bash",
      input: "{\"command\":\"ls -la\",\"description\":\"Contents of the project folder\"}" },
    { atUtc: time(10), turnId, type: "tool_result", toolUseId: "toolu_fixture_1", isError: false,
      output: "total 3\ndrwxr-xr-x  notes\n-rw-r--r--  README.md" },
    { atUtc: time(30), turnId, type: "user_input", delivery: "steer", clientId: "atlas-send-fixture",
      displayText: "And add the check date to the table." },
    { atUtc: time(40), turnId, type: "tool_use", toolUseId: "toolu_fixture_2", tool: "Write",
      input: "{\"file_path\":\"notes.md\",\"content\":\"| Memory | State |\\n|---|---|\"}" },
    { atUtc: time(41), turnId, type: "tool_result", toolUseId: "toolu_fixture_2", isError: false,
      output: "File created successfully at: notes.md", diff: "@@ -0,0 +1,3 @@\n+| Memory | State |\n+|---|---|\n+| project | readable |" },
    { atUtc: time(60), turnId, type: "assistant", model: "fixture-model",
      text: "**What was checked.** Project and quarter memory can be read, no errors. File `notes.md` created." },
    { atUtc: time(61), turnId, type: "turn_finished", status: "completed", failure: null, resultSubtype: "success",
      durationMs: 61000, numTurns: 4, costUsd: 0.0412,
      usage: { inputTokens: 1200, outputTokens: 640, cacheReadInputTokens: 18000, cacheCreationInputTokens: 2400 },
      models: { "fixture-model": { inputTokens: 1200, outputTokens: 640, costUsd: 0.0412, contextWindow: 200000 } } },
  ];
}

export const DEV_WORKSPACE = Object.freeze({
  projectId: "atlas-dev-fixture",
  sourceId: "atlas-frontend-development",
  workspaceRootSha256: "f".repeat(64),
});

const iso = (date) => new Date(date).toISOString();

/**
 * One captured archive entry. `firstSequence` is where the record first
 * appeared and `sequence` its latest observation, so a record whose state moved
 * on (an activity that finished) carries a higher `sequence` than it started
 * with - the desk must show it once, in its latest state.
 */
function archiveItem({
  firstSequence, sequence = firstSequence, kind, role = null, state = "completed",
  text = null, turn = null, requestId = null, omissions = [],
}) {
  const at = new Date(Date.UTC(2026, 8, 18, 9, 5, firstSequence * 7)).toISOString();
  return {
    firstSequence, sequence, contentSha256: sha256(`archive-${firstSequence}-${sequence}`),
    observedAtUtc: new Date(Date.UTC(2026, 8, 18, 9, 5, sequence * 7)).toISOString(),
    record: {
      recordId: `fixture-archive-${firstSequence}`, kind, role, state, text,
      providerTurnId: turn, providerItemId: `fixture-item-${firstSequence}`,
      requestId, occurredAtUtc: at, omissions,
    },
  };
}

// A conversation shaped like a real one: the start of the history was not
// imported, two turns, commands with their output, a record that changed state,
// a question waiting for the person, and content left out for two different
// reasons. Two pages, oldest first, so the cursor path is exercised too.
const FIXTURE_ARCHIVE_PAGES = Object.freeze({
  null: {
    items: [
      archiveItem({ firstSequence: 1, kind: "omission", omissions: ["history_not_imported"] }),
      archiveItem({ firstSequence: 2, kind: "submission", role: "user", turn: "fixture-turn-1",
        requestId: "fixture-send-1", text: "Check that the build passes, and describe what is broken." }),
      archiveItem({ firstSequence: 3, kind: "message", role: "assistant", turn: "fixture-turn-1",
        text: "Running the scheduler module tests." }),
      archiveItem({ firstSequence: 4, sequence: 6, kind: "activity", role: "tool", turn: "fixture-turn-1",
        text: "npm test -- scheduler\n\n  42 passing\n  1 failing\n\n  1) queue drains twice under load" }),
      archiveItem({ firstSequence: 5, kind: "message", role: "assistant", turn: "fixture-turn-1",
        text: "One test fails: under load the queue is drained twice. Looks like a race in drain() — the lock is released before the queue is marked empty." }),
      archiveItem({ firstSequence: 7, kind: "delivery", turn: "fixture-turn-1", text: "Turn finished." }),
    ],
    nextCursor: "fixture-archive-page-2",
  },
  "fixture-archive-page-2": {
    items: [
      archiveItem({ firstSequence: 8, kind: "omission", turn: "fixture-turn-2", omissions: ["hidden_reasoning"] }),
      archiveItem({ firstSequence: 9, kind: "submission", role: "user", turn: "fixture-turn-2",
        requestId: "fixture-send-2", text: "Fix the lock and run the tests again." }),
      archiveItem({ firstSequence: 10, kind: "activity", role: "tool", turn: "fixture-turn-2",
        omissions: ["oversized_content"] }),
      archiveItem({ firstSequence: 11, kind: "interaction", role: "assistant", state: "requested",
        turn: "fixture-turn-2", text: "Allow writing to src/queue/drain.mjs?" }),
      archiveItem({ firstSequence: 12, kind: "message", role: "assistant", state: "started",
        turn: "fixture-turn-2", text: "Waiting for permission to write; then I will run the tests." }),
    ],
    nextCursor: null,
  },
});

async function capabilities(kit, now, sequence) {
  const example = JSON.parse(await kit.readText("examples/capabilities.discovery.v1.json"));
  const operations = {};
  for (const [family, entries] of Object.entries(example.surface.operations)) {
    operations[family] = entries.filter(({ operation }) => (
      operation.operationId === DISCOVERY_OPERATION_ID
      || IMPLEMENTED[operation.operationId] === family
    ));
  }
  return {
    ...example,
    descriptorId: "application-capabilities:atlas-dev-fixture",
    sourceId: "atlas-dev-fixture",
    sequence,
    publishedAtUtc: iso(now),
    validForSeconds: 300,
    surface: { ...example.surface, operations },
    // Provider-scoped routes are not simulated: an operation this fixture does
    // not implement must look unavailable, not merely unselectable.
    providerOperations: { ...example.providerOperations, definitions: [] },
    providerStates: [],
  };
}

function operationRef(family, operationId) {
  return { schemaVersion: 1, contractVersion: CONTRACT_VERSION, family, operationId };
}

function descriptorAt(now, sessionId, instanceId) {
  const publishedAtUtc = iso(now - 1_000);
  const validUntilUtc = iso(now + 1_800_000);
  const exposedOperations = [
    operationRef("discovery", DISCOVERY_OPERATION_ID),
    ...Object.entries(IMPLEMENTED).map(([operationId, family]) => operationRef(family, operationId)),
  ];
  const value = {
    schemaVersion: 1, contractVersion: "v0.2.0",
    descriptorId: `application-gateway:${sha256(`atlas-dev-fixture:${instanceId}:${publishedAtUtc}`)}`,
    transportId: "loopback-http-json-ndjson-v1", publishedAtUtc, validUntilUtc,
    instance: {
      instanceId, generation: 1, lifecycleIdentitySha256: sha256(instanceId),
      processId: process.pid, processStartedAtUtc: iso(now - 9_000),
      readyAtUtc: iso(now - 4_000), adapterVersion: "v0.1.0-fixture",
    },
    workspace: { ...DEV_WORKSPACE },
    endpoint: {
      schemaVersion: 1, contractVersion: CONTRACT_VERSION,
      transportId: "loopback-http-json-ndjson-v1", instanceId,
      lifecycleIdentitySha256: sha256(instanceId), sessionId,
      workspaceRootSha256: DEV_WORKSPACE.workspaceRootSha256,
      scheme: "http", host: "127.0.0.1", port: 49152, authority: "127.0.0.1:49152",
      endpointId: `gateway-endpoint-${sha256(`${instanceId}:${sessionId}`)}`,
    },
    authorization: {
      scheme: "Bearer", sessionId,
      // Synthetic, never a credential: the fixture accepts any bearer.
      bearerToken: `fixture-${"0".repeat(36)}`, expiresAtUtc: validUntilUtc,
    },
    routes: [
      {
        routeId: "application-operations", method: "POST", path: "/v1/operations",
        requestContractVersion: CONTRACT_VERSION, responseMediaType: "application/json",
      },
      {
        routeId: "application-event-read", method: "POST", path: "/v1/events/read",
        requestContractVersion: CONTRACT_VERSION, responseMediaType: "application/x-ndjson",
      },
    ],
    capabilityDiscovery: {
      operationId: DISCOVERY_OPERATION_ID, contractVersion: CAPABILITY_VERSION,
    },
    exposedOperations,
  };
  return value;
}

function envelope(request, now, body) {
  return {
    schemaVersion: 1, contractVersion: CONTRACT_VERSION,
    requestId: request.requestId, correlationId: request.correlationId,
    ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
    operation: request.operation, startedAtUtc: iso(now), completedAtUtc: iso(now),
    diagnostics: [], ...body,
  };
}

function failure(request, now, code, message, reasonCode = null) {
  return envelope(request, now, {
    outcome: "failed",
    error: { code, message, retryable: false, phase: "precondition", ...(reasonCode === null ? {} : { reasonCode }) },
  });
}

// The agent whose captured attention the catalog cannot report: its counts
// must stay unknown on the desk, never become zero.
const ATTENTION_UNAVAILABLE_AGENT = "core-storage-2";
const WORKSPACE_BASE = Object.freeze({ schemaVersion: 1, contractVersion: CONTRACT_VERSION });

const fileText = (entry) => (typeof entry === "string" ? entry : null);

/** Direct children of `directory` ("" is the root) in a fixture project. */
function childrenOf(files, directory) {
  const prefix = directory === "" ? "" : `${directory}/`;
  const seen = new Map();
  for (const [filePath, entry] of Object.entries(files)) {
    if (!filePath.startsWith(prefix)) continue;
    const [name, ...deeper] = filePath.slice(prefix.length).split("/");
    if (deeper.length > 0) {
      seen.set(name, { name, kind: "directory", sizeBytes: null, contentSha256: null });
    } else {
      const content = fileText(entry);
      seen.set(name, { name, kind: "file", contentSha256: null,
        sizeBytes: content === null ? entry.sizeBytes : Buffer.byteLength(content, "utf8") });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Creates the fixture gateway. Returns exactly what the host needs to build a
 * normal ApplicationFrontendClient, so the production code path is unchanged.
 */
export function createDevGateway({ kit, now = () => Date.now() } = {}) {
  if (kit === undefined || typeof kit.readText !== "function") {
    throw new TypeError("createDevGateway needs the verified kit");
  }
  const sessionId = randomUUID();
  const instanceId = randomUUID();
  const world = fixtureWorld();
  const interactions = structuredClone(INTERACTIONS);
  const operations = new Map();
  let sequence = 0;
  // Per agent: the conversation revision (it moves when something is sent)
  // and the observed event log that the events read resumes from.
  const revisions = new Map();
  const events = new Map();
  // Messages queued for the end of a running turn (Kit v0.21.0 steer, mode queue).
  const queuedMessages = new Map();
  let attentionSequence = 1;

  // Files are this gateway's own copy, so a save changes them for this run only.
  const projectFiles = Object.fromEntries(Object.entries(PROJECT_FILES).map(([id, files]) => [id, { ...files }]));
  // Copies by operation id: the backend answers a replay with its first result.
  const copies = new Map();

  /** Why a project folder cannot be read - only the three public reasons, or none. */
  function folderRefusal(request, current, projectId) {
    if (projectId === "platform-core") {
      return failure(request, current, "source_unavailable", "Folder binding conflicts", "workspace_binding_conflict");
    }
    if (projectId === "research-lab") return failure(request, current, "source_unavailable", "Folder is gone", "workspace_path_missing");
    return failure(request, current, "source_unavailable", "Project folder not bound", "workspace_not_bound");
  }

  const revisionOf = (agentId) => revisions.get(agentId) ?? FIXTURE_REVISION;
  const eventsOf = (agentId) => {
    if (!events.has(agentId)) events.set(agentId, []);
    return events.get(agentId);
  };
  const eventCursor = (agentId, seq) => `fx-events:${instanceId}:${agentId}:${seq}`;
  function appendEvent(agentId, kind, turnId = null) {
    const log = eventsOf(agentId);
    log.push({ sequence: log.length + 1, turnId, itemId: null, kind, observedAtUtc: iso(now()) });
    if (kind === "interaction-changed") attentionSequence += 1;
  }

  /** Captured attention as the catalog reports it; one agent's is unavailable. */
  function attentionOf(target) {
    if (target.agentId === ATTENTION_UNAVAILABLE_AGENT) {
      return { availability: "unavailable", coverage: "captured-only", sourceSequence: null, sourceRevision: null,
        pendingQuestions: null, pendingApprovals: null, recoveryRequired: null, observedAtUtc: null };
    }
    const waiting = (interactions[target.agentId] ?? []).filter((record) => record.state === "awaiting-owner");
    return {
      availability: "available", coverage: "captured-only", sourceSequence: attentionSequence, sourceRevision: 4,
      pendingQuestions: waiting.filter((record) => record.display?.kind === "user-input").length,
      pendingApprovals: waiting.filter((record) => record.display?.kind !== "user-input").length,
      recoveryRequired: target.deliveryState === "uncertain" ? 1 : 0,
      observedAtUtc: iso(now()),
    };
  }
  const withAttention = (target) => ({ ...target, attention: attentionOf(target) });

  /** The binding the backend keeps between an agent and its conversation. */
  function bindingOf(target) {
    const base = { ...WORKSPACE_BASE, agentId: target.agentId, archiveCoverage: "captured-only" };
    if (target.agentId === "orphan-agent-1") {
      return { ...base, conversationId: null, liveRead: { status: "unavailable", reasonCode: "agent_unbound" } };
    }
    const conversationId = conversationIdOf(target.agentId);
    if (target.state === "archived") {
      return { ...base, conversationId, liveRead: { status: "unavailable", reasonCode: "agent_archived" } };
    }
    if (target.state === "failed") {
      return { ...base, conversationId, liveRead: { status: "unavailable", reasonCode: "provider_unavailable" } };
    }
    return { ...base, conversationId, liveRead: { status: "available", reasonCode: "available" } };
  }

  /** One page of a fixture file: at most 64 KiB, bound to the whole file's hash. */
  function filePage(request, current, projectId, filePath, maximumBytes, cursor) {
    const files = projectFiles[projectId];
    if (files === undefined) return folderRefusal(request, current, projectId);
    const entry = files[filePath];
    // Other causes carry no public reason: the window must show them as unknown.
    if (entry === undefined) return failure(request, current, "source_unavailable", "No such file");
    const content = fileText(entry);
    if (content === null) return failure(request, current, "source_unavailable", "File exceeds 1 MiB");
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    if (cursor !== null && cursor !== undefined) {
      const match = /^fx-file:(\d+)$/u.exec(cursor);
      if (match === null) return failure(request, current, "stale_revision", "Unknown file cursor", "cursor_invalid");
      offset = Number(match[1]);
    }
    const chunk = bytes.subarray(offset, offset + Math.min(maximumBytes ?? 65536, 65536));
    const end = offset + chunk.length;
    return {
      ...WORKSPACE_BASE, projectId, path: filePath, kind: "read", contentSha256: sha256(bytes),
      observedAtUtc: iso(current), text: chunk.toString("utf8"),
      range: { offsetBytes: offset, returnedBytes: chunk.length, totalBytes: bytes.length },
      truncated: end < bytes.length, nextCursor: end < bytes.length ? `fx-file:${end}` : null,
    };
  }

  const findAgent = (agentId) => world.agents.find((item) => item.agentId === agentId) ?? null;
  // The identity each agent was closed with (the backend keeps it in its catalog, not in the public agent).
  const closeIds = new Map();

  function operationRecord(agentId, operationId, state) {
    return {
      schemaVersion: 1, operationId, agentId, kind: "send", state,
      turnId: `fixture-turn-${operationId.slice(-8)}`,
      intentHash: sha256(operationId),
      requestedAtUtc: iso(now()), updatedAtUtc: iso(now()),
    };
  }

  async function handle(request) {
    const current = now();
    const operationId = request?.operation?.operationId;
    if (operationId === DISCOVERY_OPERATION_ID) {
      sequence += 1;
      return envelope(request, current, {
        outcome: "succeeded",
        output: { capabilities: await capabilities(kit, current, sequence) },
      });
    }
    const input = request?.input ?? {};
    switch (operationId) {
      case "query.memory.scopes.list":
        return envelope(request, current, {
          outcome: "succeeded",
          output: {
            schemaVersion: 1, truncated: false,
            scopes: world.scopes.map(({ entries, ...metadata }) => metadata),
          },
        });
      case "query.memory.agents.list":
        return envelope(request, current, {
          outcome: "succeeded",
          output: { schemaVersion: 1, revision: 4, agents: world.agents.map(withAttention) },
        });
      case "query.memory.scope.read": {
        const found = world.scopes.find((item) => item.scopeId === input.scopeId);
        return found
          ? envelope(request, current, { outcome: "succeeded", output: found })
          : failure(request, current, "source_unavailable", "Unknown fixture scope");
      }
      case "query.memory.agent.read": {
        const found = world.agents.find((item) => item.agentId === input.agentId);
        return found
          ? envelope(request, current, { outcome: "succeeded", output: withAttention(found) })
          : failure(request, current, "source_unavailable", "Unknown fixture agent");
      }
      case "query.memory.agent.context": {
        const found = world.agents.find((item) => item.agentId === input.agentId);
        if (!found) return failure(request, current, "source_unavailable", "Unknown fixture agent");
        const project = world.scopes.find(
          (item) => item.kind === "project" && item.projectId === found.projectId,
        );
        const quarter = world.scopes.find(
          (item) => item.kind === "quarter" && item.quarterId === found.quarterId,
        );
        return envelope(request, current, {
          outcome: "succeeded",
          output: {
            schemaVersion: 1, agentId: found.agentId,
            contentState: found.contentState, deliveryState: found.deliveryState,
            startBlockedByEmptyMemory: false,
            project: project ?? null, quarter: quarter ?? null,
          },
        });
      }
      case "query.memory.agent.archive": {
        const page = FIXTURE_ARCHIVE_PAGES[input.cursor ?? "null"];
        if (page === undefined) return failure(request, current, "conflict", "Unknown archive cursor");
        return envelope(request, current, {
          outcome: "succeeded",
          output: {
            schemaVersion: 1, agentId: input.agentId ?? null, revision: 1,
            coverage: "captured-only", items: page.items, nextCursor: page.nextCursor,
          },
        });
      }
      case "query.agent-control.interactions": {
        const all = interactions[input.agentId] ?? [];
        const limit = input.limit ?? 16;
        return envelope(request, current, {
          outcome: "succeeded",
          output: {
            schemaVersion: 1, contractVersion: CONTRACT_VERSION,
            agentId: input.agentId ?? null, sourceSequence: attentionSequence,
            records: all.slice(-limit),
            truncated: all.length > limit, omissionCount: Math.max(0, all.length - limit),
          },
        });
      }

      case "query.agent-conversation.resolve": {
        const found = findAgent(input.agentId);
        if (found === null) return failure(request, current, "source_unavailable", "Unknown fixture agent");
        return envelope(request, current, { outcome: "succeeded", output: bindingOf(found) });
      }

      case "query.agent-conversation.read": {
        const found = findAgent(input.agentId);
        if (found === null) return failure(request, current, "source_unavailable", "Unknown fixture agent");
        const binding = bindingOf(found);
        if (binding.liveRead.status !== "available") {
          return failure(request, current, "source_unavailable", "Live read unavailable", binding.liveRead.reasonCode);
        }
        const limit = input.limit ?? 32;
        let offset = 0;
        if (input.cursor !== undefined && input.cursor !== null) {
          const parts = /^fx-conv:([^:]+):(\d+):(\d+):(.+)$/u.exec(input.cursor);
          if (parts === null || parts[1] !== found.agentId) {
            return failure(request, current, "stale_revision", "Unknown conversation cursor", "cursor_invalid");
          }
          if (Number(parts[3]) !== limit) {
            return failure(request, current, "conflict", "Continue with the same limit", "limit_changed");
          }
          if (parts[4] !== revisionOf(found.agentId)) {
            return failure(request, current, "stale_revision", "The conversation moved on", "stale_revision");
          }
          offset = Number(parts[2]);
        }
        return envelope(request, current, {
          outcome: "succeeded",
          output: conversationPage(found, { offset, limit, revision: revisionOf(found.agentId) }),
        });
      }

      case "query.project-workspace.list": {
        const files = projectFiles[input.projectId];
        if (files === undefined) return folderRefusal(request, current, input.projectId);
        const directory = input.path ?? "";
        const entries = childrenOf(files, directory);
        if (directory !== "" && entries.length === 0) {
          return failure(request, current, "source_unavailable", "No such directory");
        }
        const limit = input.limit ?? 128;
        return envelope(request, current, {
          outcome: "succeeded",
          output: {
            ...WORKSPACE_BASE, projectId: input.projectId, path: directory, kind: "list",
            contentSha256: sha256(JSON.stringify(entries)), observedAtUtc: iso(current),
            entries: entries.slice(0, limit), totalEntries: entries.length,
            omissionCount: Math.max(0, entries.length - limit), truncated: entries.length > limit, nextCursor: null,
          },
        });
      }

      case "query.project-workspace.read": {
        const page = filePage(request, current, input.projectId, input.path, input.maximumBytes, input.cursor);
        return page.outcome === "failed" ? page : envelope(request, current, { outcome: "succeeded", output: page });
      }

      case "query.agent-artifacts.list": {
        const found = findAgent(input.agentId);
        if (found === null) return failure(request, current, "source_unavailable", "Unknown fixture agent");
        return envelope(request, current, {
          outcome: "succeeded",
          output: {
            ...WORKSPACE_BASE, agentId: found.agentId, revision: 1, coverage: "registered-only",
            records: structuredClone(ARTIFACTS[found.agentId] ?? []), truncated: false,
          },
        });
      }

      case "query.agent-artifacts.read": {
        const found = findAgent(input.agentId);
        const record = (ARTIFACTS[input.agentId] ?? []).find((item) => item.artifactId === input.artifactId);
        if (found === null || record === undefined) {
          return failure(request, current, "source_unavailable", "Unknown artifact", "artifact_not_registered");
        }
        const page = filePage(request, current, found.projectId, record.path, input.maximumBytes, input.cursor);
        if (page.outcome === "failed") return page;
        return envelope(request, current, {
          outcome: "succeeded",
          output: { ...WORKSPACE_BASE, agentId: found.agentId, artifactId: record.artifactId,
            coverage: "registered-reference", page },
        });
      }

      case "mutation.project-workspace.save": {
        // The backend's refusals: a changed file is stale_revision; a file that is
        // not bounded UTF-8 text, or too large, is access_denied.
        const files = projectFiles[input.projectId];
        if (files === undefined) return failure(request, current, "source_unavailable", "Project folder not bound");
        const existing = files[input.path];
        if (typeof existing !== "string" || Buffer.byteLength(input.text ?? "", "utf8") > 1_048_576) {
          return failure(request, current, "access_denied", "Project file save refused");
        }
        if (sha256(Buffer.from(existing, "utf8")) !== input.expectedSha256) {
          return failure(request, current, "stale_revision", "Project file save refused");
        }
        files[input.path] = input.text;
        return envelope(request, current, {
          outcome: "succeeded",
          output: {
            ...WORKSPACE_BASE, projectId: input.projectId, path: input.path, operationId: input.operationId,
            previousSha256: input.expectedSha256, contentSha256: sha256(Buffer.from(input.text, "utf8")),
            bytesWritten: Buffer.byteLength(input.text, "utf8"), completedAtUtc: iso(current),
          },
        });
      }

      case "mutation.memory.project.copy": {
        const key = JSON.stringify(input);
        const known = copies.get(input.operationId);
        if (known !== undefined) {
          return known.key === key ? envelope(request, current, { outcome: "succeeded", output: known.receipt })
            : failure(request, current, "conflict", "Operation id reused with another request");
        }
        const source = world.scopes.filter((item) => item.projectId === input.sourceProjectId);
        const project = source.find((item) => item.kind === "project");
        const quarters = source.filter((item) => item.kind === "quarter");
        const targets = [input.targetProjectScopeId, ...Object.values(input.quarterScopeIds ?? {})];
        const sameQuarters = quarters.length === Object.keys(input.quarterScopeIds ?? {}).length
          && quarters.every((item) => Object.hasOwn(input.quarterScopeIds, item.quarterId));
        if (project === undefined || !sameQuarters || new Set(targets).size !== targets.length
            || world.scopes.some((item) => item.projectId === input.targetProjectId || targets.includes(item.scopeId))) {
          // Atomic: a refusal creates nothing.
          return failure(request, current, "conflict", "Project copy conflicts with memory state");
        }
        const copied = [project, ...quarters].map((item) => {
          const targetScopeId = item.kind === "project" ? input.targetProjectScopeId : input.quarterScopeIds[item.quarterId];
          const created = scope(targetScopeId, item.kind, input.targetProjectId, item.quarterId, item.title, 1,
            structuredClone(item.entries));
          created.sha256 = item.sha256;
          world.scopes.push(created);
          return {
            sourceScopeId: item.scopeId, targetScopeId, kind: item.kind, quarterId: item.quarterId,
            sourceRevision: item.revision, sourceSha256: item.sha256, targetRevision: 1, targetSha256: item.sha256,
          };
        });
        const receipt = {
          schemaVersion: 1, outcome: "complete", sourceProjectId: input.sourceProjectId,
          targetProjectId: input.targetProjectId, operationId: input.operationId, copiedAtUtc: iso(current), scopes: copied,
        };
        copies.set(input.operationId, { key, receipt });
        return envelope(request, current, { outcome: "succeeded", output: receipt });
      }

      case "query.agent-events.read": {
        const found = findAgent(input.agentId);
        if (found === null) return failure(request, current, "source_unavailable", "Unknown fixture agent");
        const binding = bindingOf(found);
        if (binding.conversationId === null) {
          return failure(request, current, "source_unavailable", "Agent has no conversation", "agent_unbound");
        }
        const log = eventsOf(found.agentId);
        const head = eventCursor(found.agentId, log.length);
        const page = (mode, reasonCode, list, hasMore, nextCursor) => envelope(request, current, {
          outcome: "succeeded",
          output: { ...WORKSPACE_BASE, agentId: found.agentId, conversationId: binding.conversationId,
            mode, reasonCode, coverage: "observed-only", events: list, hasMore, nextCursor, observedAtUtc: iso(current) },
        });
        if (input.cursor === undefined || input.cursor === null) {
          return page("snapshot-required", "initial_snapshot_required", [], false, head);
        }
        const parts = /^fx-events:([^:]+):([^:]+):(\d+)$/u.exec(input.cursor);
        if (parts === null || parts[1] !== instanceId || parts[2] !== found.agentId || Number(parts[3]) > log.length) {
          // A cursor from another gateway instance (a restart) is not resumable.
          return page("resync-required", "cursor_invalid", [], false, head);
        }
        const limit = input.limit ?? 64;
        const after = log.slice(Number(parts[3]));
        const list = after.slice(0, limit);
        return page("resumed", null, list, after.length > limit, eventCursor(found.agentId, Number(parts[3]) + list.length));
      }

      case "mutation.memory.scope.create": {
        if (world.scopes.some((item) => item.scopeId === input.scopeId)) {
          return failure(request, current, "conflict", "Scope already exists");
        }
        const created = scope(input.scopeId, input.kind, input.projectId,
          input.quarterId ?? null, input.title, 1, []);
        world.scopes.push(created);
        return envelope(request, current, { outcome: "succeeded", output: created });
      }

      case "mutation.memory.agent.create": {
        if (findAgent(input.agentId) !== null) {
          return failure(request, current, "conflict", "Agent already exists");
        }
        const project = world.scopes.find(
          (item) => item.kind === "project" && item.projectId === input.projectId);
        const quarter = world.scopes.find(
          (item) => item.kind === "quarter" && item.quarterId === input.quarterId);
        if (project === undefined || quarter === undefined) {
          // Creating an agent assigns both memories, even when they are empty.
          return failure(request, current, "source_unavailable", "Both memories must exist first");
        }
        const created = agent({
          agentId: input.agentId, projectId: input.projectId, quarterId: input.quarterId,
          operationId: input.operationId, profile: { ...input.profile },
          assignedManifest: manifest(project, quarter), requiredManifest: manifest(project, quarter),
          deliveredManifest: null, contentState: quarter.entries.length > 0 ? "populated" : "empty",
          deliveryState: "pending", createdAtUtc: iso(current),
        });
        world.agents.push(created);
        return envelope(request, current, { outcome: "succeeded", output: created });
      }

      case "mutation.memory.agent.send": {
        const target = findAgent(input.agentId);
        if (target === null) return failure(request, current, "source_unavailable", "Unknown agent");
        if (target.state === "archived") {
          return failure(request, current, "conflict", "The agent is archived");
        }
        const saved = operations.get(input.operationId);
        if (saved !== undefined) {
          // The same operation id returns its saved record instead of sending twice.
          return envelope(request, current, { outcome: "accepted", output: saved });
        }
        if (input.agentId === UNCERTAIN_AGENT) {
          const uncertain = operationRecord(input.agentId, input.operationId, "uncertain");
          operations.set(input.operationId, uncertain);
          target.currentOperationId = input.operationId;
          target.lastOperation = uncertain;
          target.deliveryState = "uncertain";
          return envelope(request, current, {
            outcome: "uncertain",
            error: {
              code: "uncertain_outcome", message: "Delivery could not be observed",
              retryable: false, phase: "observation",
            },
          });
        }
        const record = operationRecord(input.agentId, input.operationId, "started");
        operations.set(input.operationId, record);
        revisions.set(input.agentId, iso(current));
        appendEvent(input.agentId, "turn-started", record.turnId);
        target.currentOperationId = input.operationId;
        target.lastOperation = record;
        target.deliveryState = "delivered";
        target.deliveredManifest = structuredClone(target.requiredManifest);
        return envelope(request, current, { outcome: "accepted", output: record });
      }

      // A message while the agent works: steered into its running turn, queued
      // for the turn's end, or - when nothing runs - an ordinary send.
      case "mutation.memory.agent.steer": {
        const target = findAgent(input.agentId);
        if (target === null) return failure(request, current, "source_unavailable", "Unknown agent");
        if (target.state === "archived") return failure(request, current, "conflict", "The agent is archived");
        const running = target.currentOperationId ? operations.get(target.currentOperationId) : undefined;
        if (running !== undefined && running.state === "started") {
          if (input.mode === "queue") {
            const held = queuedMessages.get(input.agentId) ?? [];
            if (!held.some((item) => item.operationId === input.operationId)) {
              held.push({ operationId: input.operationId, text: input.text, queuedAtUtc: iso(current) });
            }
            queuedMessages.set(input.agentId, held);
          }
          return envelope(request, current, { outcome: "accepted", output: { agentId: input.agentId,
            operationId: input.operationId, delivery: input.mode === "queue" ? "queued" : "steered",
            turnId: running.turnId, state: "started" } });
        }
        const record = operations.get(input.operationId) ?? operationRecord(input.agentId, input.operationId, "started");
        operations.set(input.operationId, record);
        revisions.set(input.agentId, iso(current));
        appendEvent(input.agentId, "turn-started", record.turnId);
        target.currentOperationId = input.operationId;
        target.lastOperation = record;
        target.deliveryState = "delivered";
        target.deliveredManifest = structuredClone(target.requiredManifest);
        return envelope(request, current, { outcome: "accepted", output: { agentId: input.agentId,
          operationId: input.operationId, delivery: "started", turnId: record.turnId, state: record.state } });
      }

      case "mutation.memory.agent.unqueue": {
        const held = queuedMessages.get(input.agentId) ?? [];
        const left = held.filter((item) => item.operationId !== input.operationId);
        queuedMessages.set(input.agentId, left);
        return envelope(request, current, { outcome: "succeeded", output: { agentId: input.agentId,
          operationId: input.operationId, cancelled: left.length !== held.length } });
      }

      case "mutation.memory.agent.profile": {
        const target = findAgent(input.agentId);
        if (target === null) return failure(request, current, "source_unavailable", "Unknown agent");
        if (target.state === "archived") return failure(request, current, "conflict", "The agent is archived");
        target.profile = { ...structuredClone(input.profile), fallbackPolicy: "deny" };
        revisions.set(input.agentId, iso(current));
        return envelope(request, current, { outcome: "succeeded", output: structuredClone(target) });
      }

      case "query.memory.agent.trace": {
        const target = findAgent(input.agentId);
        if (target === null) return failure(request, current, "source_unavailable", "Unknown agent");
        const records = input.after ? [] : fixtureTrace(input.agentId, current);
        return envelope(request, current, { outcome: "succeeded", output: { schemaVersion: 1,
          agentId: input.agentId, records, beforeCursor: null, afterCursor: "1:4096", gap: false, exhausted: true,
          queued: (queuedMessages.get(input.agentId) ?? []).map((item) => ({ clientId: item.operationId,
            message: item.text, queuedAtUtc: item.queuedAtUtc })) } });
      }

      case "receipt.memory.agent.send": {
        const record = operations.get(input.operationId);
        if (record === undefined || record.agentId !== input.agentId) {
          return failure(request, current, "source_unavailable", "Unknown operation");
        }
        // A receipt observation, unlike the catalog, is read fresh every time.
        return envelope(request, current, {
          outcome: "succeeded",
          output: {
            ...record,
            observation: record.state === "started" ? "available" : "terminal",
            automaticRetryAllowed: false,
          },
        });
      }

      case "mutation.agent-control.interrupt": {
        const record = operations.get(input.operationId);
        if (record === undefined || record.agentId !== input.agentId) {
          return failure(request, current, "source_unavailable", "Unknown send operation");
        }
        // Accepted means the request was acknowledged, not that the turn ended.
        record.state = record.state === "uncertain" ? "uncertain" : "interrupted";
        record.updatedAtUtc = iso(current);
        appendEvent(input.agentId, "turn-completed", record.turnId);
        const target = findAgent(input.agentId);
        if (target !== null) target.lastOperation = record;
        return envelope(request, current, {
          outcome: "accepted",
          output: {
            operationId: input.operationId, turnId: record.turnId,
            state: record.state === "uncertain" ? "uncertain" : "accepted",
            automaticRetryAllowed: false,
          },
        });
      }

      case "approval.agent-control.respond": {
        const list = interactions[input.agentId] ?? [];
        const record = list.find((item) => item.interactionId === input.response?.interactionId);
        if (record === undefined) return failure(request, current, "source_unavailable", "Unknown interaction");
        if (record.state !== "awaiting-owner") {
          return failure(request, current, "conflict", "The request already has a decision");
        }
        // As the Gateway (application-provider-interaction-bridge.mjs): the
        // interaction request's hash, never the provider request's.
        if (input.response.requestSha256 !== record.interactionRequest.requestSha256) {
          return failure(request, current, "conflict", "Request identity does not match");
        }
        if (!record.interactionRequest.allowedResponses.includes(input.response.selectedResponse)) {
          return failure(request, current, "conflict", "Choice is not allowed for this request");
        }
        record.state = "response-recorded";
        record.response = { ...input.response };
        appendEvent(input.agentId, "interaction-changed");
        record.providerResponseSha256 = sha256(JSON.stringify(input.response.providerResponse));
        record.updatedAtUtc = iso(current);
        return envelope(request, current, {
          outcome: "succeeded",
          output: {
            interaction: record, response: record.response,
            receipt: {
              schemaVersion: 1, contractVersion: CONTRACT_VERSION,
              interactionId: record.interactionId, requestSha256: record.interactionRequest.requestSha256,
              responseSha256: sha256(JSON.stringify(record.response)),
              providerResponseSha256: record.providerResponseSha256,
              deliveryState: "response-returned", automaticRetryAllowed: false,
            },
          },
        });
      }

      case "mutation.memory.agent.close": {
        // As the backend: the input is exactly {agentId, operationId} (agentOperationInput),
        // and the close keeps its identity - the same close again answers, another is refused.
        if (Object.keys(input ?? {}).sort().join() !== "agentId,operationId") {
          return failure(request, current, "conflict", "Close input is exactly agentId and operationId");
        }
        const target = findAgent(input.agentId);
        if (target === null) return failure(request, current, "source_unavailable", "Unknown agent");
        if (closeIds.has(input.agentId) && closeIds.get(input.agentId) !== input.operationId) {
          return failure(request, current, "conflict", "The agent is closed by another operation");
        }
        if (target.state === "archived") return envelope(request, current, { outcome: "succeeded", output: target });
        if (target.lastOperation !== null && target.lastOperation.state === "started") {
          return failure(request, current, "writer_busy", "The current turn is not terminal");
        }
        closeIds.set(input.agentId, input.operationId);
        target.state = "archived";
        target.deliveryState = "archived";
        target.archivedAtUtc = iso(current);
        target.currentOperationId = null;
        return envelope(request, current, { outcome: "succeeded", output: target });
      }

      default:
        return failure(request, current, "unsupported_capability", "Fixture does not implement it");
    }
  }

  async function fetchImpl(url, options = {}) {
    if (!String(url).endsWith("/v1/operations")) {
      return new Response("fixture route not implemented", { status: 404 });
    }
    const request = JSON.parse(options.body);
    const result = await handle(request);
    return new Response(JSON.stringify(result), {
      status: 200, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  return {
    workspace: { ...DEV_WORKSPACE },
    resolveDescriptor: async () => ({
      status: "available", descriptor: descriptorAt(now(), sessionId, instanceId),
    }),
    fetchImpl,
  };
}
