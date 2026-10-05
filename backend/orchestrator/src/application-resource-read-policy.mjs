import path from "node:path";
import { lstat, realpath } from "node:fs/promises";

import {
  ApplicationContractError,
  applicationCanonicalSha256,
} from "./application-contract.mjs";

export const APPLICATION_RESOURCE_READ_POLICY_VERSION = "v0.1.0";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const AUTHORITY_TYPES = new Set(["coordination-core", "child-workspace", "git-repository"]);

function fail(message, details = {}) {
  throw new ApplicationContractError("access_denied", message, details);
}

function exact(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const fields = Object.keys(value).filter((key) => !allowed.includes(key));
  if (fields.length > 0) fail(`${label} contains unsupported fields`, { fields });
}

function safePrefix(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
      || path.isAbsolute(value) || value.includes("\\") || value.includes(":")
      || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("read policy contains an unsafe relative prefix");
  }
  return value.replace(/\/$/u, "");
}

function publicPolicy(definition) {
  return {
    schemaVersion: 1,
    contractVersion: APPLICATION_RESOURCE_READ_POLICY_VERSION,
    scope: definition.scope,
    rootId: definition.rootId,
    readPolicyId: definition.readPolicyId,
    sourceId: definition.sourceId,
    authorityTypes: [...definition.authorityTypes].sort(),
    allowedPrefixes: [...definition.allowedPrefixes].sort(),
    revision: definition.revision,
  };
}

export async function createApplicationResourceReadPolicy(definition) {
  exact(definition, [
    "scope", "rootId", "rootPath", "readPolicyId", "sourceId",
    "authorityTypes", "allowedPrefixes", "revision",
  ], "resource read policy");
  if (!["artifact", "project"].includes(definition.scope)) fail("read policy scope is unsupported");
  for (const field of ["rootId", "readPolicyId", "sourceId"]) {
    if (typeof definition[field] !== "string" || !ID.test(definition[field])) fail(`${field} is invalid`);
  }
  if (!path.isAbsolute(definition.rootPath)) fail("resource root must be an absolute registered path");
  if (!Array.isArray(definition.authorityTypes) || definition.authorityTypes.length < 1
      || definition.authorityTypes.some((value) => !AUTHORITY_TYPES.has(value))
      || new Set(definition.authorityTypes).size !== definition.authorityTypes.length) {
    fail("read policy authority types are invalid");
  }
  if (!Array.isArray(definition.allowedPrefixes) || definition.allowedPrefixes.length < 1
      || definition.allowedPrefixes.length > 32) fail("read policy prefixes are invalid");
  if (definition.scope === "project") {
    exact(definition.revision, ["schemaVersion", "kind", "value"], "project root revision");
    if (definition.revision.schemaVersion !== 1
        || !["git-commit", "sha256", "opaque"].includes(definition.revision.kind)
        || typeof definition.revision.value !== "string"
        || definition.revision.value.length < 1 || definition.revision.value.length > 256) {
      fail("project root revision is invalid");
    }
  } else if (definition.revision !== null) {
    fail("artifact root policy revision must be null");
  }
  const allowedPrefixes = definition.allowedPrefixes.map(safePrefix);
  if (new Set(allowedPrefixes).size !== allowedPrefixes.length) fail("read policy prefixes are duplicated");
  const rootPath = path.resolve(definition.rootPath);
  const rootLstat = await lstat(rootPath);
  if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) fail("registered root must be a real directory");
  const canonicalRoot = await realpath(rootPath);
  const normalized = {
    ...definition,
    rootPath,
    canonicalRoot,
    authorityTypes: [...definition.authorityTypes],
    allowedPrefixes,
    revision: structuredClone(definition.revision),
  };
  const publicValue = publicPolicy(normalized);
  return Object.freeze({
    ...normalized,
    authorityTypes: Object.freeze(normalized.authorityTypes),
    allowedPrefixes: Object.freeze(normalized.allowedPrefixes),
    revision: normalized.revision === null ? null : Object.freeze(normalized.revision),
    sourceBinding: Object.freeze({
      rootId: normalized.rootId,
      rootIdentitySha256: applicationCanonicalSha256({
        rootId: normalized.rootId,
        canonicalRoot,
      }),
      readPolicyId: normalized.readPolicyId,
      readPolicySha256: applicationCanonicalSha256(publicValue),
    }),
  });
}

export function assertApplicationResourcePolicy(policy, request) {
  const relativePath = request.resource.nativeId;
  if ((policy.scope === "project"
      && (request.rootId !== policy.rootId || request.readPolicyId !== policy.readPolicyId
        || request.resource.sourceId !== policy.sourceId))
      || !policy.authorityTypes.includes(request.resource.authority.authorityType)
      || !policy.allowedPrefixes.some((prefix) => (
        relativePath === prefix || relativePath.startsWith(`${prefix}/`)
      ))) fail("resource request is outside its registered read policy");
  if (policy.scope === "project" && policy.revision !== null
      && applicationCanonicalSha256(request.resource.revision)
        !== applicationCanonicalSha256(policy.revision)) {
    fail("resource request revision differs from the registered root revision");
  }
  return policy;
}
