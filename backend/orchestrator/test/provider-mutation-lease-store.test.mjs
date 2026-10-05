import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  createFileProviderMutationLease,
  createFileProviderMutationLeaseStore,
} from "../src/provider-mutation-lease-store.mjs";
import { ProviderMutationLease } from "../src/provider-mutation-lease.mjs";

const PROJECT = "orchestrator-development";
const INTENT = "a".repeat(64);
const RECEIPT = "b".repeat(64);
const leaseSchema = JSON.parse(await readFile(
  new URL("../schemas/provider-mutation-lease.schema.json", import.meta.url),
  "utf8",
));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(leaseSchema);

function owner(operationId = "operation-one") {
  return {
    sourceId: "openai-codex",
    runtimeInstanceId: "runtime-one",
    threadId: "thread-one",
    operation: "turn/start",
    operationId,
    correlationId: `correlation-${operationId}`,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-lease-store-"));
  await mkdir(path.join(root, ".orchestrator"), { recursive: true });
  await writeFile(
    path.join(root, ".orchestrator", "contract.json"),
    `${JSON.stringify({ sourceId: PROJECT })}\n`,
    "utf8",
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("controller identity uses projectName only when child contract is absent", async (t) => {
  const root = await fixture(t);
  const contract = path.join(root, ".orchestrator", "contract.json");
  await rm(contract);
  await writeFile(path.join(root, "project-version.json"), JSON.stringify({ projectName: "Controller" }));
  const options = { controllerRoot: root, projectId: "Controller" };
  const first = await createFileProviderMutationLease(options);
  await first.lease.acquire({ owner: owner(), intentSha256: INTENT });
  const second = await createFileProviderMutationLease(options);
  await assert.rejects(second.lease.acquire({ owner: owner("second"), intentSha256: INTENT }), { code: "lease_held" });
  await assert.rejects(createFileProviderMutationLease({ ...options, projectId: "Wrong" }), { code: "project_identity_conflict" });
  await writeFile(contract, '{}');
  await assert.rejects(createFileProviderMutationLease(options), { code: "invalid_identity" });
});

test("file CAS store survives restart and retains bounded metadata only", async (t) => {
  const root = await fixture(t);
  let token = 0;
  const first = await createFileProviderMutationLease({
    controllerRoot: root,
    projectId: PROJECT,
    leaseOptions: { idFactory: () => `lease-${++token}` },
  });
  const acquired = await first.lease.acquire({ owner: owner(), intentSha256: INTENT });
  await first.lease.release({
    owner: owner(),
    intentSha256: INTENT,
    leaseId: acquired.record.leaseId,
    outcome: "applied",
    receiptSha256: RECEIPT,
  });

  const restarted = await createFileProviderMutationLease({
    controllerRoot: root,
    projectId: PROJECT,
    leaseOptions: { idFactory: () => `lease-${++token}` },
  });
  const replay = await restarted.lease.acquire({ owner: owner(), intentSha256: INTENT });
  assert.equal(replay.status, "replay");
  const persisted = await readFile(restarted.paths.document, "utf8");
  assert.doesNotMatch(persisted, /prompt|transcript|reasoning|credential|password|secret/i);
  assert.equal(createHash("sha256").update(persisted).digest("hex").length, 64);
  assert.equal(validateSchema(JSON.parse(persisted)), true, JSON.stringify(validateSchema.errors));
});

test("two file-backed lease owners admit exactly one mutation", async (t) => {
  const root = await fixture(t);
  const leftStore = await createFileProviderMutationLeaseStore({ controllerRoot: root, projectId: PROJECT });
  const rightStore = await createFileProviderMutationLeaseStore({ controllerRoot: root, projectId: PROJECT });
  const left = new ProviderMutationLease({
    projectId: PROJECT, store: leftStore, idFactory: () => "lease-left",
  });
  const right = new ProviderMutationLease({
    projectId: PROJECT, store: rightStore, idFactory: () => "lease-right",
  });
  const attempts = await Promise.allSettled([
    left.acquire({ owner: owner("operation-left"), intentSha256: INTENT }),
    right.acquire({ owner: owner("operation-right"), intentSha256: "c".repeat(64) }),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
});

test("settled receipts roll out of the bounded ledger without losing replay protection", async (t) => {
  const root = await fixture(t);
  let token = 0;
  const create = () => createFileProviderMutationLease({
    controllerRoot: root,
    projectId: PROJECT,
    leaseOptions: { maxRecords: 2, idFactory: () => `lease-rollover-${++token}` },
  });
  let current = await create();
  for (let index = 1; index <= 5; index += 1) {
    const exactOwner = owner(`operation-rollover-${index}`);
    const acquired = await current.lease.acquire({
      owner: exactOwner, intentSha256: INTENT,
    });
    await current.lease.release({
      owner: exactOwner,
      intentSha256: INTENT,
      leaseId: acquired.record.leaseId,
      outcome: "applied",
      receiptSha256: RECEIPT,
    });
  }
  current = await create();
  const replay = await current.lease.acquire({
    owner: owner("operation-rollover-1"), intentSha256: INTENT,
  });
  assert.equal(replay.status, "replay");
  assert.equal(replay.record.state, "released");
  const document = JSON.parse(await readFile(current.paths.document, "utf8"));
  assert.equal(document.contractVersion, "v0.2.0");
  assert.ok(document.records.length <= 2);
  assert.ok(document.archivedRecordCount >= 3);
  assert.equal((await readdir(current.paths.settlements)).length, document.archivedRecordCount);
  await assert.rejects(
    current.lease.acquire({
      owner: owner("operation-rollover-1"), intentSha256: "c".repeat(64),
    }),
    (error) => error.code === "mutation_intent_conflict",
  );
});

test("foreign project, key, corrupt file and stale lock fail closed", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    createFileProviderMutationLeaseStore({ controllerRoot: root, projectId: "foreign" }),
    (error) => error.code === "project_identity_conflict",
  );
  const store = await createFileProviderMutationLeaseStore({
    controllerRoot: root, projectId: PROJECT, lockAttempts: 1,
  });
  await assert.rejects(store.read("provider-mutation-lease.v1:foreign"),
    (error) => error.code === "store_key_conflict");

  await mkdir(path.dirname(store.paths.document), { recursive: true });
  await writeFile(store.paths.document, "{broken", "utf8");
  await assert.rejects(store.read(`provider-mutation-lease.v1:${PROJECT}`),
    (error) => error.code === "invalid_store_json");
  await rm(store.paths.document, { force: true });
  await writeFile(store.paths.lock, "operator reconciliation required", "utf8");
  const lease = new ProviderMutationLease({ projectId: PROJECT, store });
  await assert.rejects(
    lease.acquire({ owner: owner(), intentSha256: INTENT }),
    (error) => error.code === "store_lock_unavailable",
  );
  assert.equal(await readFile(store.paths.lock, "utf8"), "operator reconciliation required");
});

test("symlinked and oversized lease documents are rejected", async (t) => {
  const root = await fixture(t);
  const store = await createFileProviderMutationLeaseStore({
    controllerRoot: root, projectId: PROJECT, maxDocumentBytes: 4096,
  });
  const outside = path.join(root, "outside.json");
  await writeFile(outside, "{}", "utf8");
  try {
    await symlink(outside, store.paths.document, "file");
    await assert.rejects(store.read(`provider-mutation-lease.v1:${PROJECT}`),
      (error) => error.code === "invalid_store_file");
    await rm(store.paths.document, { force: true });
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
  }
  await writeFile(store.paths.document, "x".repeat(4097), "utf8");
  await assert.rejects(store.read(`provider-mutation-lease.v1:${PROJECT}`),
    (error) => error.code === "invalid_store_file");
});
