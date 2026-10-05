import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";

const FIXTURE = fileURLToPath(new URL(
  "./fixtures/fake-server-request-app-server.mjs", import.meta.url,
));

async function openClient(options = {}) {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [FIXTURE],
    requestTimeoutMs: 1_000,
    ...options,
  });
  await client.connect();
  return client;
}

async function waitFor(read, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fixture state");
}

function responses(client) {
  return client.rpc.request("test/responses", {}).then((value) => value.responses);
}

test("server request registry keeps typed identity and bounded metadata", async (t) => {
  const client = await openClient();
  t.after(() => client.close());
  const seen = [];
  client.registerServerRequestHandler("approval/test", async (params, context) => {
    seen.push({ params, context });
    return { decision: "deny" };
  });

  await client.rpc.request("test/emit", {
    requestId: "1",
    requestMethod: "approval/test",
    requestParams: { secret: "hidden" },
    resolveAfterMs: 20,
  });
  await client.rpc.request("test/emit", {
    requestId: 1, requestMethod: "approval/test", requestParams: { secret: "hidden" },
  });
  const wire = await waitFor(
    () => responses(client),
    (items) => items.filter((item) => item.result?.decision === "deny").length === 2,
  );

  assert.deepEqual(wire.map((item) => item.id), ["1", 1]);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].context.requestId, "1");
  assert.equal(seen[1].context.requestId, 1);
  const records = await waitFor(
    () => Promise.resolve(client.listServerRequestRecords()),
    (items) => items.find((record) => record.requestId === "1")?.providerResolvedAtUtc,
  );
  assert.deepEqual(records.map((record) => record.requestId), ["1", 1]);
  assert.ok(records.every((record) => record.resolution === "responded"));
  assert.match(records[0].providerResolvedAtUtc, /Z$/u);
  assert.equal(JSON.stringify(records).includes("hidden"), false);
});

test("duplicate active request gets one terminal error and no late response", async (t) => {
  const client = await openClient();
  t.after(() => client.close());
  let invocations = 0;
  client.registerServerRequestHandler("approval/test", async () => {
    invocations += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { late: true };
  });

  await client.rpc.request("test/emit", {
    requestId: "duplicate", requestMethod: "approval/test", duplicate: true,
  });
  const wire = await waitFor(() => responses(client), (items) => items.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(invocations, 1);
  assert.equal(wire[0].error.code, -32002);
  assert.equal((await responses(client)).length, 1);
  assert.equal(client.listServerRequestRecords()[0].resolution, "duplicate");
});

test("approval deadline aborts the handler and suppresses its late value", async (t) => {
  const client = await openClient({ serverRequestTimeoutMs: 40 });
  t.after(() => client.close());
  let aborted = false;
  client.registerServerRequestHandler("approval/test", async (_params, context) => (
    new Promise((resolve) => context.signal.addEventListener("abort", () => {
      aborted = true;
      resolve({ late: true });
    }, { once: true }))
  ));

  await client.rpc.request("test/emit", {
    requestId: "expires", requestMethod: "approval/test",
  });
  const wire = await waitFor(() => responses(client), (items) => items.length === 1);

  assert.equal(wire[0].error.code, -32001);
  assert.equal(aborted, true);
  assert.equal(client.listServerRequestRecords()[0].resolution, "expired");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await responses(client)).length, 1);
});

test("provider resolved notification invalidates once without a client response", async (t) => {
  const client = await openClient({ serverRequestTimeoutMs: 500 });
  t.after(() => client.close());
  const rejected = [];
  client.on("serverRequestRejected", (record) => rejected.push(record));
  client.registerServerRequestHandler("approval/test", async (_params, context) => (
    new Promise((resolve) => context.signal.addEventListener(
      "abort", () => resolve({ late: true }), { once: true },
    ))
  ));

  await client.rpc.request("test/emit", {
    requestId: "resolved",
    requestMethod: "approval/test",
    resolveAfterMs: 20,
    duplicateResolved: true,
  });
  const records = await waitFor(
    () => Promise.resolve(client.listServerRequestRecords()),
    (items) => items[0]?.resolution === "provider-resolved",
  );

  assert.equal(records[0].state, "terminal");
  assert.match(records[0].providerResolvedAtUtc, /Z$/u);
  assert.deepEqual(await responses(client), []);
  assert.ok(rejected.some((record) => record.reason === "duplicate-resolution"));
});

test("unsupported server request is terminal and explicit", async (t) => {
  const client = await openClient();
  t.after(() => client.close());

  await client.rpc.request("test/emit", {
    requestId: "unsupported", requestMethod: "unknown/request",
  });
  const wire = await waitFor(() => responses(client), (items) => items.length === 1);

  assert.equal(wire[0].error.code, -32601);
  assert.equal(client.listServerRequestRecords()[0].resolution, "unsupported");
});

test("transport exit aborts an active server request without a late write", async () => {
  const client = await openClient({ serverRequestTimeoutMs: 500 });
  let aborted = false;
  client.registerServerRequestHandler("approval/test", async (_params, context) => (
    new Promise((resolve) => context.signal.addEventListener("abort", () => {
      aborted = true;
      resolve({ late: true });
    }, { once: true }))
  ));
  const exited = once(client, "exit");

  await client.rpc.request("test/emit", {
    requestId: "exit", requestMethod: "approval/test", exitAfterMs: 30,
  });
  await exited;

  assert.equal(aborted, true);
  const record = client.listServerRequestRecords()[0];
  assert.equal(record.state, "terminal");
  assert.equal(record.resolution, "transport-exit");
  await client.close();
});

test("pending and terminal server request records stay bounded", async (t) => {
  const client = await openClient({
    serverRequestTimeoutMs: 500,
    maxPendingServerRequests: 1,
    maxServerRequestHistory: 2,
  });
  t.after(() => client.close());
  client.registerServerRequestHandler("approval/test", async (_params, context) => (
    new Promise((resolve) => context.signal.addEventListener(
      "abort", () => resolve({ late: true }), { once: true },
    ))
  ));

  await client.rpc.request("test/emit", {
    requestId: "pending", requestMethod: "approval/test",
  });
  await waitFor(
    () => Promise.resolve(client.listServerRequestRecords()),
    (items) => items[0]?.state === "pending",
  );
  await client.rpc.request("test/emit", {
    requestId: "overflow", requestMethod: "approval/test",
  });
  const wire = await waitFor(() => responses(client), (items) => items.length === 1);
  assert.equal(wire[0].error.code, -32003);
  assert.deepEqual(
    client.listServerRequestRecords().map((record) => record.resolution),
    [null, "capacity"],
  );

  assert.equal(client.rpc.resolveServerRequest("pending"), true);
  for (const id of ["old", "new"]) {
    await client.rpc.request("test/emit", { requestId: id, requestMethod: "unknown/request" });
  }
  await waitFor(() => responses(client), (items) => items.length === 3);
  assert.deepEqual(
    client.listServerRequestRecords().map((record) => record.requestId),
    ["old", "new"],
  );
});
