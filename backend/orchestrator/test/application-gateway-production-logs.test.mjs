import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  measureApplicationGatewayProductionLogs,
  validateApplicationGatewayProductionLogReport,
} from "../scripts/measure-application-gateway-production-logs-a11.mjs";

const NOW = "2026-08-31T18:00:00.000Z";

function sizes(values) {
  let index = 0;
  return async () => values[index++];
}

test("A11.6 measures production streams without reading log content", async () => {
  let requests = 0;
  const report = await measureApplicationGatewayProductionLogs({
    repoRoot: path.resolve("controller-root"),
    recordedAtUtc: NOW,
    requestCount: 3,
    runtimeReader: async () => ({ instanceId: "gateway-one", descriptor: {} }),
    sizeReader: sizes([120, 0, 120, 0]),
    discovery: async () => { requests += 1; },
  });
  assert.equal(requests, 3);
  assert.deepEqual(report.standardOutput, {
    beforeBytes: 120, afterBytes: 120, growthBytes: 0,
  });
  assert.deepEqual(report.standardError, {
    beforeBytes: 0, afterBytes: 0, growthBytes: 0,
  });
  assert.deepEqual(report.safety, {
    providerTurnInvoked: false,
    mutationInvoked: false,
    logContentRead: false,
    exactInstancePreserved: true,
  });
  assert.equal(validateApplicationGatewayProductionLogReport(report), report);
  assert.doesNotMatch(
    JSON.stringify(report),
    /(?:gateway-one|controller-root|credential|prompt|history|bearer)/iu,
  );
});

test("A11.6 production log report is tamper-evident", async () => {
  const report = await measureApplicationGatewayProductionLogs({
    repoRoot: path.resolve("controller-root"),
    recordedAtUtc: NOW,
    requestCount: 1,
    runtimeReader: async () => ({ instanceId: "gateway-one", descriptor: {} }),
    sizeReader: sizes([10, 0, 14, 0]),
    discovery: async () => {},
  });
  const changed = structuredClone(report);
  changed.standardOutput.growthBytes = 3;
  assert.throws(
    () => validateApplicationGatewayProductionLogReport(changed),
    /invalid_production_log_report/u,
  );
});

test("A11.6 stops when the exact gateway instance changes", async () => {
  let reads = 0;
  await assert.rejects(
    measureApplicationGatewayProductionLogs({
      repoRoot: path.resolve("controller-root"),
      recordedAtUtc: NOW,
      requestCount: 1,
      runtimeReader: async () => ({
        instanceId: reads++ === 0 ? "gateway-one" : "gateway-two",
        descriptor: {},
      }),
      sizeReader: sizes([10, 0, 10, 0]),
      discovery: async () => {},
    }),
    /production_gateway_identity_changed/u,
  );
});
