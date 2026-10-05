import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";

import {
  APPLICATION_ERROR_DEFINITIONS,
  applicationCanonicalJson,
} from "../src/application-contract.mjs";
import { validateApplicationCapabilityDescriptor } from "../src/application-capabilities.mjs";
import {
  APPLICATION_FRONTEND_CLIENT_METHODS,
  ApplicationFrontendClient,
} from "../frontend-kit/source/client.mjs";
import {
  APPLICATION_FRONTEND_KIT_VERSION,
  buildApplicationFrontendKit,
} from "../scripts/build-application-frontend-kit.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function references(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) references(item, result);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string") result.push(item);
      else references(item, result);
    }
  }
  return result;
}

test("frontend kit build is deterministic, closed and independently readable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "application-frontend-kit-"));
  const first = await buildApplicationFrontendKit({ output: path.join(root, "first") });
  const second = await buildApplicationFrontendKit({ output: path.join(root, "second") });
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.equal(
    applicationCanonicalJson(first.manifest),
    applicationCanonicalJson(second.manifest),
  );
  assert.equal(first.manifest.kitVersion, APPLICATION_FRONTEND_KIT_VERSION);
  assert.ok(first.manifest.rootSchemaCount >= 30);
  assert.ok(first.manifest.schemaCount >= first.manifest.rootSchemaCount);
  assert.ok(first.manifest.files.some((entry) => entry.path === "schemas/application-project-memory.v1.json"));
  assert.ok(first.manifest.files.some((entry) => entry.path === "schemas/application-agent-conversation.v1.json"));
  assert.match(await readFile(path.join(first.output, "types/index.d.ts"), "utf8"), /ApplicationAgentConversationPage/);
  for (const name of ["application-project-workspace", "application-agent-artifacts", "application-agent-events"]) {
    assert.ok(first.manifest.files.some((entry) => entry.path === `schemas/${name}.v1.json`), name);
  }
  assert.match(await readFile(path.join(first.output, "types/index.d.ts"), "utf8"), /ApplicationAgentEventsPage/);
  assert.ok(first.manifest.files.some((entry) => entry.path === "docs/desktop-integration.md"));
  const desktop = await import(pathToFileURL(path.join(first.output, "desktop/index.mjs")).href);
  assert.equal(desktop.projectDesktopMemory(desktop.createDesktopMemoryFixture()).projects.length, 1);
  const workspaceFixture = await import(pathToFileURL(path.join(first.output, "testing/agent-workspace.mjs")).href);
  const samples = workspaceFixture.createAgentWorkspaceFixture();
  assert.equal(samples.evidenceKind, "fixture");
  assert.equal(samples.liveProviderCalls, 0);
  assert.equal(samples.responses["query.agent-events.read"].mode, "snapshot-required");
  assert.equal(samples.responses["query.agent-conversation.resolve"].liveRead.reasonCode, "agent_archived");
  assert.match(await readFile(path.join(first.output, "types/index.d.ts"), "utf8"), /ApplicationMemoryOperationId/);

  for (const entry of first.manifest.files) {
    const bytes = await readFile(path.join(first.output, ...entry.path.split("/")));
    assert.equal(bytes.length, entry.bytes, entry.path);
    assert.equal(sha256(bytes), entry.sha256, entry.path);
  }
  const packageOutput = JSON.parse(await readFile(
    path.join(first.output, "package.json"), "utf8",
  ));
  assert.equal(packageOutput.name, "@isolate-vscode/application-frontend-kit");
  assert.equal(packageOutput.version, "0.21.0");
  assert.equal(packageOutput.types, "./types/index.d.ts");
  assert.equal(packageOutput.exports["."].types, "./types/index.d.ts");
  assert.equal(packageOutput.exports["."].import, "./client/index.mjs");
  assert.equal(packageOutput.exports["./manifest"], "./manifest.json");
  assert.equal(packageOutput.exports["./testing"], "./testing/index.mjs");
  assert.equal(packageOutput.exports["./diagnostics"], "./diagnostics/index.mjs");
  assert.equal(packageOutput.exports["./compatibility"], "./compatibility/index.mjs");
  assert.ok(first.manifest.files.some(
    (entry) => entry.kind === "client" && entry.path === "client/index.mjs",
  ));
  assert.ok(first.manifest.files.some(
    (entry) => entry.kind === "testing" && entry.path === "testing/index.mjs",
  ));
  assert.ok(first.manifest.files.some(
    (entry) => entry.kind === "testing" && entry.path === "testing/conformance.mjs",
  ));
  assert.ok(first.manifest.files.some(
    (entry) => entry.kind === "diagnostic" && entry.path === "diagnostics/index.mjs",
  ));
  assert.ok(first.manifest.files.some(
    (entry) => entry.kind === "compatibility" && entry.path === "compatibility/index.mjs",
  ));
  assert.ok(first.manifest.files.some(
    (entry) => entry.kind === "documentation"
      && entry.path === "docs/migration-and-rollback.md",
  ));
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "..", "frontend-kit",
  );
  const installPackage = JSON.parse(await readFile(
    path.join(packageRoot, "package.json"), "utf8",
  ));
  assert.equal(installPackage.types, "./dist/types/index.d.ts");
  assert.equal(installPackage.exports["."].types, "./dist/types/index.d.ts");
  assert.equal(installPackage.exports["."].import, "./dist/client/index.mjs");
  assert.equal(installPackage.exports["./manifest"], "./dist/manifest.json");
  assert.equal(installPackage.exports["./testing"], "./dist/testing/index.mjs");
  assert.equal(installPackage.exports["./diagnostics"], "./dist/diagnostics/index.mjs");
  assert.equal(installPackage.exports["./compatibility"], "./dist/compatibility/index.mjs");

  const testing = await import(pathToFileURL(
    path.join(first.output, "testing", "index.mjs"),
  ).href);
  const diagnostics = await import(pathToFileURL(
    path.join(first.output, "diagnostics", "index.mjs"),
  ).href);
  assert.equal(typeof diagnostics.ApplicationFrontendDiagnosticClient, "function");
  const fake = testing.createFakeApplicationBackend({
    state: "live",
    now: () => new Date("2026-08-31T00:00:01.000Z"),
  });
  validateApplicationCapabilityDescriptor(fake.capabilities);
  assert.equal(fake.state, "live");

  const capabilityExample = JSON.parse(await readFile(
    path.join(first.output, "examples", "capabilities.discovery.v1.json"), "utf8",
  ));
  const capabilities = validateApplicationCapabilityDescriptor(capabilityExample);
  assert.equal(capabilities.sourceId, "frontend-kit-example");
  assert.ok(capabilities.surface.operations.discovery.some(
    (entry) => entry.operation.operationId === "discovery.application.capabilities",
  ));
  assert.ok(capabilities.extensions.includes(
    "application.gateway.loopback-http-json-ndjson-v1",
  ));
});

test("kit schema references and error catalog remain canonical", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "application-frontend-closure-"));
  const result = await buildApplicationFrontendKit({ output: path.join(root, "kit") });
  const schemaEntries = result.manifest.files.filter((entry) => entry.kind === "schema");
  const schemaIds = new Set(schemaEntries.map((entry) => entry.schemaId));
  for (const entry of schemaEntries) {
    const schema = JSON.parse(await readFile(
      path.join(result.output, ...entry.path.split("/")), "utf8",
    ));
    for (const reference of references(schema)) {
      if (reference.startsWith("#")) continue;
      const resolved = new URL(reference, schema.$id).href.split("#", 1)[0];
      if (resolved.startsWith("https://isolate-vscode.local/schemas/")) {
        assert.ok(schemaIds.has(resolved), `${schema.$id} -> ${resolved}`);
      }
    }
  }

  const catalog = JSON.parse(await readFile(
    path.join(result.output, "errors", "error-catalog.v1.json"), "utf8",
  ));
  assert.deepEqual(
    catalog.errors.map((entry) => entry.code).sort(),
    Object.keys(APPLICATION_ERROR_DEFINITIONS).sort(),
  );
  for (const entry of catalog.errors) {
    assert.deepEqual(
      { phase: entry.phase, retryable: entry.retryable },
      APPLICATION_ERROR_DEFINITIONS[entry.code],
    );
  }
});

test("generated frontend declarations stay bound to schemas and public client methods", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "application-frontend-types-"));
  const result = await buildApplicationFrontendKit({ output: path.join(root, "kit") });
  const declaration = await readFile(
    path.join(result.output, "types", "index.d.ts"), "utf8",
  );
  await transform(declaration, { loader: "ts", format: "esm" });
  assert.ok(result.manifest.files.some(
    (entry) => entry.kind === "types" && entry.path === "types/index.d.ts",
  ));

  const schemas = await Promise.all([
    "application-common.v1.json",
    "application-result.v1.json",
    "application-event-read-result.v1.json",
  ].map(async (name) => JSON.parse(await readFile(
    path.join(result.output, "schemas", name), "utf8",
  ))));
  const expectedLiterals = [
    ...schemas[0].$defs.operationFamily.enum,
    ...schemas[0].$defs.resourceKind.enum,
    ...schemas[0].$defs.applicationErrorCode.enum,
    ...schemas[1].properties.outcome.enum,
    ...schemas[2].properties.mode.enum,
    ...schemas[2].properties.reasonCode.enum,
  ];
  for (const value of new Set(expectedLiterals)) {
    assert.ok(declaration.includes(JSON.stringify(value)), value);
  }
  for (const value of [
    "query.provider.owner-thread.resolve",
    "mutation.provider.owner-turn.start",
    "mutation.provider.owner-turn.steer",
    "receipt.provider.owner-message.read",
  ]) {
    assert.ok(declaration.includes(JSON.stringify(value)), value);
  }
  for (const name of [
    "ApplicationOwnerChatBinding",
    "ApplicationOwnerChatReceipt",
    "ApplicationOwnerChatStartInput",
    "ApplicationOwnerChatSteerInput",
  ]) {
    assert.match(declaration, new RegExp(`interface ${name}\\b`, "u"), name);
  }

  const prototypeMethods = Object.getOwnPropertyNames(ApplicationFrontendClient.prototype)
    .filter((name) => name !== "constructor").sort();
  assert.deepEqual(prototypeMethods, [...APPLICATION_FRONTEND_CLIENT_METHODS].sort());
  for (const method of APPLICATION_FRONTEND_CLIENT_METHODS) {
    assert.match(declaration, new RegExp(`^  ${method}(?:<|\\()`, "mu"), method);
  }
});

test("builder refuses canonical source roots as output", async () => {
  const canonicalSchemas = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "..", "schemas",
  );
  await assert.rejects(
    buildApplicationFrontendKit({ output: canonicalSchemas }),
    (error) => error.message === "unsafe_output_path",
  );
});
