import { createHash } from "node:crypto";

import {
  validateAuthorityReference,
  validateExternalReference,
} from "./work-authority-contract.mjs";

export const WORK_PROJECTION_V2_SCHEMA_VERSION = 2;
export const WORK_PROJECTION_V2_CONTRACT_VERSION = "v0.2.0";
export const WORK_PROJECTION_V2_LAYERS = Object.freeze([
  "work", "execution", "artifact", "attention", "surface", "authority",
]);
export const WORK_PROJECTION_V2_LIMITS = Object.freeze({
  maxFactsPerLayer: 128,
  maxTotalFacts: 512,
  maxExternalRefsPerFact: 16,
  maxEvidenceRefsPerFact: 16,
  maxFactValueBytes: 16_384,
  maxSnapshotBytes: 1_048_576,
});

const DOMAIN_LAYERS = WORK_PROJECTION_V2_LAYERS.filter((layer) => layer !== "authority");
const DOMAIN_LAYER_SET = new Set(DOMAIN_LAYERS);
const FACT_STATES = new Set([
  "current", "stale", "unknown", "unavailable", "unsupported",
  "contradictory", "authority-mismatch", "ambiguous",
]);
const FRESHNESS_BY_STATE = Object.freeze({
  current: "fresh",
  stale: "stale",
  unknown: "unknown",
  unavailable: "unavailable",
  unsupported: "unavailable",
  contradictory: "unknown",
  "authority-mismatch": "unknown",
  ambiguous: "unknown",
});
const FRESHNESS_FIELDS = Object.freeze({
  occurred: "occurredAtUtc",
  observed: "observedAtUtc",
  published: "publishedAtUtc",
  heartbeat: "heartbeatAtUtc",
  semantic: "semanticUpdatedAtUtc",
});
const SUBJECT_KINDS = Object.freeze({
  work: new Set(["work-item", "task", "goal", "feature", "issue", "decision", "dependency"]),
  execution: new Set([
    "execution", "execution-actor", "provider-session", "provider-thread",
    "provider-turn", "provider-run", "provider-subagent",
  ]),
  artifact: new Set(["artifact"]),
  attention: new Set(["attention-event"]),
  surface: new Set(["application", "window", "document", "thread", "file"]),
});
const PRIVATE_KEYS = new Set([
  "accesstoken", "apikey", "audiobytes", "authorization", "authstate", "base64", "binary",
  "blob", "body", "bytes", "chainofthought", "chatbody", "chatcontent", "chatmessages",
  "clientsecret", "content", "contents", "cookie", "credential", "credentials", "datauri",
  "documentbody", "documentcontent", "environmentsecrets", "filebody", "filecontent",
  "hiddenreasoning", "history", "imagebytes", "itembody", "media", "mediabytes", "message",
  "messagecontent", "messages", "password",
  "payloadbytes", "privatekey", "prompt", "promptcontent", "prompts", "providercontent",
  "providerhistory", "providerpayload", "providerprivate", "providerprivatecontent",
  "providerprivatedata", "providerrequest", "providerresponse", "rawdiagnostic",
  "rawdiagnostics", "rawlog", "rawlogs", "rawmedia", "rawprovider", "rawprovidercontent",
  "reasoning", "refreshtoken", "responsebody", "rollout", "rollouts", "secret",
  "sessioncookie", "sessionhistory", "sourcecode", "systemprompt", "taskprompt", "text",
  "threadhistory", "token", "toolcalls", "toolresults", "transcript", "transcripts",
  "turncontext", "userprompt",
  "videobytes",
]);
const PRESENTATION_KEYS = new Set([
  "animation", "card", "color", "controllerbinding", "coordinates", "focus", "font", "gaze",
  "geometry", "gesture", "grouping", "handstate", "inputmapping", "layout", "openxr",
  "opacity", "physicalinput", "polling", "position", "refreshcadence", "refreshinterval",
  "roomstate", "rotation", "scale", "sound", "spatialstate", "transform", "typography",
  "vrgeometry",
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const FIELD = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CAUSAL_ID = /^causal-event-[a-f0-9]{64}$/;
const RELATIVE_PATH = /^[A-Za-z0-9._-][A-Za-z0-9._\/-]{0,511}$/;

export class WorkProjectionV2ModelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkProjectionV2ModelError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new WorkProjectionV2ModelError(code, message, details);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail("unknown_field", `${label} has unsupported fields`, { unknown });
}

function string(value, label, maximumLength = 160) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    fail("invalid_string", `${label} must be a non-empty bounded string`);
  }
  return value;
}

function identifier(value, label) {
  string(value, label);
  if (!ID.test(value)) fail("invalid_identifier", `${label} is invalid`);
  return value;
}

function utc(value, label) {
  string(value, label, 64);
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    fail("invalid_timestamp", `${label} must be a UTC timestamp ending in Z`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("invalid_hash", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function canonicalValue(value, ancestors = new WeakSet(), depth = 0) {
  if (depth > 32) fail("invalid_value", "Values cannot exceed 32 nested levels");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) fail("invalid_value", "Values cannot contain cycles");
    ancestors.add(value);
    const normalized = value.map((item) => canonicalValue(item, ancestors, depth + 1));
    ancestors.delete(value);
    return normalized;
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value)) fail("invalid_value", "Values cannot contain cycles");
    ancestors.add(value);
    const normalized = Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) fail("invalid_value", "Values cannot contain undefined");
      return [key, canonicalValue(value[key], ancestors, depth + 1)];
    }));
    ancestors.delete(value);
    return normalized;
  }
  fail("invalid_value", "Values must be JSON-compatible");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedKey(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function privacyScan(value, path = "projection", depth = 0) {
  if (depth > 16) fail("forbidden_payload", "Projection exceeds 16 nested levels");
  if (typeof value === "string") {
    const text = value.trim();
    if (/^(?:data:(?:(?:image|audio|video)\/|application\/octet-stream)|blob:)/i.test(text)
        || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(text)
        || /^(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{16,}$/i.test(text)
        || /^(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}$/i.test(text)
        || (text.length >= 256 && /^[A-Za-z0-9+/]+={0,2}$/.test(text))) {
      fail("forbidden_payload", `Private or inline payload is forbidden at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => privacyScan(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (PRIVATE_KEYS.has(normalized) || PRESENTATION_KEYS.has(normalized)) {
      fail("forbidden_payload", `Field '${key}' is forbidden at ${path}`);
    }
    privacyScan(child, `${path}.${key}`, depth + 1);
  }
}

function array(value, label, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumLength) {
    fail("invalid_array", `${label} must contain at most ${maximumLength} items`);
  }
  return value;
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const identity = key(item);
    if (seen.has(identity)) fail("duplicate_identity", `${label} duplicates '${identity}'`);
    seen.add(identity);
  }
  return seen;
}

function authority(value, label) {
  try {
    validateAuthorityReference(value);
  } catch (error) {
    fail("invalid_authority", `${label} is invalid`, { cause: error.code ?? error.name });
  }
  return canonicalValue(value);
}

function normalizeExternalRefs(value, label, maximumLength, evidenceOnly = false) {
  const refs = array(value, label, maximumLength).map((ref, index) => {
    try {
      validateExternalReference(ref);
    } catch (error) {
      fail("invalid_reference", `${label}[${index}] is invalid`, { cause: error.code ?? error.name });
    }
    if (evidenceOnly && ref.kind !== "artifact") {
      fail("invalid_evidence", `${label}[${index}] must be a hashed artifact reference`);
    }
    if (ref.kind === "artifact") {
      if (ref.authority.artifactSha256 === undefined) {
        fail("invalid_artifact", `${label}[${index}] requires an artifact SHA-256`);
      }
      if (ref.locator !== undefined
          && (!RELATIVE_PATH.test(ref.locator) || ref.locator.split("/").includes(".."))) {
        fail("invalid_artifact", `${label}[${index}].locator must be project-relative`);
      }
    }
    if (ref.kind.startsWith("semantic-")
        && ref.authority.authorityType !== "external-semantic-source") {
      fail("authority_mismatch", `${label}[${index}] semantic reference has the wrong authority`);
    }
    if (ref.kind.startsWith("provider-") && ref.authority.authorityType !== "provider") {
      fail("authority_mismatch", `${label}[${index}] provider reference has the wrong authority`);
    }
    if (ref.kind === "presentation-surface"
        && ref.authority.authorityType !== "presentation") {
      fail("authority_mismatch", `${label}[${index}] surface reference has the wrong authority`);
    }
    return canonicalValue(ref);
  }).sort((left, right) => compareText(canonicalSha256(left), canonicalSha256(right)));
  unique(refs, canonicalSha256, label);
  return refs;
}

function normalizeSubject(value, layer, label) {
  object(value, label);
  exactKeys(value, ["kind", "sourceId", "id"], label);
  string(value.kind, `${label}.kind`, 32);
  if (!SUBJECT_KINDS[layer].has(value.kind)) {
    fail("invalid_subject", `${label}.kind is not valid in the ${layer} layer`);
  }
  return {
    kind: value.kind,
    sourceId: identifier(value.sourceId, `${label}.sourceId`),
    id: identifier(value.id, `${label}.id`),
  };
}

function normalizeTargetRef(value, label) {
  object(value, label);
  exactKeys(value, ["layer", "kind", "sourceId", "id"], label);
  if (!DOMAIN_LAYER_SET.has(value.layer)) fail("invalid_layer", `${label}.layer is invalid`);
  const { layer, ...subject } = value;
  return { layer, ...normalizeSubject(subject, layer, label) };
}

function normalizeField(value, label) {
  string(value, label, 128);
  if (!FIELD.test(value)) fail("invalid_field", `${label} is invalid`);
  const compact = normalizedKey(value);
  const segments = value.split(/[.-]/).map(normalizedKey);
  const privateSegments = new Set([
    "base64", "body", "bytes", "content", "contents", "credential", "credentials",
    "history", "message", "messages", "password", "prompt", "prompts", "rawlog",
    "rawmedia", "reasoning", "secret", "sourcecode", "text", "transcript", "transcripts",
  ]);
  const privateFragments = [
    "providercontent", "providerhistory", "providerpayload", "providerprivate",
    "rawdiagnostic", "rawprovider", "turncontext",
  ];
  if (PRIVATE_KEYS.has(compact) || PRESENTATION_KEYS.has(compact)
      || privateFragments.some((fragment) => compact.includes(fragment))
      || segments.some((segment) => privateSegments.has(segment) || PRESENTATION_KEYS.has(segment))) {
    fail("forbidden_payload", `${label} crosses a private or presentation boundary`);
  }
  return value;
}

function normalizeScalar(value, label) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return string(value, label, 1024);
  fail("invalid_value", `${label} must be a bounded scalar or null`);
}

function normalizeFact(value, layer, index) {
  const label = `layers.${layer}[${index}]`;
  object(value, label);
  exactKeys(value, ["factId", "subject", "field", "value", "targetRefs", "externalRefs"], label);
  const targetRefs = array(value.targetRefs, `${label}.targetRefs`, 16)
    .map((ref, targetIndex) => normalizeTargetRef(ref, `${label}.targetRefs[${targetIndex}]`))
    .sort((left, right) => compareText(canonicalSha256(left), canonicalSha256(right)));
  unique(targetRefs, canonicalSha256, `${label}.targetRefs`);
  const normalized = {
    factId: identifier(value.factId, `${label}.factId`),
    subject: normalizeSubject(value.subject, layer, `${label}.subject`),
    field: normalizeField(value.field, `${label}.field`),
    value: normalizeScalar(value.value, `${label}.value`),
    targetRefs,
    externalRefs: normalizeExternalRefs(
      value.externalRefs,
      `${label}.externalRefs`,
      WORK_PROJECTION_V2_LIMITS.maxExternalRefsPerFact,
    ),
  };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8")
      > WORK_PROJECTION_V2_LIMITS.maxFactValueBytes) {
    fail("fact_too_large", `${label} exceeds the per-fact byte limit`);
  }
  return normalized;
}

function nullableUtc(value, label) {
  return value === null ? null : utc(value, label);
}

function normalizeSummaryDerivation(value, label) {
  object(value, label);
  if (!["source", "deterministic", "model-derived"].includes(value.kind)) {
    fail("invalid_derivation", `${label}.kind is invalid`);
  }
  if (value.kind !== "model-derived") {
    exactKeys(value, ["kind"], label);
    return { kind: value.kind };
  }
  exactKeys(value, ["kind", "provider", "model", "reasoningEffort"], label);
  return {
    kind: value.kind,
    provider: string(value.provider, `${label}.provider`, 96),
    model: string(value.model, `${label}.model`, 128),
    reasoningEffort: string(value.reasoningEffort, `${label}.reasoningEffort`, 32),
  };
}

function normalizeProvenance(value, label) {
  object(value, label);
  exactKeys(value, [
    "sourceSequence", "sourceArtifactSha256", "occurredAtUtc", "observedAtUtc",
    "publishedAtUtc", "heartbeatAtUtc", "semanticUpdatedAtUtc", "evidenceRefs",
    "causalEventIds", "derivation",
  ], label);
  if (value.sourceSequence !== null
      && (!Number.isSafeInteger(value.sourceSequence) || value.sourceSequence < 0)) {
    fail("invalid_sequence", `${label}.sourceSequence must be non-negative or null`);
  }
  if (value.sourceArtifactSha256 !== null) {
    sha256(value.sourceArtifactSha256, `${label}.sourceArtifactSha256`);
  }
  const observedAtUtc = utc(value.observedAtUtc, `${label}.observedAtUtc`);
  const normalized = {
    sourceSequence: value.sourceSequence,
    sourceArtifactSha256: value.sourceArtifactSha256,
    occurredAtUtc: nullableUtc(value.occurredAtUtc, `${label}.occurredAtUtc`),
    observedAtUtc,
    publishedAtUtc: nullableUtc(value.publishedAtUtc, `${label}.publishedAtUtc`),
    heartbeatAtUtc: nullableUtc(value.heartbeatAtUtc, `${label}.heartbeatAtUtc`),
    semanticUpdatedAtUtc: nullableUtc(
      value.semanticUpdatedAtUtc,
      `${label}.semanticUpdatedAtUtc`,
    ),
    evidenceRefs: normalizeExternalRefs(
      value.evidenceRefs,
      `${label}.evidenceRefs`,
      WORK_PROJECTION_V2_LIMITS.maxEvidenceRefsPerFact,
      true,
    ),
    causalEventIds: array(value.causalEventIds, `${label}.causalEventIds`, 16).map((eventId) => {
      if (typeof eventId !== "string" || !CAUSAL_ID.test(eventId)) {
        fail("invalid_causal_id", `${label}.causalEventIds contains an invalid ID`);
      }
      return eventId;
    }).sort(),
    ...(value.derivation === undefined ? {} : {
      derivation: normalizeSummaryDerivation(value.derivation, `${label}.derivation`),
    }),
  };
  unique(normalized.causalEventIds, (item) => item, `${label}.causalEventIds`);
  for (const field of [
    "occurredAtUtc", "publishedAtUtc", "heartbeatAtUtc", "semanticUpdatedAtUtc",
  ]) {
    if (normalized[field] !== null
        && Date.parse(normalized[field]) > Date.parse(observedAtUtc)) {
      fail("invalid_timestamp_order", `${label}.${field} cannot follow observedAtUtc`);
    }
  }
  return normalized;
}

function normalizeFreshness(value, state, provenance, label) {
  object(value, label);
  exactKeys(value, [
    "status", "basis", "basisAtUtc", "evaluatedAtUtc", "ageSeconds",
    "staleAfterSeconds",
  ], label);
  const expectedStatus = FRESHNESS_BY_STATE[state];
  if (value.status !== expectedStatus) {
    fail("freshness_mismatch", `${label}.status must be '${expectedStatus}' for '${state}'`);
  }
  const evaluatedAtUtc = utc(value.evaluatedAtUtc, `${label}.evaluatedAtUtc`);
  const selected = state === "current" || state === "stale";
  if (selected) {
    if (!Object.hasOwn(FRESHNESS_FIELDS, value.basis)) {
      fail("invalid_freshness", `${label}.basis must name an exact source clock`);
    }
    const basisAtUtc = utc(value.basisAtUtc, `${label}.basisAtUtc`);
    if (provenance[FRESHNESS_FIELDS[value.basis]] !== basisAtUtc) {
      fail("invalid_freshness", `${label}.basisAtUtc does not match provenance`);
    }
    if (Date.parse(basisAtUtc) > Date.parse(evaluatedAtUtc)) {
      fail("invalid_freshness", `${label}.basisAtUtc cannot be in the future`);
    }
    const ageSeconds = Math.floor((Date.parse(evaluatedAtUtc) - Date.parse(basisAtUtc)) / 1000);
    if (value.ageSeconds !== ageSeconds) {
      fail("invalid_freshness", `${label}.ageSeconds must be ${ageSeconds}`);
    }
    if (!Number.isInteger(value.staleAfterSeconds) || value.staleAfterSeconds < 1
        || value.staleAfterSeconds > 86_400) {
      fail("invalid_freshness", `${label}.staleAfterSeconds is out of bounds`);
    }
    const calculated = ageSeconds >= value.staleAfterSeconds ? "stale" : "fresh";
    if (value.status !== calculated) {
      fail("invalid_freshness", `${label}.status must be '${calculated}' for its age`);
    }
  } else if (value.basis !== "none" || value.basisAtUtc !== null
      || value.ageSeconds !== null || value.staleAfterSeconds !== null) {
    fail("invalid_freshness", `${label}.${value.status} cannot select a source clock`);
  }
  return {
    status: value.status,
    basis: value.basis,
    basisAtUtc: value.basisAtUtc,
    evaluatedAtUtc,
    ageSeconds: value.ageSeconds,
    staleAfterSeconds: value.staleAfterSeconds,
  };
}

function normalizeConflicts(value, state, expectedAuthority, label) {
  const conflicts = array(value, label, 8).map((item, index) => (
    authority(item, `${label}[${index}]`)
  )).sort((left, right) => compareText(canonicalSha256(left), canonicalSha256(right)));
  unique(conflicts, canonicalSha256, label);
  if ((state === "contradictory" || state === "ambiguous") && conflicts.length < 2) {
    fail("missing_conflict", `${label} requires at least two authorities`);
  }
  if (state === "authority-mismatch") {
    if (conflicts.length < 1
        || conflicts.every((item) => canonicalSha256(item) === canonicalSha256(expectedAuthority))) {
      fail("missing_conflict", `${label} requires a mismatched authority`);
    }
  } else if (!new Set(["contradictory", "ambiguous"]).has(state) && conflicts.length !== 0) {
    fail("unexpected_conflict", `${label} is not valid for '${state}'`);
  }
  return conflicts;
}

function normalizeAuthorityFact(value, index) {
  const label = `layers.authority[${index}]`;
  object(value, label);
  exactKeys(value, [
    "factId", "state", "reasonCode", "expectedAuthority", "selectedAuthority",
    "provenance", "freshness", "conflictingAuthorities",
  ], label);
  const factId = identifier(value.factId, `${label}.factId`);
  if (!FACT_STATES.has(value.state)) fail("invalid_state", `${label}.state is invalid`);
  const expectedAuthority = authority(value.expectedAuthority, `${label}.expectedAuthority`);
  const selected = value.state === "current" || value.state === "stale";
  let selectedAuthority = null;
  if (selected) {
    if (value.selectedAuthority === null) {
      fail("missing_authority", `${label}.${value.state} requires selectedAuthority`);
    }
    selectedAuthority = authority(value.selectedAuthority, `${label}.selectedAuthority`);
    if (canonicalSha256(selectedAuthority) !== canonicalSha256(expectedAuthority)) {
      fail("authority_mismatch", `${label}.selectedAuthority differs from expectedAuthority`);
    }
  } else if (value.selectedAuthority !== null) {
    fail("unsafe_value", `${label}.${value.state} cannot select an authority`);
  }
  if (value.state === "current") {
    if (value.reasonCode !== null) fail("invalid_reason", `${label}.current needs null reasonCode`);
  } else if (typeof value.reasonCode !== "string" || !REASON.test(value.reasonCode)) {
    fail("invalid_reason", `${label}.${value.state} requires a reasonCode`);
  }
  const provenance = normalizeProvenance(value.provenance, `${label}.provenance`);
  if (provenance.derivation?.kind === "model-derived") {
    if (expectedAuthority.authorityType !== "provider"
        || expectedAuthority.sourceId !== provenance.derivation.provider
        || expectedAuthority.externalId !== provenance.derivation.model) {
      fail("authority_mismatch", `${label}.model-derived provenance requires its provider authority`);
    }
  }
  const freshness = normalizeFreshness(value.freshness, value.state, provenance, `${label}.freshness`);
  if (Date.parse(provenance.observedAtUtc) > Date.parse(freshness.evaluatedAtUtc)) {
    fail("invalid_timestamp_order", `${label}.provenance was observed after evaluation`);
  }
  return {
    factId,
    state: value.state,
    reasonCode: value.reasonCode,
    expectedAuthority,
    selectedAuthority,
    provenance,
    freshness,
    conflictingAuthorities: normalizeConflicts(
      value.conflictingAuthorities,
      value.state,
      expectedAuthority,
      `${label}.conflictingAuthorities`,
    ),
  };
}

function normalizeLimits(value, required) {
  if (value === undefined && !required) return { ...WORK_PROJECTION_V2_LIMITS };
  object(value, "limits");
  const keys = Object.keys(WORK_PROJECTION_V2_LIMITS);
  exactKeys(value, keys, "limits");
  for (const key of keys) {
    if (value[key] !== WORK_PROJECTION_V2_LIMITS[key]) {
      fail("invalid_limits", `limits.${key} must equal ${WORK_PROJECTION_V2_LIMITS[key]}`);
    }
  }
  return { ...WORK_PROJECTION_V2_LIMITS };
}

function normalizeLayers(value) {
  object(value, "layers");
  exactKeys(value, WORK_PROJECTION_V2_LAYERS, "layers");
  const layers = Object.fromEntries(DOMAIN_LAYERS.map((layer) => {
    const facts = array(
      value[layer],
      `layers.${layer}`,
      WORK_PROJECTION_V2_LIMITS.maxFactsPerLayer,
    ).map((fact, index) => normalizeFact(fact, layer, index))
      .sort((left, right) => compareText(left.factId, right.factId));
    unique(facts, (fact) => fact.factId, `layers.${layer}`);
    return [layer, facts];
  }));
  const factCount = DOMAIN_LAYERS.reduce((total, layer) => total + layers[layer].length, 0);
  if (factCount > WORK_PROJECTION_V2_LIMITS.maxTotalFacts) {
    fail("too_many_facts", "Projection exceeds the total fact limit");
  }
  layers.authority = array(
    value.authority,
    "layers.authority",
    WORK_PROJECTION_V2_LIMITS.maxTotalFacts,
  ).map(normalizeAuthorityFact).sort((left, right) => compareText(left.factId, right.factId));
  unique(layers.authority, (fact) => fact.factId, "layers.authority");

  const domainFacts = DOMAIN_LAYERS.flatMap((layer) => layers[layer]);
  const factIds = unique(domainFacts, (fact) => fact.factId, "domain facts");
  const authorityByFactId = new Map(layers.authority.map((fact) => [fact.factId, fact]));
  for (const fact of domainFacts) {
    const ownership = authorityByFactId.get(fact.factId);
    if (ownership === undefined) {
      fail("missing_authority", `Fact '${fact.factId}' has no Authority layer record`);
    }
    const hasValue = fact.value !== null
      || fact.targetRefs.length > 0
      || fact.externalRefs.length > 0;
    const selected = ownership.state === "current" || ownership.state === "stale";
    if (selected && !hasValue) {
      fail("missing_value", `Fact '${fact.factId}' has no selected payload`);
    }
    if (!selected && hasValue) {
      fail("unsafe_value", `Fact '${fact.factId}' cannot carry a value in '${ownership.state}'`);
    }
  }
  for (const ownership of layers.authority) {
    if (!factIds.has(ownership.factId)) {
      fail("orphan_authority", `Authority record '${ownership.factId}' has no domain fact`);
    }
  }
  return layers;
}

function normalizeProjection(value, { requireHash }) {
  object(value, "projection");
  privacyScan(value);
  exactKeys(value, [
    "schemaVersion", "contractVersion", "projectionId", "sequence", "publishedAtUtc",
    "limits", "layers", "projectionSha256",
  ], "projection");
  if (value.schemaVersion !== WORK_PROJECTION_V2_SCHEMA_VERSION
      || value.contractVersion !== WORK_PROJECTION_V2_CONTRACT_VERSION) {
    fail("unsupported_contract", "Work Projection v2 contract is unsupported");
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    fail("invalid_sequence", "projection.sequence must be non-negative");
  }
  const publishedAtUtc = utc(value.publishedAtUtc, "projection.publishedAtUtc");
  const layers = normalizeLayers(value.layers);
  for (const ownership of layers.authority) {
    if (ownership.freshness.evaluatedAtUtc !== publishedAtUtc) {
      fail("incoherent_snapshot", `Fact '${ownership.factId}' was evaluated outside the snapshot`);
    }
  }
  const base = {
    schemaVersion: WORK_PROJECTION_V2_SCHEMA_VERSION,
    contractVersion: WORK_PROJECTION_V2_CONTRACT_VERSION,
    projectionId: identifier(value.projectionId, "projection.projectionId"),
    sequence: value.sequence,
    publishedAtUtc,
    limits: normalizeLimits(value.limits, requireHash),
    layers,
  };
  const projectionSha256 = canonicalSha256(base);
  if (requireHash && value.projectionSha256 === undefined) {
    fail("missing_hash", "projection.projectionSha256 is required");
  }
  if (value.projectionSha256 !== undefined) {
    sha256(value.projectionSha256, "projection.projectionSha256");
    if (value.projectionSha256 !== projectionSha256) {
      fail("hash_mismatch", "projection.projectionSha256 does not match canonical content");
    }
  }
  const normalized = { ...base, projectionSha256 };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8")
      > WORK_PROJECTION_V2_LIMITS.maxSnapshotBytes) {
    fail("projection_too_large", "Work Projection v2 exceeds the snapshot byte limit");
  }
  return normalized;
}

export function buildWorkProjectionV2(value) {
  return normalizeProjection(value, { requireHash: false });
}

export function validateWorkProjectionV2(value) {
  return normalizeProjection(value, { requireHash: true });
}

export function canonicalWorkProjectionV2Json(value) {
  return canonicalJson(validateWorkProjectionV2(value));
}

export function workProjectionV2Sha256(value) {
  return (value?.projectionSha256 === undefined
    ? buildWorkProjectionV2(value)
    : validateWorkProjectionV2(value)).projectionSha256;
}

export const buildWorkProjectionV2Model = buildWorkProjectionV2;
export const validateWorkProjectionV2Model = validateWorkProjectionV2;
