import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  createApplicationCapabilityDescriptor,
  validateApplicationCapabilityDescriptor,
} from "../src/application-capabilities.mjs";
import { validateApplicationGatewayDescriptor } from "../src/application-gateway-descriptor.mjs";
import {
  ApplicationFrontendClient,
  ApplicationFrontendClientError,
} from "../frontend-kit/source/client.mjs";
import {
  FAKE_APPLICATION_OPERATIONS,
  FAKE_APPLICATION_STATES,
  FakeApplicationBackend,
} from "../frontend-kit/source/fake-backend.mjs";

const NOW = "2026-08-31T01:00:00.000Z";
const READ_OPERATION = "query.application-fixture.state";

function baseCapabilities() {
  return createApplicationCapabilityDescriptor({
    sourceId: "application-frontend-fixture",
    sequence: 1,
    publishedAtUtc: "2026-08-31T00:59:59.000Z",
    validForSeconds: 3_600,
  });
}

function fixture(state, { delayMs = 50 } = {}) {
  const backend = new FakeApplicationBackend({
    capabilities: baseCapabilities(),
    state,
    delayMs,
    now: () => new Date(NOW),
  });
  const client = new ApplicationFrontendClient({
    resolveDescriptor: backend.resolveDescriptor,
    fetchImpl: backend.fetch,
    now: () => new Date(NOW),
    idFactory: (prefix) => `${prefix}-00000000-0000-4000-8000-000000000001`,
    expectedWorkspace: backend.workspace,
  });
  return { backend, client };
}

function clientError(code, reasonCode = null) {
  return (error) => {
    assert.ok(error instanceof ApplicationFrontendClientError);
    assert.equal(error.code, code);
    if (reasonCode !== null) assert.equal(error.details.reasonCode, reasonCode);
    return true;
  };
}

test("fake backend advertises canonical fixture capabilities", async () => {
  const { backend } = fixture("live");
  const capabilities = backend.capabilities;
  assert.strictEqual(validateApplicationCapabilityDescriptor(capabilities), capabilities);
  assert.deepEqual(FAKE_APPLICATION_STATES, [
    "live", "delayed", "stale", "unavailable", "contradictory", "blocked",
    "approval-required", "uncertain", "recovered",
  ]);
  assert.equal(
    FAKE_APPLICATION_OPERATIONS[READ_OPERATION].family,
    "query",
  );
  const resolved = await backend.resolveDescriptor();
  assert.equal(validateApplicationGatewayDescriptor(resolved.descriptor).workspace.projectId,
    "application-frontend-fixture");
});

test("live, delayed and recovered fixtures use the real frontend client", async () => {
  const live = fixture("live");
  const liveResult = await live.client.read(READ_OPERATION);
  assert.equal(liveResult.outcome, "succeeded");
  assert.equal(liveResult.output.state, "live");

  const delayed = fixture("delayed", { delayMs: 60 });
  const started = performance.now();
  const delayedResult = await delayed.client.read(READ_OPERATION);
  assert.ok(performance.now() - started >= 100);
  assert.equal(delayedResult.output.state, "delayed");

  const recovered = fixture("unavailable");
  await assert.rejects(
    recovered.client.connect(),
    clientError("descriptor_unavailable", "fixture_unavailable"),
  );
  recovered.backend.setState("recovered");
  recovered.client.disconnect();
  const recoveredResult = await recovered.client.read(READ_OPERATION);
  assert.equal(recoveredResult.output.recovered, true);
});

test("stale and contradictory fixtures fail at exact client boundaries", async () => {
  const stale = fixture("stale");
  await assert.rejects(stale.client.connect(), clientError("descriptor_unavailable"));
  assert.equal(stale.backend.snapshot().requestCount, 0);

  const contradictory = fixture("contradictory");
  await assert.rejects(
    contradictory.client.discoverCapabilities(),
    clientError("response_identity_mismatch"),
  );
  assert.equal(contradictory.backend.snapshot().requestCount, 1);
});

test("blocked, approval-required and uncertain outcomes are not retried", async () => {
  const cases = [
    ["blocked", "failed", "access_denied"],
    ["approval-required", "failed", "continuation_required"],
    ["uncertain", "uncertain", "uncertain_outcome"],
  ];
  for (const [state, outcome, code] of cases) {
    const { backend, client } = fixture(state);
    const result = await client.read(READ_OPERATION);
    assert.equal(result.outcome, outcome);
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryable, false);
    assert.equal(backend.snapshot().requestCount, 2);
  }
});

test("event fixture supports bounded snapshot and resume without payload logging", async () => {
  const { backend, client } = fixture("live");
  const snapshot = await client.readEvents({ streamId: "application-global" });
  assert.equal(snapshot.mode, "snapshot-required");
  const resumed = await client.readEvents({
    streamId: "application-global",
    cursor: snapshot.cursor,
  });
  assert.equal(resumed.mode, "resumed");
  assert.equal(resumed.cursor, snapshot.cursor);
  const calls = backend.snapshot().calls;
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => !Object.hasOwn(call, "input")));
});
