import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_SHADOW_TIMING_METRICS,
  measureApplicationShadowTiming,
  validateApplicationShadowTimingReport,
} from "../scripts/measure-application-shadow-a11.mjs";

function clock(values) {
  let index = 0;
  return () => values[index++];
}

test("A11.5 measures loopback startup, first data and controlled recovery", async () => {
  const report = await measureApplicationShadowTiming({
    clock: clock([0, 5, 10, 12, 20, 22, 25, 30]),
  });
  const managed = report.sources.find(({ sourceId }) => sourceId === "current-managed-vscode");
  const candidate = report.sources.find(
    ({ sourceId }) => sourceId === "candidate-application-gateway",
  );
  assert.deepEqual(candidate.metrics.slice(0, 2).map(
    ({ metricId, status, durationMs }) => ({ metricId, status, durationMs }),
  ), [
    { metricId: "startup-to-ready", status: "measured", durationMs: 5 },
    { metricId: "ready-to-first-useful-data", status: "measured", durationMs: 2 },
  ]);
  assert.ok(candidate.metrics.slice(2, -1).every(
    ({ status, durationMs }) => status === "unavailable" && durationMs === null,
  ));
  assert.deepEqual(candidate.metrics.at(-1), {
    metricId: "recovery-time",
    status: "measured",
    durationMs: 10,
    reasonCode: "controlled-stop-restart-discovery",
    evidenceId: "candidate-a11-local-recovery",
  });
  assert.deepEqual(
    candidate.metrics.map(({ metricId }) => metricId),
    [...APPLICATION_SHADOW_TIMING_METRICS],
  );
  assert.equal(managed.metrics.find(
    ({ metricId }) => metricId === "startup-to-ready",
  ).status, "historical");
  assert.equal(report.safety.providerInvoked, false);
  assert.equal(report.safety.mutationInvoked, false);
});

test("A11.5 timing report is bounded and tamper-evident", async () => {
  const report = await measureApplicationShadowTiming({
    clock: clock([0, 1, 2, 3, 4, 5, 6, 7]),
  });
  assert.equal(validateApplicationShadowTimingReport(report), report);
  assert.doesNotMatch(
    JSON.stringify(report),
    /(?:bearer|credential|prompt|history|sqlite|\\\\|[a-z]:\/)/iu,
  );
  const changed = structuredClone(report);
  changed.sources[1].metrics[0].durationMs = 999;
  assert.throws(
    () => validateApplicationShadowTimingReport(changed),
    /invalid_shadow_timing_report/,
  );
});
