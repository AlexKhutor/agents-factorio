import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  WORK_PROJECTION_V2_CONTRACT_VERSION,
  WORK_PROJECTION_V2_LAYERS,
  WORK_PROJECTION_V2_LIMITS,
  WORK_PROJECTION_V2_SCHEMA_VERSION,
  buildWorkProjectionV2,
  canonicalWorkProjectionV2Json,
  validateWorkProjectionV2,
  workProjectionV2Sha256,
} from "../src/work-projection-v2-model.mjs";

const PUBLISHED_AT = "2026-08-30T12:00:00.000Z";

function authority(authorityType, sourceId, externalId, extra = {}) {
  return {
    schemaVersion: 1,
    authorityType,
    sourceId,
    externalId,
    contractVersion: "v0.1.0",
    ...extra,
  };
}

function externalRef(owner, kind, locator, relationship = "references") {
  return { schemaVersion: 1, kind, relationship, authority: owner, locator };
}

function fact(factId, kind, field, value, externalRefs = [], targetRefs = []) {
  return {
    factId,
    subject: { kind, sourceId: "orchestrator-development", id: `${factId}-subject` },
    field,
    value,
    targetRefs,
    externalRefs,
  };
}

function provenance({
  observedAtUtc = "2026-08-30T11:59:50.000Z",
  heartbeatAtUtc = null,
  evidenceRefs = [],
  derivation,
} = {}) {
  return {
    sourceSequence: 42,
    sourceArtifactSha256: "a".repeat(64),
    occurredAtUtc: "2026-08-30T11:59:40.000Z",
    observedAtUtc,
    publishedAtUtc: "2026-08-30T11:59:45.000Z",
    heartbeatAtUtc,
    semanticUpdatedAtUtc: "2026-08-30T11:59:40.000Z",
    evidenceRefs,
    causalEventIds: [`causal-event-${"b".repeat(64)}`],
    ...(derivation === undefined ? {} : { derivation }),
  };
}

function ownership(factId, state, owner, options = {}) {
  const selected = state === "current" || state === "stale";
  const source = provenance(options);
  let freshness;
  if (state === "current") {
    freshness = {
      status: "fresh",
      basis: "observed",
      basisAtUtc: source.observedAtUtc,
      evaluatedAtUtc: PUBLISHED_AT,
      ageSeconds: 10,
      staleAfterSeconds: 60,
    };
  } else if (state === "stale") {
    freshness = {
      status: "stale",
      basis: "heartbeat",
      basisAtUtc: source.heartbeatAtUtc,
      evaluatedAtUtc: PUBLISHED_AT,
      ageSeconds: 120,
      staleAfterSeconds: 60,
    };
  } else {
    freshness = {
      status: ["unavailable", "unsupported"].includes(state) ? "unavailable" : "unknown",
      basis: "none",
      basisAtUtc: null,
      evaluatedAtUtc: PUBLISHED_AT,
      ageSeconds: null,
      staleAfterSeconds: null,
    };
  }
  return {
    factId,
    state,
    reasonCode: state === "current" ? null : `${state.replaceAll("-", "_")}_fact`,
    expectedAuthority: owner,
    selectedAuthority: selected ? owner : null,
    provenance: source,
    freshness,
    conflictingAuthorities: options.conflictingAuthorities ?? [],
  };
}

function candidate() {
  const coordination = authority("coordination-core", "controller", "projection-v2");
  const provider = authority("provider", "codex-app-server", "runtime-1");
  const semantic = authority("external-semantic-source", "semantic-fixture", "source-1");
  const repository = authority("git-repository", "orchestrator-repo", "branch-1");
  const presentation = authority("presentation", "diagnostic-client", "surface-owner-1");
  const semanticRefs = [
    externalRef(semantic, "semantic-work-item", "semantic://items/2"),
    externalRef(semantic, "semantic-workstream", "semantic://streams/1"),
  ];
  const work = fact(
    "work-state", "work-item", "work.lifecycle-state", "in-progress", semanticRefs,
    [{ layer: "work", kind: "task", sourceId: "orchestrator-development", id: "task-1" }],
  );
  const execution = fact(
    "execution-state", "execution", "execution.lifecycle-state", "running",
    [externalRef(provider, "provider-thread", "provider://threads/thread-1")],
  );
  const artifact = fact("artifact-state", "artifact", "artifact.availability", null);
  const attention = fact("attention-state", "attention-event", "attention.rank", null);
  const surface = fact(
    "surface-state", "document", "surface.reference", "document-1",
    [externalRef(presentation, "presentation-surface", "surface://documents/1")],
  );
  return {
    schemaVersion: WORK_PROJECTION_V2_SCHEMA_VERSION,
    contractVersion: WORK_PROJECTION_V2_CONTRACT_VERSION,
    projectionId: "work-projection-v2-fixture",
    sequence: 7,
    publishedAtUtc: PUBLISHED_AT,
    layers: {
      work: [work],
      execution: [execution],
      artifact: [artifact],
      attention: [attention],
      surface: [surface],
      authority: [
        ownership("surface-state", "current", presentation),
        ownership("attention-state", "unknown", coordination),
        ownership("artifact-state", "unavailable", repository),
        ownership("execution-state", "stale", provider, {
          heartbeatAtUtc: "2026-08-30T11:58:00.000Z",
        }),
        ownership("work-state", "current", coordination),
      ],
    },
  };
}

function modelError(code) {
  return (error) => {
    assert.equal(error.name, "WorkProjectionV2ModelError");
    assert.equal(error.code, code);
    return true;
  };
}

test("v2 keeps six bounded layers and exact per-fact authority metadata", () => {
  const projection = buildWorkProjectionV2(candidate());

  assert.equal(projection.schemaVersion, 2);
  assert.equal(projection.contractVersion, "v0.2.0");
  assert.deepEqual(Object.keys(projection.layers), WORK_PROJECTION_V2_LAYERS);
  assert.deepEqual(projection.limits, WORK_PROJECTION_V2_LIMITS);
  assert.match(projection.projectionSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateWorkProjectionV2(projection), projection);
  assert.equal(workProjectionV2Sha256(projection), projection.projectionSha256);

  const domainFacts = WORK_PROJECTION_V2_LAYERS
    .filter((layer) => layer !== "authority")
    .flatMap((layer) => projection.layers[layer]);
  assert.deepEqual(
    projection.layers.authority.map((item) => item.factId),
    domainFacts.map((item) => item.factId).sort(),
  );
  const states = Object.fromEntries(projection.layers.authority.map((item) => [
    item.factId,
    [item.state, item.freshness.status],
  ]));
  assert.deepEqual(states["execution-state"], ["stale", "stale"]);
  assert.deepEqual(states["attention-state"], ["unknown", "unknown"]);
  assert.deepEqual(states["artifact-state"], ["unavailable", "unavailable"]);
  assert.deepEqual(
    new Set(projection.layers.work[0].externalRefs.map((ref) => ref.kind)),
    new Set(["semantic-work-item", "semantic-workstream"]),
  );
});

test("canonical order and hash do not depend on input list or object order", () => {
  const ordered = candidate();
  const workOwner = ordered.layers.authority.find((item) => item.factId === "work-state")
    .expectedAuthority;
  ordered.layers.work.push(fact(
    "work-plan", "work-item", "work.plan-state", "confirmed",
  ));
  ordered.layers.authority.push(ownership("work-plan", "current", workOwner));
  const shuffled = structuredClone(ordered);
  shuffled.layers.work.reverse();
  shuffled.layers.work[1].externalRefs.reverse();
  shuffled.layers.authority.reverse();

  const first = buildWorkProjectionV2(ordered);
  const second = buildWorkProjectionV2(shuffled);
  assert.deepEqual(second, first);
  assert.deepEqual(first.layers.work.map((item) => item.factId), ["work-plan", "work-state"]);
  assert.equal(canonicalWorkProjectionV2Json(second), canonicalWorkProjectionV2Json(first));
  assert.equal(second.projectionSha256, first.projectionSha256);
});

test("stale, unknown, and unavailable remain distinct and fail closed", () => {
  const unknownValue = candidate();
  unknownValue.layers.attention[0].value = "guessed-rank";
  assert.throws(() => buildWorkProjectionV2(unknownValue), modelError("unsafe_value"));

  const staleAsFresh = candidate();
  const stale = staleAsFresh.layers.authority.find((item) => item.factId === "execution-state");
  stale.freshness.status = "fresh";
  assert.throws(() => buildWorkProjectionV2(staleAsFresh), modelError("freshness_mismatch"));

  const missingSelection = candidate();
  missingSelection.layers.authority.find((item) => item.factId === "execution-state")
    .selectedAuthority = null;
  assert.throws(() => buildWorkProjectionV2(missingSelection), modelError("missing_authority"));

  const unavailableSelection = candidate();
  const unavailable = unavailableSelection.layers.authority
    .find((item) => item.factId === "artifact-state");
  unavailable.selectedAuthority = unavailable.expectedAuthority;
  assert.throws(() => buildWorkProjectionV2(unavailableSelection), modelError("unsafe_value"));
});

test("authority joins and the canonical snapshot hash reject partial or changed facts", () => {
  const missing = candidate();
  missing.layers.authority = missing.layers.authority
    .filter((item) => item.factId !== "work-state");
  assert.throws(() => buildWorkProjectionV2(missing), modelError("missing_authority"));

  const orphan = candidate();
  orphan.layers.work = [];
  assert.throws(() => buildWorkProjectionV2(orphan), modelError("orphan_authority"));

  const duplicate = candidate();
  duplicate.layers.surface[0].factId = "work-state";
  assert.throws(() => buildWorkProjectionV2(duplicate), modelError("duplicate_identity"));

  const tampered = buildWorkProjectionV2(candidate());
  tampered.layers.work[0].value = "accepted";
  assert.throws(() => validateWorkProjectionV2(tampered), modelError("hash_mismatch"));
});

test("private content, renderer state, inline media, and unsafe artifact locators are rejected", () => {
  const privateField = candidate();
  privateField.layers.work[0].field = "work.transcript";
  assert.throws(() => buildWorkProjectionV2(privateField), modelError("forbidden_payload"));

  for (const field of ["file.body", "thread.content", "document.text"]) {
    const bodyField = candidate();
    bodyField.layers.surface[0].field = field;
    assert.throws(
      () => buildWorkProjectionV2(bodyField),
      modelError("forbidden_payload"),
      field,
    );
  }

  const privateKey = candidate();
  privateKey.layers.execution[0].providerPrivate = { messages: ["not projection data"] };
  assert.throws(() => buildWorkProjectionV2(privateKey), modelError("forbidden_payload"));

  const inlineMedia = candidate();
  inlineMedia.layers.surface[0].value = ["data", "image/png,AAAA"].join(":");
  assert.throws(() => buildWorkProjectionV2(inlineMedia), modelError("forbidden_payload"));

  const inlineBinary = candidate();
  inlineBinary.layers.artifact[0].value = "data:application/octet-stream;base64,AAAA";
  assert.throws(() => buildWorkProjectionV2(inlineBinary), modelError("forbidden_payload"));

  const opaqueBytes = candidate();
  opaqueBytes.layers.work[0].value = "A".repeat(256);
  assert.throws(() => buildWorkProjectionV2(opaqueBytes), modelError("forbidden_payload"));

  const rendererState = candidate();
  rendererState.layers.surface[0].field = "surface.position";
  assert.throws(() => buildWorkProjectionV2(rendererState), modelError("forbidden_payload"));

  const absoluteArtifact = candidate();
  const artifactOwner = authority("git-repository", "repo", "artifact-1", {
    artifactSha256: "c".repeat(64),
  });
  absoluteArtifact.layers.work[0].externalRefs.push(
    externalRef(artifactOwner, "artifact", "C:/private/report.json"),
  );
  assert.throws(() => buildWorkProjectionV2(absoluteArtifact), modelError("invalid_artifact"));

  const relativeArtifact = candidate();
  const safeRef = externalRef(artifactOwner, "artifact", "artifacts/report.json", "supports");
  relativeArtifact.layers.work[0].externalRefs.push(safeRef);
  relativeArtifact.layers.authority.find((item) => item.factId === "work-state")
    .provenance.evidenceRefs.push(safeRef);
  assert.doesNotThrow(() => buildWorkProjectionV2(relativeArtifact));
});

test("list, text, reference, and advertised contract limits are enforced", () => {
  const longText = candidate();
  longText.layers.work[0].value = "x-".repeat(513);
  assert.throws(() => buildWorkProjectionV2(longText), modelError("invalid_string"));

  const tooManyFacts = candidate();
  tooManyFacts.layers.work = Array.from({ length: 129 }, (_, index) => (
    fact(`work-${index}`, "work-item", "work.lifecycle-state", "planned")
  ));
  assert.throws(() => buildWorkProjectionV2(tooManyFacts), modelError("invalid_array"));

  const tooManyRefs = candidate();
  const semantic = tooManyRefs.layers.work[0].externalRefs[0];
  tooManyRefs.layers.work[0].externalRefs = Array.from({ length: 17 }, (_, index) => ({
    ...structuredClone(semantic),
    locator: `semantic://items/${index}`,
  }));
  assert.throws(() => buildWorkProjectionV2(tooManyRefs), modelError("invalid_array"));

  const changedLimit = candidate();
  changedLimit.limits = { ...WORK_PROJECTION_V2_LIMITS, maxTotalFacts: 513 };
  assert.throws(() => buildWorkProjectionV2(changedLimit), modelError("invalid_limits"));
});

test("model-derived provenance requires its exact bounded provider authority", () => {
  const derivation = {
    kind: "model-derived",
    provider: "openai",
    model: "example-model-max",
    reasoningEffort: "max",
  };
  const provider = authority("provider", derivation.provider, derivation.model);
  const valid = candidate();
  const validOwnership = valid.layers.authority.find((item) => item.factId === "work-state");
  validOwnership.expectedAuthority = provider;
  validOwnership.selectedAuthority = provider;
  validOwnership.provenance.derivation = derivation;
  assert.deepEqual(
    buildWorkProjectionV2(valid).layers.authority
      .find((item) => item.factId === "work-state").provenance.derivation,
    derivation,
  );

  const masquerading = candidate();
  masquerading.layers.authority.find((item) => item.factId === "work-state")
    .provenance.derivation = derivation;
  assert.throws(() => buildWorkProjectionV2(masquerading), modelError("authority_mismatch"));

  const privatePayload = structuredClone(valid);
  privatePayload.layers.authority.find((item) => item.factId === "work-state")
    .provenance.derivation.prompt = "PRIVATE_PROMPT_MARKER";
  assert.throws(() => buildWorkProjectionV2(privatePayload), modelError("forbidden_payload"));

  const missingEffort = structuredClone(valid);
  delete missingEffort.layers.authority.find((item) => item.factId === "work-state")
    .provenance.derivation.reasoningEffort;
  assert.throws(() => buildWorkProjectionV2(missingEffort), modelError("invalid_string"));

  const oversized = structuredClone(valid);
  oversized.layers.authority.find((item) => item.factId === "work-state")
    .provenance.derivation.model = "m".repeat(129);
  assert.throws(() => buildWorkProjectionV2(oversized), modelError("invalid_string"));
});

test("contradictory authority evidence is explicit and cannot select a value", () => {
  const value = candidate();
  const record = value.layers.authority.find((item) => item.factId === "attention-state");
  record.state = "contradictory";
  record.reasonCode = "authoritative_values_disagree";
  record.conflictingAuthorities = [
    record.expectedAuthority,
    authority("human", "project-owner", "owner-1"),
  ];
  const projection = buildWorkProjectionV2(value);
  const conflict = projection.layers.authority
    .find((item) => item.factId === "attention-state");
  assert.equal(conflict.state, "contradictory");
  assert.equal(conflict.selectedAuthority, null);
  assert.equal(conflict.freshness.status, "unknown");

  value.layers.attention[0].value = "guessed";
  assert.throws(() => buildWorkProjectionV2(value), modelError("unsafe_value"));
});

async function readSchema(name) {
  return JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
}

test("the strict v2 schema validates normalized output without changing v1", async () => {
  const names = [
    "authority-reference.schema.json",
    "external-reference.schema.json",
    "work-projection-v2.schema.json",
  ];
  const documents = await Promise.all(names.map(readSchema));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (let index = 0; index < 2; index += 1) {
    ajv.addSchema(documents[index], `https://isolate-vscode.local/schemas/${names[index]}`);
  }
  const validate = ajv.compile(documents[2]);
  const projection = buildWorkProjectionV2(candidate());

  assert.equal(validate(projection), true, JSON.stringify(validate.errors));
  const derived = candidate();
  const derivedOwnership = derived.layers.authority.find((item) => item.factId === "work-state");
  const derivedAuthority = authority("provider", "openai", "example-model-max");
  derivedOwnership.expectedAuthority = derivedAuthority;
  derivedOwnership.selectedAuthority = derivedAuthority;
  derivedOwnership.provenance.derivation = {
    kind: "model-derived",
    provider: "openai",
    model: "example-model-max",
    reasoningEffort: "max",
  };
  const derivedProjection = buildWorkProjectionV2(derived);
  assert.equal(validate(derivedProjection), true, JSON.stringify(validate.errors));
  const invalid = { ...projection, extraLayer: [] };
  assert.equal(validate(invalid), false);
  for (const field of ["file.body", "thread.content", "document.text"]) {
    const bodyProjection = structuredClone(projection);
    bodyProjection.layers.surface[0].field = field;
    assert.equal(validate(bodyProjection), false, field);
  }
  assert.equal(documents[2].properties.schemaVersion.const, 2);
  assert.equal(documents[2].properties.contractVersion.const, "v0.2.0");
  assert.deepEqual(documents[2].$defs.layers.required, WORK_PROJECTION_V2_LAYERS);
  assert.equal(documents[2].$defs.workFacts.maxItems, 128);
  assert.equal(documents[2].$defs.authorityFacts.maxItems, 512);
  assert.equal(documents[2].$defs.limits.properties.maxSnapshotBytes.const, 1048576);
});
