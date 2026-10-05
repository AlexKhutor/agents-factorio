import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  APPLICATION_ARTIFACT_OWNER_POLICIES,
  APPLICATION_ARTIFACT_RESOURCE_KINDS,
  createApplicationArtifactResourceQuery,
  validateApplicationArtifactResourceQuery,
} from "../src/application-artifact-resource.mjs";

const HASH = "a".repeat(64);
const PATHS = Object.freeze({
  report: "knowledge/reports/inbox/worker-one/task-one-report.md",
  acceptance: "coordination/acceptances/worker-one/task-one/acceptance.json",
  diagnostic: "coordination/drafts/incidents/incident-one/incident.json",
  review: "coordination/reviews/task-one/decision.json",
});

function resource(artifactKind = "report", overrides = {}) {
  const sourceId = artifactKind === "report" ? "worker-one" : "controller";
  const authorityType = artifactKind === "report" ? "child-workspace" : "coordination-core";
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    resourceKind: "artifact",
    sourceId,
    nativeId: PATHS[artifactKind],
    authority: {
      schemaVersion: 1,
      authorityType,
      sourceId,
      externalId: `artifact-${artifactKind}`,
      contractVersion: "v0.1.0",
      artifactSha256: HASH,
    },
    revision: { schemaVersion: 1, kind: "sha256", value: HASH },
    contentSha256: HASH,
    ...overrides,
  };
}

function query(artifactKind = "report", overrides = {}) {
  return createApplicationArtifactResourceQuery({
    artifactKind,
    resource: resource(artifactKind),
    requestedAtUtc: "2026-08-30T16:00:00.000Z",
    ...overrides,
  });
}

function contractError(error) {
  assert.equal(error.name, "ApplicationContractError");
  assert.equal(error.code, "invalid_artifact_resource");
  return true;
}

function applicationError(code) {
  return (error) => {
    assert.equal(error.name, "ApplicationContractError");
    assert.equal(error.code, code);
    return true;
  };
}

test("A3.2 binds every supported artifact query to exact owner policy and hash", () => {
  assert.deepEqual(APPLICATION_ARTIFACT_RESOURCE_KINDS, [
    "report", "acceptance", "diagnostic", "review",
  ]);
  for (const kind of APPLICATION_ARTIFACT_RESOURCE_KINDS) {
    const value = query(kind);
    assert.strictEqual(validateApplicationArtifactResourceQuery(value), value);
    assert.equal(value.resource.revision.value, value.resource.contentSha256);
    assert.equal(value.resource.authority.artifactSha256, value.resource.contentSha256);
    assert.equal(value.resource.nativeId.startsWith(APPLICATION_ARTIFACT_OWNER_POLICIES[kind].root), true);
  }
});

test("A3.2 rejects foreign owners, unscoped reports, and hash drift", () => {
  const foreign = query();
  foreign.resource.authority.authorityType = "coordination-core";
  assert.throws(() => validateApplicationArtifactResourceQuery(foreign), contractError);

  const unscoped = query();
  unscoped.resource.nativeId = "knowledge/reports/inbox/worker-two/report.md";
  assert.throws(() => validateApplicationArtifactResourceQuery(unscoped), contractError);

  const drift = query();
  drift.resource.authority.artifactSha256 = "b".repeat(64);
  assert.throws(() => validateApplicationArtifactResourceQuery(drift), contractError);

  const wrongRoot = query("review");
  wrongRoot.resource.nativeId = "logs/review.json";
  assert.throws(() => validateApplicationArtifactResourceQuery(wrongRoot), contractError);
});

test("A3.2 rejects additive request fields and non-query operations", () => {
  assert.throws(
    () => validateApplicationArtifactResourceQuery({ ...query(), credential: "forbidden" }),
    contractError,
  );
  const mutation = query();
  mutation.operation = { ...mutation.operation, family: "mutation" };
  assert.throws(
    () => validateApplicationArtifactResourceQuery(mutation),
    applicationError("operation_family_mismatch"),
  );
});

test("A3.2 portable schema accepts owner-bound queries and rejects wrong roots", async () => {
  const names = [
    "authority-reference.schema.json",
    "application-common.schema.json",
    "application-artifact-resource.schema.json",
  ];
  const schemas = await Promise.all(names.map(async (name) => (
    JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"))
  )));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schemas[0]);
  ajv.addSchema(schemas[1]);
  const validate = ajv.compile(schemas[2]);
  for (const kind of APPLICATION_ARTIFACT_RESOURCE_KINDS) {
    assert.equal(validate(query(kind)), true, JSON.stringify(validate.errors));
  }
  const invalid = query("diagnostic");
  invalid.resource.nativeId = "coordination/reviews/task-one/decision.json";
  assert.equal(validate(invalid), false);
});
