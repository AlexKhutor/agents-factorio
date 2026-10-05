import assert from "node:assert/strict";
import test from "node:test";

import {
  measureApplicationShadowResources,
  validateApplicationShadowResourceReport,
} from "../scripts/measure-application-shadow-resources-a11.mjs";

test("A11.6 measures bounded process, memory, active CPU and idle CPU evidence", async () => {
  const report = await measureApplicationShadowResources({
    requestCount: 3,
    idleDurationMs: 20,
  });
  const { processes, memory, active, idle, logGrowth } = report.candidate;

  assert.deepEqual(processes, {
    status: "measured",
    hostingMode: "in-process-listener",
    hostProcessCount: 1,
    additionalProcessCount: 0,
    reasonCode: "in-process-listener",
  });
  assert.ok(memory.rssBeforeStartBytes > 0);
  assert.ok(memory.rssAtReadyBytes > 0);
  assert.ok(memory.rssAfterActiveBytes > 0);
  assert.ok(memory.rssAfterIdleBytes > 0);
  assert.equal(active.requestCount, 3);
  assert.ok(active.wallDurationMs >= 0);
  assert.ok(active.userCpuMicroseconds + active.systemCpuMicroseconds >= 0);
  assert.equal(idle.requestedDurationMs, 20);
  assert.ok(idle.wallDurationMs >= idle.requestedDurationMs - 2);
  assert.equal(logGrowth.status, "unavailable");
  assert.equal(logGrowth.value, null);
  assert.equal(report.safety.providerInvoked, false);
  assert.equal(report.safety.productionGatewayInvoked, false);
  assert.equal(validateApplicationShadowResourceReport(report), report);
});

test("A11.6 resource report is private, closed and tamper-evident", async () => {
  const report = await measureApplicationShadowResources({
    requestCount: 1,
    idleDurationMs: 20,
  });
  assert.doesNotMatch(
    JSON.stringify(report),
    /(?:bearer|credential|prompt|history|sqlite|endpoint|authorization|\\|[a-z]:\/)/iu,
  );

  const changed = structuredClone(report);
  changed.candidate.memory.rssAtReadyBytes += 1;
  assert.throws(
    () => validateApplicationShadowResourceReport(changed),
    /invalid_shadow_resource_report/,
  );
  const widened = structuredClone(report);
  widened.candidate.processes.processId = 123;
  assert.throws(
    () => validateApplicationShadowResourceReport(widened),
    /invalid_shadow_resource_report/,
  );
});

test("A11.6 rejects unbounded sample parameters", async () => {
  await assert.rejects(
    measureApplicationShadowResources({ requestCount: 101 }),
    /invalid_shadow_resource_sample/,
  );
  await assert.rejects(
    measureApplicationShadowResources({ idleDurationMs: 5 }),
    /invalid_shadow_resource_sample/,
  );
});
