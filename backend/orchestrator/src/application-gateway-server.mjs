import http from "node:http";
import { gatewayFailureDiagnostic } from "./application-gateway-diagnostics.mjs";
import { randomBytes, randomUUID } from "node:crypto";

import { applicationCanonicalJson } from "./application-contract.mjs";
import { InMemoryApplicationGatewayAdapter } from "./application-gateway-adapter.mjs";
import { ApplicationGatewayLifecycle } from "./application-gateway-lifecycle.mjs";
import {
  APPLICATION_GATEWAY_SECURITY_LIMITS,
  authorizeApplicationGatewayRequest,
  bindApplicationGatewayEndpoint,
  buildApplicationGatewaySecurityPolicy,
  hashApplicationGatewayBearerToken,
} from "./application-gateway-security.mjs";

export const APPLICATION_GATEWAY_SERVER_VERSION = "v0.2.4";

function wireProblem(response, statusCode, reasonCode) {
  const body = `${applicationCanonicalJson({
    schemaVersion: 1,
    serverVersion: APPLICATION_GATEWAY_SERVER_VERSION,
    outcome: "rejected",
    reasonCode,
  })}\n`;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body, "utf8")),
    "content-type": "application/problem+json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function securityStatus(reasonCode) {
  if (reasonCode === "headers_too_large" || reasonCode === "request_too_large") return 413;
  if (reasonCode === "authorization_denied" || reasonCode === "session_expired") return 401;
  return 403;
}

function headerBytes(request) {
  return Buffer.byteLength(request.rawHeaders.join("\r\n"), "utf8");
}

function contentLength(request) {
  const raw = request.headers["content-length"];
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return -1;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : -1;
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) {
      const error = new Error("request_too_large");
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function securityMetadata(request, declaredLength, now) {
  return {
    remoteAddress: request.socket.remoteAddress,
    host: request.headers.host ?? null,
    origin: request.headers.origin ?? null,
    authorization: request.headers.authorization ?? null,
    headerBytes: headerBytes(request),
    contentLength: declaredLength,
    receivedAtUtc: now().toISOString(),
  };
}

export class ApplicationGatewayServer {
  #lifecycle;
  #descriptorStore;
  #invokeApplication;
  #readEvents;
  #exposedOperations;
  #allowedOrigins;
  #sessionLifetimeMs;
  #heartbeatIntervalMs;
  #now;
  #writeStatus;
  #writeDiagnostic;
  #server = null;
  #adapter = null;
  #policy = null;
  #endpoint = null;
  #bearerToken = null;
  #descriptor = null;
  #renewal = null;
  #heartbeat = null;

  constructor({
    instanceId,
    generation = 1,
    restartOf = null,
    workspace,
    process,
    descriptorStore,
    invokeApplication,
    readEvents,
    exposedOperations = null,
    allowedOrigins = [],
    sessionLifetimeMs = 60 * 60 * 1000,
    heartbeatIntervalMs = 10_000,
    now = () => new Date(),
    writeStatus = async () => {},
    writeDiagnostic = () => {},
  }) {
    if (!descriptorStore || typeof descriptorStore.publish !== "function"
        || typeof descriptorStore.remove !== "function"
        || typeof invokeApplication !== "function" || typeof readEvents !== "function"
        || (exposedOperations !== null
          && (!Array.isArray(exposedOperations) || exposedOperations.length < 1))
        || typeof writeStatus !== "function" || typeof writeDiagnostic !== "function") {
      throw new TypeError("Application gateway server dependencies are invalid");
    }
    if (!Number.isSafeInteger(sessionLifetimeMs) || sessionLifetimeMs < 60_000
        || sessionLifetimeMs > APPLICATION_GATEWAY_SECURITY_LIMITS.maximumSessionLifetimeMs
        || !Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000
        || heartbeatIntervalMs > 60_000) {
      throw new TypeError("Application gateway server timing is invalid");
    }
    this.#lifecycle = new ApplicationGatewayLifecycle({
      instanceId, generation, restartOf, workspace, process,
    });
    this.#descriptorStore = descriptorStore;
    this.#invokeApplication = invokeApplication;
    this.#readEvents = readEvents;
    this.#exposedOperations = exposedOperations === null
      ? null : structuredClone(exposedOperations);
    this.#allowedOrigins = [...allowedOrigins];
    this.#sessionLifetimeMs = sessionLifetimeMs;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
    this.#now = now;
    this.#writeStatus = writeStatus;
    this.#writeDiagnostic = writeDiagnostic;
  }

  get status() {
    return this.#lifecycle.snapshot();
  }

  async start() {
    if (this.#server !== null) throw new Error("gateway_already_started");
    const issuedAtUtc = this.#now().toISOString();
    const expiresAtUtc = new Date(
      Date.parse(issuedAtUtc) + this.#sessionLifetimeMs,
    ).toISOString();
    this.#bearerToken = randomBytes(32).toString("base64url");
    this.#policy = buildApplicationGatewaySecurityPolicy({
      lifecycleStatus: this.status,
      sessionId: randomUUID(),
      bearerSha256: hashApplicationGatewayBearerToken(this.#bearerToken),
      issuedAtUtc,
      expiresAtUtc,
      allowedOrigins: this.#allowedOrigins,
    });
    this.#server = http.createServer((request, response) => {
      this.#handle(request, response).catch(() => {
        if (!response.headersSent) wireProblem(response, 500, "gateway_request_failed");
        else response.destroy();
      });
    });
    this.#server.maxHeadersCount = 64;
    this.#server.headersTimeout = APPLICATION_GATEWAY_SECURITY_LIMITS.requestTimeoutMs;
    this.#server.requestTimeout = APPLICATION_GATEWAY_SECURITY_LIMITS.requestTimeoutMs;

    try {
      await new Promise((resolve, reject) => {
        this.#server.once("error", reject);
        this.#server.listen(0, "127.0.0.1", resolve);
      });
      const address = this.#server.address();
      if (!address || typeof address === "string") throw new Error("gateway_address_unavailable");
      this.#endpoint = bindApplicationGatewayEndpoint(this.#policy, address.port);
      this.#adapter = new InMemoryApplicationGatewayAdapter({
        securityPolicy: this.#policy,
        endpoint: this.#endpoint,
        invokeApplication: this.#invokeApplication,
        readEvents: this.#readEvents,
      });
      const ready = this.#lifecycle.markReady(this.#now().toISOString());
      this.#descriptor = await this.#descriptorStore.publish({
        lifecycleStatus: ready,
        securityPolicy: this.#policy,
        endpoint: this.#endpoint,
        bearerToken: this.#bearerToken,
        publishedAtUtc: ready.readyAtUtc,
        ...(this.#exposedOperations === null
          ? {} : { exposedOperations: this.#exposedOperations }),
      });
      await this.#writeStatus(ready);
      this.#heartbeat = setInterval(() => {
        this.#publishHeartbeat().catch(async (error) => {
          try {
            await this.#writeDiagnostic(gatewayFailureDiagnostic(error, this.status, this.#now().toISOString()));
          } catch { /* Diagnostic failure must not suppress terminalization. */ }
          await this.#abort("observability_lost");
        });
      }, this.#heartbeatIntervalMs);
      this.#heartbeat.unref?.();
      return this.status;
    } catch (error) {
      const collision = error?.code === "descriptor_exists";
      await this.#abort(collision ? "process_collision" : "startup_failed", {
        publishStatus: !collision,
        removeDescriptor: !collision,
      });
      if (collision) {
        const bounded = new Error("gateway_process_collision");
        bounded.code = "gateway_process_collision";
        throw bounded;
      }
      throw error;
    }
  }

  async #publishHeartbeat() {
    if (this.status.lifecycle !== "ready") return;
    if (this.#descriptor?.validUntilUtc && Date.parse(this.#descriptor.validUntilUtc)
        - this.#now().getTime() <= this.#sessionLifetimeMs / 4) {
      this.#renewal ??= this.#renewConnection();
      try { await this.#renewal; } finally { this.#renewal = null; }
    }
    if (this.status.lifecycle !== "ready") return;
    await this.#writeStatus(this.#lifecycle.heartbeat(this.#now().toISOString()));
  }

  async #renewConnection() {
    const issuedAtUtc = this.#now().toISOString();
    if (Date.parse(issuedAtUtc) >= Date.parse(this.#descriptor.validUntilUtc)) {
      throw Object.assign(new Error("gateway_connection_expired"), { code: "gateway_connection_expired" });
    }
    const policy = buildApplicationGatewaySecurityPolicy({
      lifecycleStatus: this.status,
      sessionId: this.#policy.session.sessionId,
      bearerSha256: this.#policy.session.bearerSha256,
      issuedAtUtc,
      expiresAtUtc: new Date(Date.parse(issuedAtUtc) + this.#sessionLifetimeMs).toISOString(),
      allowedOrigins: this.#allowedOrigins,
    });
    const endpoint = bindApplicationGatewayEndpoint(policy, this.#endpoint.port);
    const adapter = new InMemoryApplicationGatewayAdapter({
      securityPolicy: policy, endpoint,
      invokeApplication: this.#invokeApplication, readEvents: this.#readEvents,
    });
    const descriptor = await this.#descriptorStore.renew({ expected: this.#descriptor,
      options: { lifecycleStatus: this.status, securityPolicy: policy, endpoint,
        bearerToken: this.#bearerToken, publishedAtUtc: issuedAtUtc,
        ...(this.#exposedOperations === null ? {} : { exposedOperations: this.#exposedOperations }) } });
    this.#policy = policy;
    this.#endpoint = endpoint;
    this.#adapter = adapter;
    this.#descriptor = descriptor;
  }

  async #abort(reasonCode, { publishStatus = true, removeDescriptor = true } = {}) {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    const current = this.status;
    if (!current.terminal) {
      try {
        this.#lifecycle.markUncertain(reasonCode, this.#now().toISOString());
      } catch { }
    }
    if (this.#server !== null) {
      this.#server.closeAllConnections?.();
      await new Promise((resolve) => this.#server.close(() => resolve())).catch(() => {});
    }
    this.#server = null;
    this.#adapter = null;
    this.#descriptor = null;
    if (removeDescriptor) {
      await this.#descriptorStore.remove({
        expectedInstanceId: current.identity.instanceId,
      }).catch(() => {});
    }
    if (publishStatus) await this.#writeStatus(this.status).catch(() => {});
  }

  async #handle(request, response) {
    if (this.#adapter === null || this.status.lifecycle !== "ready") {
      wireProblem(response, 503, "gateway_not_ready");
      return;
    }
    const declaredLength = contentLength(request);
    const security = securityMetadata(request, declaredLength, this.#now);
    let authorization;
    try {
      authorization = authorizeApplicationGatewayRequest(
        this.#policy,
        this.#endpoint,
        security,
      );
    } catch {
      wireProblem(response, 401, "authorization_denied");
      return;
    }
    if (authorization.status !== "allow") {
      wireProblem(response, securityStatus(authorization.reasonCode), authorization.reasonCode);
      return;
    }
    let body;
    try {
      body = await readBody(request, APPLICATION_GATEWAY_SECURITY_LIMITS.maximumRequestBytes);
    } catch {
      wireProblem(response, 413, "request_too_large");
      return;
    }
    const result = await this.#adapter.handle({
      method: request.method ?? "",
      path: request.url ?? "",
      contentType: typeof request.headers["content-type"] === "string"
        ? request.headers["content-type"]
        : "",
      body,
      security,
    });
    response.writeHead(result.statusCode, result.headers);
    response.end(result.body);
  }

  async stop(requestId, requestedAtUtc = this.#now().toISOString()) {
    if (this.status.terminal) return this.status;
    const stopping = this.#lifecycle.requestStop(requestId, requestedAtUtc);
    await this.#writeStatus(stopping);
    if (this.#renewal !== null) await this.#renewal.catch(() => {});
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#server !== null) {
      const server = this.#server;
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          server.closeAllConnections?.();
        }, 5_000);
        timeout.unref?.();
        server.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.#server = null;
    this.#adapter = null;
    this.#descriptor = null;
    await this.#descriptorStore.remove({
      expectedInstanceId: stopping.identity.instanceId,
    });
    const stopped = this.#lifecycle.markStopped(this.#now().toISOString());
    await this.#writeStatus(stopped);
    return stopped;
  }
}
