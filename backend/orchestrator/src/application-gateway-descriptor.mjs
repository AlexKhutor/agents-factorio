import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { renameOver } from "./rename-over.mjs";
import path from "node:path";

import {
  APPLICATION_CONTRACT_VERSION,
  applicationCanonicalJson,
  applicationCanonicalSha256,
  validateApplicationOperationRef,
} from "./application-contract.mjs";
import { APPLICATION_CAPABILITY_CONTRACT_VERSION } from "./application-capabilities.mjs";
import { APPLICATION_CAPABILITY_SURFACE } from "./application-capability-surface.mjs";
import { APPLICATION_EVENT_STREAM_CONTRACT_VERSION } from "./application-event-stream.mjs";
import {
  APPLICATION_GATEWAY_ADAPTER_VERSION,
  APPLICATION_GATEWAY_ROUTES,
} from "./application-gateway-adapter.mjs";
import {
  APPLICATION_GATEWAY_TRANSPORT_ID,
  validateApplicationGatewayLifecycleStatus,
} from "./application-gateway-lifecycle.mjs";
import {
  APPLICATION_GATEWAY_SECURITY_VERSION,
  bindApplicationGatewayEndpoint,
  hashApplicationGatewayBearerToken,
  validateApplicationGatewaySecurityPolicy,
} from "./application-gateway-security.mjs";

export const APPLICATION_GATEWAY_DESCRIPTOR_VERSION = "v0.2.0";
const CAPABILITY_OPERATION_ID = APPLICATION_CAPABILITY_SURFACE.operations.discovery
  .find((entry) => entry.binding.contractId === "application-capabilities")
  ?.operation.operationId;
const TOKEN = /^[A-Za-z0-9_-]{43,256}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DESCRIPTOR_FIELDS = new Set([
  "schemaVersion", "contractVersion", "descriptorId", "transportId",
  "publishedAtUtc", "validUntilUtc", "instance", "workspace", "endpoint",
  "authorization", "routes", "capabilityDiscovery", "exposedOperations",
]);
const DISCOVERY_OPERATION = Object.freeze({
  schemaVersion: 1,
  contractVersion: APPLICATION_CONTRACT_VERSION,
  family: "discovery",
  operationId: CAPABILITY_OPERATION_ID,
});
const ROUTES = Object.freeze([
  Object.freeze({
    routeId: "application-operations",
    method: "POST",
    path: APPLICATION_GATEWAY_ROUTES.operation,
    requestContractVersion: APPLICATION_CONTRACT_VERSION,
    responseMediaType: "application/json",
  }),
  Object.freeze({
    routeId: "application-event-read",
    method: "POST",
    path: APPLICATION_GATEWAY_ROUTES.eventRead,
    requestContractVersion: APPLICATION_EVENT_STREAM_CONTRACT_VERSION,
    responseMediaType: "application/x-ndjson",
  }),
]);

export class ApplicationGatewayDescriptorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApplicationGatewayDescriptorError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ApplicationGatewayDescriptorError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_descriptor", `${label} must be an object`);
  }
  return value;
}

function exact(value, fields, label) {
  if (Object.keys(value).some((key) => !fields.has(key))) {
    fail("invalid_descriptor", `${label} contains unsupported fields`);
  }
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) {
    fail("invalid_descriptor", `${label} must be a bounded UTC timestamp`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_descriptor", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function descriptorIdentity(value) {
  return {
    transportId: value.transportId,
    lifecycleIdentitySha256: value.instance.lifecycleIdentitySha256,
    instanceId: value.instance.instanceId,
    workspaceRootSha256: value.workspace.workspaceRootSha256,
    endpointId: value.endpoint.endpointId,
    sessionId: value.authorization.sessionId,
    bearerSha256: hashApplicationGatewayBearerToken(value.authorization.bearerToken),
    routes: value.routes,
    capabilityDiscovery: value.capabilityDiscovery,
    exposedOperations: value.exposedOperations,
  };
}

function unavailable(reasonCode) {
  return Object.freeze({ status: "unavailable", reasonCode });
}

export function validateApplicationGatewayDescriptor(value) {
  object(value, "descriptor");
  exact(value, DESCRIPTOR_FIELDS, "descriptor");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_GATEWAY_DESCRIPTOR_VERSION
      || value.transportId !== APPLICATION_GATEWAY_TRANSPORT_ID) {
    fail("unsupported_contract", "Application gateway descriptor is unsupported");
  }
  utc(value.publishedAtUtc, "publishedAtUtc");
  utc(value.validUntilUtc, "validUntilUtc");
  if (Date.parse(value.validUntilUtc) <= Date.parse(value.publishedAtUtc)) {
    fail("invalid_timeline", "Descriptor validity must follow publication");
  }

  object(value.instance, "instance");
  exact(value.instance, new Set([
    "instanceId", "generation", "lifecycleIdentitySha256", "processId",
    "processStartedAtUtc", "readyAtUtc", "adapterVersion",
  ]), "instance");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value.instance.instanceId ?? "",
  ) || !Number.isSafeInteger(value.instance.generation) || value.instance.generation < 1
      || !Number.isSafeInteger(value.instance.processId) || value.instance.processId < 1
      || value.instance.adapterVersion !== APPLICATION_GATEWAY_ADAPTER_VERSION) {
    fail("invalid_instance", "Descriptor instance identity is invalid");
  }
  hash(value.instance.lifecycleIdentitySha256, "instance.lifecycleIdentitySha256");
  utc(value.instance.processStartedAtUtc, "instance.processStartedAtUtc");
  utc(value.instance.readyAtUtc, "instance.readyAtUtc");

  object(value.workspace, "workspace");
  exact(value.workspace, new Set(["projectId", "sourceId", "workspaceRootSha256"]), "workspace");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.workspace.projectId ?? "")
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.workspace.sourceId ?? "")) {
    fail("invalid_workspace", "Descriptor workspace identity is invalid");
  }
  hash(value.workspace.workspaceRootSha256, "workspace.workspaceRootSha256");

  object(value.endpoint, "endpoint");
  exact(value.endpoint, new Set([
    "schemaVersion", "contractVersion", "transportId", "instanceId",
    "lifecycleIdentitySha256", "sessionId", "workspaceRootSha256", "scheme",
    "host", "port", "authority", "endpointId",
  ]), "endpoint");
  if (value.endpoint.transportId !== value.transportId || value.endpoint.scheme !== "http"
      || value.endpoint.schemaVersion !== 1
      || value.endpoint.contractVersion !== APPLICATION_GATEWAY_SECURITY_VERSION
      || value.endpoint.host !== "127.0.0.1"
      || !Number.isSafeInteger(value.endpoint.port) || value.endpoint.port < 1024
      || value.endpoint.port > 65535
      || value.endpoint.authority !== `127.0.0.1:${value.endpoint.port}`
      || !/^gateway-endpoint-[a-f0-9]{64}$/.test(value.endpoint.endpointId ?? "")) {
    fail("invalid_endpoint", "Descriptor endpoint is invalid");
  }
  if (value.endpoint.instanceId !== value.instance.instanceId
      || value.endpoint.lifecycleIdentitySha256 !== value.instance.lifecycleIdentitySha256
      || value.endpoint.workspaceRootSha256 !== value.workspace.workspaceRootSha256) {
    fail("identity_mismatch", "Descriptor endpoint identity does not match its instance");
  }
  const endpointIdentity = {
    transportId: value.endpoint.transportId,
    instanceId: value.endpoint.instanceId,
    lifecycleIdentitySha256: value.endpoint.lifecycleIdentitySha256,
    sessionId: value.endpoint.sessionId,
    workspaceRootSha256: value.endpoint.workspaceRootSha256,
    scheme: value.endpoint.scheme,
    host: value.endpoint.host,
    port: value.endpoint.port,
  };
  if (value.endpoint.endpointId
      !== `gateway-endpoint-${applicationCanonicalSha256(endpointIdentity)}`) {
    fail("invalid_endpoint", "Descriptor endpoint identity is not canonical");
  }

  object(value.authorization, "authorization");
  exact(value.authorization, new Set([
    "scheme", "sessionId", "bearerToken", "expiresAtUtc",
  ]), "authorization");
  if (value.authorization.scheme !== "Bearer"
      || typeof value.authorization.bearerToken !== "string"
      || !TOKEN.test(value.authorization.bearerToken)
      || value.authorization.sessionId !== value.endpoint.sessionId) {
    fail("invalid_authorization", "Descriptor authorization is invalid");
  }
  utc(value.authorization.expiresAtUtc, "authorization.expiresAtUtc");
  if (value.validUntilUtc !== value.authorization.expiresAtUtc) {
    fail("invalid_timeline", "Descriptor validity must match session expiry");
  }

  if (applicationCanonicalSha256(value.routes) !== applicationCanonicalSha256(ROUTES)) {
    fail("route_mismatch", "Descriptor routes do not match the adapter");
  }
  object(value.capabilityDiscovery, "capabilityDiscovery");
  exact(value.capabilityDiscovery, new Set(["operationId", "contractVersion"]),
    "capabilityDiscovery");
  if (value.capabilityDiscovery.operationId !== CAPABILITY_OPERATION_ID
      || value.capabilityDiscovery.contractVersion !== APPLICATION_CAPABILITY_CONTRACT_VERSION) {
    fail("capability_mismatch", "Descriptor capability discovery is unsupported");
  }
  if (!Array.isArray(value.exposedOperations) || value.exposedOperations.length < 1
      || value.exposedOperations.length > 128) {
    fail("operation_mismatch", "Descriptor exposed operations are invalid");
  }
  const operationIds = new Set();
  for (const operation of value.exposedOperations) {
    validateApplicationOperationRef(operation);
    if (operationIds.has(operation.operationId)) {
      fail("operation_mismatch", "Descriptor exposed operations are duplicated");
    }
    operationIds.add(operation.operationId);
  }
  if (!operationIds.has(CAPABILITY_OPERATION_ID)) {
    fail("operation_mismatch", "Capability discovery must remain exposed");
  }

  const expectedId = `application-gateway:${applicationCanonicalSha256(descriptorIdentity(value))}`;
  if (value.descriptorId !== expectedId) {
    fail("descriptor_identity_mismatch", "Descriptor identity is not canonical");
  }
  if (Buffer.byteLength(applicationCanonicalJson(value), "utf8") > 128 * 1024) {
    fail("descriptor_too_large", "Application gateway descriptor exceeds 128 KiB");
  }
  return structuredClone(value);
}

export function buildApplicationGatewayDescriptor({
  lifecycleStatus,
  securityPolicy,
  endpoint,
  bearerToken,
  publishedAtUtc,
  exposedOperations = [DISCOVERY_OPERATION],
}) {
  const lifecycle = validateApplicationGatewayLifecycleStatus(lifecycleStatus);
  if (!lifecycle.ready || lifecycle.lifecycle !== "ready") {
    fail("gateway_not_ready", "Only a ready gateway can publish discovery");
  }
  const policy = validateApplicationGatewaySecurityPolicy(securityPolicy);
  const canonicalEndpoint = bindApplicationGatewayEndpoint(policy, endpoint?.port);
  if (applicationCanonicalSha256(canonicalEndpoint) !== applicationCanonicalSha256(endpoint)
      || policy.session.lifecycleIdentitySha256 !== lifecycle.identity.identitySha256
      || policy.session.instanceId !== lifecycle.identity.instanceId
      || policy.session.workspaceRootSha256 !== lifecycle.identity.workspace.workspaceRootSha256) {
    fail("identity_mismatch", "Gateway lifecycle, policy and endpoint do not match");
  }
  if (hashApplicationGatewayBearerToken(bearerToken) !== policy.session.bearerSha256) {
    fail("authorization_mismatch", "Gateway bearer does not match its session");
  }
  const published = utc(publishedAtUtc, "publishedAtUtc");
  if (Date.parse(published) < Date.parse(lifecycle.readyAtUtc)
      || Date.parse(published) >= Date.parse(policy.session.expiresAtUtc)) {
    fail("invalid_timeline", "Descriptor publication is outside ready session time");
  }
  const value = {
    schemaVersion: 1,
    contractVersion: APPLICATION_GATEWAY_DESCRIPTOR_VERSION,
    descriptorId: "pending",
    transportId: APPLICATION_GATEWAY_TRANSPORT_ID,
    publishedAtUtc: published,
    validUntilUtc: policy.session.expiresAtUtc,
    instance: {
      instanceId: lifecycle.identity.instanceId,
      generation: lifecycle.identity.generation,
      lifecycleIdentitySha256: lifecycle.identity.identitySha256,
      processId: lifecycle.identity.process.processId,
      processStartedAtUtc: lifecycle.identity.process.startedAtUtc,
      readyAtUtc: lifecycle.readyAtUtc,
      adapterVersion: APPLICATION_GATEWAY_ADAPTER_VERSION,
    },
    workspace: structuredClone(lifecycle.identity.workspace),
    endpoint: structuredClone(canonicalEndpoint),
    authorization: {
      scheme: "Bearer",
      sessionId: policy.session.sessionId,
      bearerToken,
      expiresAtUtc: policy.session.expiresAtUtc,
    },
    routes: structuredClone(ROUTES),
    capabilityDiscovery: {
      operationId: CAPABILITY_OPERATION_ID,
      contractVersion: APPLICATION_CAPABILITY_CONTRACT_VERSION,
    },
    exposedOperations: structuredClone(exposedOperations),
  };
  value.descriptorId = `application-gateway:${applicationCanonicalSha256(descriptorIdentity(value))}`;
  return validateApplicationGatewayDescriptor(value);
}

export function resolveApplicationGatewayDescriptor({
  descriptor,
  lifecycleStatus,
  observedAtUtc,
}) {
  let value;
  let lifecycle;
  try {
    value = validateApplicationGatewayDescriptor(descriptor);
    lifecycle = validateApplicationGatewayLifecycleStatus(lifecycleStatus);
  } catch {
    return unavailable("descriptor_invalid");
  }
  if (!lifecycle.ready || lifecycle.lifecycle !== "ready") {
    return unavailable("gateway_not_ready");
  }
  const current = lifecycle.identity;
  if (value.instance.instanceId !== current.instanceId
      || value.instance.generation !== current.generation
      || value.instance.lifecycleIdentitySha256 !== current.identitySha256
      || value.instance.processId !== current.process.processId
      || value.instance.processStartedAtUtc !== current.process.startedAtUtc
      || value.workspace.workspaceRootSha256 !== current.workspace.workspaceRootSha256
      || value.workspace.projectId !== current.workspace.projectId
      || value.workspace.sourceId !== current.workspace.sourceId) {
    return unavailable("descriptor_stale");
  }
  let observed;
  try {
    observed = utc(observedAtUtc, "observedAtUtc");
  } catch {
    return unavailable("observation_invalid");
  }
  if (Date.parse(observed) < Date.parse(value.publishedAtUtc)
      || Date.parse(observed) >= Date.parse(value.validUntilUtc)) {
    return unavailable("descriptor_expired");
  }
  return Object.freeze({
    status: "available",
    reasonCode: "ready_descriptor",
    descriptor: value,
  });
}

export class ApplicationGatewayDescriptorStore {
  #descriptorPath;
  #claimPath;

  constructor({ descriptorPath }) {
    if (typeof descriptorPath !== "string" || descriptorPath.trim() === "") {
      fail("invalid_store", "Descriptor store requires a path");
    }
    this.#descriptorPath = path.resolve(descriptorPath);
    this.#claimPath = `${this.#descriptorPath}.publish-claim.v1.json`;
  }

  async publish(options) {
    const descriptor = buildApplicationGatewayDescriptor(options);
    await mkdir(path.dirname(this.#descriptorPath), { recursive: true });
    const temporaryPath = `${this.#descriptorPath}.${randomUUID()}.tmp`;
    let claimed = false;
    try {
      await writeFile(this.#claimPath, `${applicationCanonicalJson({
        schemaVersion: 1,
        instanceId: descriptor.instance.instanceId,
      })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      claimed = true;
      try {
        await readFile(this.#descriptorPath, "utf8");
        fail("descriptor_exists", "A gateway descriptor already owns this workspace");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await writeFile(temporaryPath, `${applicationCanonicalJson(descriptor)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await renameOver(temporaryPath, this.#descriptorPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (error?.code === "EEXIST") {
        fail("descriptor_exists", "A gateway descriptor already owns this workspace");
      }
      throw error;
    } finally {
      if (claimed) await rm(this.#claimPath, { force: true }).catch(() => {});
    }
    return descriptor;
  }

  async read({ lifecycleStatus, observedAtUtc }) {
    let raw;
    try {
      raw = await readFile(this.#descriptorPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return unavailable("descriptor_missing");
      return unavailable("descriptor_unreadable");
    }
    let descriptor;
    try {
      descriptor = JSON.parse(raw);
    } catch {
      return unavailable("descriptor_invalid");
    }
    return resolveApplicationGatewayDescriptor({ descriptor, lifecycleStatus, observedAtUtc });
  }

  async renew({ expected, options }) {
    const prior = validateApplicationGatewayDescriptor(expected);
    const next = buildApplicationGatewayDescriptor(options);
    if (next.descriptorId !== prior.descriptorId
        || next.instance.instanceId !== prior.instance.instanceId
        || next.authorization.sessionId !== prior.authorization.sessionId
        || next.authorization.bearerToken !== prior.authorization.bearerToken
        || Date.parse(next.publishedAtUtc) <= Date.parse(prior.publishedAtUtc)
        || Date.parse(next.publishedAtUtc) >= Date.parse(prior.validUntilUtc)
        || Date.parse(next.validUntilUtc) <= Date.parse(prior.validUntilUtc)) {
      fail("descriptor_stale", "Descriptor renewal changed identity or timeline");
    }
    const temporaryPath = `${this.#descriptorPath}.${randomUUID()}.tmp`;
    let claimed = false;
    try {
      await writeFile(this.#claimPath, `${applicationCanonicalJson({
        schemaVersion: 1, instanceId: prior.instance.instanceId,
      })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      claimed = true;
      let current;
      try {
        current = validateApplicationGatewayDescriptor(JSON.parse(
          await readFile(this.#descriptorPath, "utf8")));
      } catch { fail("descriptor_stale", "Owned descriptor is missing or invalid"); }
      if (applicationCanonicalSha256(current) !== applicationCanonicalSha256(prior)) {
        fail("descriptor_stale", "Owned descriptor changed before renewal");
      }
      await writeFile(temporaryPath, `${applicationCanonicalJson(next)}\n`, {
        encoding: "utf8", mode: 0o600, flag: "wx",
      });
      await renameOver(temporaryPath, this.#descriptorPath);
      return next;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (error?.code === "EEXIST") fail("descriptor_exists", "Descriptor publication is already claimed");
      throw error;
    } finally {
      if (claimed) await rm(this.#claimPath, { force: true }).catch(() => {});
    }
  }

  async remove({ expectedInstanceId }) {
    let claim = null;
    try {
      claim = JSON.parse(await readFile(this.#claimPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") return unavailable("descriptor_claim_invalid");
    }
    if (claim !== null) return unavailable("descriptor_claim_active");
    let descriptor;
    try {
      descriptor = validateApplicationGatewayDescriptor(JSON.parse(
        await readFile(this.#descriptorPath, "utf8"),
      ));
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (claim !== null) await rm(this.#claimPath, { force: true });
        return Object.freeze({ status: "absent" });
      }
      return unavailable("descriptor_invalid");
    }
    if (descriptor.instance.instanceId !== expectedInstanceId) {
      return unavailable("descriptor_stale");
    }
    await rm(this.#descriptorPath, { force: true });
    if (claim !== null) await rm(this.#claimPath, { force: true });
    return Object.freeze({ status: "removed", instanceId: expectedInstanceId });
  }
}
