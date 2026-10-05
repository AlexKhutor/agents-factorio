import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { buildApplicationFrontendKit } from "../scripts/build-application-frontend-kit.mjs";

const NOW = "2026-08-31T02:30:00.000Z";
const OPERATIONS = Object.freeze([
  ["read", "query.application-fixture.state"],
  ["propose", "proposal.application-fixture.change"],
  ["approve", "approval.application-fixture.interaction"],
  ["mutate", "mutation.application-fixture.action"],
  ["receipt", "receipt.application-fixture.lookup"],
  ["review", "query.application-fixture.review"],
]);

async function importFrom(root, relativePath) {
  return import(pathToFileURL(path.join(root, ...relativePath.split("/"))).href);
}

test("A10 portable kit exercises every fake-advertised workflow without private source", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "application-frontend-consumer-"));
  const built = await buildApplicationFrontendKit({ output: path.join(temporary, "package") });
  const clientApi = await importFrom(built.output, "client/index.mjs");
  const testing = await importFrom(built.output, "testing/index.mjs");
  const diagnostics = await importFrom(built.output, "diagnostics/index.mjs");
  const compatibility = await importFrom(built.output, "compatibility/index.mjs");

  const backend = testing.createFakeApplicationBackend({
    state: "live",
    now: () => new Date(NOW),
  });
  const client = new clientApi.ApplicationFrontendClient({
    resolveDescriptor: backend.resolveDescriptor,
    fetchImpl: backend.fetch,
    expectedWorkspace: backend.workspace,
    now: () => new Date(NOW),
    idFactory: (prefix) => `${prefix}-00000000-0000-4000-8000-000000000001`,
  });

  const capabilities = await client.discoverCapabilities();
  assert.equal(capabilities.outcome, "succeeded");
  for (const [method, operationId] of OPERATIONS) {
    const status = await client.operationStatus(operationId);
    assert.equal(status.status, "available", operationId);
    const result = await client[method](operationId, { fixture: method });
    assert.equal(result.outcome, "succeeded", operationId);
  }
  const events = await client.readEvents({
    streamId: "application-global",
    cursor: null,
  });
  assert.equal(events.mode, "snapshot-required");

  const conformance = await testing.runApplicationFrontendConformance();
  assert.deepEqual(
    {
      status: conformance.status,
      passedCount: conformance.passedCount,
      failedCount: conformance.failedCount,
    },
    { status: "passed", passedCount: 10, failedCount: 0 },
  );
  const diagnostic = await new diagnostics.ApplicationFrontendDiagnosticClient({ client }).inspect({
    operationIds: OPERATIONS.map(([, operationId]) => operationId),
    eventStreamId: "application-global",
  });
  assert.equal(diagnostic.status, "ready");
  assert.ok(diagnostic.operations.every(({ status }) => status === "available"));

  const policy = compatibility.APPLICATION_FRONTEND_COMPATIBILITY_POLICY;
  const current = policy.pairs.find(({ status }) => status === "current");
  const assessment = compatibility.assessApplicationFrontendCompatibility(policy, {
    ...Object.fromEntries(Object.entries(current).filter(
      ([field]) => !["status", "supportedUntilUtc"].includes(field),
    )),
    observedAtUtc: NOW,
  });
  assert.deepEqual(
    { compatible: assessment.compatible, status: assessment.status },
    { compatible: true, status: "current" },
  );
  assert.doesNotMatch(
    JSON.stringify({ conformance, diagnostic, assessment }),
    /(?:bearer|credential|prompt|history|sqlite|[a-z]:\\\\|\/home\/)/iu,
  );
});
