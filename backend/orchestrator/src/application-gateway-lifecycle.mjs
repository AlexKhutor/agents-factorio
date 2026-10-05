import { applicationCanonicalSha256 } from "./application-contract.mjs";

export const APPLICATION_GATEWAY_LIFECYCLE_VERSION = "v0.1.0";
export const APPLICATION_GATEWAY_TRANSPORT_ID = "loopback-http-json-ndjson-v1";
export const APPLICATION_GATEWAY_LIFECYCLE_STATES = Object.freeze([
  "starting", "ready", "stop-requested", "stopped", "failed", "uncertain",
]);

const STATES = new Set(APPLICATION_GATEWAY_LIFECYCLE_STATES);
const TERMINAL = new Set(["stopped", "failed", "uncertain"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BYTES = 16 * 1024;

export class ApplicationGatewayLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApplicationGatewayLifecycleError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ApplicationGatewayLifecycleError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`);
  }
  return value;
}

function exact(value, keys, label) {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    fail("unknown_field", `${label} contains unsupported fields`);
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_identifier", `${label} must be a bounded identifier`);
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail("invalid_identifier", `${label} must be a lowercase UUID`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a UTC timestamp ending in Z`);
  }
  return value;
}

function workspace(value) {
  object(value, "workspace");
  exact(value, ["projectId", "sourceId", "workspaceRootSha256"], "workspace");
  return {
    projectId: identifier(value.projectId, "workspace.projectId"),
    sourceId: identifier(value.sourceId, "workspace.sourceId"),
    workspaceRootSha256: hash(value.workspaceRootSha256, "workspace.workspaceRootSha256"),
  };
}

function processIdentity(value) {
  object(value, "process");
  exact(value, ["processId", "startedAtUtc", "executableSha256"], "process");
  if (!Number.isSafeInteger(value.processId) || value.processId < 1) {
    fail("invalid_process", "process.processId must be a positive safe integer");
  }
  return {
    processId: value.processId,
    startedAtUtc: utc(value.startedAtUtc, "process.startedAtUtc"),
    executableSha256: hash(value.executableSha256, "process.executableSha256"),
  };
}

function buildIdentity({ instanceId, generation, restartOf = null, workspace: binding, process }) {
  const normalized = {
    instanceId: uuid(instanceId, "identity.instanceId"),
    generation,
    restartOf: restartOf === null ? null : uuid(restartOf, "identity.restartOf"),
    transportId: APPLICATION_GATEWAY_TRANSPORT_ID,
    workspace: workspace(binding),
    process: processIdentity(process),
  };
  if (!Number.isSafeInteger(generation) || generation < 1) {
    fail("invalid_generation", "identity.generation must be a positive safe integer");
  }
  if (normalized.restartOf === normalized.instanceId) {
    fail("invalid_restart", "A gateway instance cannot restart itself");
  }
  return {
    ...normalized,
    identitySha256: applicationCanonicalSha256(normalized),
  };
}

function boundedReason(value, label) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,95}$/.test(value)) {
    fail("invalid_reason", `${label} must be a stable reason code`);
  }
  return value;
}

function validateIdentity(value) {
  object(value, "identity");
  exact(value, [
    "instanceId", "generation", "restartOf", "transportId", "workspace", "process",
    "identitySha256",
  ], "identity");
  if (value.transportId !== APPLICATION_GATEWAY_TRANSPORT_ID) {
    fail("transport_mismatch", "Gateway transport identity is unsupported");
  }
  const rebuilt = buildIdentity(value);
  if (rebuilt.identitySha256 !== value.identitySha256) {
    fail("identity_mismatch", "Gateway lifecycle identity is not canonical");
  }
  return rebuilt;
}

export function validateApplicationGatewayLifecycleStatus(value) {
  object(value, "gatewayStatus");
  exact(value, [
    "schemaVersion", "contractVersion", "identity", "lifecycle", "health",
    "ready", "startedAtUtc", "updatedAtUtc", "heartbeatAtUtc", "readyAtUtc",
    "stop", "failure", "terminal",
  ], "gatewayStatus");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_GATEWAY_LIFECYCLE_VERSION) {
    fail("unsupported_contract", "Gateway lifecycle contract is unsupported");
  }
  const identity = validateIdentity(value.identity);
  if (!STATES.has(value.lifecycle)) fail("invalid_state", "Gateway lifecycle state is invalid");
  if (value.health !== value.lifecycle || value.ready !== (value.lifecycle === "ready")
      || value.terminal !== TERMINAL.has(value.lifecycle)) {
    fail("invalid_state", "Gateway health, readiness or terminal flag is inconsistent");
  }
  const startedAtUtc = utc(value.startedAtUtc, "startedAtUtc");
  const updatedAtUtc = utc(value.updatedAtUtc, "updatedAtUtc");
  const heartbeatAtUtc = utc(value.heartbeatAtUtc, "heartbeatAtUtc");
  if (startedAtUtc !== identity.process.startedAtUtc
      || Date.parse(updatedAtUtc) < Date.parse(startedAtUtc)
      || Date.parse(heartbeatAtUtc) < Date.parse(startedAtUtc)
      || Date.parse(heartbeatAtUtc) > Date.parse(updatedAtUtc)) {
    fail("invalid_timeline", "Gateway lifecycle timeline is inconsistent");
  }
  const readyAtUtc = value.readyAtUtc === null ? null : utc(value.readyAtUtc, "readyAtUtc");
  if (value.lifecycle === "ready" && readyAtUtc === null) {
    fail("invalid_state", "Ready state requires readiness time");
  }
  if (readyAtUtc !== null && (Date.parse(readyAtUtc) < Date.parse(startedAtUtc)
      || Date.parse(readyAtUtc) > Date.parse(updatedAtUtc))) {
    fail("invalid_timeline", "Readiness cannot follow the latest lifecycle update");
  }
  object(value.stop, "stop");
  exact(value.stop, ["requestId", "requestedAtUtc", "confirmedAtUtc"], "stop");
  const stopPresent = value.stop.requestId !== null;
  if (stopPresent) {
    identifier(value.stop.requestId, "stop.requestId");
    utc(value.stop.requestedAtUtc, "stop.requestedAtUtc");
    if (Date.parse(value.stop.requestedAtUtc) < Date.parse(startedAtUtc)
        || Date.parse(value.stop.requestedAtUtc) > Date.parse(updatedAtUtc)) {
      fail("invalid_timeline", "Stop request is outside the lifecycle timeline");
    }
  } else if (value.stop.requestedAtUtc !== null || value.stop.confirmedAtUtc !== null) {
    fail("invalid_stop", "Stop timestamps require a request identity");
  }
  if (["stop-requested", "stopped"].includes(value.lifecycle) && !stopPresent) {
    fail("invalid_stop", "Stop state requires request evidence");
  }
  if (stopPresent && !["stop-requested", "stopped", "failed", "uncertain"].includes(
    value.lifecycle,
  )) {
    fail("invalid_stop", "Stop request evidence is inconsistent with lifecycle");
  }
  if (value.lifecycle === "stopped") {
    utc(value.stop.confirmedAtUtc, "stop.confirmedAtUtc");
    if (Date.parse(value.stop.confirmedAtUtc) < Date.parse(value.stop.requestedAtUtc)
        || Date.parse(value.stop.confirmedAtUtc) > Date.parse(updatedAtUtc)) {
      fail("invalid_timeline", "Stop confirmation is outside the lifecycle timeline");
    }
  } else if (value.stop.confirmedAtUtc !== null) {
    fail("invalid_stop", "Only stopped state can confirm Stop");
  }
  if (["failed", "uncertain"].includes(value.lifecycle)) {
    object(value.failure, "failure");
    exact(value.failure, ["reasonCode", "failedAtUtc"], "failure");
    boundedReason(value.failure.reasonCode, "failure.reasonCode");
    utc(value.failure.failedAtUtc, "failure.failedAtUtc");
    if (Date.parse(value.failure.failedAtUtc) < Date.parse(startedAtUtc)
        || Date.parse(value.failure.failedAtUtc) > Date.parse(updatedAtUtc)) {
      fail("invalid_timeline", "Failure is outside the lifecycle timeline");
    }
  } else if (value.failure !== null) {
    fail("invalid_failure", "Failure evidence requires a failure lifecycle");
  }
  const result = { ...structuredClone(value), identity };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_BYTES) {
    fail("status_too_large", "Gateway lifecycle status exceeds 16 KiB");
  }
  return result;
}

function nextTime(state, value, label) {
  const result = utc(value, label);
  if (Date.parse(result) < Date.parse(state.updatedAtUtc)) {
    fail("clock_regressed", `${label} cannot precede the current state`);
  }
  return result;
}

export class ApplicationGatewayLifecycle {
  #state;

  constructor({ instanceId, generation = 1, restartOf = null, workspace, process }) {
    const identity = buildIdentity({ instanceId, generation, restartOf, workspace, process });
    this.#state = validateApplicationGatewayLifecycleStatus({
      schemaVersion: 1,
      contractVersion: APPLICATION_GATEWAY_LIFECYCLE_VERSION,
      identity,
      lifecycle: "starting",
      health: "starting",
      ready: false,
      startedAtUtc: identity.process.startedAtUtc,
      updatedAtUtc: identity.process.startedAtUtc,
      heartbeatAtUtc: identity.process.startedAtUtc,
      readyAtUtc: null,
      stop: { requestId: null, requestedAtUtc: null, confirmedAtUtc: null },
      failure: null,
      terminal: false,
    });
  }

  snapshot() {
    return validateApplicationGatewayLifecycleStatus(this.#state);
  }

  #transition(lifecycle, atUtc, changes = {}) {
    if (TERMINAL.has(this.#state.lifecycle)) {
      fail("terminal_state", "Terminal gateway instance cannot transition");
    }
    const at = nextTime(this.#state, atUtc, `${lifecycle}AtUtc`);
    this.#state = validateApplicationGatewayLifecycleStatus({
      ...this.#state,
      ...changes,
      lifecycle,
      health: lifecycle,
      ready: lifecycle === "ready",
      updatedAtUtc: at,
      heartbeatAtUtc: at,
      terminal: TERMINAL.has(lifecycle),
    });
    return this.snapshot();
  }

  markReady(atUtc) {
    if (this.#state.lifecycle !== "starting") {
      fail("invalid_transition", "Only a starting gateway can become ready");
    }
    return this.#transition("ready", atUtc, { readyAtUtc: atUtc });
  }

  heartbeat(atUtc) {
    if (!["starting", "ready", "stop-requested"].includes(this.#state.lifecycle)) {
      fail("invalid_transition", "Terminal gateway cannot heartbeat");
    }
    const at = nextTime(this.#state, atUtc, "heartbeatAtUtc");
    this.#state = validateApplicationGatewayLifecycleStatus({
      ...this.#state, updatedAtUtc: at, heartbeatAtUtc: at,
    });
    return this.snapshot();
  }

  requestStop(requestId, atUtc) {
    if (this.#state.lifecycle === "stop-requested") {
      if (this.#state.stop.requestId !== requestId) {
        fail("stop_conflict", "Gateway already has a different Stop request");
      }
      return this.snapshot();
    }
    if (!["starting", "ready"].includes(this.#state.lifecycle)) {
      fail("invalid_transition", "Gateway cannot accept Stop in its current state");
    }
    identifier(requestId, "stop.requestId");
    return this.#transition("stop-requested", atUtc, {
      stop: { requestId, requestedAtUtc: atUtc, confirmedAtUtc: null },
    });
  }

  markStopped(atUtc) {
    if (this.#state.lifecycle !== "stop-requested") {
      fail("invalid_transition", "Gateway Stop must be requested before confirmation");
    }
    return this.#transition("stopped", atUtc, {
      stop: { ...this.#state.stop, confirmedAtUtc: atUtc },
    });
  }

  markFailed(reasonCode, atUtc) {
    boundedReason(reasonCode, "failure.reasonCode");
    return this.#transition("failed", atUtc, {
      failure: { reasonCode, failedAtUtc: atUtc },
    });
  }

  markUncertain(reasonCode, atUtc) {
    boundedReason(reasonCode, "failure.reasonCode");
    return this.#transition("uncertain", atUtc, {
      failure: { reasonCode, failedAtUtc: atUtc },
    });
  }
}

export function restartApplicationGatewayLifecycle(previousValue, { instanceId, process }) {
  const previous = validateApplicationGatewayLifecycleStatus(previousValue);
  if (!previous.terminal) {
    fail("restart_not_allowed", "Only a terminal gateway instance can be restarted");
  }
  const nextProcess = processIdentity(process);
  if (Date.parse(nextProcess.startedAtUtc) <= Date.parse(previous.updatedAtUtc)) {
    fail("invalid_restart", "Restart process must start after the terminal instance");
  }
  return new ApplicationGatewayLifecycle({
    instanceId,
    generation: previous.identity.generation + 1,
    restartOf: previous.identity.instanceId,
    workspace: previous.identity.workspace,
    process: nextProcess,
  });
}

export function recoverCrashedApplicationGatewayLifecycle(
  previousValue,
  { observedAtUtc, reasonCode = "process_terminated" },
) {
  const previous = validateApplicationGatewayLifecycleStatus(previousValue);
  if (previous.terminal) {
    fail("recovery_not_required", "A terminal gateway does not require crash recovery");
  }
  const observed = nextTime(previous, observedAtUtc, "observedAtUtc");
  boundedReason(reasonCode, "failure.reasonCode");
  return validateApplicationGatewayLifecycleStatus({
    ...previous,
    lifecycle: "uncertain",
    health: "uncertain",
    ready: false,
    updatedAtUtc: observed,
    failure: { reasonCode, failedAtUtc: observed },
    terminal: true,
  });
}
