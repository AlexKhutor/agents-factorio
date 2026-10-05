import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applicationCanonicalJson,
  applicationCanonicalSha256,
} from "../src/application-contract.mjs";
import { ApplicationGatewayDescriptorStore } from "../src/application-gateway-descriptor.mjs";
import { ApplicationGatewayRuntimeFiles } from "../src/application-gateway-runtime.mjs";
import { postApplicationShadowDiscovery } from "./application-shadow-gateway-harness.mjs";

export const APPLICATION_GATEWAY_PRODUCTION_LOG_MEASUREMENT_VERSION = "v0.1.0";

const scriptPath = fileURLToPath(import.meta.url);

async function fileSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readReadyRuntime(repoRoot) {
  const files = new ApplicationGatewayRuntimeFiles({ repoRoot });
  const lifecycle = await files.readStatus();
  if (lifecycle === null || lifecycle.terminal || !lifecycle.ready) {
    throw new Error("production_gateway_not_ready");
  }
  const store = new ApplicationGatewayDescriptorStore({
    descriptorPath: files.paths.descriptor,
  });
  const resolved = await store.read({
    lifecycleStatus: lifecycle,
    observedAtUtc: new Date().toISOString(),
  });
  if (resolved.status !== "available") throw new Error("production_descriptor_unavailable");
  return { instanceId: lifecycle.identity.instanceId, descriptor: resolved.descriptor };
}

function snapshot(logRoot, sizeReader) {
  return Promise.all([
    sizeReader(path.join(logRoot, "application_gateway.log")),
    sizeReader(path.join(logRoot, "application_gateway.error.log")),
  ]).then(([standardOutputBytes, standardErrorBytes]) => ({
    standardOutputBytes,
    standardErrorBytes,
  }));
}

export async function measureApplicationGatewayProductionLogs({
  repoRoot,
  requestCount = 20,
  recordedAtUtc = new Date().toISOString(),
  runtimeReader = readReadyRuntime,
  sizeReader = fileSize,
  discovery = postApplicationShadowDiscovery,
} = {}) {
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)
      || !Number.isInteger(requestCount) || requestCount < 1 || requestCount > 100
      || typeof runtimeReader !== "function" || typeof sizeReader !== "function"
      || typeof discovery !== "function") {
    throw new Error("invalid_production_log_measurement");
  }
  const root = path.resolve(repoRoot);
  const beforeRuntime = await runtimeReader(root);
  const before = await snapshot(path.join(root, "logs"), sizeReader);
  if (!Number.isSafeInteger(before.standardOutputBytes)
      || before.standardOutputBytes < 1
      || (before.standardErrorBytes !== null
        && (!Number.isSafeInteger(before.standardErrorBytes) || before.standardErrorBytes < 0))) {
    throw new Error("production_log_path_unavailable");
  }
  for (let index = 0; index < requestCount; index += 1) {
    await discovery({
      descriptor: beforeRuntime.descriptor,
      requestedAtUtc: recordedAtUtc,
      requestId: `a11-production-log-${index + 1}`,
      correlationId: "a11-production-log-measurement",
    });
  }
  const after = await snapshot(path.join(root, "logs"), sizeReader);
  const afterRuntime = await runtimeReader(root);
  if (afterRuntime.instanceId !== beforeRuntime.instanceId
      || !Number.isSafeInteger(after.standardOutputBytes)
      || !Number.isSafeInteger(after.standardErrorBytes ?? 0)) {
    throw new Error("production_gateway_identity_changed");
  }
  const body = {
    schemaVersion: 1,
    contractVersion: APPLICATION_GATEWAY_PRODUCTION_LOG_MEASUREMENT_VERSION,
    runId: "a11-production-log-growth",
    recordedAtUtc,
    gatewayInstanceSha256: applicationCanonicalSha256({
      instanceId: beforeRuntime.instanceId,
    }),
    requestCount,
    standardOutput: {
      beforeBytes: before.standardOutputBytes,
      afterBytes: after.standardOutputBytes,
      growthBytes: after.standardOutputBytes - before.standardOutputBytes,
    },
    standardError: {
      beforeBytes: before.standardErrorBytes ?? 0,
      afterBytes: after.standardErrorBytes ?? 0,
      growthBytes: (after.standardErrorBytes ?? 0) - (before.standardErrorBytes ?? 0),
    },
    safety: {
      providerTurnInvoked: false,
      mutationInvoked: false,
      logContentRead: false,
      exactInstancePreserved: true,
    },
  };
  const report = Object.freeze({
    ...body,
    reportId: `application-gateway-production-logs-${applicationCanonicalSha256(body)}`,
  });
  validateApplicationGatewayProductionLogReport(report);
  return report;
}

function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !fields.includes(field))
      || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new Error("invalid_production_log_report");
  }
}

export function validateApplicationGatewayProductionLogReport(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "runId", "recordedAtUtc",
    "gatewayInstanceSha256", "requestCount", "standardOutput", "standardError",
    "safety", "reportId",
  ]);
  if (value.schemaVersion !== 1
      || value.contractVersion !== APPLICATION_GATEWAY_PRODUCTION_LOG_MEASUREMENT_VERSION
      || value.runId !== "a11-production-log-growth"
      || !value.recordedAtUtc?.endsWith("Z")
      || !Number.isFinite(Date.parse(value.recordedAtUtc))
      || !/^[a-f0-9]{64}$/u.test(value.gatewayInstanceSha256 ?? "")
      || !Number.isInteger(value.requestCount) || value.requestCount < 1
      || value.requestCount > 100
      || !/^application-gateway-production-logs-[a-f0-9]{64}$/u.test(
        value.reportId ?? "",
      )) {
    throw new Error("invalid_production_log_report");
  }
  for (const stream of [value.standardOutput, value.standardError]) {
    exact(stream, ["beforeBytes", "afterBytes", "growthBytes"]);
    if (![stream.beforeBytes, stream.afterBytes, stream.growthBytes].every(
      (item) => Number.isSafeInteger(item) && item >= 0,
    ) || stream.afterBytes - stream.beforeBytes !== stream.growthBytes) {
      throw new Error("invalid_production_log_report");
    }
  }
  if (value.standardOutput.beforeBytes < 1) throw new Error("invalid_production_log_report");
  exact(value.safety, [
    "providerTurnInvoked", "mutationInvoked", "logContentRead", "exactInstancePreserved",
  ]);
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "reportId"));
  if (value.safety.providerTurnInvoked !== false
      || value.safety.mutationInvoked !== false
      || value.safety.logContentRead !== false
      || value.safety.exactInstancePreserved !== true
      || value.reportId
        !== `application-gateway-production-logs-${applicationCanonicalSha256(body)}`) {
    throw new Error("invalid_production_log_report");
  }
  return value;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!["--repo-root", "--request-count"].includes(token)
        || index + 1 >= argv.length) throw new Error("invalid_argument");
    options[token.slice(2)] = argv[index += 1];
  }
  if (!options["repo-root"]) throw new Error("repo_root_required");
  const requestCount = options["request-count"] === undefined
    ? 20 : Number(options["request-count"]);
  return { repoRoot: options["repo-root"], requestCount };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const report = await measureApplicationGatewayProductionLogs(
      parseArguments(process.argv.slice(2)),
    );
    console.log(applicationCanonicalJson(report));
  } catch {
    console.error(applicationCanonicalJson({
      status: "failed", reasonCode: "production_log_measurement_failed",
    }));
    process.exitCode = 1;
  }
}
