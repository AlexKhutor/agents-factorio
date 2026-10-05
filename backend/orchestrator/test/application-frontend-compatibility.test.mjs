import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  assessApplicationFrontendCompatibility,
  createApplicationFrontendMigrationReceipt,
  validateApplicationFrontendCompatibilityPolicy,
  validateApplicationFrontendMigrationReceipt,
} from "../frontend-kit/source/compatibility.mjs";
import { buildApplicationFrontendKit } from "../scripts/build-application-frontend-kit.mjs";

const BACKEND = Object.freeze({
  applicationContractVersion: "v0.1.0",
  capabilityContractVersion: "v0.2.0",
  gatewayDescriptorVersion: "v0.2.0",
  eventContractVersion: "v0.2.0",
});

function policy() {
  return {
    schemaVersion: 1,
    contractVersion: "v0.1.0",
    policyId: "application-frontend-kit-compatibility",
    packageName: "@isolate-vscode/application-frontend-kit",
    currentSdkVersion: "v0.11.0",
    pairs: [
      { sdkVersion: "v0.11.0", status: "current", supportedUntilUtc: null, ...BACKEND },
      { sdkVersion: "v0.10.0", status: "supported", supportedUntilUtc: null, ...BACKEND },
      { sdkVersion: "v0.9.2", status: "supported", supportedUntilUtc: null, ...BACKEND },
      { sdkVersion: "v0.9.1", status: "supported", supportedUntilUtc: null, ...BACKEND },
      { sdkVersion: "v0.9.0", status: "supported", supportedUntilUtc: null, ...BACKEND },
      { sdkVersion: "v0.8.0", status: "supported", supportedUntilUtc: null, ...BACKEND },
      { sdkVersion: "v0.7.0", status: "supported", supportedUntilUtc: null, ...BACKEND },
      { sdkVersion: "v0.6.0", status: "supported", supportedUntilUtc: null, ...BACKEND },
    ],
    deprecations: [],
  };
}

function candidate(sdkVersion, observedAtUtc = "2026-08-31T02:00:00.000Z") {
  return { sdkVersion, ...BACKEND, observedAtUtc };
}

test("packaged policy binds exact current and supported SDK/backend pairs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "application-frontend-compatibility-"));
  const built = await buildApplicationFrontendKit({ output: path.join(root, "kit") });
  const packaged = await import(pathToFileURL(
    path.join(built.output, "compatibility", "index.mjs"),
  ).href);
  assert.equal(packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY.currentSdkVersion, "v0.21.0");
  assert.equal(
    await packaged.applicationFrontendSha256(packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY),
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY_SHA256,
  );
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.21.0"),
  ).status, "current");
  // v0.21.0 only adds operations and optional fields: v0.20.0 keeps working.
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.20.0"),
  ).status, "supported");
  // v0.19.0 names the receipt field memory (refused by the Gateway's privacy check).
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.19.0"),
  ).status, "unsupported");
  // v0.18.0, v0.17.0 and v0.16.1 validate agent reads strictly and would refuse their new fields.
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.18.0"),
  ).status, "unsupported");
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.17.0"),
  ).status, "unsupported");
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.16.1"),
  ).status, "unsupported");
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.16.0"),
  ).status, "unsupported");
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.15.0"),
  ).status, "supported");
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.14.0"),
  ).status, "supported");
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.11.0"),
  ).status, "supported");
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.10.0"),
  ).status, "supported");
  assert.equal(packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.6.0"),
  ).status, "supported");
  const unknown = packaged.assessApplicationFrontendCompatibility(
    packaged.APPLICATION_FRONTEND_COMPATIBILITY_POLICY, candidate("v0.5.0"),
  );
  assert.deepEqual(
    { compatible: unknown.compatible, status: unknown.status, reasonCode: unknown.reasonCode },
    { compatible: false, status: "unsupported", reasonCode: "unsupported-version-pair" },
  );
});

test("deprecation remains explicit and expires fail closed", () => {
  const value = policy();
  const deprecatedPair = value.pairs.find(({ sdkVersion }) => sdkVersion === "v0.6.0");
  deprecatedPair.status = "deprecated";
  deprecatedPair.supportedUntilUtc = "2027-03-01T00:00:00.000Z";
  value.deprecations.push({
    noticeId: "frontend-kit-v06-retirement",
    sdkVersion: "v0.6.0",
    applicationContractVersion: "v0.1.0",
    announcedAtUtc: "2026-09-01T00:00:00.000Z",
    supportedUntilUtc: "2027-03-01T00:00:00.000Z",
    replacementSdkVersion: "v0.9.0",
    ownerId: "orchestrator-development",
  });
  validateApplicationFrontendCompatibilityPolicy(value);
  assert.equal(assessApplicationFrontendCompatibility(
    value, candidate("v0.6.0", "2027-02-28T23:59:59.000Z"),
  ).reasonCode, "compatible-deprecated");
  assert.equal(assessApplicationFrontendCompatibility(
    value, candidate("v0.6.0", "2027-03-01T00:00:00.000Z"),
  ).reasonCode, "support-window-expired");
  const duplicate = structuredClone(value);
  duplicate.deprecations.push({ ...duplicate.deprecations[0], noticeId: "second-retirement-notice" });
  assert.throws(
    () => validateApplicationFrontendCompatibilityPolicy(duplicate),
    (error) => error.code === "invalid_compatibility_data",
  );
});

function evidence(sdkVersion, supportStatus, digit) {
  return {
    sdkVersion,
    ...BACKEND,
    kitManifestSha256: digit.repeat(64),
    supportStatus,
  };
}

async function receipt() {
  return createApplicationFrontendMigrationReceipt({
    schemaVersion: 1,
    receiptVersion: "v0.1.0",
    migrationId: "frontend-kit-v08-adoption",
    outcome: "committed",
    startedAtUtc: "2026-08-31T02:00:00.000Z",
    recordedAtUtc: "2026-08-31T02:00:01.000Z",
    policySha256: "a".repeat(64),
    source: evidence("v0.8.0", "supported", "b"),
    target: evidence("v0.9.0", "current", "c"),
    rollback: {
      status: "available",
      sdkVersion: "v0.8.0",
      kitManifestSha256: "b".repeat(64),
    },
    problems: [],
  });
}

test("migration receipt is deterministic, bounded and tamper-evident", async () => {
  const first = await receipt();
  const second = await receipt();
  assert.deepEqual(first, second);
  assert.match(first.receiptId, /^application-frontend-migration-[a-f0-9]{64}$/u);
  assert.strictEqual(await validateApplicationFrontendMigrationReceipt(first), first);
  const tampered = structuredClone(first);
  tampered.target.sdkVersion = "v9.0.0";
  await assert.rejects(
    validateApplicationFrontendMigrationReceipt(tampered),
    (error) => error.code === "invalid_migration_receipt",
  );
  assert.doesNotMatch(
    JSON.stringify(first),
    /(?:bearer|credential|prompt|history|sqlite|[a-z]:\\\\|\/home\/)/iu,
  );
});

test("portable schemas accept canonical policy and receipt", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const name of [
    "application-frontend-compatibility.schema.json",
    "application-frontend-migration-receipt.schema.json",
  ]) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8")));
  }
  const validatePolicy = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-frontend-compatibility.v1.json",
  );
  const validateReceipt = ajv.getSchema(
    "https://isolate-vscode.local/schemas/application-frontend-migration-receipt.v1.json",
  );
  const migrationReceipt = await receipt();
  assert.equal(validatePolicy(policy()), true, JSON.stringify(validatePolicy.errors));
  assert.equal(validateReceipt(migrationReceipt), true, JSON.stringify(validateReceipt.errors));
});
