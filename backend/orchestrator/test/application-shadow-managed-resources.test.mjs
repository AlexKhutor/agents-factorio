import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  measureApplicationShadowManagedResources,
  validateApplicationShadowManagedResourceReport,
} from "../scripts/measure-application-shadow-managed-resources-a11.mjs";
import {
  measureApplicationShadowResources,
} from "../scripts/measure-application-shadow-resources-a11.mjs";

const RECORDED_AT = "2026-09-01T13:05:00.000Z";
const CREATED_AT = "2026-09-01T10:00:00.000Z";

function managedSample({ sampledAtUtc, processId = 40123, workingSetBytes, user, system }) {
  return {
    launcherStatus: "success",
    launcherFinishedAtUtc: "2026-09-01T10:00:10.000Z",
    recordedProcesses: [{ processId, createdAtUtc: CREATED_AT }],
    processes: [{
      processId,
      createdAtUtc: CREATED_AT,
      workingSetBytes,
      userCpuMicroseconds: user,
      systemCpuMicroseconds: system,
    }],
    sampledAtUtc,
  };
}

function sequence(values) {
  let index = 0;
  return () => structuredClone(values[index++]);
}

async function candidate(recordedAtUtc) {
  return measureApplicationShadowResources({
    recordedAtUtc,
    requestCount: 1,
    idleDurationMs: 20,
  });
}

test("A11.6 records launcher-bound managed and overlapping candidate resources", async () => {
  const managedSampler = sequence([
    managedSample({
      sampledAtUtc: "2026-09-01T13:05:00.000Z",
      workingSetBytes: 2_000, user: 100, system: 50,
    }),
    managedSample({
      sampledAtUtc: "2026-09-01T13:05:00.050Z",
      workingSetBytes: 2_100, user: 140, system: 55,
    }),
  ]);
  const candidateProcessSampler = sequence([
    { workingSetBytes: 1_000, userCpuMicroseconds: 200, systemCpuMicroseconds: 80 },
    { workingSetBytes: 1_100, userCpuMicroseconds: 220, systemCpuMicroseconds: 90 },
  ]);
  const clock = sequence([10, 17]);
  const report = await measureApplicationShadowManagedResources({
    workspaceRoot: path.resolve("managed-resource-workspace"),
    recordedAtUtc: RECORDED_AT,
    managedSampler,
    candidateSampler: ({ recordedAtUtc }) => candidate(recordedAtUtc),
    candidateProcessSampler,
    clock,
  });

  assert.equal(report.status, "passed");
  assert.deepEqual({
    processCount: report.managed.processCount,
    workingSetBeforeBytes: report.managed.workingSetBeforeBytes,
    workingSetAfterBytes: report.managed.workingSetAfterBytes,
    userCpuDeltaMicroseconds: report.managed.userCpuDeltaMicroseconds,
    systemCpuDeltaMicroseconds: report.managed.systemCpuDeltaMicroseconds,
    observationWindowMs: report.managed.observationWindowMs,
  }, {
    processCount: 1,
    workingSetBeforeBytes: 2_000,
    workingSetAfterBytes: 2_100,
    userCpuDeltaMicroseconds: 40,
    systemCpuDeltaMicroseconds: 5,
    observationWindowMs: 50,
  });
  assert.equal(report.candidate.processCount, 1);
  assert.equal(report.candidate.userCpuDeltaMicroseconds, 20);
  assert.equal(report.candidate.systemCpuDeltaMicroseconds, 10);
  assert.equal(report.candidate.observationWindowMs, 7);
  assert.equal(report.comparison.performanceWinnerSelected, false);
  assert.equal(report.safety.commandLinePersisted, false);
  assert.equal(report.safety.rawProcessIdentityPersisted, false);
  assert.equal(Object.hasOwn(report.managed, "processId"), false);
  assert.equal(validateApplicationShadowManagedResourceReport(report), report);
  assert.doesNotMatch(
    JSON.stringify(report),
    /(?:40123|Code\.exe|vscode-user-data|[a-z]:[\\/])/iu,
  );

  const changed = structuredClone(report);
  changed.managed.processCount = 2;
  assert.throws(
    () => validateApplicationShadowManagedResourceReport(changed),
    /invalid_managed_resource_report/u,
  );
});

test("A11.6 rejects a process set that is not bound to the launcher report", async () => {
  let candidateInvoked = false;
  const sample = managedSample({
    sampledAtUtc: RECORDED_AT,
    workingSetBytes: 2_000, user: 100, system: 50,
  });
  sample.processes[0].processId = 40124;
  await assert.rejects(
    measureApplicationShadowManagedResources({
      workspaceRoot: path.resolve("managed-resource-workspace"),
      recordedAtUtc: RECORDED_AT,
      managedSampler: async () => sample,
      candidateSampler: async () => { candidateInvoked = true; },
    }),
    /invalid_managed_resource_report/u,
  );
  assert.equal(candidateInvoked, false);
});
