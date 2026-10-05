// The agent's workspace reads: its conversation, its project's files, its
// registered artifacts and its observed events.
//
// All of them go through the one host gateway (gateway.run), so they are
// allowlisted, capability-gated by the kit client and journalled like any other
// read. What this module adds is what the generic client cannot know:
//
//   - inputs and outputs are checked against the kit's exact schemas; a value
//     that does not match is refused, never shown;
//   - the conversation is the one the backend bound to the agent. No thread id
//     is guessed. An archived agent is sent to its archive; a live read that is
//     unavailable is reported as unavailable, never as an empty chat. Pages are
//     followed to the end with the same limit, or the traversal says honestly
//     that it is partial or stale - refreshed pages are never glued to old ones;
//   - files and artifacts are read-only, one explicitly named path at a time:
//     no directory is walked on the reader's behalf. An artifact is a
//     registered, hash-bound reference; its text is shown only when it still
//     hashes to what was registered;
//   - events are invalidations, not conversation. The head cursor is kept
//     before the snapshot is read, then reading resumes from it; any gap,
//     restart or disorder asks for a new snapshot. Nothing here sends,
//     responds or mutates - an event can only cause reads.

import { createHash } from "node:crypto";

export const WORKSPACE_LIMITS = Object.freeze({
  pathMax: 256,
  fileMaxBytes: 1_048_576,
  pageMaxBytes: 65_536,
  conversationLimit: 32,
  conversationLimitMax: 128,
  conversationMaxPages: 8,
  conversationPagesCeiling: 32,
  listLimit: 128,
  artifactMaxPages: 16,
  eventLimit: 64,
  eventReadsPerPoll: 4,
});

const CONVERSATION = "application-agent-conversation.v1.json";
const WORKSPACE = "application-project-workspace.v1.json";
const ARTIFACTS = "application-agent-artifacts.v1.json";
const EVENTS = "application-agent-events.v1.json";

const COMPLETENESS_ORDER = Object.freeze({ complete: 0, partial: 1, "metadata-only": 2 });

const bounded = (value, min, max, fallback) => (
  Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback);

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** What events of each kind make stale on the desk. */
function invalidatedBy(kind) {
  if (kind === "interaction-changed") return ["interactions", "attention"];
  return ["conversation"];
}

export function createAgentWorkspace({ gateway, schemas, journal = null }) {
  if (gateway === null || gateway === undefined || typeof gateway.run !== "function") {
    throw new TypeError("createAgentWorkspace needs the host gateway");
  }
  if (schemas === null || schemas === undefined || typeof schemas.check !== "function") {
    throw new TypeError("createAgentWorkspace needs the kit schema set");
  }
  const cursors = new Map();

  /** Refused before the network: the journal says not-attempted, the value is not kept. */
  function refuse(operationId, input, file, definition) {
    const checked = schemas.check(file, definition, input);
    if (checked.ok) return null;
    journal?.notAttempted(operationId, input, "invalid_input");
    return { ok: false, error: { code: "invalid_input", reasonCode: checked.problems[0]?.keyword ?? null,
      field: checked.problems[0]?.path.split("/")[1] ?? null } };
  }

  /** One read through the gateway; only a succeeded envelope with a schema-valid output is data. */
  async function read(operationId, input, file, definition) {
    const response = await gateway.run(operationId, input);
    if (!response.ok) {
      return { ok: false, error: { code: response.error?.code ?? "host_error", reasonCode: response.error?.reasonCode ?? null } };
    }
    const envelope = response.result;
    if (envelope?.outcome !== "succeeded") {
      return { ok: false, error: {
        code: envelope?.error?.code ?? envelope?.outcome ?? "unknown",
        reasonCode: envelope?.error?.reasonCode ?? null,
        outcome: envelope?.outcome ?? null,
      } };
    }
    const checked = schemas.check(file, definition, envelope.output);
    if (!checked.ok) {
      return { ok: false, error: { code: "response_invalid", reasonCode: checked.problems[0]?.keyword ?? null,
        problems: checked.problems } };
    }
    return { ok: true, output: envelope.output };
  }

  const mismatch = (reasonCode) => ({ ok: false, error: { code: "response_invalid", reasonCode } });

  // --- conversation ----------------------------------------------------------------

  async function conversation({ agentId, limit, maxPages, bindingOnly = false } = {}) {
    const pageLimit = bounded(limit, 1, WORKSPACE_LIMITS.conversationLimitMax, WORKSPACE_LIMITS.conversationLimit);
    const pageBudget = bounded(maxPages, 1, WORKSPACE_LIMITS.conversationPagesCeiling, WORKSPACE_LIMITS.conversationMaxPages);
    const resolveInput = { agentId };
    const refused = refuse("query.agent-conversation.resolve", resolveInput, CONVERSATION, "resolveInput");
    if (refused !== null) return refused;
    const resolved = await read("query.agent-conversation.resolve", resolveInput, CONVERSATION, "binding");
    if (!resolved.ok) return resolved;
    const found = resolved.output;
    if (found.agentId !== agentId) return mismatch("agent_mismatch");

    const binding = {
      agentId: found.agentId,
      conversationId: found.conversationId,
      archiveCoverage: found.archiveCoverage,
      liveStatus: found.liveRead.status,
      reasonCode: found.liveRead.reasonCode,
    };
    const nothing = { traversal: null, pages: null, thread: null, turns: null, content: null, completeness: null };
    if (found.liveRead.status !== "available" || found.conversationId === null) {
      // Archived agents keep their captured archive; anything else is simply
      // not readable live right now - which is not the same as an empty chat.
      return { ok: true, data: { binding, route: found.liveRead.reasonCode === "agent_archived" ? "archive" : "unavailable", ...nothing } };
    }
    // The route alone: the window decides from it what to read next (events
    // before the snapshot for a live branch, nothing live for an archived one).
    if (bindingOnly === true) return { ok: true, data: { binding, route: "live", ...nothing } };

    const stop = (status, reasonCode, extra = {}) => ({ ok: true, data: {
      binding, route: "live", ...nothing, traversal: { status, reasonCode, pageCount: 0, revision: null, ...extra },
    } });
    const pages = [];
    let cursor = null;
    let revision = null;
    for (;;) {
      const input = { agentId, limit: pageLimit, ...(cursor === null ? {} : { cursor }) };
      const refusedPage = refuse("query.agent-conversation.read", input, CONVERSATION, "readInput");
      if (refusedPage !== null) return refusedPage;
      const response = await read("query.agent-conversation.read", input, CONVERSATION, "page");
      if (!response.ok) {
        const stale = response.error.code === "stale_revision" || response.error.reasonCode === "stale_revision";
        return stop(stale ? "stale" : "failed", stale ? "stale_revision" : response.error.reasonCode,
          stale ? {} : { code: response.error.code });
      }
      const page = response.output;
      if (page.agentId !== agentId || page.conversationId !== found.conversationId) {
        return stop("invalid", "binding_mismatch");
      }
      if (revision !== null && page.revision !== revision) return stop("stale", "revision_changed");
      revision = page.revision;
      pages.push(page);
      cursor = page.nextCursor;
      if (cursor === null || pages.length >= pageBudget) break;
    }

    const worst = pages.reduce((current, page) => (
      COMPLETENESS_ORDER[page.completeness.status] > COMPLETENESS_ORDER[current] ? page.completeness.status : current),
    "complete");
    return { ok: true, data: {
      binding,
      route: "live",
      traversal: {
        status: cursor === null ? "complete" : "partial",
        reasonCode: cursor === null ? null : "page_limit",
        pageCount: pages.length,
        revision,
      },
      pages: pages.map((page) => ({
        conversationId: page.conversationId, revision: page.revision, observedAtUtc: page.observedAtUtc,
        completeness: page.completeness, turnCount: page.turns.length, contentCount: page.content.length,
      })),
      thread: pages[pages.length - 1].thread,
      turns: pages.flatMap((page) => page.turns),
      content: pages.flatMap((page) => page.content),
      completeness: {
        status: worst,
        reasonCodes: [...new Set(pages.map((page) => page.completeness.reasonCode).filter((code) => code !== null))],
      },
    } };
  }

  // --- project files ---------------------------------------------------------------

  async function listProjectFiles({ projectId, path = "", cursor = null } = {}) {
    const input = {
      projectId, limit: WORKSPACE_LIMITS.listLimit,
      ...(path === "" ? {} : { path }), ...(cursor === null ? {} : { cursor }),
    };
    const refused = refuse("query.project-workspace.list", input, WORKSPACE, "listInput");
    if (refused !== null) return refused;
    const response = await read("query.project-workspace.list", input, WORKSPACE, "page");
    if (!response.ok) return response;
    const page = response.output;
    if (page.kind !== "list" || page.projectId !== projectId || page.path !== path) return mismatch("target_mismatch");
    return { ok: true, data: page };
  }

  /**
   * One page of a file. A continuation names the version it continues
   * (`expectedSha256`, the first page's contentSha256): a page of a file that
   * changed in between is refused as `file_changed`, never glued on.
   */
  async function readProjectFile({ projectId, path, cursor = null, expectedSha256 = null } = {}) {
    const input = {
      projectId, path, maximumBytes: WORKSPACE_LIMITS.pageMaxBytes, ...(cursor === null ? {} : { cursor }),
    };
    const refused = refuse("query.project-workspace.read", input, WORKSPACE, "readInput");
    if (refused !== null) return refused;
    const response = await read("query.project-workspace.read", input, WORKSPACE, "page");
    if (!response.ok) return response;
    const page = response.output;
    if (page.kind !== "read" || page.projectId !== projectId || page.path !== path) return mismatch("target_mismatch");
    if (expectedSha256 !== null && page.contentSha256 !== expectedSha256) {
      return { ok: false, error: { code: "file_changed", reasonCode: "content_sha256_changed" } };
    }
    return { ok: true, data: page };
  }

  // --- artifacts ---------------------------------------------------------------------

  async function listArtifacts({ agentId } = {}) {
    const input = { agentId };
    const refused = refuse("query.agent-artifacts.list", input, ARTIFACTS, "listInput");
    if (refused !== null) return refused;
    const response = await read("query.agent-artifacts.list", input, ARTIFACTS, "catalog");
    if (!response.ok) return response;
    if (response.output.agentId !== agentId) return mismatch("agent_mismatch");
    return { ok: true, data: response.output };
  }

  /**
   * Reads one registered artifact to its end and checks it still is what was
   * registered: the same path, byte size and SHA-256. Only then is its text
   * handed on; otherwise the reader learns that it changed, not its content.
   */
  async function readArtifact({ agentId, artifactId } = {}) {
    const probe = { agentId, artifactId };
    const refused = refuse("query.agent-artifacts.read", probe, ARTIFACTS, "readInput");
    if (refused !== null) return refused;
    const catalog = await listArtifacts({ agentId });
    if (!catalog.ok) return catalog;
    const record = catalog.data.records.find((item) => item.artifactId === artifactId);
    if (record === undefined) return { ok: false, error: { code: "artifact_not_registered", reasonCode: null } };

    let text = "";
    let cursor = null;
    let pages = 0;
    let last = null;
    do {
      const input = { agentId, artifactId, maximumBytes: WORKSPACE_LIMITS.pageMaxBytes, ...(cursor === null ? {} : { cursor }) };
      const response = await read("query.agent-artifacts.read", input, ARTIFACTS, "page");
      if (!response.ok) return response;
      const page = response.output;
      if (page.agentId !== agentId || page.artifactId !== artifactId) return mismatch("target_mismatch");
      if (page.page.kind !== "read" || page.page.path !== record.path) return mismatch("path_mismatch");
      if (last !== null && page.page.contentSha256 !== last.contentSha256) {
        return { ok: false, error: { code: "file_changed", reasonCode: "content_sha256_changed" } };
      }
      text += page.page.text;
      last = page.page;
      cursor = page.page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < WORKSPACE_LIMITS.artifactMaxPages);

    const bytes = Buffer.byteLength(text, "utf8");
    const verification = cursor !== null ? "incomplete"
      : bytes === record.sizeBytes && sha256(text) === record.sha256 ? "hash-matches" : "hash-mismatch";
    return { ok: true, data: {
      record, verification, pageCount: pages, observedAtUtc: last.observedAtUtc,
      totalBytes: last.range.totalBytes, readBytes: bytes,
      text: verification === "hash-matches" ? text : null,
    } };
  }

  // --- events ------------------------------------------------------------------------

  const snapshot = (reasonCode) => ({ ok: true, data: { action: "snapshot", reasonCode, invalidate: [], eventCount: 0 } });

  async function pollEvents({ agentId } = {}) {
    const probe = { agentId };
    const refused = refuse("query.agent-events.read", probe, EVENTS, "input");
    if (refused !== null) return refused;
    const known = cursors.get(agentId);

    if (known === undefined) {
      // First contact: keep the head cursor now, so that whatever happens while
      // the snapshot is being read is still delivered when reading resumes.
      const response = await read("query.agent-events.read", { agentId, limit: WORKSPACE_LIMITS.eventLimit }, EVENTS, "page");
      if (!response.ok) return response;
      const page = response.output;
      if (page.agentId !== agentId) return mismatch("agent_mismatch");
      cursors.set(agentId, { cursor: page.nextCursor, conversationId: page.conversationId, lastSequence: null });
      return snapshot(page.reasonCode ?? "initial_snapshot_required");
    }

    const invalidate = new Set();
    let eventCount = 0;
    for (let reads = 0; reads < WORKSPACE_LIMITS.eventReadsPerPoll; reads += 1) {
      const input = { agentId, cursor: known.cursor, limit: WORKSPACE_LIMITS.eventLimit };
      const response = await read("query.agent-events.read", input, EVENTS, "page");
      if (!response.ok) return response;
      const page = response.output;
      if (page.agentId !== agentId) return mismatch("agent_mismatch");
      const restart = (reasonCode) => {
        cursors.set(agentId, { cursor: page.nextCursor, conversationId: page.conversationId, lastSequence: null });
        return snapshot(reasonCode);
      };
      if (page.conversationId !== known.conversationId) return restart("conversation_changed");
      if (page.mode !== "resumed") return restart(page.reasonCode);
      let previous = known.lastSequence;
      for (const event of page.events) {
        if (previous !== null && event.sequence <= previous) return restart("sequence_not_increasing");
        previous = event.sequence;
        for (const target of invalidatedBy(event.kind)) invalidate.add(target);
      }
      eventCount += page.events.length;
      known.cursor = page.nextCursor;
      known.lastSequence = previous;
      if (!page.hasMore) break;
    }
    return { ok: true, data: {
      action: eventCount > 0 ? "invalidate" : "none", reasonCode: null,
      invalidate: [...invalidate], eventCount, lastSequence: known.lastSequence,
    } };
  }

  /** Drops the kept cursor: the next poll starts with a new snapshot. */
  function forgetEvents(agentId) {
    cursors.delete(agentId);
  }

  return { conversation, listProjectFiles, readProjectFile, listArtifacts, readArtifact, pollEvents, forgetEvents };
}
