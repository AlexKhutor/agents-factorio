import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applicationCanonicalJson,
  applicationCanonicalSha256,
} from "../src/application-contract.mjs";
import {
  postApplicationShadowDiscovery,
  withApplicationShadowGateway,
} from "./application-shadow-gateway-harness.mjs";

export const APPLICATION_SHADOW_TIMING_VERSION = "v0.2.0";
export const APPLICATION_SHADOW_TIMING_METRICS = Object.freeze([
  "startup-to-ready",
  "ready-to-first-useful-data",
  "chat-list-latency",
  "chat-read-latency",
  "submit-to-provider-start",
  "provider-event-latency",
  "interaction-round-trip",
  "recovery-time",
]);

const scriptPath = fileURLToPath(import.meta.url);

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function observation(metricId, status, durationMs, reasonCode, evidenceId) {
  return { metricId, status, durationMs, reasonCode, evidenceId };
}

function unavailable(metricId, reasonCode, evidenceId) {
  return observation(metricId, "unavailable", null, reasonCode, evidenceId);
}

function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !fields.includes(field))
      || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new Error("invalid_shadow_timing_report");
  }
}

function managedMetrics() {
  return [
    observation("startup-to-ready", "historical", 16620,
      "historical-supervised-smoke", "managed-smoke-20260827"),
    unavailable("ready-to-first-useful-data", "historical-phase-not-separated",
      "managed-smoke-20260827"),
    unavailable("chat-list-latency", "historical-phase-not-separated",
      "managed-smoke-20260827"),
    unavailable("chat-read-latency", "historical-measurement-absent",
      "managed-baseline-a0"),
    observation("submit-to-provider-start", "historical", 48151,
      "historical-supervised-smoke", "managed-smoke-20260827"),
    unavailable("provider-event-latency", "historical-semantics-not-equivalent",
      "managed-smoke-20260827"),
    unavailable("interaction-round-trip", "historical-measurement-absent",
      "managed-baseline-a0"),
    unavailable("recovery-time", "historical-semantics-not-equivalent",
      "managed-smoke-20260827"),
  ];
}

export async function measureApplicationShadowTiming({
  recordedAtUtc = new Date().toISOString(),
  clock = () => performance.now(),
} = {}) {
  return withApplicationShadowGateway({
    recordedAtUtc,
    clock,
    tempPrefix: "application-shadow-timing-",
    epoch: "a11-shadow-timing-epoch",
  }, async ({ descriptor, server, startupDurationMs }) => {
    const firstDataStart = clock();
    await postApplicationShadowDiscovery({
      descriptor,
      requestedAtUtc: recordedAtUtc,
      requestId: "a11-timing-discovery",
      correlationId: "a11-shadow-timing",
    });
    const firstDataMs = rounded(clock() - firstDataStart);
    const recoveryStart = clock();
    await server.stop("a11-controlled-recovery");
    let recoveryMs = null;
    await withApplicationShadowGateway({
      recordedAtUtc,
      clock,
      tempPrefix: "application-shadow-recovery-",
      instanceId: "11111111-1111-4111-8111-111111111117",
      epoch: "a11-shadow-recovery-epoch",
    }, async ({ descriptor: recoveredDescriptor }) => {
      await postApplicationShadowDiscovery({
        descriptor: recoveredDescriptor,
        requestedAtUtc: recordedAtUtc,
        requestId: "a11-recovery-discovery",
        correlationId: "a11-shadow-recovery",
      });
      recoveryMs = rounded(clock() - recoveryStart);
    });
    if (!Number.isFinite(recoveryMs) || recoveryMs < 0) {
      throw new Error("candidate_recovery_measurement_failed");
    }
    const candidateMetrics = [
      observation("startup-to-ready", "measured", startupDurationMs,
        "local-loopback-listener", "candidate-a11-local-run"),
      observation("ready-to-first-useful-data", "measured", firstDataMs,
        "capability-discovery-response", "candidate-a11-local-run"),
      unavailable("chat-list-latency", "operation-not-exposed", "a11-read-baseline"),
      unavailable("chat-read-latency", "operation-not-exposed", "a11-read-baseline"),
      unavailable("submit-to-provider-start", "operation-not-exposed", "a11-read-baseline"),
      unavailable("provider-event-latency", "operation-not-exposed", "a11-read-baseline"),
      unavailable("interaction-round-trip", "contract-bridge-unavailable", "a11-read-baseline"),
      observation("recovery-time", "measured", recoveryMs,
        "controlled-stop-restart-discovery", "candidate-a11-local-recovery"),
    ];
    const body = {
      schemaVersion: 1,
      contractVersion: APPLICATION_SHADOW_TIMING_VERSION,
      runId: "a11-shadow-timing-local",
      recordedAtUtc,
      environment: {
        runtime: `node-${process.version}`,
        platform: process.platform,
        architecture: process.arch,
      },
      sources: [
        { sourceId: "current-managed-vscode", evidenceMode: "historical", metrics: managedMetrics() },
        { sourceId: "candidate-application-gateway", evidenceMode: "measured-local", metrics: candidateMetrics },
      ],
      safety: {
        modelFree: true,
        providerInvoked: false,
        mutationInvoked: false,
        visibleMonitorRequired: false,
        reasonCode: "bounded-foreground-measurement",
      },
    };
    const report = Object.freeze({
      ...body,
      reportId: `application-shadow-timing-${applicationCanonicalSha256(body)}`,
    });
    validateApplicationShadowTimingReport(report);
    return report;
  });
}

export function validateApplicationShadowTimingReport(value) {
  exact(value, [
    "schemaVersion", "contractVersion", "runId", "recordedAtUtc", "environment",
    "sources", "safety", "reportId",
  ]);
  if (value?.schemaVersion !== 1 || value.contractVersion !== APPLICATION_SHADOW_TIMING_VERSION
      || value.runId !== "a11-shadow-timing-local" || !value.recordedAtUtc?.endsWith("Z")
      || !Number.isFinite(Date.parse(value.recordedAtUtc)) || value.sources?.length !== 2) {
    throw new Error("invalid_shadow_timing_report");
  }
  exact(value.environment, ["runtime", "platform", "architecture"]);
  if (!/^node-v[0-9.]+$/u.test(value.environment.runtime)
      || !/^[a-z0-9-]{2,32}$/u.test(value.environment.platform)
      || !/^[a-z0-9-]{2,32}$/u.test(value.environment.architecture)) {
    throw new Error("invalid_shadow_timing_report");
  }
  for (const source of value.sources) {
    exact(source, ["sourceId", "evidenceMode", "metrics"]);
    if (![
      "current-managed-vscode", "candidate-application-gateway",
    ].includes(source.sourceId) || !["historical", "measured-local"].includes(source.evidenceMode)) {
      throw new Error("invalid_shadow_timing_report");
    }
    if (!Array.isArray(source.metrics) || source.metrics.length !== APPLICATION_SHADOW_TIMING_METRICS.length
        || APPLICATION_SHADOW_TIMING_METRICS.some(
          (metricId) => !source.metrics.some((item) => item.metricId === metricId),
        ) || new Set(source.metrics.map(({ metricId }) => metricId)).size !== source.metrics.length) {
      throw new Error("invalid_shadow_timing_report");
    }
    for (const item of source.metrics) {
      exact(item, ["metricId", "status", "durationMs", "reasonCode", "evidenceId"]);
      if (!["measured", "historical", "unavailable"].includes(item.status)
          || (item.status === "unavailable" ? item.durationMs !== null
            : !Number.isFinite(item.durationMs) || item.durationMs < 0)
          || !/^[a-z][a-z0-9-]{1,95}$/u.test(item.evidenceId)
          || !/^[a-z][a-z0-9-]{1,95}$/u.test(item.reasonCode)) {
        throw new Error("invalid_shadow_timing_report");
      }
    }
  }
  exact(value.safety, [
    "modelFree", "providerInvoked", "mutationInvoked", "visibleMonitorRequired", "reasonCode",
  ]);
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "reportId"));
  if (value.reportId !== `application-shadow-timing-${applicationCanonicalSha256(body)}`
      || value.safety?.modelFree !== true || value.safety.providerInvoked !== false
      || value.safety.mutationInvoked !== false) {
    throw new Error("invalid_shadow_timing_report");
  }
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  measureApplicationShadowTiming()
    .then((report) => console.log(applicationCanonicalJson(report)))
    .catch(() => {
      console.error(applicationCanonicalJson({ status: "failed", reasonCode: "shadow-timing-failed" }));
      process.exitCode = 1;
    });
}
