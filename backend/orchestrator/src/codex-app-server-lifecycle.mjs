import { createHash } from "node:crypto";

export const CODEX_APP_SERVER_LIFECYCLE_VERSION = "v0.2.0";

const TERMINAL = new Set(["completed", "interrupted", "failed"]);
const METHODS = new Set([
  "thread/started", "thread/compacted", "thread/tokenUsage/updated",
  "turn/started", "turn/completed", "item/started", "item/completed",
  "hook/started", "hook/completed", "model/rerouted", "error",
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function ids(method, params) {
  return {
    method,
    threadId: params.threadId ?? params.thread?.id ?? null,
    turnId: params.turnId ?? params.turn?.id ?? null,
    itemId: params.item?.id ?? null,
    hookId: params.hook?.id ?? params.hookId ?? null,
    status: params.turn?.status ?? null,
  };
}

function eventDiscriminator(method, params) {
  if (method === "thread/tokenUsage/updated") {
    const usage = params.tokenUsage ?? {};
    const total = usage.total ?? {};
    return {
      totalTokens: total.totalTokens ?? null,
      inputTokens: total.inputTokens ?? null,
      outputTokens: total.outputTokens ?? null,
      reasoningOutputTokens: total.reasoningOutputTokens ?? null,
      modelContextWindow: usage.modelContextWindow ?? null,
    };
  }
  if (method === "model/rerouted") {
    return {
      fromModel: params.fromModel ?? null,
      toModel: params.toModel ?? null,
    };
  }
  return null;
}

function providerOccurrence(method, params) {
  const value = method === "turn/started" ? params.turn?.startedAt
    : method === "turn/completed" ? params.turn?.completedAt
      : null;
  if (value === null || value === undefined) return null;
  let milliseconds;
  if (Number.isSafeInteger(value) && value >= 0) {
    milliseconds = value > 10_000_000_000 ? value : value * 1000;
  } else if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    milliseconds = Date.parse(value);
  } else {
    throw new TypeError("Provider lifecycle timestamp is invalid");
  }
  if (!Number.isFinite(milliseconds) || milliseconds < 0
      || milliseconds > 8_640_000_000_000_000) {
    throw new TypeError("Provider lifecycle timestamp is outside UTC bounds");
  }
  return new Date(milliseconds).toISOString();
}

export function mapAppServerCommandReceipt({ operation, threadId, turnId = null }) {
  if (typeof operation !== "string" || typeof threadId !== "string") {
    throw new TypeError("Command receipt requires operation and thread identity");
  }
  return {
    schemaVersion: 1, operation, commandOutcome: "accepted", threadId, turnId,
    lifecycleState: "none", providerObserved: false,
  };
}

export function classifyCodexHookEvidence({ method, params = {} }) {
  if (!["hook/started", "hook/completed"].includes(method)) {
    throw new TypeError("Only App Server hook notifications are accepted");
  }
  const identity = ids(method, params);
  return {
    schemaVersion: 1,
    evidenceKind: "supplementary-hook",
    authoritativeForTurnLifecycle: false,
    threadId: identity.threadId,
    turnId: identity.turnId,
    hookId: identity.hookId,
    state: method === "hook/started" ? "started" : "completed",
  };
}

export class CodexAppServerLifecycleReconciler {
  #threadId;
  #correlationId;
  #events = [];
  #seen = new Map();
  #sequenceHashes = new Map();
  #lastProviderSequence = null;
  #state = "unknown";
  #turnId = null;
  #continuity = "complete";

  constructor({ threadId, correlationId }) {
    if (typeof threadId !== "string" || typeof correlationId !== "string") {
      throw new TypeError("Lifecycle reconciliation requires exact identities");
    }
    this.#threadId = threadId;
    this.#correlationId = correlationId;
  }

  observe({ method, params = {} }, observedAtUtc) {
    if (!METHODS.has(method)) return { accepted: false, reason: "unsupported_event" };
    if (!observedAtUtc?.endsWith("Z") || !Number.isFinite(Date.parse(observedAtUtc))) {
      throw new TypeError("observedAtUtc must be UTC");
    }
    if (method === "error") {
      if (params.willRetry === true && !TERMINAL.has(this.#state)) this.#state = "reconnecting";
      return { accepted: true, duplicate: false, state: this.#state };
    }
    const identity = ids(method, params);
    if (identity.threadId !== this.#threadId) return { accepted: false, reason: "foreign_thread" };
    if (this.#turnId && identity.turnId && identity.turnId !== this.#turnId) {
      return { accepted: false, reason: "foreign_turn" };
    }
    if (method === "turn/completed" && TERMINAL.has(this.#state)
        && identity.status !== this.#state) {
      this.#continuity = "contradictory";
      return { accepted: false, duplicate: false, replayed: false, state: this.#state };
    }
    const nativeEventId = typeof params.eventId === "string" ? params.eventId : null;
    const providerOccurredAtUtc = providerOccurrence(method, params);
    const contentHash = hash({
      identity,
      discriminator: eventDiscriminator(method, params),
      providerSequence: params.sequence ?? null,
      providerOccurredAtUtc,
    });
    const observationId = nativeEventId ?? `appserver-observation:${contentHash}`;
    const previous = this.#seen.get(observationId);
    if (previous) {
      if (previous !== contentHash) this.#continuity = "contradictory";
      return {
        accepted: previous === contentHash,
        duplicate: previous === contentHash,
        state: this.#state,
      };
    }
    const sequence = Number.isInteger(params.sequence) ? params.sequence : null;
    const replayed = sequence !== null && this.#lastProviderSequence !== null
      && sequence <= this.#lastProviderSequence;
    if (sequence !== null) {
      const priorHash = this.#sequenceHashes.get(sequence);
      if (priorHash && priorHash !== contentHash) this.#continuity = "contradictory";
      if (this.#lastProviderSequence !== null && sequence > this.#lastProviderSequence + 1) {
        this.#continuity = "gap";
      }
      this.#sequenceHashes.set(sequence, contentHash);
      this.#lastProviderSequence = Math.max(this.#lastProviderSequence ?? sequence, sequence);
    }
    this.#seen.set(observationId, contentHash);
    if (identity.turnId) this.#turnId = identity.turnId;
    if (method === "turn/started") this.#state = "started";
    if (method === "turn/completed") {
      const next = TERMINAL.has(identity.status) ? identity.status : "uncertain";
      this.#state = next;
    }
    if (method === "thread/compacted" && !TERMINAL.has(this.#state)) this.#state = "compacted";
    this.#events.push({
      observationId,
      nativeEventId,
      method,
      threadId: identity.threadId,
      turnId: identity.turnId,
      itemId: identity.itemId,
      hookId: identity.hookId,
      providerSequence: sequence,
      replayed,
      providerOccurredAtUtc,
      observedAtUtc,
      contentHash,
    });
    if (this.#events.length > 512) {
      const removed = this.#events.shift();
      this.#seen.delete(removed.observationId);
      if (removed.providerSequence !== null
          && this.#sequenceHashes.get(removed.providerSequence) === removed.contentHash) {
        this.#sequenceHashes.delete(removed.providerSequence);
      }
    }
    return { accepted: true, duplicate: false, replayed, state: this.#state };
  }

  snapshot() {
    return {
      schemaVersion: 1,
      contractVersion: CODEX_APP_SERVER_LIFECYCLE_VERSION,
      correlationId: this.#correlationId,
      threadId: this.#threadId,
      turnId: this.#turnId,
      state: this.#state,
      continuity: this.#continuity,
      lastProviderSequence: this.#lastProviderSequence,
      eventCount: this.#events.length,
      events: structuredClone(this.#events),
      deterministicAcceptanceState: "separate",
    };
  }
}

export function rebuildLifecycleFromThread({ thread, correlationId }) {
  if (!thread?.id || !Array.isArray(thread.turns)) {
    throw new TypeError("Exact thread read is required");
  }
  const latest = thread.turns.at(-1) ?? null;
  const nativeState = latest?.status ?? (thread.turns.length === 0 ? "idle" : "unknown");
  const state = nativeState === "inProgress" ? "started"
    : (["completed", "interrupted", "failed", "idle"].includes(nativeState)
      ? nativeState : "unknown");
  return {
    schemaVersion: 1,
    contractVersion: CODEX_APP_SERVER_LIFECYCLE_VERSION,
    correlationId,
    threadId: thread.id,
    turnId: latest?.id ?? null,
    state,
    evidence: "thread/read",
    repeatsProviderAction: false,
  };
}
