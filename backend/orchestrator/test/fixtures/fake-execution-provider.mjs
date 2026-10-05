import {
  ADAPTER_CONTRACT_VERSION,
  adapterOperationRequestHash,
  matchAdapterCapabilities,
  validateAdapterOperationRequest,
  validateAdapterResult,
} from "../../src/adapter-contracts.mjs";

const FAMILY = "execution-provider";
const BASE_TIME = Date.parse("2026-08-30T12:00:00.000Z");

function capability(operation, support, {
  guarantees = [],
  visibility = "headless",
  interruptBehavior = "not-applicable",
  recovery = ["none"],
  limits = {},
  extensions = [],
} = {}) {
  return {
    operation,
    support,
    contractVersions: [ADAPTER_CONTRACT_VERSION],
    guarantees,
    visibility,
    interruptBehavior,
    recovery,
    limits,
    extensions,
  };
}

function descriptor(runtimeInstanceId, capabilitiesObservedAtUtc) {
  const identity = {
    adapterId: "fake-execution-provider",
    adapterFamily: FAMILY,
    adapterVersion: ADAPTER_CONTRACT_VERSION,
    sourceId: "fake-execution-provider",
    runtimeInstanceId,
  };
  return {
    schemaVersion: 1,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    identity,
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: identity.sourceId,
      externalId: runtimeInstanceId,
      contractVersion: identity.adapterVersion,
    },
    capabilities: [
      capability("discoverCapabilities", "native", {
        guarantees: ["exact-native-identity"],
      }),
      capability("startExecution", "native", {
        guarantees: [
          "command-acceptance", "accepted-started-separate", "exact-native-identity",
          "exact-task-binding", "exact-profile-binding",
        ],
      }),
      capability("observeLifecycle", "native", {
        guarantees: [
          "provider-observed-start", "provider-observed-terminal", "ordered-lifecycle",
          "cursor-replay", "exact-native-identity",
        ],
        visibility: "provider-observed",
        recovery: ["reconnect", "cursor-replay"],
        extensions: [{ extensionId: "fake.execution.lifecycle-marker", contractVersion: ADAPTER_CONTRACT_VERSION }],
      }),
      capability("interruptExecution", "native", {
        guarantees: ["command-acceptance", "accepted-terminal-separate"],
        interruptBehavior: "cooperative",
      }),
      capability("listModels", "unavailable"),
    ],
    capabilitiesObservedAtUtc,
    capabilitiesValidForSeconds: 3600,
    extensions: [{ extensionId: "fake.execution.diagnostics", contractVersion: ADAPTER_CONTRACT_VERSION }],
  };
}

function requirement(operation, requiredGuarantees = []) {
  return {
    operation,
    acceptableSupport: ["native"],
    requiredGuarantees,
    acceptableVisibility: ["provider-observed", "platform-visible", "headless", "none"],
    acceptableInterruptBehavior: [
      "not-applicable", "unsupported", "cooperative", "immediate", "provider-defined",
    ],
    requiredRecovery: [],
    minimumLimits: {},
  };
}

export function fakeOperationRequest(operation, operationId, {
  subjectRefs = [],
  taskBinding = null,
  profile = null,
  parameters = {},
  requiredGuarantees = [],
} = {}) {
  return {
    schemaVersion: 1,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    operation,
    operationId,
    correlationId: "fake-conformance-correlation",
    requestedAtUtc: "2026-08-30T12:00:00.000Z",
    taskBinding,
    profile,
    subjectRefs,
    requiredCapabilities: [requirement(operation, requiredGuarantees)],
    parameters,
  };
}

export function fakeTaskBinding() {
  return {
    sourceId: "orchestrator-development",
    taskId: "adapter-conformance-task",
    taskSha256: "a".repeat(64),
  };
}

export function fakeProfile() {
  return { model: "fake-model", reasoningEffort: "max", fallbackPolicy: "deny" };
}

function providerReference(identity, externalId) {
  const authority = {
    schemaVersion: 1,
    authorityType: "provider",
    sourceId: identity.sourceId,
    externalId,
    contractVersion: identity.adapterVersion,
  };
  return {
    schemaVersion: 1,
    kind: "provider-turn",
    relationship: "provider-owner",
    authority,
  };
}

export class FakeExecutionProvider {
  #descriptor;
  #tick = 0;
  #nextExecution = 1;
  #executions = new Map();
  #mutationOperations = new Map();
  #submitCount = 0;
  #interruptCount = 0;

  constructor({
    runtimeInstanceId = "fake-runtime-1",
    capabilitiesObservedAtUtc = "2026-08-30T12:00:00.000Z",
    restoredState = null,
  } = {}) {
    this.#descriptor = descriptor(runtimeInstanceId, capabilitiesObservedAtUtc);
    if (restoredState !== null) this.#restore(restoredState);
  }

  get descriptor() {
    return structuredClone(this.#descriptor);
  }

  #restore(state) {
    if (state.runtimeInstanceId !== this.#descriptor.identity.runtimeInstanceId) {
      throw new Error("Restored fake state belongs to another runtime");
    }
    this.#tick = state.tick;
    this.#nextExecution = state.nextExecution;
    this.#submitCount = state.submitCount;
    this.#interruptCount = state.interruptCount;
    this.#executions = new Map(state.executions.map((item) => [
      item.executionId, structuredClone(item),
    ]));
    this.#mutationOperations = new Map(state.mutationOperations.map(
      ([key, item]) => [key, structuredClone(item)],
    ));
  }

  exportState() {
    return structuredClone({
      runtimeInstanceId: this.#descriptor.identity.runtimeInstanceId,
      tick: this.#tick,
      nextExecution: this.#nextExecution,
      submitCount: this.#submitCount,
      interruptCount: this.#interruptCount,
      executions: [...this.#executions.values()],
      mutationOperations: [...this.#mutationOperations.entries()],
    });
  }

  #now() {
    this.#tick += 1;
    return new Date(BASE_TIME + this.#tick * 1000).toISOString();
  }

  #authority(externalId = this.#descriptor.identity.runtimeInstanceId) {
    return {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: this.#descriptor.identity.sourceId,
      externalId,
      contractVersion: this.#descriptor.identity.adapterVersion,
    };
  }

  #result(request, {
    outcome,
    data = null,
    error = null,
    lifecycle = {
      state: "none",
      evidence: "none",
      eventId: null,
      sequence: null,
      cursor: null,
      providerOccurredAtUtc: null,
    },
    retry = { allowed: false, reasonCode: "operation_not_replayable" },
    authorityId,
    observedAtUtc = this.#now(),
    evidenceRefs = [],
    extensions = [],
  }) {
    const result = {
      schemaVersion: 1,
      contractVersion: ADAPTER_CONTRACT_VERSION,
      adapter: structuredClone(this.#descriptor.identity),
      operation: {
        name: request.operation,
        operationId: request.operationId,
        correlationId: request.correlationId,
      },
      observedAtUtc,
      authority: this.#authority(authorityId),
      freshness: { status: "fresh", ageSeconds: 0, staleAfterSeconds: 60 },
      resultType: ["accepted", "started", "completed", "cancelled"].includes(outcome)
        ? "success" : "error",
      outcome,
      lifecycle,
      retry,
      evidenceRefs,
      data,
      error,
      extensions,
    };
    return validateAdapterResult(result);
  }

  #request(request, operation) {
    validateAdapterOperationRequest(request, FAMILY);
    if (request.operation !== operation) throw new Error(`Expected ${operation} request`);
    return request;
  }

  #unsupported(request) {
    return this.#result(request, {
      outcome: "unsupported",
      error: {
        code: "capability_unavailable",
        phase: "pre-submit",
        providerCategory: "fake_unsupported",
      },
      retry: { allowed: false, reasonCode: "capability_unavailable" },
    });
  }

  #executionFrom(request) {
    const ref = request.subjectRefs[0];
    if (ref?.kind !== "provider-turn"
        || ref?.authority.authorityType !== "provider"
        || ref?.authority.sourceId !== this.#descriptor.identity.sourceId
        || ref?.authority.contractVersion !== this.#descriptor.identity.adapterVersion) {
      return undefined;
    }
    const externalId = ref?.authority.externalId;
    return externalId ? this.#executions.get(externalId) : undefined;
  }

  #ambiguous(request) {
    return this.#result(request, {
      outcome: "ambiguous",
      error: {
        code: "identity_ambiguous",
        phase: "observation",
        providerCategory: "fake_execution_not_found",
      },
      retry: { allowed: false, reasonCode: "identity_requires_reconciliation" },
    });
  }

  snapshot() {
    return {
      submitCount: this.#submitCount,
      interruptCount: this.#interruptCount,
      executionCount: this.#executions.size,
      executions: [...this.#executions.values()].map((item) => ({
        executionId: item.executionId,
        pendingInterrupt: item.pendingInterrupt,
        events: structuredClone(item.events),
      })),
    };
  }

  async discoverCapabilities(request) {
    this.#request(request, "discoverCapabilities");
    return this.#result(request, {
      outcome: "completed",
      data: { descriptor: this.descriptor },
      retry: { allowed: false, reasonCode: "capabilities_observed" },
    });
  }

  async listModels(request) {
    this.#request(request, "listModels");
    return this.#unsupported(request);
  }

  async startExecution(request) {
    this.#request(request, "startExecution");
    const capabilityMatch = matchAdapterCapabilities(this.#descriptor, request.requiredCapabilities);
    if (!capabilityMatch.compatible) return this.#unsupported(request);
    const mode = request.parameters.mode ?? "normal";
    if (!["normal", "pre-submit-disconnected", "post-submit-uncertain"].includes(mode)) {
      throw new Error(`Unsupported fake mode '${mode}'`);
    }
    const terminalOutcome = request.parameters.terminalOutcome ?? "completed";
    if (!["completed", "failed"].includes(terminalOutcome)) {
      throw new Error(`Unsupported fake terminal outcome '${terminalOutcome}'`);
    }
    if (mode === "pre-submit-disconnected") {
      return this.#result(request, {
        outcome: "unavailable",
        error: {
          code: "provider_disconnected",
          phase: "pre-submit",
          providerCategory: "fake_disconnected_before_submit",
        },
        retry: { allowed: true, reasonCode: "provider_reconnect_required" },
      });
    }

    const requestHash = adapterOperationRequestHash(request, FAMILY);
    const existing = this.#mutationOperations.get(request.operationId);
    if (existing && existing.requestHash !== requestHash) {
      return this.#result(request, {
        outcome: "ambiguous",
        error: {
          code: "operation_conflict",
          phase: "pre-submit",
          providerCategory: "operation_id_payload_conflict",
        },
        retry: { allowed: false, reasonCode: "operation_id_bound_to_other_payload" },
      });
    }
    if (existing?.result) return structuredClone(existing.result);
    if (existing?.uncertain) {
      return this.#result(request, {
        outcome: "ambiguous",
        error: {
          code: "operation_conflict",
          phase: "pre-submit",
          providerCategory: "duplicate_uncertain_operation",
        },
        retry: { allowed: false, reasonCode: "uncertain_operation_not_replayable" },
      });
    }

    this.#submitCount += 1;
    const executionId = `fake-turn-${this.#nextExecution++}`;
    const executionRef = providerReference(this.#descriptor.identity, executionId);
    const record = {
      executionId,
      executionRef,
      taskBinding: structuredClone(request.taskBinding),
      profile: structuredClone(request.profile),
      terminalOutcome,
      pendingInterrupt: false,
      events: [],
    };
    this.#executions.set(executionId, record);

    if (mode === "post-submit-uncertain") {
      this.#mutationOperations.set(request.operationId, { requestHash, uncertain: true });
      return this.#result(request, {
        outcome: "uncertain",
        error: {
          code: "post_submit_uncertain",
          phase: "post-submit",
          providerCategory: "fake_response_lost_after_submit",
        },
        retry: { allowed: false, reasonCode: "post_submit_outcome_uncertain" },
      });
    }
    const result = this.#result(request, {
      outcome: "accepted",
      data: { executionRef },
      retry: { allowed: false, reasonCode: "provider_accepted_operation" },
      authorityId: executionId,
      evidenceRefs: [executionRef],
    });
    this.#mutationOperations.set(request.operationId, {
      requestHash,
      result: structuredClone(result),
    });
    return result;
  }

  #appendEvent(record, outcome) {
    const sequence = record.events.length + 1;
    const providerOccurredAtUtc = this.#now();
    const event = {
      eventId: `fake-lifecycle-${record.executionId}-${sequence}`,
      sequence,
      cursor: `fake-cursor-${record.executionId}-${sequence}`,
      outcome,
      providerOccurredAtUtc,
      observedAtUtc: providerOccurredAtUtc,
    };
    record.events.push(event);
    return event;
  }

  #observedResult(request, record, event) {
    const executionRef = structuredClone(record.executionRef);
    const lifecycle = {
      state: event.outcome,
      evidence: "provider-observed",
      eventId: event.eventId,
      sequence: event.sequence,
      cursor: event.cursor,
      providerOccurredAtUtc: event.providerOccurredAtUtc,
    };
    if (event.outcome === "failed") {
      return this.#result(request, {
        outcome: "failed",
        data: null,
        error: {
          code: "provider_terminal_failure",
          phase: "provider-terminal",
          providerCategory: "fake_terminal_failure",
        },
        lifecycle,
        retry: { allowed: false, reasonCode: "provider_terminal_failure" },
        authorityId: record.executionId,
        observedAtUtc: event.observedAtUtc,
        evidenceRefs: [executionRef],
      });
    }
    return this.#result(request, {
      outcome: event.outcome,
      data: { executionRef },
      lifecycle,
      retry: { allowed: false, reasonCode: "provider_lifecycle_observed" },
      authorityId: record.executionId,
      observedAtUtc: event.observedAtUtc,
      evidenceRefs: [executionRef],
      extensions: [{
        extensionId: "fake.execution.lifecycle-marker",
        contractVersion: ADAPTER_CONTRACT_VERSION,
        data: { eventType: `Fake${event.outcome[0].toUpperCase()}${event.outcome.slice(1)}` },
      }],
    });
  }

  async observeLifecycle(request) {
    this.#request(request, "observeLifecycle");
    const capabilityMatch = matchAdapterCapabilities(this.#descriptor, request.requiredCapabilities);
    if (!capabilityMatch.compatible) return this.#unsupported(request);
    const record = this.#executionFrom(request);
    if (!record) return this.#ambiguous(request);
    const afterSequence = request.parameters.afterSequence ?? 0;
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new Error("afterSequence must be a non-negative integer");
    }

    let event = record.events.find((item) => item.sequence > afterSequence);
    if (!event && record.events.length === 0) {
      event = this.#appendEvent(record, "started");
    } else if (!event && record.pendingInterrupt
        && !["cancelled", "completed", "failed"].includes(record.events.at(-1)?.outcome)) {
      event = this.#appendEvent(record, "cancelled");
    } else if (!event && record.events.at(-1)?.outcome === "started") {
      event = this.#appendEvent(record, record.terminalOutcome);
    } else if (!event) {
      event = record.events.at(-1);
    }
    return this.#observedResult(request, record, event);
  }

  async interruptExecution(request) {
    this.#request(request, "interruptExecution");
    const capabilityMatch = matchAdapterCapabilities(this.#descriptor, request.requiredCapabilities);
    if (!capabilityMatch.compatible) return this.#unsupported(request);
    const record = this.#executionFrom(request);
    if (!record) return this.#ambiguous(request);
    const requestHash = adapterOperationRequestHash(request, FAMILY);
    const existing = this.#mutationOperations.get(request.operationId);
    if (existing && existing.requestHash !== requestHash) {
      return this.#result(request, {
        outcome: "ambiguous",
        error: {
          code: "operation_conflict",
          phase: "pre-submit",
          providerCategory: "operation_id_payload_conflict",
        },
        retry: { allowed: false, reasonCode: "operation_id_bound_to_other_payload" },
      });
    }
    if (existing?.result) return structuredClone(existing.result);
    if (["cancelled", "completed", "failed"].includes(record.events.at(-1)?.outcome)) {
      return this.#result(request, {
        outcome: "ambiguous",
        error: {
          code: "operation_conflict",
          phase: "observation",
          providerCategory: "fake_execution_already_terminal",
        },
        retry: { allowed: false, reasonCode: "execution_already_terminal" },
        authorityId: record.executionId,
        evidenceRefs: [record.executionRef],
      });
    }
    this.#interruptCount += 1;
    record.pendingInterrupt = true;
    const result = this.#result(request, {
      outcome: "accepted",
      data: { executionRef: structuredClone(record.executionRef) },
      retry: { allowed: false, reasonCode: "provider_accepted_interrupt" },
      authorityId: record.executionId,
      evidenceRefs: [record.executionRef],
    });
    this.#mutationOperations.set(request.operationId, {
      requestHash,
      result: structuredClone(result),
    });
    return result;
  }
}

export function createFakeConformanceDriver(adapter) {
  const startGuarantees = [
    "command-acceptance", "accepted-started-separate", "exact-native-identity",
    "exact-task-binding", "exact-profile-binding",
  ];
  const observed = (executionRef, afterSequence, purpose) => fakeOperationRequest(
    "observeLifecycle",
    `observe-${purpose}`,
    {
      subjectRefs: [executionRef],
      parameters: { afterSequence },
      requiredGuarantees: [
        "provider-observed-start", "provider-observed-terminal", "ordered-lifecycle",
        "cursor-replay", "exact-native-identity",
      ],
    },
  );
  const startForTerminal = (purpose, terminalOutcome) => {
    const taskBinding = fakeTaskBinding();
    taskBinding.taskId = `adapter-conformance-${purpose}`;
    return fakeOperationRequest("startExecution", `start-${purpose}`, {
      taskBinding,
      profile: fakeProfile(),
      parameters: { mode: "normal", terminalOutcome },
      requiredGuarantees: startGuarantees,
    });
  };
  const restartedReplay = (executionRef, afterSequence, purpose) => ({
    adapter: new FakeExecutionProvider({
      runtimeInstanceId: adapter.descriptor.identity.runtimeInstanceId,
      capabilitiesObservedAtUtc: adapter.descriptor.capabilitiesObservedAtUtc,
      restoredState: adapter.exportState(),
    }),
    request: observed(executionRef, afterSequence, purpose),
  });
  return {
    snapshot: () => adapter.snapshot(),
    discovery: () => fakeOperationRequest(
      "discoverCapabilities",
      "discover-capabilities",
      { requiredGuarantees: ["exact-native-identity"] },
    ),
    start: () => fakeOperationRequest("startExecution", "start-normal", {
      taskBinding: fakeTaskBinding(),
      profile: fakeProfile(),
      parameters: { mode: "normal" },
      requiredGuarantees: startGuarantees,
    }),
    conflictingStart: () => {
      const request = fakeOperationRequest("startExecution", "start-normal", {
        taskBinding: fakeTaskBinding(),
        profile: fakeProfile(),
        parameters: { mode: "normal" },
        requiredGuarantees: startGuarantees,
      });
      request.taskBinding.taskId = "conflicting-task-binding";
      return request;
    },
    observeStarted: (executionRef) => observed(executionRef, 0, "started"),
    replayStarted: (executionRef) => observed(executionRef, 0, "reconnect-replay"),
    restartAndReplayStarted: (executionRef) => restartedReplay(
      executionRef, 0, "restart-replay",
    ),
    startCompleted: () => startForTerminal("completed", "completed"),
    observeCompletedStarted: (executionRef) => observed(executionRef, 0, "completed-started"),
    observeCompleted: (executionRef) => observed(executionRef, 1, "completed-terminal"),
    restartAndReplayCompleted: (executionRef) => restartedReplay(
      executionRef, 1, "completed-restart-replay",
    ),
    startFailed: () => startForTerminal("failed", "failed"),
    observeFailedStarted: (executionRef) => observed(executionRef, 0, "failed-started"),
    observeFailed: (executionRef) => observed(executionRef, 1, "failed-terminal"),
    restartAndReplayFailed: (executionRef) => restartedReplay(
      executionRef, 1, "failed-restart-replay",
    ),
    interrupt: (executionRef) => fakeOperationRequest(
      "interruptExecution",
      "interrupt-normal",
      {
        subjectRefs: [executionRef],
        requiredGuarantees: ["command-acceptance", "accepted-terminal-separate"],
      },
    ),
    replayInterrupt: (executionRef) => fakeOperationRequest(
      "interruptExecution",
      "interrupt-normal",
      {
        subjectRefs: [executionRef],
        requiredGuarantees: ["command-acceptance", "accepted-terminal-separate"],
      },
    ),
    conflictingInterrupt: (executionRef) => fakeOperationRequest(
      "interruptExecution",
      "interrupt-normal",
      {
        subjectRefs: [executionRef],
        parameters: { reasonCode: "changed_payload" },
        requiredGuarantees: ["command-acceptance", "accepted-terminal-separate"],
      },
    ),
    crossOperationIdInterrupt: (executionRef) => fakeOperationRequest(
      "interruptExecution",
      "start-normal",
      {
        subjectRefs: [executionRef],
        requiredGuarantees: ["command-acceptance", "accepted-terminal-separate"],
      },
    ),
    observeCancelled: (executionRef) => observed(executionRef, 1, "cancelled"),
    restartAndReplayCancelled: (executionRef) => restartedReplay(
      executionRef, 1, "cancelled-restart-replay",
    ),
    unsupported: () => fakeOperationRequest("listModels", "list-models-unsupported"),
    preSubmitDisconnected: () => fakeOperationRequest(
      "startExecution", "start-pre-submit-disconnected", {
        taskBinding: fakeTaskBinding(),
        profile: fakeProfile(),
        parameters: { mode: "pre-submit-disconnected" },
        requiredGuarantees: startGuarantees,
      },
    ),
    uncertainStart: () => fakeOperationRequest("startExecution", "start-uncertain", {
      taskBinding: fakeTaskBinding(),
      profile: fakeProfile(),
      parameters: { mode: "post-submit-uncertain" },
      requiredGuarantees: startGuarantees,
    }),
    replayUncertain: () => fakeOperationRequest("startExecution", "start-uncertain", {
      taskBinding: fakeTaskBinding(),
      profile: fakeProfile(),
      parameters: { mode: "post-submit-uncertain" },
      requiredGuarantees: startGuarantees,
    }),
  };
}
