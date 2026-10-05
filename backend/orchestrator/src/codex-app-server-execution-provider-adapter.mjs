import { createHash } from "node:crypto";

import {
  ADAPTER_CONTRACT_VERSION,
  validateAdapterDescriptor,
  validateAdapterRequestAuthority,
  validateAdapterResult,
} from "./adapter-contracts.mjs";
import { CodexAppServerLifecycleReconciler } from "./codex-app-server-lifecycle.mjs";
import {
  conversationReadCapabilityExtension,
  isProviderConversationReadOperation,
} from "./provider-conversation-read-contract.mjs";
import {
  conversationMutationCapabilityExtension,
} from "./provider-conversation-mutation-contract.mjs";

export const CODEX_APP_SERVER_EXECUTION_PROVIDER_ADAPTER_VERSION = "v0.5.2";

const FAMILY = "execution-provider";
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function identifier(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a UTC timestamp`);
  }
  return value;
}

function authority(identity, externalId) {
  return {
    schemaVersion: 1,
    authorityType: "provider",
    sourceId: identity.sourceId,
    externalId: identifier(externalId, "provider externalId"),
    contractVersion: identity.adapterVersion,
  };
}

function providerRef(identity, kind, externalId) {
  return {
    schemaVersion: 1,
    kind,
    relationship: "provider-owner",
    authority: authority(identity, externalId),
  };
}

function capability(operation, { visibility = "headless", recovery = ["none"] } = {}) {
  return {
    operation,
    support: "native",
    contractVersions: [ADAPTER_CONTRACT_VERSION],
    guarantees: [
      "exact-native-identity",
      ...(operation === "observeLifecycle"
        ? ["provider-observed-start", "provider-observed-terminal", "ordered-lifecycle"]
        : []),
    ],
    visibility,
    interruptBehavior: "not-applicable",
    recovery,
    limits: operation === "listThreads" ? { maximumItems: 128 } : {},
    extensions: isProviderConversationReadOperation(operation)
      ? [conversationReadCapabilityExtension()]
      : [],
  };
}

function createThreadCapability() {
  return {
    ...capability("createThread", {
      visibility: "provider-observed",
      recovery: ["reconnect", "read-after-disconnect"],
    }),
    guarantees: [
      "exact-native-identity", "single-writer-required", "command-acceptance",
    ],
    extensions: [conversationMutationCapabilityExtension()],
  };
}

function startExecutionCapability() {
  return {
    ...capability("startExecution", {
      visibility: "provider-observed",
      recovery: ["reconnect", "read-after-disconnect"],
    }),
    guarantees: [
      "exact-native-identity", "single-writer-required", "command-acceptance",
      "exact-task-binding", "exact-profile-binding", "accepted-started-separate",
    ],
    extensions: [conversationMutationCapabilityExtension()],
  };
}

function interruptExecutionCapability() {
  return {
    ...capability("interruptExecution", {
      visibility: "provider-observed",
      recovery: ["reconnect", "read-after-disconnect"],
    }),
    guarantees: [
      "exact-native-identity", "single-writer-required", "command-acceptance",
      "accepted-terminal-separate",
    ],
    interruptBehavior: "cooperative",
    extensions: [conversationMutationCapabilityExtension()],
  };
}

function descriptor(sourceId, runtimeInstanceId, observedAtUtc, enabled) {
  const identity = {
    adapterId: "codex-app-server",
    adapterFamily: FAMILY,
    adapterVersion: CODEX_APP_SERVER_EXECUTION_PROVIDER_ADAPTER_VERSION,
    sourceId: identifier(sourceId, "sourceId"),
    runtimeInstanceId: identifier(runtimeInstanceId, "runtimeInstanceId"),
  };
  return validateAdapterDescriptor({
    schemaVersion: 1,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    identity,
    authority: authority(identity, runtimeInstanceId),
    capabilities: [
      capability("discoverCapabilities"),
      capability("listModels"),
      capability("listThreads", { recovery: ["reconnect"] }),
      capability("readThread", { recovery: ["reconnect", "read-after-disconnect"] }),
      ...(enabled.createThread ? [createThreadCapability()] : []),
      ...(enabled.startExecution ? [startExecutionCapability()] : []),
      ...(enabled.interruptExecution ? [interruptExecutionCapability()] : []),
      capability("getUsage", { recovery: ["reconnect"] }),
      capability("observeLifecycle", {
        visibility: "provider-observed", recovery: ["reconnect"],
      }),
    ],
    capabilitiesObservedAtUtc: utc(observedAtUtc, "capabilitiesObservedAtUtc"),
    capabilitiesValidForSeconds: 3600,
    extensions: [],
  });
}

function lifecycleNone() {
  return {
    state: "none", evidence: "none", eventId: null, sequence: null,
    cursor: null, providerOccurredAtUtc: null,
  };
}

function exactSubject(request, kinds) {
  const allowed = new Set(Array.isArray(kinds) ? kinds : [kinds]);
  if (request.subjectRefs.length !== 1 || !allowed.has(request.subjectRefs[0].kind)) {
    throw new TypeError(`${request.operation} requires one exact provider subject`);
  }
  return request.subjectRefs[0];
}

function boundedObservationId(value) {
  if (typeof value === "string" && ID_PATTERN.test(value)) return value;
  return `appserver-event:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function threadState(thread) {
  const state = thread?.status?.type ?? thread?.status ?? "unknown";
  return ID_PATTERN.test(String(state)) ? String(state) : "unknown";
}

function threadRecord(identity, thread) {
  const ref = providerRef(identity, "provider-thread", thread?.id);
  const updatedAt = thread?.updatedAt ?? thread?.updatedAtUtc ?? null;
  return {
    ref,
    title: typeof thread?.name === "string" && thread.name.length > 0
      ? thread.name.slice(0, 256) : null,
    state: threadState(thread),
    updatedAtUtc: updatedAt === null ? null : utc(updatedAt, "thread.updatedAt"),
  };
}

function failureFrom(error) {
  const code = String(error?.code ?? "");
  if (/TIMEOUT/i.test(code)) {
    return {
      outcome: "unavailable",
      error: { code: "operation_timeout", phase: "observation", providerCategory: null },
      retry: { allowed: true, reasonCode: "bounded_read_timeout" },
    };
  }
  if (/DISCONNECT|EXIT|TRANSPORT/i.test(code)) {
    return {
      outcome: "unavailable",
      error: { code: "provider_disconnected", phase: "observation", providerCategory: null },
      retry: { allowed: true, reasonCode: "provider_disconnected" },
    };
  }
  return {
    outcome: "unavailable",
    error: { code: "adapter_internal_failure", phase: "observation", providerCategory: null },
    retry: { allowed: false, reasonCode: "adapter_internal_failure" },
  };
}

function createThreadOptions(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("createThreadOptions must be null or a plain object");
  }
  const allowed = ["cwd", "approvalPolicy", "sandbox", "serviceName", "ephemeral"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError("createThreadOptions contains an unsupported field");
  }
  if (typeof value.cwd !== "string" || value.cwd.length < 1 || value.cwd.length > 1024) {
    throw new TypeError("createThreadOptions.cwd must be bounded text");
  }
  if (value.approvalPolicy !== "never") {
    throw new TypeError("Supervised thread creation requires approvalPolicy=never");
  }
  if (!["read-only", "workspace-write"].includes(value.sandbox)) {
    throw new TypeError("createThreadOptions.sandbox is unsupported");
  }
  identifier(value.serviceName, "createThreadOptions.serviceName");
  if (typeof value.ephemeral !== "boolean") {
    throw new TypeError("createThreadOptions.ephemeral must be boolean");
  }
  return structuredClone(value);
}

function mutationFailure() {
  return {
    outcome: "uncertain",
    error: {
      code: "post_submit_uncertain",
      phase: "post-submit",
      providerCategory: null,
    },
    retry: { allowed: false, reasonCode: "read_after_disconnect_required" },
  };
}

export class CodexAppServerExecutionProviderAdapter {
  #client;
  #createThreadOptions;
  #startExecutionHandler;
  #interruptExecutionHandler;
  #descriptor;
  #clock;
  #now;
  #onTelemetry;
  #reconcilers = new Map();
  #turnToThread = new Map();
  #usageByThread = new Map();
  #notificationHandler;

  constructor({
    client,
    sourceId,
    runtimeInstanceId,
    capabilitiesObservedAtUtc,
    clock = () => Date.now(),
    now = () => new Date(),
    onTelemetry = async () => {},
    createThreadOptions: requestedCreateThreadOptions = null,
    startExecutionHandler = null,
    interruptExecutionHandler = null,
  }) {
    if (!client || typeof client.on !== "function") {
      throw new TypeError("A connected App Server client is required");
    }
    for (const operation of ["listModels", "listThreads", "readThread"]) {
      if (typeof client[operation] !== "function") {
        throw new TypeError(`App Server client lacks ${operation}`);
      }
    }
    this.#createThreadOptions = createThreadOptions(requestedCreateThreadOptions);
    if (this.#createThreadOptions !== null && typeof client.startThread !== "function") {
      throw new TypeError("App Server client lacks startThread");
    }
    if (startExecutionHandler !== null && typeof startExecutionHandler !== "function") {
      throw new TypeError("startExecutionHandler must be a function or null");
    }
    if (interruptExecutionHandler !== null && typeof interruptExecutionHandler !== "function") {
      throw new TypeError("interruptExecutionHandler must be a function or null");
    }
    this.#startExecutionHandler = startExecutionHandler;
    this.#interruptExecutionHandler = interruptExecutionHandler;
    this.#client = client;
    this.#descriptor = descriptor(
      sourceId,
      runtimeInstanceId,
      capabilitiesObservedAtUtc,
      {
        createThread: this.#createThreadOptions !== null,
        startExecution: this.#startExecutionHandler !== null,
        interruptExecution: this.#interruptExecutionHandler !== null,
      },
    );
    this.#clock = clock;
    this.#now = now;
    this.#onTelemetry = onTelemetry;
    this.#notificationHandler = (message) => this.#observeNotification(message);
    this.#client.on("notification", this.#notificationHandler);
  }

  get descriptor() {
    return structuredClone(this.#descriptor);
  }

  dispose() {
    this.#client.off?.("notification", this.#notificationHandler);
  }

  #observeNotification(message) {
    const params = message?.params ?? {};
    const threadId = params.threadId ?? params.thread?.id ?? null;
    if (typeof threadId !== "string") return;
    const observedAtUtc = this.#now().toISOString();
    if (message.method === "thread/tokenUsage/updated") {
      const lastTotalTokens = params.tokenUsage?.last?.totalTokens;
      const modelContextWindow = params.tokenUsage?.modelContextWindow;
      if (Number.isInteger(lastTotalTokens) && lastTotalTokens >= 0
          && Number.isInteger(modelContextWindow) && modelContextWindow > 0) {
        this.#usageByThread.set(threadId, {
          lastTotalTokens, modelContextWindow, observedAtUtc,
        });
      }
    }
    let reconciler = this.#reconcilers.get(threadId);
    if (!reconciler) {
      reconciler = new CodexAppServerLifecycleReconciler({
        threadId,
        correlationId: `appserver:${threadId}`.slice(0, 160),
      });
      this.#reconcilers.set(threadId, reconciler);
    }
    const turnId = params.turnId ?? params.turn?.id ?? null;
    if (typeof turnId === "string") this.#turnToThread.set(turnId, threadId);
    reconciler.observe(message, observedAtUtc);
  }

  #result(request, {
    outcome,
    data = null,
    evidenceRefs = [],
    authorityId = this.#descriptor.identity.runtimeInstanceId,
    lifecycle = lifecycleNone(),
    freshness = { status: "fresh", ageSeconds: 0, staleAfterSeconds: 60 },
    error = null,
    retry = { allowed: false, reasonCode: "bounded_operation_complete" },
  }) {
    return validateAdapterResult({
      schemaVersion: 1,
      contractVersion: ADAPTER_CONTRACT_VERSION,
      adapter: structuredClone(this.#descriptor.identity),
      operation: {
        name: request.operation,
        operationId: request.operationId,
        correlationId: request.correlationId,
      },
      observedAtUtc: this.#now().toISOString(),
      authority: authority(this.#descriptor.identity, authorityId),
      freshness,
      resultType: ["accepted", "started", "completed", "cancelled", "interrupted"]
        .includes(outcome) ? "success" : "error",
      outcome,
      lifecycle,
      retry,
      evidenceRefs,
      data,
      error,
      extensions: [],
    });
  }

  async #telemetry(request, result, startedAt) {
    try {
      await this.#onTelemetry({
        schemaVersion: 1,
        adapter: structuredClone(this.#descriptor.identity),
        operation: request.operation,
        operationId: request.operationId,
        durationMs: Math.max(0, this.#clock() - startedAt),
        outcome: result.outcome,
        errorCode: result.error?.code ?? null,
      });
    } catch {
      // Telemetry cannot alter a completed provider read or observation.
    }
  }

  async #read(request, operation, action, normalize) {
    validateAdapterRequestAuthority(request, this.#descriptor.identity);
    if (request.operation !== operation) throw new TypeError(`Expected ${operation} request`);
    const startedAt = this.#clock();
    let result;
    try {
      result = this.#result(request, normalize(await action()));
    } catch (error) {
      result = this.#result(request, failureFrom(error));
    }
    await this.#telemetry(request, result, startedAt);
    return result;
  }

  async #mutation(request, operation, action, normalize) {
    validateAdapterRequestAuthority(request, this.#descriptor.identity);
    if (request.operation !== operation) throw new TypeError(`Expected ${operation} request`);
    const startedAt = this.#clock();
    let result;
    try {
      result = this.#result(request, normalize(await action()));
    } catch {
      result = this.#result(request, mutationFailure());
    }
    await this.#telemetry(request, result, startedAt);
    return result;
  }

  async discoverCapabilities(request) {
    validateAdapterRequestAuthority(request, this.#descriptor.identity);
    if (request.operation !== "discoverCapabilities") {
      throw new TypeError("Expected discoverCapabilities request");
    }
    const startedAt = this.#clock();
    const result = this.#result(request, {
      outcome: "completed",
      data: { descriptor: this.descriptor },
      retry: { allowed: false, reasonCode: "capabilities_observed" },
    });
    await this.#telemetry(request, result, startedAt);
    return result;
  }

  listModels(request) {
    return this.#read(request, "listModels", () => this.#client.listModels(request.parameters), (raw) => {
      const models = raw?.data ?? [];
      if (!Array.isArray(models) || models.length > 128) {
        throw new TypeError("App Server returned an invalid model catalog");
      }
      const evidenceRefs = [];
      const records = models.map((model) => {
        const ref = providerRef(this.#descriptor.identity, "provider-item", model?.id);
        evidenceRefs.push(ref);
        const efforts = (model?.supportedReasoningEfforts ?? []).map(
          (item) => typeof item === "string" ? item : item?.reasoningEffort,
        ).filter((item) => typeof item === "string");
        return {
          ref,
          name: String(model?.displayName ?? model?.id ?? "").slice(0, 256),
          supportedReasoningEfforts: [...new Set(efforts)],
          defaultReasoningEffort: model?.defaultReasoningEffort ?? null,
        };
      });
      return {
        outcome: "completed",
        data: { records },
        evidenceRefs,
        retry: { allowed: false, reasonCode: "model_catalog_observed" },
      };
    });
  }

  listThreads(request) {
    return this.#read(request, "listThreads", () => this.#client.listThreads(request.parameters), (raw) => {
      const threads = raw?.data ?? [];
      if (!Array.isArray(threads) || threads.length > 128) {
        throw new TypeError("App Server returned an invalid bounded thread catalog");
      }
      const records = threads.map((thread) => threadRecord(this.#descriptor.identity, thread));
      return {
        outcome: "completed",
        data: { records },
        evidenceRefs: records.map((record) => record.ref),
        retry: { allowed: false, reasonCode: "thread_catalog_observed" },
      };
    });
  }

  readThread(request) {
    const subject = exactSubject(request, "provider-thread");
    const expectedId = subject.authority.externalId;
    return this.#read(request, "readThread", () => this.#client.readThread(expectedId, false), (raw) => {
      if (raw?.thread?.id !== expectedId) {
        throw new TypeError("App Server thread read changed native identity");
      }
      const record = threadRecord(this.#descriptor.identity, raw.thread);
      return {
        outcome: "completed",
        data: { record },
        evidenceRefs: [record.ref],
        authorityId: expectedId,
        retry: { allowed: false, reasonCode: "thread_observed" },
      };
    });
  }

  createThread(request) {
    if (this.#createThreadOptions === null) {
      throw new TypeError("App Server thread creation is not enabled for this adapter");
    }
    return this.#mutation(
      request,
      "createThread",
      () => this.#client.startThread(structuredClone(this.#createThreadOptions)),
      (raw) => {
        const threadId = identifier(raw?.thread?.id, "thread.id");
        const threadRef = providerRef(this.#descriptor.identity, "provider-thread", threadId);
        return {
          outcome: "accepted",
          data: { threadRef },
          evidenceRefs: [threadRef],
          authorityId: threadId,
          retry: { allowed: false, reasonCode: "provider_thread_creation_accepted" },
        };
      },
    );
  }

  startExecution(request) {
    if (this.#startExecutionHandler === null) {
      throw new TypeError("App Server turn start is not enabled for this adapter");
    }
    const subject = exactSubject(request, "provider-thread");
    const threadId = subject.authority.externalId;
    return this.#mutation(
      request,
      "startExecution",
      () => this.#startExecutionHandler(structuredClone(request)),
      (raw) => {
        if (identifier(raw?.threadId, "thread.id") !== threadId) {
          throw new TypeError("App Server turn start changed thread identity");
        }
        const commandSubjectRef = providerRef(
          this.#descriptor.identity, "provider-thread", threadId,
        );
        return {
          outcome: "accepted",
          data: { commandSubjectRef },
          evidenceRefs: [commandSubjectRef],
          authorityId: threadId,
          retry: { allowed: false, reasonCode: "provider_turn_start_accepted" },
        };
      },
    );
  }

  interruptExecution(request) {
    if (this.#interruptExecutionHandler === null) {
      throw new TypeError("App Server turn interrupt is not enabled for this adapter");
    }
    const subject = exactSubject(
      request, ["provider-thread", "provider-turn", "provider-subagent"],
    );
    return this.#mutation(
      request,
      "interruptExecution",
      () => this.#interruptExecutionHandler(structuredClone(request)),
      (raw) => {
        const expectedId = subject.authority.externalId;
        const observedId = subject.kind === "provider-thread"
          ? raw?.threadId : raw?.executionId;
        if (identifier(observedId, "interrupt subject id") !== expectedId) {
          throw new TypeError("App Server interrupt changed command subject identity");
        }
        const commandSubjectRef = providerRef(
          this.#descriptor.identity, subject.kind, expectedId,
        );
        const data = subject.kind === "provider-thread"
          ? { commandSubjectRef }
          : { executionRef: commandSubjectRef };
        return {
          outcome: "accepted",
          data,
          evidenceRefs: [commandSubjectRef],
          authorityId: expectedId,
          retry: { allowed: false, reasonCode: "provider_turn_interrupt_accepted" },
        };
      },
    );
  }

  async getUsage(request) {
    validateAdapterRequestAuthority(request, this.#descriptor.identity);
    if (request.operation !== "getUsage") throw new TypeError("Expected getUsage request");
    const startedAt = this.#clock();
    const subject = exactSubject(request, "provider-thread");
    const threadId = subject.authority.externalId;
    const usage = this.#usageByThread.get(threadId) ?? null;
    const observedAtUtc = this.#now().toISOString();
    const ageSeconds = usage === null ? null
      : Math.max(0, Math.floor((Date.parse(observedAtUtc) - Date.parse(usage.observedAtUtc)) / 1000));
    let result;
    if (usage === null || ageSeconds >= 60) {
      result = this.#result(request, {
        outcome: "stale",
        authorityId: threadId,
        freshness: {
          status: "stale", ageSeconds: usage === null ? 60 : ageSeconds, staleAfterSeconds: 60,
        },
        error: { code: "stale_observation", phase: "observation", providerCategory: null },
        retry: { allowed: true, reasonCode: "usage_not_fresh" },
      });
    } else {
      const threadRef = providerRef(this.#descriptor.identity, "provider-thread", threadId);
      result = this.#result(request, {
        outcome: "completed",
        authorityId: threadId,
        freshness: { status: "fresh", ageSeconds, staleAfterSeconds: 60 },
        evidenceRefs: [threadRef],
        data: {
          threadRef,
          observedAtUtc: usage.observedAtUtc,
          lastTotalTokens: usage.lastTotalTokens,
          modelContextWindow: usage.modelContextWindow,
          cumulativeUsageUsed: false,
        },
        retry: { allowed: false, reasonCode: "context_usage_observed" },
      });
    }
    await this.#telemetry(request, result, startedAt);
    return result;
  }

  async observeLifecycle(request) {
    validateAdapterRequestAuthority(request, this.#descriptor.identity);
    if (request.operation !== "observeLifecycle") {
      throw new TypeError("Expected observeLifecycle request");
    }
    const startedAt = this.#clock();
    const subject = exactSubject(request, ["provider-turn", "provider-subagent"]);
    const turnId = subject.authority.externalId;
    const threadId = this.#turnToThread.get(turnId);
    const snapshot = threadId ? this.#reconcilers.get(threadId)?.snapshot() : null;
    const relevant = snapshot?.events.filter((event) => event.turnId === turnId) ?? [];
    const state = snapshot?.turnId === turnId ? snapshot.state : "unknown";
    const terminalMethod = TERMINAL.has(state) ? "turn/completed" : "turn/started";
    const event = [...relevant].reverse().find((item) => item.method === terminalMethod) ?? null;
    let result;
    if (!event || !["started", "completed", "failed", "interrupted"].includes(state)) {
      result = this.#result(request, {
        outcome: "stale",
        authorityId: turnId,
        freshness: { status: "stale", ageSeconds: 60, staleAfterSeconds: 60 },
        error: { code: "stale_observation", phase: "observation", providerCategory: null },
        retry: { allowed: true, reasonCode: "lifecycle_not_observed" },
      });
    } else {
      const executionRef = providerRef(this.#descriptor.identity, subject.kind, turnId);
      const eventIndex = snapshot.events.findIndex(
        (item) => item.observationId === event.observationId,
      );
      const lifecycle = {
        state,
        evidence: "provider-observed",
        eventId: boundedObservationId(event.observationId),
        sequence: event.providerSequence ?? eventIndex + 1,
        cursor: event.observationId,
        providerOccurredAtUtc: event.providerOccurredAtUtc,
      };
      if (state === "failed") {
        result = this.#result(request, {
          outcome: "failed",
          authorityId: turnId,
          evidenceRefs: [executionRef],
          lifecycle,
          error: {
            code: "provider_terminal_failure", phase: "provider-terminal", providerCategory: null,
          },
          retry: { allowed: false, reasonCode: "provider_terminal_failure" },
        });
      } else {
        result = this.#result(request, {
          outcome: state,
          data: { executionRef },
          evidenceRefs: [executionRef],
          authorityId: turnId,
          lifecycle,
          retry: { allowed: false, reasonCode: "provider_lifecycle_observed" },
        });
      }
    }
    await this.#telemetry(request, result, startedAt);
    return result;
  }
}
