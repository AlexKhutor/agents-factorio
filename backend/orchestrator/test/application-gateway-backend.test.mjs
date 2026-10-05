import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_GATEWAY_BACKEND_VERSION,
  createApplicationGatewayBackend,
} from "../src/application-gateway-backend.mjs";
import { ApplicationContractError } from "../src/application-contract.mjs";

const NOW = "2026-08-31T05:00:00.000Z";

function request(operationId, family = operationId.split(".", 1)[0], input = {}) {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    requestId: `request-${operationId.replaceAll(".", "-")}`,
    correlationId: "application-gateway-backend-test",
    operation: {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      family,
      operationId,
    },
    requestedAtUtc: NOW,
    input,
  };
}

function backend(operationHandlers = {}) {
  return createApplicationGatewayBackend({
    sourceId: "orchestrator-development",
    sequence: 1,
    publishedAtUtc: NOW,
    epoch: "application-gateway-backend-test",
    now: () => new Date(NOW),
    operationHandlers,
  });
}

test("gateway backend dispatches one exact advertised operation", async () => {
  let received = null;
  const value = backend({
    "query.work-projection.overview": async (candidate) => {
      received = candidate;
      return { projectionId: "work-projection-one", sequence: 7 };
    },
  });
  const input = { include: "summary" };
  const result = await value.invokeApplication(request(
    "query.work-projection.overview", "query", input,
  ));

  assert.equal(APPLICATION_GATEWAY_BACKEND_VERSION, "v0.2.3");
  assert.deepEqual(value.exposedOperations.map(({ operationId }) => operationId), [
    "discovery.application.capabilities",
    "query.work-projection.overview",
  ]);
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(result.output, { projectionId: "work-projection-one", sequence: 7 });
  assert.deepEqual(received.input, input);
  assert.notStrictEqual(received.input, input);
});

test("gateway backend rejects unknown or discovery handler registration", () => {
  assert.throws(
    () => backend({ "query.unknown.read": async () => ({}) }),
    /unsupported operation/u,
  );
  assert.throws(
    () => backend({ "discovery.application.capabilities": async () => ({}) }),
    /unsupported operation/u,
  );
});

test("project file save is a mutation and cannot be dispatched as a query", async () => {
  const operationId = "mutation.project-workspace.save";
  const value = backend({ [operationId]: async () => ({ operationId, bytesWritten: 3 }) });
  assert.equal(value.exposedOperations.find((entry) => entry.operationId === operationId)?.family,
    "mutation");
  await assert.rejects(value.invokeApplication(request(operationId, "query")),
    { code: "operation_family_mismatch" });
  assert.equal((await value.invokeApplication(request(operationId, "mutation"))).outcome, "succeeded");
});

test("atomic project copy is exposed only as a mutation", async () => {
  const operationId = "mutation.memory.project.copy";
  const value = backend({ [operationId]: async () => ({ outcome: "complete" }) });
  assert.equal(value.exposedOperations.find((entry) => entry.operationId === operationId)?.family,
    "mutation");
  await assert.rejects(value.invokeApplication(request(operationId, "query")),
    { code: "operation_family_mismatch" });
  assert.equal((await value.invokeApplication(request(operationId, "mutation"))).outcome, "succeeded");
});

test("missing operations retain bounded unsupported semantics", async () => {
  const result = await backend().invokeApplication(request(
    "query.work-projection.overview", "query",
  ));
  assert.equal(result.outcome, "failed");
  assert.deepEqual(result.error, {
    code: "unsupported_capability",
    message: "Operation is not exposed by the current gateway runtime",
    retryable: false,
    phase: "precondition",
  });
});

test("handler failures collapse to fixed application errors", async () => {
  const value = backend({
    "query.work-projection.overview": async () => {
      throw new Error("private prompt at E:\\private\\rollout.jsonl");
    },
  });
  const result = await value.invokeApplication(request(
    "query.work-projection.overview", "query",
  ));
  assert.equal(result.outcome, "failed");
  assert.equal(result.error.code, "source_unavailable");
  assert.equal(result.error.message, "Operation source is unavailable");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("private"), false);
  assert.equal(serialized.includes("rollout"), false);
});

test("workspace list publishes only an allowlisted reason without private details", async () => {
  const operationId = "query.project-workspace.list";
  const invoke = async (reasonCode, message = "private E:\\secret\\folder") => {
    const value = backend({ [operationId]: async () => {
      throw new ApplicationContractError("source_unavailable", message, { reasonCode });
    } });
    return value.invokeApplication(request(operationId, "query", { projectId: "project-a" }));
  };
  const safe = await invoke("workspace_not_bound");
  assert.equal(safe.outcome, "failed");
  assert.equal(safe.error.code, "source_unavailable");
  assert.equal(safe.error.reasonCode, "workspace_not_bound");
  assert.doesNotMatch(JSON.stringify(safe), /secret|folder/u);
  const unsafe = await invoke("private_absolute_path");
  assert.equal(unsafe.error.code, "source_unavailable");
  assert.equal(unsafe.error.reasonCode, undefined);
});

test("the capability descriptor stays current for as long as the Gateway runs", async () => {
  // A client accepts a descriptor only until publishedAtUtc + validForSeconds;
  // a Gateway that ran past that refused every operation (unsupported_capability).
  let clock = Date.parse(NOW);
  const value = createApplicationGatewayBackend({
    sourceId: "orchestrator-development",
    sequence: 1,
    publishedAtUtc: NOW,
    validForSeconds: 3600,
    epoch: "application-gateway-backend-test",
    now: () => new Date(clock),
  });
  const discover = async () => {
    const result = await value.invokeApplication(request("discovery.application.capabilities", "discovery"));
    assert.equal(result.outcome, "succeeded");
    return result.output.capabilities;
  };
  const withoutTime = ({ publishedAtUtc, ...rest }) => rest;
  const minutes = (count) => Date.parse(NOW) + count * 60_000;

  const first = await discover();
  assert.equal(first.publishedAtUtc, NOW);
  clock = minutes(10);
  assert.equal((await discover()).publishedAtUtc, NOW, "republished only after half of its validity");
  clock = minutes(40);
  const second = await discover();
  assert.equal(second.publishedAtUtc, new Date(minutes(40)).toISOString());
  assert.deepEqual(withoutTime(second), withoutTime(first), "the content does not change");
  clock = minutes(75);
  const third = await discover();
  assert.ok(minutes(75) < Date.parse(third.publishedAtUtc) + third.validForSeconds * 1000,
    "still current more than an hour after the Gateway started");
  assert.equal(value.capabilities.publishedAtUtc, NOW);
});
