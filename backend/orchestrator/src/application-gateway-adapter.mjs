import {
  applicationCanonicalJson,
  applicationCanonicalSha256,
  validateApplicationRequestEnvelope,
  validateApplicationResultEnvelope,
} from "./application-contract.mjs";
import { APPLICATION_EVENT_ENVELOPE_LIMITS } from "./application-event-envelope.mjs";
import {
  APPLICATION_EVENT_STREAM_LIMITS,
  validateApplicationEventReadResult,
} from "./application-event-stream.mjs";
import { APPLICATION_GATEWAY_TRANSPORT_ID } from "./application-gateway-lifecycle.mjs";
import {
  APPLICATION_GATEWAY_SECURITY_LIMITS,
  authorizeApplicationGatewayRequest,
  bindApplicationGatewayEndpoint,
  validateApplicationGatewaySecurityPolicy,
} from "./application-gateway-security.mjs";

export const APPLICATION_GATEWAY_ADAPTER_VERSION = "v0.1.0";
export const APPLICATION_GATEWAY_ROUTES = Object.freeze({
  operation: "/v1/operations",
  eventRead: "/v1/events/read",
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REQUEST_FIELDS = new Set(["method", "path", "contentType", "body", "security"]);
const EVENT_READ_FIELDS = new Set(["streamId", "cursor", "limit", "byteLimit"]);
const JSON_MEDIA_TYPE = "application/json";
const NDJSON_MEDIA_TYPE = "application/x-ndjson";
const MAX_EVENT_FRAME_BYTES = APPLICATION_EVENT_STREAM_LIMITS.maximumReplayBytes
  + (2 * APPLICATION_EVENT_ENVELOPE_LIMITS.maximumBytes);

export class ApplicationGatewayAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApplicationGatewayAdapterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ApplicationGatewayAdapterError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_transport_request", `${label} must be an object`);
  }
  return value;
}

function exact(value, fields, label) {
  if (Object.keys(value).some((key) => !fields.has(key))) {
    fail("invalid_transport_request", `${label} contains unsupported fields`);
  }
}

function responseHeaders(mediaType, origin = null, extra = {}) {
  const headers = {
    "cache-control": "no-store",
    "content-type": `${mediaType}; charset=utf-8`,
    "x-content-type-options": "nosniff",
    ...extra,
  };
  if (origin !== null) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  return Object.freeze(headers);
}

function response(statusCode, mediaType, value, origin = null, extraHeaders = {}) {
  const body = `${applicationCanonicalJson(value)}\n`;
  return Object.freeze({
    schemaVersion: 1,
    adapterVersion: APPLICATION_GATEWAY_ADAPTER_VERSION,
    statusCode,
    headers: responseHeaders(mediaType, origin, {
      "content-length": String(Buffer.byteLength(body, "utf8")),
      ...extraHeaders,
    }),
    body,
  });
}

function problem(statusCode, reasonCode, origin = null, extraHeaders = {}) {
  return response(statusCode, "application/problem+json", {
    schemaVersion: 1,
    adapterVersion: APPLICATION_GATEWAY_ADAPTER_VERSION,
    transportId: APPLICATION_GATEWAY_TRANSPORT_ID,
    outcome: "rejected",
    reasonCode,
  }, origin, extraHeaders);
}

function securityStatus(reasonCode) {
  if (reasonCode === "headers_too_large" || reasonCode === "request_too_large") return 413;
  if (reasonCode === "authorization_denied" || reasonCode === "session_expired") return 401;
  return 403;
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    fail("invalid_json", "Gateway body must be valid JSON");
  }
}

function validateEventReadRequest(value) {
  object(value, "eventReadRequest");
  exact(value, EVENT_READ_FIELDS, "eventReadRequest");
  if (typeof value.streamId !== "string" || !ID.test(value.streamId)) {
    fail("invalid_event_read", "eventReadRequest.streamId is invalid");
  }
  if (value.cursor !== null
      && (typeof value.cursor !== "string" || value.cursor.length > 768)) {
    fail("invalid_event_read", "eventReadRequest.cursor is invalid");
  }
  const limit = value.limit ?? APPLICATION_EVENT_STREAM_LIMITS.defaultReplayEvents;
  const byteLimit = value.byteLimit ?? APPLICATION_EVENT_STREAM_LIMITS.defaultReplayBytes;
  if (!Number.isSafeInteger(limit) || limit < 1
      || limit > APPLICATION_EVENT_STREAM_LIMITS.maximumReplayEvents) {
    fail("invalid_event_read", "eventReadRequest.limit is outside its bound");
  }
  if (!Number.isSafeInteger(byteLimit)
      || byteLimit < APPLICATION_EVENT_ENVELOPE_LIMITS.maximumBytes
      || byteLimit > APPLICATION_EVENT_STREAM_LIMITS.maximumReplayBytes) {
    fail("invalid_event_read", "eventReadRequest.byteLimit is outside its bound");
  }
  return Object.freeze({ streamId: value.streamId, cursor: value.cursor, limit, byteLimit });
}

function resultMatchesRequest(request, result) {
  return result.requestId === request.requestId
    && result.correlationId === request.correlationId
    && (result.causationId ?? null) === (request.causationId ?? null)
    && applicationCanonicalSha256(result.operation)
      === applicationCanonicalSha256(request.operation);
}

function eventResultWithinRequest(request, result) {
  if (result.streamId !== request.streamId || result.events.length > request.limit) return false;
  const eventBytes = result.events.reduce(
    (total, event) => total + Buffer.byteLength(applicationCanonicalJson(event), "utf8"),
    0,
  );
  return eventBytes <= request.byteLimit;
}

export class InMemoryApplicationGatewayAdapter {
  #policy;
  #endpoint;
  #invokeApplication;
  #readEvents;

  constructor({ securityPolicy, endpoint, invokeApplication, readEvents }) {
    this.#policy = validateApplicationGatewaySecurityPolicy(securityPolicy);
    this.#endpoint = bindApplicationGatewayEndpoint(this.#policy, endpoint?.port);
    if (applicationCanonicalSha256(this.#endpoint) !== applicationCanonicalSha256(endpoint)) {
      fail("endpoint_mismatch", "Gateway endpoint does not match security policy");
    }
    if (typeof invokeApplication !== "function" || typeof readEvents !== "function") {
      fail("invalid_adapter", "Gateway adapter requires application and event readers");
    }
    this.#invokeApplication = invokeApplication;
    this.#readEvents = readEvents;
  }

  async handle(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return problem(400, "invalid_transport_request");
    }

    let authorization;
    try {
      authorization = authorizeApplicationGatewayRequest(
        this.#policy,
        this.#endpoint,
        value.security,
      );
    } catch {
      return problem(401, "authorization_denied");
    }
    if (authorization.status !== "allow") {
      return problem(securityStatus(authorization.reasonCode), authorization.reasonCode);
    }

    const origin = value.security.origin;
    try {
      exact(value, REQUEST_FIELDS, "gatewayRequest");
      if (typeof value.method !== "string" || typeof value.path !== "string"
          || typeof value.contentType !== "string" || typeof value.body !== "string") {
        fail("invalid_transport_request", "Gateway request fields are invalid");
      }
      const actualBytes = Buffer.byteLength(value.body, "utf8");
      if (actualBytes > APPLICATION_GATEWAY_SECURITY_LIMITS.maximumRequestBytes) {
        return problem(413, "request_too_large", origin);
      }
      if (actualBytes !== value.security.contentLength) {
        return problem(400, "content_length_mismatch", origin);
      }
      if (value.method !== "POST") {
        return problem(405, "method_not_allowed", origin, { allow: "POST" });
      }
      if (!Object.values(APPLICATION_GATEWAY_ROUTES).includes(value.path)) {
        return problem(404, "route_not_found", origin);
      }
      if (value.contentType.toLowerCase() !== JSON_MEDIA_TYPE) {
        return problem(415, "unsupported_media_type", origin);
      }
      const body = parseJson(value.body);
      if (value.path === APPLICATION_GATEWAY_ROUTES.operation) {
        return await this.#handleOperation(body, origin);
      }
      return await this.#handleEventRead(body, origin);
    } catch (error) {
      const reasonCode = error instanceof ApplicationGatewayAdapterError
        ? error.code
        : "invalid_transport_request";
      return problem(reasonCode === "invalid_json" ? 400 : 422, reasonCode, origin);
    }
  }

  async #handleOperation(body, origin) {
    let request;
    try {
      request = validateApplicationRequestEnvelope(body);
    } catch {
      return problem(422, "invalid_application_request", origin);
    }
    let result;
    try {
      result = await this.#invokeApplication(structuredClone(request));
    } catch {
      return problem(503, "backend_unavailable", origin);
    }
    try {
      validateApplicationResultEnvelope(result);
      if (!resultMatchesRequest(request, result)) {
        return problem(502, "application_identity_mismatch", origin);
      }
      const encodedBytes = Buffer.byteLength(applicationCanonicalJson(result), "utf8") + 1;
      if (encodedBytes > APPLICATION_GATEWAY_SECURITY_LIMITS.maximumRequestBytes) {
        return problem(502, "application_result_too_large", origin);
      }
      return response(200, JSON_MEDIA_TYPE, result, origin);
    } catch {
      return problem(502, "invalid_application_result", origin);
    }
  }

  async #handleEventRead(body, origin) {
    let request;
    try {
      request = validateEventReadRequest(body);
    } catch {
      return problem(422, "invalid_event_read", origin);
    }
    let result;
    try {
      result = await this.#readEvents(request);
    } catch {
      return problem(503, "event_source_unavailable", origin);
    }
    try {
      const normalized = validateApplicationEventReadResult(result);
      if (!eventResultWithinRequest(request, normalized)) {
        return problem(502, "event_read_mismatch", origin);
      }
      const encodedBytes = Buffer.byteLength(applicationCanonicalJson(normalized), "utf8") + 1;
      if (encodedBytes > MAX_EVENT_FRAME_BYTES) {
        return problem(502, "event_frame_too_large", origin);
      }
      return response(200, NDJSON_MEDIA_TYPE, normalized, origin);
    } catch {
      return problem(502, "invalid_event_read_result", origin);
    }
  }
}
