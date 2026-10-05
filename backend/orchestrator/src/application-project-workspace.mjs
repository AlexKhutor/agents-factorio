import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { ApplicationContractError, applicationCanonicalSha256, validateApplicationPayloadPrivacy } from "./application-contract.mjs";
import { ApplicationResourceReader, assertPublicApplicationProjectPath,
  readPublicApplicationProjectDirectory, normalizeApplicationResourceReadError } from "./application-resource-reader.mjs";
import { createApplicationProjectResourceQuery } from "./application-project-resource.mjs";
import { resolveProjectWorkspace } from "./project-workspace-binding.mjs";

export const APPLICATION_PROJECT_WORKSPACE_VERSION = "v0.1.0";
export const APPLICATION_PROJECT_WORKSPACE_OPERATIONS = Object.freeze({
  list: "query.project-workspace.list", read: "query.project-workspace.read",
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const BINDING_REASONS = Object.freeze({
  memory_workspace_required: "workspace_not_bound",
  memory_workspace_conflict: "workspace_binding_conflict",
  ENOENT: "workspace_path_missing",
  ENOTDIR: "workspace_path_missing",
});
function fail(code, details = {}) {
  throw new ApplicationContractError(code, "Project workspace read refused", details);
}
export function createApplicationProjectWorkspaceHandlers({ store, sourceId, instanceId, now = () => new Date(),
  onDiagnostic = () => {} } = {}) {
  if (!store) return {};
  const secret = randomBytes(32);
  const mac = (body) => createHmac("sha256", secret).update(body).digest();
  const encode = (claims) => {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return body + "." + mac(body).toString("base64url");
  };
  const decode = (cursor) => {
    try {
      if (typeof cursor !== "string" || cursor.length > 2048) fail("stale_revision");
      const [body, signature, extra] = cursor.split(".");
      const supplied = Buffer.from(signature, "base64url"), expected = mac(body);
      if (extra !== undefined || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail("stale_revision");
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch { fail("stale_revision"); }
  };
  const handlers = {};
  for (const [kind, operationId] of Object.entries(APPLICATION_PROJECT_WORKSPACE_OPERATIONS)) {
    handlers[operationId] = async (request) => {
      let phase = "input";
      try {
        const input = request?.input, list = kind === "list";
        if (!input || Object.getPrototypeOf(input) !== Object.prototype
            || Object.keys(input).some((key) => !["projectId", "path", "cursor", list ? "limit" : "maximumBytes"].includes(key))
            || typeof input.projectId !== "string" || !ID.test(input.projectId)) fail("conflict");
        const relativePath = input.path === undefined && list ? "" : input.path;
        if (typeof relativePath === 'string' && relativePath.length > 256) fail('conflict');
        if (!(list && relativePath === "")) assertPublicApplicationProjectPath(relativePath);
        const suppliedLimit = input[list ? "limit" : "maximumBytes"];
        const limit = suppliedLimit === undefined ? (list ? 128 : 65536) : suppliedLimit;
        if (!Number.isInteger(limit) || limit < 1 || limit > (list ? 256 : 65536)) fail("conflict");
        validateApplicationPayloadPrivacy(input, { zone: "request-input", operationId });
        phase = "workspace-binding";
        const workspace = await resolveProjectWorkspace(store, input.projectId);
        const identity = applicationCanonicalSha256({ projectId: input.projectId,
          workspaceKey: workspace.workspaceKey, kind, relativePath, limit, instanceId,
          resourceBindingId: request.resourceBindingId ?? null });
        phase = "continuation";
        const previous = input.cursor == null ? null : decode(input.cursor);
        if (previous && (previous.identity !== identity || previous.expiresAt < now().getTime())) fail("stale_revision");
        const offset = previous?.offset ?? 0;
        phase = "resource-read";
        let result, contentSha256, nextOffset, total;
        if (list) {
          const directory = await readPublicApplicationProjectDirectory(workspace.workspacePath, relativePath);
          contentSha256 = directory.contentSha256; total = directory.entries.length;
          if (offset > total) fail("stale_revision");
          const entries = directory.entries.slice(offset, offset + limit);
          nextOffset = offset + entries.length;
          result = { entries, omissionCount: directory.omissionCount, totalEntries: total };
        } else {
          const revision = { schemaVersion: 1, kind: "opaque", value: workspace.workspaceKey };
          const rootId = "bound-project", readPolicyId = "public-project-read-v1";
          const reader = await ApplicationResourceReader.create({ now, policies: [{ scope: "project", rootId,
            rootPath: workspace.workspacePath, readPolicyId, sourceId, authorityTypes: ["child-workspace"],
            allowedPrefixes: [relativePath], revision }] });
          const query = createApplicationProjectResourceQuery({ rootId, readPolicyId, requestedAtUtc: now().toISOString(),
            resource: { schemaVersion: 1, contractVersion: "v0.1.0", resourceKind: "project-file", sourceId,
              nativeId: relativePath, revision, authority: { schemaVersion: 1, authorityType: "child-workspace",
                sourceId, externalId: input.projectId, contractVersion: "v0.1.0" } },
            view: "text-slice", slice: { offsetBytes: 0, maximumBytes: limit } });
          const page = await reader.readProjectPage(query, { offsetBytes: offset });
          contentSha256 = page.contentSha256; total = page.range.totalBytes;
          nextOffset = offset + page.range.returnedBytes;
          result = { text: page.payload.text, range: page.range };
        }
        if (previous && previous.contentSha256 !== contentSha256) fail("stale_revision");
        phase = "binding-recheck";
        if ((await resolveProjectWorkspace(store, input.projectId)).workspaceKey !== workspace.workspaceKey) fail("stale_revision");
        const truncated = nextOffset < total;
        const output = { schemaVersion: 1, contractVersion: APPLICATION_PROJECT_WORKSPACE_VERSION,
          projectId: input.projectId, path: relativePath, kind, contentSha256,
          observedAtUtc: now().toISOString(), ...result, truncated,
          nextCursor: truncated ? encode({ identity, contentSha256, offset: nextOffset,
            expiresAt: now().getTime() + 900000 }) : null };
        phase = "output";
        validateApplicationPayloadPrivacy(output, { zone: "result-output", operationId });
        return output;
      } catch (error) {
        const normalized = normalizeApplicationResourceReadError(error);
        const code = ["access_denied", "stale_revision", "conflict"].includes(normalized?.code)
          ? normalized.code : "source_unavailable";
        const reasonCode = phase === "workspace-binding"
          ? (BINDING_REASONS[error?.code] ?? code) : code;
        try { await onDiagnostic({ schemaVersion: 1, component: "project-workspace", operationId, phase,
          atUtc: now().toISOString(), code, reasonCode,
          requestId: typeof request?.requestId === "string" && ID.test(request.requestId) ? request.requestId : null,
          correlationId: typeof request?.correlationId === "string" && ID.test(request.correlationId) ? request.correlationId : null }); }
        catch { /* Diagnostic failure does not authorize a resource read. */ }
        fail(code, code === "source_unavailable" ? { reasonCode } : {});
      }
    };
  }
  return Object.freeze(handlers);
}
