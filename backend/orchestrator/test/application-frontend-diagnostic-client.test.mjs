import assert from "node:assert/strict";
import test from "node:test";

import { createApplicationCapabilityDescriptor } from "../src/application-capabilities.mjs";
import { ApplicationFrontendClient } from "../frontend-kit/source/client.mjs";
import { FakeApplicationBackend } from "../frontend-kit/source/fake-backend.mjs";
import {
  ApplicationFrontendDiagnosticClient,
} from "../frontend-kit/source/diagnostic-client.mjs";

const NOW = "2026-08-31T01:00:00.000Z";
const READ = "query.application-fixture.state";
const MUTATION = "mutation.application-fixture.action";

function fixture(state = "live") {
  const capabilities = createApplicationCapabilityDescriptor({
    sourceId: "application-frontend-fixture",
    sequence: 1,
    publishedAtUtc: "2026-08-31T00:59:59.000Z",
    validForSeconds: 3_600,
  });
  const backend = new FakeApplicationBackend({
    capabilities,
    state,
    now: () => new Date(NOW),
  });
  const client = new ApplicationFrontendClient({
    resolveDescriptor: backend.resolveDescriptor,
    fetchImpl: backend.fetch,
    expectedWorkspace: backend.workspace,
    now: () => new Date(NOW),
    idFactory: (prefix) => `${prefix}-00000000-0000-4000-8000-000000000001`,
  });
  return { backend, client };
}

test("diagnostic proves read workflow without invoking advertised operations", async () => {
  const { backend, client } = fixture();
  const diagnostic = new ApplicationFrontendDiagnosticClient({ client });
  const result = await diagnostic.inspect({
    operationIds: [READ, MUTATION],
    eventStreamId: "application-global",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.operations.length, 2);
  assert.ok(result.operations.every(({ status }) => status === "available"));
  assert.equal(result.events.mode, "snapshot-required");
  assert.deepEqual(
    backend.snapshot().calls.map(({ operationId }) => operationId),
    ["discovery.application.capabilities", "subscription.application-fixture.events"],
  );
  const serialized = JSON.stringify(result);
  assert.ok(Buffer.byteLength(serialized) < 64 * 1024);
  assert.doesNotMatch(serialized, /(?:bearerToken|cursor|input|prompt|history)/u);
});

test("diagnostic reports stale, unavailable and contradictory states fail closed", async () => {
  const cases = [
    ["stale", "connect", "descriptor_unavailable"],
    ["unavailable", "connect", "descriptor_unavailable"],
    ["contradictory", "capability-discovery", "response_identity_mismatch"],
  ];
  for (const [state, stage, code] of cases) {
    const { client } = fixture(state);
    const result = await new ApplicationFrontendDiagnosticClient({ client }).inspect();
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.problem, { stage, code });
  }
});

test("diagnostic degrades event failure without exposing thrown text", async () => {
  const { client } = fixture();
  const wrapped = {
    connect: client.connect.bind(client),
    discoverCapabilities: client.discoverCapabilities.bind(client),
    operationStatus: client.operationStatus.bind(client),
    readEvents: async () => {
      throw Object.assign(new Error("prompt at E:\\private\\history"), {
        code: "private_prompt",
      });
    },
  };
  const result = await new ApplicationFrontendDiagnosticClient({
    client: wrapped,
  }).inspect({ eventStreamId: "application-global" });
  assert.equal(result.status, "degraded");
  assert.deepEqual(result.problem, {
    stage: "event-read",
    code: "diagnostic_step_failed",
  });
  assert.doesNotMatch(JSON.stringify(result), /(?:prompt|private|history|[a-z]:\\)/iu);
});

test("diagnostic rejects unbounded or malformed operation requests", async () => {
  const { client } = fixture();
  const diagnostic = new ApplicationFrontendDiagnosticClient({ client });
  await assert.rejects(
    diagnostic.inspect({ operationIds: ["mutation"] }),
    (error) => error.code === "client_configuration_invalid",
  );
  await assert.rejects(
    diagnostic.inspect({ operationIds: Array.from({ length: 33 }, (_, i) => `query.fake.op-${i}`) }),
    (error) => error.code === "client_configuration_invalid",
  );
});
