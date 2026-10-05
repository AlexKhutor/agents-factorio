import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
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

export const APPLICATION_SHADOW_RESOURCE_VERSION = "v0.1.0";

const scriptPath = fileURLToPath(import.meta.url);

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !fields.includes(field))
      || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new Error("invalid_shadow_resource_report");
  }
}

export async function measureApplicationShadowResources({
  recordedAtUtc = new Date().toISOString(),
  requestCount = 20,
  idleDurationMs = 100,
  clock = () => performance.now(),
} = {}) {
  if (!Number.isInteger(requestCount) || requestCount < 1 || requestCount > 100
      || !Number.isInteger(idleDurationMs) || idleDurationMs < 20 || idleDurationMs > 1000) {
    throw new RangeError("invalid_shadow_resource_sample");
  }
  const rssBeforeStartBytes = process.memoryUsage().rss;
  return withApplicationShadowGateway({
    recordedAtUtc,
    tempPrefix: "application-shadow-resources-",
    instanceId: "11111111-1111-4111-8111-111111111116",
    epoch: "a11-shadow-resource-epoch",
  }, async ({ descriptor }) => {
    const rssAtReadyBytes = process.memoryUsage().rss;
    const activeCpuStart = process.cpuUsage();
    const activeWallStart = clock();
    for (let index = 0; index < requestCount; index += 1) {
      await postApplicationShadowDiscovery({
        descriptor,
        requestedAtUtc: recordedAtUtc,
        requestId: `a11-resource-discovery-${index + 1}`,
        correlationId: "a11-shadow-resources",
      });
    }
    const activeWallDurationMs = rounded(clock() - activeWallStart);
    const activeCpu = process.cpuUsage(activeCpuStart);
    const rssAfterActiveBytes = process.memoryUsage().rss;

    const idleCpuStart = process.cpuUsage();
    const idleWallStart = clock();
    await delay(idleDurationMs);
    const idleWallDurationMs = rounded(clock() - idleWallStart);
    const idleCpu = process.cpuUsage(idleCpuStart);
    const rssAfterIdleBytes = process.memoryUsage().rss;

    const body = {
      schemaVersion: 1,
      contractVersion: APPLICATION_SHADOW_RESOURCE_VERSION,
      runId: "a11-shadow-resources-local",
      recordedAtUtc,
      environment: {
        runtime: `node-${process.version}`,
        platform: process.platform,
        architecture: process.arch,
      },
      candidate: {
        sourceId: "candidate-application-gateway",
        evidenceMode: "measured-local",
        processes: {
          status: "measured",
          hostingMode: "in-process-listener",
          hostProcessCount: 1,
          additionalProcessCount: 0,
          reasonCode: "in-process-listener",
        },
        memory: {
          status: "measured",
          unit: "bytes",
          rssBeforeStartBytes,
          rssAtReadyBytes,
          rssAfterActiveBytes,
          rssAfterIdleBytes,
          reasonCode: "node-process-rss",
        },
        active: {
          status: "measured",
          requestCount,
          wallDurationMs: activeWallDurationMs,
          userCpuMicroseconds: activeCpu.user,
          systemCpuMicroseconds: activeCpu.system,
          reasonCode: "authenticated-discovery-batch",
        },
        idle: {
          status: "measured",
          requestedDurationMs: idleDurationMs,
          wallDurationMs: idleWallDurationMs,
          userCpuMicroseconds: idleCpu.user,
          systemCpuMicroseconds: idleCpu.system,
          reasonCode: "ready-listener-idle-sample",
        },
        logGrowth: {
          status: "unavailable",
          unit: "bytes",
          value: null,
          reasonCode: "production-log-path-not-exercised",
        },
      },
      safety: {
        modelFree: true,
        providerInvoked: false,
        mutationInvoked: false,
        productionGatewayInvoked: false,
        visibleMonitorRequired: false,
        reasonCode: "bounded-foreground-measurement",
      },
    };
    const report = Object.freeze({
      ...body,
      reportId: `application-shadow-resources-${applicationCanonicalSha256(body)}`,
    });
    validateApplicationShadowResourceReport(report);
    return report;
  });
}

export function validateApplicationShadowResourceReport(value) {
  const fail = () => { throw new Error("invalid_shadow_resource_report"); };
  const integer = (item) => Number.isSafeInteger(item) && item >= 0;
  const duration = (item) => Number.isFinite(item) && item >= 0;
  const reason = (item) => /^[a-z][a-z0-9-]{1,95}$/u.test(item);

  exact(value, [
    "schemaVersion", "contractVersion", "runId", "recordedAtUtc", "environment",
    "candidate", "safety", "reportId",
  ]);
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_SHADOW_RESOURCE_VERSION
      || value.runId !== "a11-shadow-resources-local"
      || typeof value.recordedAtUtc !== "string" || !value.recordedAtUtc.endsWith("Z")
      || !Number.isFinite(Date.parse(value.recordedAtUtc))) fail();

  exact(value.environment, ["runtime", "platform", "architecture"]);
  if (!/^node-v[0-9.]+$/u.test(value.environment.runtime)
      || !/^[a-z0-9-]{2,32}$/u.test(value.environment.platform)
      || !/^[a-z0-9-]{2,32}$/u.test(value.environment.architecture)) fail();

  exact(value.candidate, [
    "sourceId", "evidenceMode", "processes", "memory", "active", "idle", "logGrowth",
  ]);
  if (value.candidate.sourceId !== "candidate-application-gateway"
      || value.candidate.evidenceMode !== "measured-local") fail();

  const { processes, memory, active, idle, logGrowth } = value.candidate;
  exact(processes, [
    "status", "hostingMode", "hostProcessCount", "additionalProcessCount", "reasonCode",
  ]);
  if (processes.status !== "measured" || processes.hostingMode !== "in-process-listener"
      || processes.hostProcessCount !== 1 || processes.additionalProcessCount !== 0
      || !reason(processes.reasonCode)) fail();

  exact(memory, [
    "status", "unit", "rssBeforeStartBytes", "rssAtReadyBytes", "rssAfterActiveBytes",
    "rssAfterIdleBytes", "reasonCode",
  ]);
  if (memory.status !== "measured" || memory.unit !== "bytes"
      || ![
        memory.rssBeforeStartBytes, memory.rssAtReadyBytes,
        memory.rssAfterActiveBytes, memory.rssAfterIdleBytes,
      ].every(integer) || !reason(memory.reasonCode)) fail();

  exact(active, [
    "status", "requestCount", "wallDurationMs", "userCpuMicroseconds",
    "systemCpuMicroseconds", "reasonCode",
  ]);
  if (active.status !== "measured" || !integer(active.requestCount)
      || active.requestCount < 1 || active.requestCount > 100
      || !duration(active.wallDurationMs) || !integer(active.userCpuMicroseconds)
      || !integer(active.systemCpuMicroseconds) || !reason(active.reasonCode)) fail();

  exact(idle, [
    "status", "requestedDurationMs", "wallDurationMs", "userCpuMicroseconds",
    "systemCpuMicroseconds", "reasonCode",
  ]);
  if (idle.status !== "measured" || !integer(idle.requestedDurationMs)
      || idle.requestedDurationMs < 20 || idle.requestedDurationMs > 1000
      || !duration(idle.wallDurationMs) || !integer(idle.userCpuMicroseconds)
      || !integer(idle.systemCpuMicroseconds) || !reason(idle.reasonCode)) fail();

  exact(logGrowth, ["status", "unit", "value", "reasonCode"]);
  if (logGrowth.status !== "unavailable" || logGrowth.unit !== "bytes"
      || logGrowth.value !== null || !reason(logGrowth.reasonCode)) fail();

  exact(value.safety, [
    "modelFree", "providerInvoked", "mutationInvoked", "productionGatewayInvoked",
    "visibleMonitorRequired", "reasonCode",
  ]);
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "reportId"));
  if (value.reportId !== `application-shadow-resources-${applicationCanonicalSha256(body)}`
      || value.safety.modelFree !== true || value.safety.providerInvoked !== false
      || value.safety.mutationInvoked !== false
      || value.safety.productionGatewayInvoked !== false
      || value.safety.visibleMonitorRequired !== false
      || !reason(value.safety.reasonCode)) fail();
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  measureApplicationShadowResources()
    .then((report) => console.log(applicationCanonicalJson(report)))
    .catch(() => {
      console.error(applicationCanonicalJson({
        status: "failed",
        reasonCode: "shadow-resource-measurement-failed",
      }));
      process.exitCode = 1;
    });
}
