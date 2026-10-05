export const APPLICATION_FRONTEND_COMPATIBILITY_VERSION = "v0.1.0";
export const APPLICATION_FRONTEND_MIGRATION_RECEIPT_VERSION = "v0.1.0";

const VERSION = /^v\d+\.\d+\.\d+$/u;
const ID = /^[a-z][a-z0-9-]{1,95}$/u;
const PROBLEM = /^[a-z][a-z0-9_]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PACKAGE = /^@[a-z0-9-]+\/[a-z0-9-]+$/u;
const SUPPORT = new Set(["current", "supported", "deprecated"]);

function fail(code, message) {
  throw Object.assign(new TypeError(message), { code });
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_compatibility_data", `${label} must be an object`);
  }
}

function exact(value, fields, label) {
  object(value, label);
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length > 0) fail("invalid_compatibility_data", `${label} has unsupported fields`);
  if (fields.some((field) => !(field in value))) {
    fail("invalid_compatibility_data", `${label} is incomplete`);
  }
}

function utc(value, label) {
  if (typeof value !== "string" || value.length > 64 || !value.endsWith("Z")
      || !Number.isFinite(Date.parse(value))) {
    fail("invalid_compatibility_data", `${label} must be a UTC timestamp`);
  }
}

function version(value, label) {
  if (!VERSION.test(value ?? "")) fail("invalid_compatibility_data", `${label} is invalid`);
}

const PAIR_FIELDS = [
  "sdkVersion", "applicationContractVersion", "capabilityContractVersion",
  "gatewayDescriptorVersion", "eventContractVersion", "status", "supportedUntilUtc",
];

function validatePair(value, label = "version pair") {
  exact(value, PAIR_FIELDS, label);
  for (const field of PAIR_FIELDS.slice(0, 5)) version(value[field], `${label}.${field}`);
  if (!SUPPORT.has(value.status)) fail("invalid_compatibility_data", `${label}.status is invalid`);
  if (value.supportedUntilUtc !== null) utc(value.supportedUntilUtc, `${label}.supportedUntilUtc`);
  if ((value.status === "deprecated") !== (value.supportedUntilUtc !== null)) {
    fail("invalid_compatibility_data", "only a deprecated pair has a support deadline");
  }
  return value;
}

function pairKey(value) {
  return PAIR_FIELDS.slice(0, 5).map((field) => value[field]).join("\u0000");
}

function validateNotice(value) {
  const fields = [
    "noticeId", "sdkVersion", "applicationContractVersion", "announcedAtUtc",
    "supportedUntilUtc", "replacementSdkVersion", "ownerId",
  ];
  exact(value, fields, "deprecation notice");
  if (!ID.test(value.noticeId ?? "") || !ID.test(value.ownerId ?? "")) {
    fail("invalid_compatibility_data", "deprecation identity is invalid");
  }
  version(value.sdkVersion, "deprecation sdkVersion");
  version(value.applicationContractVersion, "deprecation applicationContractVersion");
  version(value.replacementSdkVersion, "deprecation replacementSdkVersion");
  utc(value.announcedAtUtc, "deprecation announcedAtUtc");
  utc(value.supportedUntilUtc, "deprecation supportedUntilUtc");
  if (Date.parse(value.supportedUntilUtc) <= Date.parse(value.announcedAtUtc)
      || value.replacementSdkVersion === value.sdkVersion) {
    fail("invalid_compatibility_data", "deprecation transition is invalid");
  }
  return value;
}

export function validateApplicationFrontendCompatibilityPolicy(value) {
  const fields = [
    "schemaVersion", "contractVersion", "policyId", "packageName",
    "currentSdkVersion", "pairs", "deprecations",
  ];
  exact(value, fields, "compatibility policy");
  if (value.schemaVersion !== 1 || value.contractVersion !== APPLICATION_FRONTEND_COMPATIBILITY_VERSION
      || !ID.test(value.policyId ?? "") || !PACKAGE.test(value.packageName ?? "")) {
    fail("invalid_compatibility_data", "compatibility policy identity is invalid");
  }
  version(value.currentSdkVersion, "currentSdkVersion");
  if (!Array.isArray(value.pairs) || value.pairs.length < 1 || value.pairs.length > 32
      || !Array.isArray(value.deprecations) || value.deprecations.length > 32) {
    fail("invalid_compatibility_data", "compatibility policy lists are invalid");
  }
  value.pairs.forEach((pair) => validatePair(pair));
  value.deprecations.forEach(validateNotice);
  const noticePairs = value.deprecations.map(
    (notice) => `${notice.sdkVersion}\u0000${notice.applicationContractVersion}`,
  );
  if (new Set(value.pairs.map(pairKey)).size !== value.pairs.length
      || new Set(value.deprecations.map(({ noticeId }) => noticeId)).size !== value.deprecations.length
      || new Set(noticePairs).size !== noticePairs.length
      || !value.pairs.some((pair) => pair.sdkVersion === value.currentSdkVersion
        && pair.status === "current")) {
    fail("invalid_compatibility_data", "compatibility policy identities are ambiguous");
  }
  for (const pair of value.pairs.filter(({ status }) => status === "deprecated")) {
    const notice = value.deprecations.find((item) => item.sdkVersion === pair.sdkVersion
      && item.applicationContractVersion === pair.applicationContractVersion);
    if (!notice || notice.supportedUntilUtc !== pair.supportedUntilUtc) {
      fail("invalid_compatibility_data", "deprecated pair requires an exact notice");
    }
  }
  for (const notice of value.deprecations) {
    if (!value.pairs.some((pair) => pair.sdkVersion === notice.sdkVersion
      && pair.applicationContractVersion === notice.applicationContractVersion
      && pair.status === "deprecated" && pair.supportedUntilUtc === notice.supportedUntilUtc)) {
      fail("invalid_compatibility_data", "deprecation notice has no exact deprecated pair");
    }
  }
  return value;
}

export function assessApplicationFrontendCompatibility(policy, candidate) {
  validateApplicationFrontendCompatibilityPolicy(policy);
  const fields = [...PAIR_FIELDS.slice(0, 5), "observedAtUtc"];
  exact(candidate, fields, "compatibility candidate");
  for (const field of fields.slice(0, 5)) version(candidate[field], `candidate.${field}`);
  utc(candidate.observedAtUtc, "candidate.observedAtUtc");
  const selected = policy.pairs.find((pair) => pairKey(pair) === pairKey(candidate));
  if (!selected) {
    return Object.freeze({
      compatible: false, status: "unsupported",
      reasonCode: "unsupported-version-pair", supportedUntilUtc: null,
      deprecationNoticeId: null, replacementSdkVersion: null,
    });
  }
  const notice = policy.deprecations.find((item) => item.sdkVersion === selected.sdkVersion
    && item.applicationContractVersion === selected.applicationContractVersion) ?? null;
  if (selected.supportedUntilUtc !== null
      && Date.parse(candidate.observedAtUtc) >= Date.parse(selected.supportedUntilUtc)) {
    return Object.freeze({
      compatible: false, status: "unsupported",
      reasonCode: "support-window-expired", supportedUntilUtc: selected.supportedUntilUtc,
      deprecationNoticeId: notice?.noticeId ?? null,
      replacementSdkVersion: notice?.replacementSdkVersion ?? null,
    });
  }
  return Object.freeze({
    compatible: true,
    status: selected.status,
    reasonCode: `compatible-${selected.status}`,
    supportedUntilUtc: selected.supportedUntilUtc,
    deprecationNoticeId: notice?.noticeId ?? null,
    replacementSdkVersion: notice?.replacementSdkVersion ?? null,
  });
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  object(value, "canonical value");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function applicationFrontendCanonicalJson(value) {
  const result = JSON.stringify(canonicalValue(value));
  if (new TextEncoder().encode(result).byteLength > 64 * 1024) {
    fail("invalid_compatibility_data", "canonical value exceeds 64 KiB");
  }
  return result;
}

export async function applicationFrontendSha256(value) {
  if (!globalThis.crypto?.subtle) fail("hash_unavailable", "SHA-256 is unavailable");
  const bytes = new TextEncoder().encode(
    typeof value === "string" ? value : applicationFrontendCanonicalJson(value),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const EVIDENCE_FIELDS = [
  "sdkVersion", "applicationContractVersion", "capabilityContractVersion",
  "gatewayDescriptorVersion", "eventContractVersion", "kitManifestSha256", "supportStatus",
];

function validateEvidence(value, label) {
  exact(value, EVIDENCE_FIELDS, label);
  for (const field of EVIDENCE_FIELDS.slice(0, 5)) version(value[field], `${label}.${field}`);
  if (!SHA256.test(value.kitManifestSha256 ?? "")
      || ![...SUPPORT, "unsupported"].includes(value.supportStatus)) {
    fail("invalid_migration_receipt", `${label} is invalid`);
  }
  return value;
}

function validateReceiptCore(value, requireReceiptId) {
  const fields = [
    "schemaVersion", "receiptVersion", "migrationId", "outcome", "startedAtUtc",
    "recordedAtUtc", "policySha256", "source", "target", "rollback", "problems",
    ...(requireReceiptId ? ["receiptId"] : []),
  ];
  exact(value, fields, "migration receipt");
  if (value.schemaVersion !== 1
      || value.receiptVersion !== APPLICATION_FRONTEND_MIGRATION_RECEIPT_VERSION
      || !ID.test(value.migrationId ?? "")
      || !["committed", "rolled-back", "failed", "uncertain"].includes(value.outcome)
      || !SHA256.test(value.policySha256 ?? "")) {
    fail("invalid_migration_receipt", "migration receipt identity is invalid");
  }
  utc(value.startedAtUtc, "startedAtUtc");
  utc(value.recordedAtUtc, "recordedAtUtc");
  if (Date.parse(value.recordedAtUtc) < Date.parse(value.startedAtUtc)) {
    fail("invalid_migration_receipt", "migration receipt time order is invalid");
  }
  validateEvidence(value.source, "source evidence");
  validateEvidence(value.target, "target evidence");
  exact(value.rollback, ["status", "sdkVersion", "kitManifestSha256"], "rollback evidence");
  if (!["available", "applied", "not-required", "unavailable"].includes(value.rollback.status)) {
    fail("invalid_migration_receipt", "rollback status is invalid");
  }
  const rollbackBound = ["available", "applied"].includes(value.rollback.status);
  if (rollbackBound !== (VERSION.test(value.rollback.sdkVersion ?? "")
      && SHA256.test(value.rollback.kitManifestSha256 ?? ""))) {
    fail("invalid_migration_receipt", "rollback evidence is incomplete");
  }
  if (!Array.isArray(value.problems) || value.problems.length > 16
      || new Set(value.problems).size !== value.problems.length
      || value.problems.some((problem) => !PROBLEM.test(problem))) {
    fail("invalid_migration_receipt", "migration problems are invalid");
  }
  if (value.outcome === "committed"
      && (value.target.supportStatus === "unsupported" || value.problems.length > 0)) {
    fail("invalid_migration_receipt", "committed migration must target supported evidence");
  }
  if (value.outcome === "rolled-back"
      && (value.rollback.status !== "applied" || value.problems.length > 0)) {
    fail("invalid_migration_receipt", "rolled-back migration requires applied rollback evidence");
  }
  if (["failed", "uncertain"].includes(value.outcome) && value.problems.length < 1) {
    fail("invalid_migration_receipt", "failed or uncertain migration requires a problem code");
  }
  if (requireReceiptId && !/^application-frontend-migration-[a-f0-9]{64}$/u.test(value.receiptId ?? "")) {
    fail("invalid_migration_receipt", "migration receipt ID is invalid");
  }
  return value;
}

export async function createApplicationFrontendMigrationReceipt(value) {
  const body = structuredClone(value);
  validateReceiptCore(body, false);
  const digest = await applicationFrontendSha256(body);
  const receipt = { ...body, receiptId: `application-frontend-migration-${digest}` };
  await validateApplicationFrontendMigrationReceipt(receipt);
  return Object.freeze(receipt);
}

export async function validateApplicationFrontendMigrationReceipt(value) {
  validateReceiptCore(value, true);
  const body = Object.fromEntries(
    Object.entries(value).filter(([field]) => field !== "receiptId"),
  );
  const expected = `application-frontend-migration-${await applicationFrontendSha256(body)}`;
  if (value.receiptId !== expected) {
    fail("invalid_migration_receipt", "migration receipt checksum is invalid");
  }
  return value;
}
