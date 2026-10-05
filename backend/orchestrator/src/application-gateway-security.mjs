import { createHash, timingSafeEqual } from "node:crypto";

import { applicationCanonicalSha256 } from "./application-contract.mjs";
import {
  APPLICATION_GATEWAY_TRANSPORT_ID,
  validateApplicationGatewayLifecycleStatus,
} from "./application-gateway-lifecycle.mjs";

export const APPLICATION_GATEWAY_SECURITY_VERSION = "v0.1.0";
export const APPLICATION_GATEWAY_SECURITY_LIMITS = Object.freeze({
  maximumHeaderBytes: 16 * 1024,
  maximumRequestBytes: 1152 * 1024,
  requestTimeoutMs: 15_000,
  maximumSessionLifetimeMs: 24 * 60 * 60 * 1000,
  maximumAllowedOrigins: 8,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43,256}$/;

export class ApplicationGatewaySecurityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApplicationGatewaySecurityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ApplicationGatewaySecurityError(code, message);
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

function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length > 512) {
    fail("invalid_origin", "Allowed origin must be bounded text");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_origin", "Allowed origin must be an absolute URL origin");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname !== "/" || parsed.origin === "null") {
    fail("invalid_origin", "Allowed origin must be an exact non-opaque origin");
  }
  return parsed.origin;
}

export function hashApplicationGatewayBearerToken(value) {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    fail("invalid_token", "Gateway bearer token must be bounded base64url text");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createSecurityPolicy({
  sessionId,
  instanceId,
  lifecycleIdentitySha256,
  workspaceRootSha256,
  bearerSha256,
  issuedAtUtc,
  expiresAtUtc,
  allowedOrigins = [],
}) {
  if (!Array.isArray(allowedOrigins)
      || allowedOrigins.length > APPLICATION_GATEWAY_SECURITY_LIMITS.maximumAllowedOrigins) {
    fail("invalid_origin", "Allowed origin list exceeds its bound");
  }
  const origins = [...new Set(allowedOrigins.map(normalizeOrigin))].sort();
  const issued = utc(issuedAtUtc, "session.issuedAtUtc");
  const expires = utc(expiresAtUtc, "session.expiresAtUtc");
  if (Date.parse(expires) <= Date.parse(issued)) {
    fail("invalid_timeline", "Gateway session expiry must follow issue time");
  }
  if (Date.parse(expires) - Date.parse(issued)
      > APPLICATION_GATEWAY_SECURITY_LIMITS.maximumSessionLifetimeMs) {
    fail("invalid_timeline", "Gateway session lifetime exceeds its bound");
  }
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: APPLICATION_GATEWAY_SECURITY_VERSION,
    transportId: APPLICATION_GATEWAY_TRANSPORT_ID,
    listener: { host: "127.0.0.1", family: "ipv4", portStrategy: "os-assigned", requestedPort: 0 },
    session: {
      sessionId: uuid(sessionId, "session.sessionId"),
      instanceId: uuid(instanceId, "session.instanceId"),
      lifecycleIdentitySha256: hash(
        lifecycleIdentitySha256,
        "session.lifecycleIdentitySha256",
      ),
      workspaceRootSha256: hash(workspaceRootSha256, "session.workspaceRootSha256"),
      bearerSha256: hash(bearerSha256, "session.bearerSha256"),
      issuedAtUtc: issued,
      expiresAtUtc: expires,
    },
    allowedOrigins: origins,
    limits: { ...APPLICATION_GATEWAY_SECURITY_LIMITS },
  });
}

export function buildApplicationGatewaySecurityPolicy({
  lifecycleStatus,
  sessionId,
  bearerSha256,
  issuedAtUtc,
  expiresAtUtc,
  allowedOrigins = [],
}) {
  const lifecycle = validateApplicationGatewayLifecycleStatus(lifecycleStatus);
  return createSecurityPolicy({
    sessionId,
    instanceId: lifecycle.identity.instanceId,
    lifecycleIdentitySha256: lifecycle.identity.identitySha256,
    workspaceRootSha256: lifecycle.identity.workspace.workspaceRootSha256,
    bearerSha256,
    issuedAtUtc,
    expiresAtUtc,
    allowedOrigins,
  });
}

export function validateApplicationGatewaySecurityPolicy(value) {
  object(value, "securityPolicy");
  exact(value, [
    "schemaVersion", "contractVersion", "transportId", "listener", "session",
    "allowedOrigins", "limits",
  ], "securityPolicy");
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_GATEWAY_SECURITY_VERSION
      || value.transportId !== APPLICATION_GATEWAY_TRANSPORT_ID) {
    fail("unsupported_contract", "Gateway security policy is unsupported");
  }
  object(value.listener, "listener");
  exact(value.listener, ["host", "family", "portStrategy", "requestedPort"], "listener");
  if (value.listener.host !== "127.0.0.1" || value.listener.family !== "ipv4"
      || value.listener.portStrategy !== "os-assigned" || value.listener.requestedPort !== 0) {
    fail("non_loopback_listener", "Gateway listener must use OS-assigned IPv4 loopback");
  }
  object(value.session, "session");
  exact(value.session, [
    "sessionId", "instanceId", "lifecycleIdentitySha256", "workspaceRootSha256",
    "bearerSha256", "issuedAtUtc", "expiresAtUtc",
  ], "session");
  object(value.limits, "limits");
  exact(value.limits, Object.keys(APPLICATION_GATEWAY_SECURITY_LIMITS), "limits");
  if (Object.entries(APPLICATION_GATEWAY_SECURITY_LIMITS).some(
    ([key, expected]) => value.limits[key] !== expected,
  )) {
    fail("invalid_limits", "Gateway security limits are not canonical");
  }
  const rebuilt = createSecurityPolicy({
    ...value.session,
    allowedOrigins: value.allowedOrigins,
  });
  if (applicationCanonicalSha256(rebuilt) !== applicationCanonicalSha256(value)) {
    fail("noncanonical_policy", "Gateway security policy is not canonical");
  }
  return rebuilt;
}

export function bindApplicationGatewayEndpoint(policyValue, port) {
  const policy = validateApplicationGatewaySecurityPolicy(policyValue);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    fail("invalid_port", "Bound gateway port must be an unprivileged TCP port");
  }
  const identity = {
    transportId: policy.transportId,
    instanceId: policy.session.instanceId,
    lifecycleIdentitySha256: policy.session.lifecycleIdentitySha256,
    sessionId: policy.session.sessionId,
    workspaceRootSha256: policy.session.workspaceRootSha256,
    scheme: "http",
    host: policy.listener.host,
    port,
  };
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: APPLICATION_GATEWAY_SECURITY_VERSION,
    ...identity,
    authority: `${identity.host}:${port}`,
    endpointId: `gateway-endpoint-${applicationCanonicalSha256(identity)}`,
  });
}

function deny(policy, reasonCode) {
  return Object.freeze({
    status: "deny",
    reasonCode,
    instanceId: policy.session.instanceId,
    lifecycleIdentitySha256: policy.session.lifecycleIdentitySha256,
    sessionId: policy.session.sessionId,
    workspaceRootSha256: policy.session.workspaceRootSha256,
  });
}

function bearerMatches(header, expectedSha256) {
  let candidate = "";
  if (typeof header === "string" && header.length <= 320 && header.startsWith("Bearer ")) {
    candidate = header.slice(7);
  }
  const candidateHash = TOKEN.test(candidate)
    ? createHash("sha256").update(candidate, "utf8").digest()
    : createHash("sha256").update("invalid", "utf8").digest();
  return timingSafeEqual(candidateHash, Buffer.from(expectedSha256, "hex"));
}

export function authorizeApplicationGatewayRequest(policyValue, endpointValue, requestValue) {
  const policy = validateApplicationGatewaySecurityPolicy(policyValue);
  const endpoint = bindApplicationGatewayEndpoint(policy, endpointValue?.port);
  if (applicationCanonicalSha256(endpoint) !== applicationCanonicalSha256(endpointValue)) {
    fail("endpoint_mismatch", "Bound gateway endpoint identity is not canonical");
  }
  object(requestValue, "request");
  exact(requestValue, [
    "remoteAddress", "host", "origin", "authorization", "headerBytes",
    "contentLength", "receivedAtUtc",
  ], "request");
  const receivedAtUtc = utc(requestValue.receivedAtUtc, "request.receivedAtUtc");
  if (requestValue.remoteAddress !== "127.0.0.1") return deny(policy, "foreign_address");
  if (requestValue.host !== endpoint.authority) return deny(policy, "host_mismatch");
  if (requestValue.origin !== null
      && !policy.allowedOrigins.includes(requestValue.origin)) return deny(policy, "origin_denied");
  if (!Number.isSafeInteger(requestValue.headerBytes) || requestValue.headerBytes < 0
      || requestValue.headerBytes > policy.limits.maximumHeaderBytes) {
    return deny(policy, "headers_too_large");
  }
  if (!Number.isSafeInteger(requestValue.contentLength) || requestValue.contentLength < 0
      || requestValue.contentLength > policy.limits.maximumRequestBytes) {
    return deny(policy, "request_too_large");
  }
  if (Date.parse(receivedAtUtc) < Date.parse(policy.session.issuedAtUtc)
      || Date.parse(receivedAtUtc) >= Date.parse(policy.session.expiresAtUtc)) {
    return deny(policy, "session_expired");
  }
  if (!bearerMatches(requestValue.authorization, policy.session.bearerSha256)) {
    return deny(policy, "authorization_denied");
  }
  return Object.freeze({
    status: "allow",
    reasonCode: "authorized",
    instanceId: policy.session.instanceId,
    lifecycleIdentitySha256: policy.session.lifecycleIdentitySha256,
    sessionId: policy.session.sessionId,
    workspaceRootSha256: policy.session.workspaceRootSha256,
  });
}
