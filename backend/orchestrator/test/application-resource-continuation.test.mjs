import assert from "node:assert/strict";
import test from "node:test";

import { createApplicationProjectResourceQuery } from "../src/application-project-resource.mjs";
import {
  issueApplicationResourceContinuation,
  verifyApplicationResourceContinuation,
} from "../src/application-resource-continuation.mjs";
import { createApplicationResourceReadResult } from "../src/application-resource-read-result.mjs";

const COMMIT = "a".repeat(40);
const CONTENT_HASH = "b".repeat(64);
const SECRET = Buffer.alloc(32, 7);
const NOW = new Date("2026-08-30T18:00:00.000Z");

function binding() {
  return {
    rootId: "controller-workspace",
    rootIdentitySha256: "c".repeat(64),
    readPolicyId: "project-owner-read-v1",
    readPolicySha256: "d".repeat(64),
  };
}

function request(view = "text-slice") {
  const directory = view === "directory-summary";
  return createApplicationProjectResourceQuery({
    rootId: "controller-workspace",
    readPolicyId: "project-owner-read-v1",
    resource: {
      schemaVersion: 1,
      contractVersion: "v0.1.0",
      resourceKind: directory ? "project-directory" : "project-file",
      sourceId: "orchestrator-repository",
      nativeId: directory ? "orchestrator/src" : "orchestrator/src/example.mjs",
      authority: {
        schemaVersion: 1,
        authorityType: "git-repository",
        sourceId: "orchestrator-repository",
        externalId: "main-worktree",
        contractVersion: "v0.1.0",
      },
      revision: { schemaVersion: 1, kind: "git-commit", value: COMMIT },
    },
    view,
    slice: view === "text-slice" ? { offsetBytes: 0, maximumBytes: 32 } : null,
    maxEntries: directory ? 2 : null,
    requestedAtUtc: "2026-08-30T17:59:59.000Z",
  });
}

function textResult(input = request()) {
  const text = "first bounded page\n";
  return createApplicationResourceReadResult(input, {
    sourceBinding: binding(),
    contentSha256: CONTENT_HASH,
    mediaType: "text/plain",
    encoding: "utf-8",
    range: { offsetBytes: 0, returnedBytes: Buffer.byteLength(text), totalBytes: 80 },
    page: { unit: "bytes", offset: 0, returned: Buffer.byteLength(text), total: 80 },
    truncated: true,
    readAtUtc: NOW.toISOString(),
    payload: { kind: "text", text },
  });
}

function directoryResult(input = request("directory-summary")) {
  const entries = [
    { name: "a.mjs", kind: "file", sizeBytes: 10, contentSha256: null },
    { name: "b", kind: "directory", sizeBytes: null, contentSha256: null },
  ];
  const returnedBytes = Buffer.byteLength(JSON.stringify(entries));
  return createApplicationResourceReadResult(input, {
    sourceBinding: binding(),
    contentSha256: CONTENT_HASH,
    mediaType: "application/vnd.isolate-vscode.directory+json",
    encoding: "utf-8",
    range: { offsetBytes: 0, returnedBytes, totalBytes: returnedBytes + 20 },
    page: { unit: "entries", offset: 0, returned: entries.length, total: 5 },
    truncated: true,
    readAtUtc: NOW.toISOString(),
    payload: { kind: "directory-summary", entries },
  });
}

function errorCode(code) {
  return (error) => {
    assert.equal(error.name, "ApplicationContractError");
    assert.equal(error.code, code);
    return true;
  };
}

test("A3.6 issues a bounded token and verifies it only with fresh authority evidence", () => {
  const input = request();
  const issued = issueApplicationResourceContinuation({
    secret: SECRET,
    backendInstanceId: "backend-instance-1",
    request: input,
    result: textResult(input),
    ttlSeconds: 120,
    now: () => NOW,
  });
  assert.match(issued.token, /^arc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(issued.expiresAtUtc, "2026-08-30T18:02:00.000Z");

  const claims = verifyApplicationResourceContinuation({
    token: issued.token,
    secret: SECRET,
    backendInstanceId: "backend-instance-1",
    request: input,
    currentSourceBinding: binding(),
    currentContentSha256: CONTENT_HASH,
    now: () => new Date("2026-08-30T18:01:00.000Z"),
  });
  assert.deepEqual(claims.cursor, { kind: "byte-offset", value: 19 });
  assert.deepEqual(claims.pageLimit, { kind: "maximum-bytes", value: 32 });
});

test("A3.6 rejects request, authority, root, policy, and page-limit widening", () => {
  const input = request();
  const issued = issueApplicationResourceContinuation({
    secret: SECRET,
    backendInstanceId: "backend-instance-1",
    request: input,
    result: textResult(input),
    now: () => NOW,
  });
  const widened = structuredClone(input);
  widened.slice.maximumBytes = 64;
  assert.throws(() => verifyApplicationResourceContinuation({
    token: issued.token,
    secret: SECRET,
    backendInstanceId: "backend-instance-1",
    request: widened,
    currentSourceBinding: binding(),
    currentContentSha256: CONTENT_HASH,
    now: () => NOW,
  }), errorCode("access_denied"));

  const foreignPolicy = binding();
  foreignPolicy.readPolicySha256 = "e".repeat(64);
  assert.throws(() => verifyApplicationResourceContinuation({
    token: issued.token,
    secret: SECRET,
    backendInstanceId: "backend-instance-1",
    request: input,
    currentSourceBinding: foreignPolicy,
    currentContentSha256: CONTENT_HASH,
    now: () => NOW,
  }), errorCode("access_denied"));
});

test("A3.6 rejects tampering, wrong instances, expiry, and changed content", () => {
  const input = request();
  const issued = issueApplicationResourceContinuation({
    secret: SECRET,
    backendInstanceId: "backend-instance-1",
    request: input,
    result: textResult(input),
    ttlSeconds: 30,
    now: () => NOW,
  });
  const common = {
    token: issued.token,
    secret: SECRET,
    backendInstanceId: "backend-instance-1",
    request: input,
    currentSourceBinding: binding(),
    currentContentSha256: CONTENT_HASH,
    now: () => NOW,
  };
  const last = issued.token.at(-1) === "A" ? "B" : "A";
  assert.throws(
    () => verifyApplicationResourceContinuation({ ...common, token: issued.token.slice(0, -1) + last }),
    errorCode("access_denied"),
  );
  assert.throws(
    () => verifyApplicationResourceContinuation({ ...common, secret: Buffer.alloc(32, 8) }),
    errorCode("access_denied"),
  );
  assert.throws(
    () => verifyApplicationResourceContinuation({ ...common, backendInstanceId: "backend-instance-2" }),
    errorCode("stale_revision"),
  );
  assert.throws(
    () => verifyApplicationResourceContinuation({ ...common, currentContentSha256: "f".repeat(64) }),
    errorCode("stale_revision"),
  );
  assert.throws(
    () => verifyApplicationResourceContinuation({
      ...common, now: () => new Date("2026-08-30T18:00:30.000Z"),
    }),
    errorCode("stale_revision"),
  );
});

test("A3.6 supports directory cursors and refuses complete reads", () => {
  const input = request("directory-summary");
  const value = directoryResult(input);
  const issued = issueApplicationResourceContinuation({
    secret: SECRET,
    backendInstanceId: "backend-instance-1",
    request: input,
    result: value,
    now: () => NOW,
  });
  const claims = verifyApplicationResourceContinuation({
    token: issued.token,
    secret: SECRET,
    backendInstanceId: "backend-instance-1",
    request: input,
    currentSourceBinding: binding(),
    currentContentSha256: CONTENT_HASH,
    now: () => NOW,
  });
  assert.deepEqual(claims.cursor, { kind: "entry-index", value: 2 });
  value.truncated = false;
  value.range.totalBytes = value.range.returnedBytes;
  value.page.total = value.page.returned;
  assert.throws(() => issueApplicationResourceContinuation({
    secret: SECRET,
    backendInstanceId: "backend-instance-1",
    request: input,
    result: value,
    now: () => NOW,
  }), errorCode("conflict"));
});
