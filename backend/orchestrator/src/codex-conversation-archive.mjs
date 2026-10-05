import { createHash } from "node:crypto";
import { validateApplicationPayloadPrivacy } from "./application-contract.mjs";
import { ConversationArchiveError, conversationArchiveIdentity } from "./conversation-archive.mjs";

export const CODEX_CONVERSATION_ARCHIVE_VERSION = "v0.4.0";
const PRIVATE_TEXT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];
function fail(code = "archive_invalid_provider_page") { throw new ConversationArchiveError(code); }
function keyHash(value) { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function providerId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 512
      || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}
function state(value) {
  const candidate = value?.type ?? value;
  if (["requested", "accepted", "started", "completed", "failed", "interrupted",
    "uncertain", "unknown"].includes(candidate)) return candidate;
  return ({ inProgress: "started" })[candidate] ?? "unknown";
}
function timestamp(value) {
  if (value === null || value === undefined) return null;
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) fail();
  return date.toISOString();
}
function safeContent(text) {
  if (typeof text !== "string" || text.length === 0) return "content_not_provided";
  if (/data:(?:image|audio|video)\//iu.test(text)) return "inline_media";
  if (Buffer.byteLength(text, "utf8") > 262_144) return "oversized_content";
  try { validateApplicationPayloadPrivacy(text, { zone: "result-output" }); }
  catch { return "private_content"; }
  if (PRIVATE_TEXT.some((pattern) => pattern.test(text))
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return "private_content";
  return null;
}

export class CodexConversationArchive {
  #pending = Promise.resolve();
  #queued = 0;
  #failed = false;
  #providerUnavailable = false;
  #listeners = [];
  #synchronization = null;
  #synchronizationStatus = {
    state: "not-started", pagesImported: 0, capturedRecords: 0,
    checkpointRevision: 0, exhausted: false,
  };

  // providerId: the provider of the bound conversation; the Claude Code session
  // host emits the same notifications as the Codex client.
  constructor({ archive, binding, client, providerId = "codex" }) {
    if (binding.providerId !== providerId) fail("archive_identity_conflict");
    this.archive = archive;
    this.binding = structuredClone(binding);
    this.client = client;
    this.conversationId = conversationArchiveIdentity(binding);
  }

  get captureStatus() {
    return { status: this.#failed || this.#providerUnavailable ? "unavailable" : "available",
      reasonCode: this.#failed ? "archive_capture_failed"
        : this.#providerUnavailable ? "provider_unavailable" : "available",
      synchronization: structuredClone(this.#synchronizationStatus) };
  }

  #enqueue(action) {
    if (this.#failed) return;
    if (this.#queued >= 256) { this.#failed = true; return; }
    this.#queued++;
    this.#pending = this.#pending.then(action).catch(() => { this.#failed = true; })
      .finally(() => { this.#queued--; });
  }

  async flush() {
    await this.#pending;
    if (this.#failed) fail("archive_capture_unavailable");
  }

  async synchronize({ limit = 32, maxPages = 64 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32
        || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 256) fail();
    if (this.#synchronization !== null) return this.#synchronization;
    this.#synchronization = (async () => {
      const checkpoint = await this.archive.readImportCheckpoint(this.binding);
      let restart = checkpoint.exhausted;
      let pagesImported = 0;
      let capturedRecords = 0;
      let latest = {
        checkpointRevision: checkpoint.revision,
        exhausted: checkpoint.exhausted,
      };
      this.#synchronizationStatus = {
        state: "running", pagesImported, capturedRecords,
        checkpointRevision: checkpoint.revision, exhausted: false,
      };
      while (pagesImported < maxPages) {
        latest = await this.importNextPage({ limit, restart });
        restart = false;
        pagesImported += 1;
        capturedRecords += latest.capturedRecords;
        this.#synchronizationStatus = {
          state: latest.exhausted ? "caught-up" : "running",
          pagesImported, capturedRecords,
          checkpointRevision: latest.checkpointRevision,
          exhausted: latest.exhausted,
        };
        if (latest.exhausted) break;
      }
      if (!latest.exhausted) this.#synchronizationStatus.state = "partial";
      return structuredClone(this.#synchronizationStatus);
    })().catch((error) => {
      this.#failed = true;
      this.#synchronizationStatus = {
        ...this.#synchronizationStatus, state: "failed", exhausted: false,
      };
      throw error;
    }).finally(() => { this.#synchronization = null; });
    return this.#synchronization;
  }

  observe() {
    if (this.#listeners.length) return;
    for (const method of ["transportError", "exit", "protocolError"]) {
      const listener = () => { this.#providerUnavailable = true; };
      this.client.on(method, listener);
      this.#listeners.push([method, listener]);
    }
    for (const method of ["item/completed", "turn/started", "turn/completed"]) {
      const listener = (event) => {
        if (event?.threadId !== this.binding.threadId) return;
        try {
          const turn = method === "item/completed"
            ? { id: event.turnId, status: "completed" } : event.turn;
          const items = method === "item/completed" ? [event.item] : (turn?.items ?? []);
          if (!Array.isArray(items) || items.length > 512) fail();
          for (const item of items) this.#enqueue(() => this.recordItem(turn, item));
          if (method !== "item/completed") this.#enqueue(() => this.archive.append(this.binding, {
              recordId: `turn:${keyHash(providerId(turn?.id))}`,
              kind: "delivery", role: null, state: state(turn.status), text: null,
              providerTurnId: turn.id, providerItemId: null, requestId: null,
              occurredAtUtc: null, omissions: [],
            }));
        } catch { this.#failed = true; }
      };
      this.client.on(method, listener);
      this.#listeners.push([method, listener]);
    }
  }

  async close() {
    for (const [method, listener] of this.#listeners) this.client.off(method, listener);
    this.#listeners = [];
    this.#providerUnavailable = true;
    await this.#synchronization?.catch(() => undefined);
    await this.#pending;
  }

  async recordOutgoing({ requestId, text }) {
    await this.flush();
    if (this.#providerUnavailable) fail("archive_provider_unavailable");
    providerId(requestId);
    return this.archive.append(this.binding, {
      recordId: `request:${keyHash(requestId)}`,
      kind: "submission", role: "user", state: "requested",
      text, providerTurnId: null, providerItemId: null, requestId,
      occurredAtUtc: null, omissions: [],
    });
  }

  recordDelivery({ requestId, deliveryState, turnId = null }) {
    providerId(requestId);
    this.#enqueue(() => this.archive.append(this.binding, {
      recordId: `delivery:${keyHash(requestId)}`,
      kind: "delivery", role: null, state: deliveryState,
      text: null, providerTurnId: turnId, providerItemId: null, requestId,
      occurredAtUtc: null, omissions: [],
    }));
  }

  async recordInteraction({
    interactionId, phase, turnId = null, itemId = null, state: interactionState,
    text, occurredAtUtc,
  }) {
    await this.flush();
    providerId(interactionId);
    providerId(phase);
    if (turnId !== null) providerId(turnId);
    if (itemId !== null) providerId(itemId);
    const omission = safeContent(text);
    return this.archive.append(this.binding, {
      recordId: `interaction:${keyHash({ interactionId, phase })}`,
      kind: "interaction", role: null, state: state(interactionState),
      text: omission === null ? text : null,
      providerTurnId: turnId, providerItemId: itemId, requestId: interactionId,
      occurredAtUtc: timestamp(occurredAtUtc),
      omissions: omission === null ? [] : [omission],
    });
  }

  recordItem(turn, item) {
    if ((turn.threadId !== undefined && turn.threadId !== this.binding.threadId)
        || (item.threadId !== undefined && item.threadId !== this.binding.threadId)) {
      fail("archive_identity_conflict");
    }
    const turnId = providerId(turn.id);
    const itemId = providerId(item.id);
    let kind = "omission", role = null, text = null, requestId = null;
    const omissions = [];
    if (item.type === "userMessage") {
      kind = "message"; role = "user";
      requestId = item.clientId == null ? null : providerId(item.clientId);
      if (Array.isArray(item.content)) {
        const parts = item.content.filter((part) => part?.type === "text" && typeof part.text === "string");
        text = parts.map((part) => part.text).join("\n");
        if (parts.length !== item.content.length) omissions.push("unsupported_content");
      }
    } else if (item.type === "agentMessage") {
      kind = "message"; role = "assistant"; text = item.text;
    } else if (item.type === "commandExecution") {
      kind = "activity"; role = "tool";
      const command = typeof item.command === "string" ? item.command : null;
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null;
      text = [command === null ? null : `Command:\n${command}`,
        output === null ? null : `Output:\n${output}`,
        Number.isSafeInteger(item.exitCode) ? `Exit code: ${item.exitCode}` : null].filter(Boolean).join("\n");
      if (command === null || output === null) omissions.push("content_not_provided");
    } else {
      omissions.push(item.type === "reasoning" ? "hidden_reasoning" : "unsupported_content");
    }
    if (kind !== "omission") {
      const reason = safeContent(text);
      if (reason !== null) { text = null; omissions.push(reason); }
    }
    return this.archive.append(this.binding, {
      recordId: `provider-item:${keyHash({ turnId, itemId })}`,
      kind, role, state: state(item.status ?? turn.status), text: text ?? null,
      providerTurnId: turnId, providerItemId: itemId, requestId,
      occurredAtUtc: timestamp(item.createdAt ?? null), omissions: [...new Set(omissions)],
    });
  }

  async importPage({ cursor = null, limit = 10 } = {}) {
    if ((cursor !== null && (typeof cursor !== "string" || cursor.length > 512))
        || !Number.isInteger(limit) || limit < 1 || limit > 32) fail();
    let page;
    try {
      const result = await this.client.readThread(this.binding.threadId, false);
      if (result?.thread?.id !== this.binding.threadId) fail("archive_identity_conflict");
      page = await this.client.listThreadTurns(this.binding.threadId, {
        cursor: cursor ?? undefined, limit, sortDirection: "asc", itemsView: "full",
      });
    } catch (error) {
      if (error instanceof ConversationArchiveError) throw error;
      fail("archive_provider_unavailable");
    }
    if (!Array.isArray(page?.data) || page.data.length > limit
        || (page.nextCursor != null && (typeof page.nextCursor !== "string" || page.nextCursor.length > 512))) fail();
    let captured = 0;
    for (const turn of page.data) {
      if (!Array.isArray(turn.items) || turn.items.length > 512) fail();
      for (const item of turn.items) {
        const receipt = await this.recordItem(turn, item);
        if (!receipt.replay) captured++;
      }
    }
    return { conversationId: this.conversationId, capturedRecords: captured,
      nextCursor: page.nextCursor ?? null, coverage: "provider-page" };
  }

  async importNextPage({ limit = 10, restart = false } = {}) {
    if (typeof restart !== "boolean" || !Number.isInteger(limit) || limit < 1 || limit > 32) fail();
    const previous = await this.archive.readImportCheckpoint(this.binding);
    if (previous.exhausted && !restart) return {
      conversationId: this.conversationId, capturedRecords: 0,
      checkpointRevision: previous.revision, exhausted: true, coverage: "captured-only",
    };
    const cursor = restart ? null : previous.cursor;
    const page = await this.importPage({ cursor, limit });
    if (page.nextCursor !== null && page.nextCursor === cursor) fail("archive_import_cursor_stalled");
    const swapped = await this.archive.checkpointImport(this.binding, {
      expectedRevision: previous.revision, nextCursor: page.nextCursor,
    });
    if (!swapped) fail("archive_import_conflict");
    return { conversationId: this.conversationId, capturedRecords: page.capturedRecords,
      checkpointRevision: previous.revision + 1, exhausted: page.nextCursor === null,
      coverage: "captured-only" };
  }
}
