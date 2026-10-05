#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPLICATION_ERROR_DEFINITIONS,
  APPLICATION_CONTRACT_VERSION,
  applicationCanonicalJson,
} from "../src/application-contract.mjs";
import { APPLICATION_CAPABILITY_CONTRACT_VERSION } from "../src/application-capabilities.mjs";
import { APPLICATION_EVENT_CONTRACT_VERSION } from "../src/application-event-envelope.mjs";
import { createApplicationGatewayBackend } from "../src/application-gateway-backend.mjs";
import { APPLICATION_GATEWAY_DESCRIPTOR_VERSION } from "../src/application-gateway-descriptor.mjs";
import {
  APPLICATION_FRONTEND_COMPATIBILITY_VERSION,
  validateApplicationFrontendCompatibilityPolicy,
} from "../frontend-kit/source/compatibility.mjs";
import {
  generateApplicationFrontendTypes,
} from "./generate-application-frontend-types.mjs";

export const APPLICATION_FRONTEND_KIT_VERSION = "v0.21.0";

const scriptPath = fileURLToPath(import.meta.url);
const orchestratorRoot = path.resolve(path.dirname(scriptPath), "..");
const schemaRoot = path.join(orchestratorRoot, "schemas");
const kitRoot = path.join(orchestratorRoot, "frontend-kit");
const sourceRoot = path.join(kitRoot, "source");

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

function portableSchema(schema, byReference) {
  let changed = false;
  function visit(value, baseId) {
    if (Array.isArray(value)) return value.map((item) => visit(item, baseId));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key !== "$ref" || typeof item !== "string" || item.startsWith("#")) {
        return [key, visit(item, baseId)];
      }
      const resolved = new URL(item, baseId);
      const fragment = resolved.hash;
      resolved.hash = "";
      const dependency = byReference.get(resolved.href);
      if (!dependency || resolved.href === dependency.id) return [key, item];
      changed = true;
      return [key, `${dependency.id}${fragment}`];
    }));
  }
  const value = visit(schema, schema.$id);
  return changed ? `${JSON.stringify(value, null, 2)}\n` : null;
}

function parseArguments(argv) {
  let output = path.join(kitRoot, "dist");
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--output" || index + 1 >= argv.length) {
      throw new Error(`invalid_argument:${argv[index] ?? "missing"}`);
    }
    output = path.resolve(argv[index += 1]);
  }
  return { output };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function discoverSchemaClosure() {
  const names = (await readdir(schemaRoot))
    .filter((name) => name.endsWith(".schema.json") || /^application-.*\.v\d+\.json$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  const records = [];
  const byReference = new Map();
  for (const name of names) {
    const sourcePath = path.join(schemaRoot, name);
    const raw = await readFile(sourcePath, "utf8");
    const schema = JSON.parse(raw);
    if (typeof schema.$id !== "string") continue;
    const id = new URL(schema.$id, "https://isolate-vscode.local/schemas/").href;
    const record = { name, sourcePath, raw, schema, id };
    records.push(record);
    for (const reference of [id, new URL(name, id).href]) {
      const existing = byReference.get(reference);
      if (existing && existing !== record) {
        throw new Error(`schema_reference_collision:${reference}`);
      }
      byReference.set(reference, record);
    }
  }
  const queue = records.filter((record) => record.name.startsWith("application-"));
  const selected = new Map(queue.map((record) => [record.id, record]));
  for (let index = 0; index < queue.length; index += 1) {
    const record = queue[index];
    for (const reference of references(record.schema)) {
      if (reference.startsWith("#")) continue;
      const resolved = new URL(reference, record.id).href.split("#", 1)[0];
      const dependency = byReference.get(resolved);
      if (!dependency) {
        if (resolved.startsWith("https://isolate-vscode.local/schemas/")) {
          throw new Error(`schema_dependency_missing:${resolved}`);
        }
        continue;
      }
      if (!selected.has(dependency.id)) {
        selected.set(dependency.id, dependency);
        queue.push(dependency);
      }
    }
  }
  return [...selected.values()]
    .map((record) => ({
      ...record,
      packagedRaw: portableSchema(record.schema, byReference) ?? record.raw,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function writeAsset(root, relativePath, bytes, files, kind, schemaId = null) {
  const destination = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  files.push({
    kind,
    path: relativePath,
    bytes: Buffer.byteLength(bytes),
    sha256: sha256(bytes),
    ...(schemaId === null ? {} : { schemaId }),
  });
}

function validateErrorCatalog(catalog, commonSchema) {
  const canonicalCodes = commonSchema.$defs.applicationErrorCode.enum;
  const entries = catalog?.errors;
  if (catalog?.schemaVersion !== 1 || catalog?.catalogVersion !== "v0.1.0"
      || !Array.isArray(entries)) {
    throw new Error("error_catalog_invalid");
  }
  const codes = entries.map((entry) => entry.code);
  if (new Set(codes).size !== codes.length
      || applicationCanonicalJson([...codes].sort())
        !== applicationCanonicalJson([...canonicalCodes].sort())) {
    throw new Error("error_catalog_code_drift");
  }
  for (const entry of entries) {
    const definition = APPLICATION_ERROR_DEFINITIONS[entry.code];
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(entry.code)
        || !["precondition", "execution", "observation", "unknown"].includes(entry.phase)
        || typeof entry.retryable !== "boolean"
        || typeof entry.meaning !== "string" || entry.meaning.length > 512
        || typeof entry.consumerAction !== "string" || entry.consumerAction.length > 512
        || definition.phase !== entry.phase || definition.retryable !== entry.retryable) {
      throw new Error("error_catalog_entry_invalid");
    }
  }
  return catalog;
}

export async function buildApplicationFrontendKit({ output } = {}) {
  const outputRoot = path.resolve(output ?? path.join(kitRoot, "dist"));
  const forbidden = new Set([orchestratorRoot, schemaRoot, kitRoot, sourceRoot]
    .map((value) => path.resolve(value).toLowerCase()));
  if (outputRoot === path.parse(outputRoot).root
      || forbidden.has(outputRoot.toLowerCase())) {
    throw new Error("unsafe_output_path");
  }
  const staging = `${outputRoot}.tmp-${randomUUID()}`;
  const files = [];
  try {
    await mkdir(staging, { recursive: false });
    const packageSource = await readJson(path.join(kitRoot, "package.json"));
    const packageOutput = {
      name: packageSource.name,
      version: packageSource.version,
      description: packageSource.description,
      type: "module",
      sideEffects: false,
      types: "./types/index.d.ts",
      exports: {
        ".": {
          types: "./types/index.d.ts",
          import: "./client/index.mjs",
          default: "./client/index.mjs",
        },
        "./client": {
          types: "./types/index.d.ts",
          import: "./client/index.mjs",
          default: "./client/index.mjs",
        },
        "./testing": "./testing/index.mjs",
        "./testing/agent-workspace": "./testing/agent-workspace.mjs",
        "./desktop": "./desktop/index.mjs",
        "./diagnostics": "./diagnostics/index.mjs",
        "./compatibility": "./compatibility/index.mjs",
        "./manifest": "./manifest.json",
        "./errors": "./errors/error-catalog.v1.json",
        "./capabilities-example": "./examples/capabilities.discovery.v1.json",
        "./schemas/*": "./schemas/*",
      },
      engines: packageSource.engines,
      license: packageSource.license,
    };
    await writeAsset(staging, "package.json",
      `${applicationCanonicalJson(packageOutput)}\n`, files, "package");
    await writeAsset(staging, "README.md",
      await readFile(path.join(kitRoot, "README.md")), files, "documentation");
    await writeAsset(staging, "testing/agent-workspace.mjs",
      await readFile(path.join(sourceRoot, "agent-workspace-fixture.mjs")), files, "client");
    await writeAsset(staging, "docs/gateway-lifecycle.md",
      await readFile(path.join(sourceRoot, "gateway-lifecycle.md")), files, "documentation");
    await writeAsset(staging, "docs/desktop-integration.md",
      await readFile(path.join(sourceRoot, "desktop-integration.md")), files, "documentation");
    await writeAsset(staging, "desktop/index.mjs",
      await readFile(path.join(sourceRoot, "desktop-memory.mjs")), files, "client");
    await writeAsset(staging, "docs/migration-and-rollback.md",
      await readFile(path.join(sourceRoot, "migration-and-rollback.md")), files, "documentation");
    await writeAsset(staging, "client/index.mjs",
      await readFile(path.join(sourceRoot, "client.mjs")), files, "client");
    await writeAsset(staging, "diagnostics/index.mjs",
      await readFile(path.join(sourceRoot, "diagnostic-client.mjs")), files, "diagnostic");
    const pair = {
      applicationContractVersion: APPLICATION_CONTRACT_VERSION,
      capabilityContractVersion: APPLICATION_CAPABILITY_CONTRACT_VERSION,
      gatewayDescriptorVersion: APPLICATION_GATEWAY_DESCRIPTOR_VERSION,
      eventContractVersion: APPLICATION_EVENT_CONTRACT_VERSION,
      supportedUntilUtc: null,
    };
    const compatibilityPolicy = validateApplicationFrontendCompatibilityPolicy({
      schemaVersion: 1,
      contractVersion: APPLICATION_FRONTEND_COMPATIBILITY_VERSION,
      policyId: "application-frontend-kit-compatibility",
      packageName: packageSource.name,
      currentSdkVersion: APPLICATION_FRONTEND_KIT_VERSION,
      pairs: [
        { sdkVersion: APPLICATION_FRONTEND_KIT_VERSION, status: "current", ...pair },
        // v0.21.0 only adds operations and optional fields: a v0.20.0 consumer keeps working.
        { sdkVersion: "v0.20.0", status: "supported", ...pair },
        { sdkVersion: "v0.15.0", status: "supported", ...pair },
        { sdkVersion: "v0.14.0", status: "supported", ...pair },
        { sdkVersion: "v0.12.0", status: "supported", ...pair },
        { sdkVersion: "v0.11.0", status: "supported", ...pair },
        { sdkVersion: "v0.10.0", status: "supported", ...pair },
        { sdkVersion: "v0.9.2", status: "supported", ...pair },
        { sdkVersion: "v0.9.1", status: "supported", ...pair },
        { sdkVersion: "v0.9.0", status: "supported", ...pair },
        { sdkVersion: "v0.8.0", status: "supported", ...pair },
        { sdkVersion: "v0.7.0", status: "supported", ...pair },
        { sdkVersion: "v0.6.0", status: "supported", ...pair },
      ],
      deprecations: [],
    });
    const policyBytes = `${applicationCanonicalJson(compatibilityPolicy)}\n`;
    const policySha256 = sha256(policyBytes.trimEnd());
    await writeAsset(staging, "compatibility/runtime.mjs",
      await readFile(path.join(sourceRoot, "compatibility.mjs")), files, "compatibility");
    await writeAsset(staging, "compatibility/policy.v1.json",
      policyBytes, files, "compatibility-policy");
    await writeAsset(staging, "compatibility/index.mjs", [
      "import { validateApplicationFrontendCompatibilityPolicy } from \"./runtime.mjs\";",
      "export * from \"./runtime.mjs\";",
      `const policy = ${applicationCanonicalJson(compatibilityPolicy)};`,
      "export const APPLICATION_FRONTEND_COMPATIBILITY_POLICY =",
      "  Object.freeze(validateApplicationFrontendCompatibilityPolicy(policy));",
      `export const APPLICATION_FRONTEND_COMPATIBILITY_POLICY_SHA256 = \"${policySha256}\";`,
      "",
    ].join("\n"), files, "compatibility");
    await writeAsset(staging, "testing/fake-backend.mjs",
      await readFile(path.join(sourceRoot, "fake-backend.mjs")), files, "testing");
    await writeAsset(staging, "testing/conformance.mjs",
      await readFile(path.join(sourceRoot, "conformance.mjs")), files, "testing");

    const schemas = await discoverSchemaClosure();
    await writeAsset(staging, "types/index.d.ts",
      generateApplicationFrontendTypes({ schemas }), files, "types");
    const common = schemas.find((entry) => entry.id.endsWith("/application-common.v1.json"));
    if (!common) throw new Error("application_common_schema_missing");
    const catalog = validateErrorCatalog(
      await readJson(path.join(sourceRoot, "error-catalog.v1.json")),
      common.schema,
    );
    await writeAsset(staging, "errors/error-catalog.v1.json",
      `${applicationCanonicalJson(catalog)}\n`, files, "error-catalog");

    const fixedTime = "2026-08-31T00:00:00.000Z";
    const backend = createApplicationGatewayBackend({
      sourceId: "frontend-kit-example",
      sequence: 1,
      publishedAtUtc: fixedTime,
      streamId: "application-global",
      epoch: "frontend-kit-example-epoch",
      now: () => new Date(fixedTime),
    });
    await writeAsset(staging, "examples/capabilities.discovery.v1.json",
      `${applicationCanonicalJson(backend.capabilities)}\n`, files, "example");
    await writeAsset(staging, "testing/default-capabilities.mjs",
      `export const DEFAULT_FAKE_APPLICATION_CAPABILITIES = Object.freeze(${applicationCanonicalJson(backend.capabilities)});\n`,
      files, "testing");
    await writeAsset(staging, "testing/index.mjs", [
      "import { ApplicationFrontendClient } from \"../client/index.mjs\";",
      "import { FakeApplicationBackend } from \"./fake-backend.mjs\";",
      "import { DEFAULT_FAKE_APPLICATION_CAPABILITIES } from \"./default-capabilities.mjs\";",
      "import { runApplicationFrontendConformanceCore } from \"./conformance.mjs\";",
      "export * from \"./fake-backend.mjs\";",
      "export * from \"./conformance.mjs\";",
      "export { DEFAULT_FAKE_APPLICATION_CAPABILITIES };",
      "export function createFakeApplicationBackend(options = {}) {",
      "  const { capabilities = DEFAULT_FAKE_APPLICATION_CAPABILITIES, ...rest } = options;",
      "  return new FakeApplicationBackend({ capabilities: structuredClone(capabilities), ...rest });",
      "}",
      "function createConformanceClient(backend, { now, idFactory }) {",
      "  return new ApplicationFrontendClient({",
      "    resolveDescriptor: backend.resolveDescriptor, fetchImpl: backend.fetch,",
      "    expectedWorkspace: backend.workspace, now, idFactory,",
      "  });",
      "}",
      "export function runApplicationFrontendConformance({",
      "  backendFactory = createFakeApplicationBackend,",
      "  clientFactory = createConformanceClient,",
      "  delayMs = 10,",
      "} = {}) {",
      "  return runApplicationFrontendConformanceCore({",
      "    createBackend: backendFactory, createClient: clientFactory, delayMs,",
      "  });",
      "}",
      "",
    ].join("\n"), files, "testing");

    const outputNames = new Set();
    for (const schema of schemas) {
      const outputName = path.basename(new URL(schema.id).pathname);
      if (outputNames.has(outputName)) throw new Error(`schema_name_collision:${outputName}`);
      outputNames.add(outputName);
      await writeAsset(
        staging, `schemas/${outputName}`, schema.packagedRaw, files, "schema", schema.id,
      );
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
      schemaVersion: 1,
      kitVersion: APPLICATION_FRONTEND_KIT_VERSION,
      packageName: packageOutput.name,
      packageVersion: packageOutput.version,
      capabilityDiscoveryOperation: "discovery.application.capabilities",
      compatibilityPolicySha256: policySha256,
      rootSchemaCount: schemas.filter((entry) => entry.name.startsWith("application-")).length,
      schemaCount: schemas.length,
      files,
    };
    const manifestBytes = `${applicationCanonicalJson(manifest)}\n`;
    await writeFile(path.join(staging, "manifest.json"), manifestBytes, "utf8");
    await rm(outputRoot, { recursive: true, force: true });
    await rename(staging, outputRoot);
    return Object.freeze({
      output: outputRoot,
      manifest,
      manifestSha256: sha256(manifestBytes),
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const options = parseArguments(process.argv.slice(2));
  buildApplicationFrontendKit(options)
    .then((result) => console.log(applicationCanonicalJson({
      status: "built",
      kitVersion: result.manifest.kitVersion,
      schemaCount: result.manifest.schemaCount,
      fileCount: result.manifest.files.length + 1,
      manifestSha256: result.manifestSha256,
    })))
    .catch((error) => {
      console.error(applicationCanonicalJson({
        status: "failed",
        code: /^[a-z0-9_:.-]+$/.test(error?.message ?? "")
          ? error.message
          : "frontend_kit_build_failed",
      }));
      process.exitCode = 1;
    });
}
