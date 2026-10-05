import { applicationCanonicalSha256 as hash, ApplicationContractError, validateApplicationPayloadPrivacy } from "./application-contract.mjs";
import { assertPublicApplicationProjectPath } from "./application-resource-reader.mjs";
import { normalizeApplicationProjectMemoryError } from "./application-project-memory.mjs";

export const APPLICATION_AGENT_ARTIFACT_VERSION = "v0.1.0";
export const APPLICATION_AGENT_ARTIFACT_OPERATIONS = Object.freeze({
  list: "query.agent-artifacts.list", read: "query.agent-artifacts.read",
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u, SHA = /^[a-f0-9]{64}$/u;
function fail(code) { throw new ApplicationContractError(code, "Agent artifact operation refused"); }
function exact(input, required, optional = []) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || required.some((key) => !Object.hasOwn(input, key))
      || Object.keys(input).some((key) => ![...required, ...optional].includes(key))) fail("conflict");
  for (const key of ["agentId", "artifactId"].filter((key) => Object.hasOwn(input, key))) {
    if (typeof input[key] !== "string" || !ID.test(input[key])) fail("conflict");
  }
}
export function createAgentArtifactService({ service, projectRead, now = () => new Date() }) {
  const catalog = async (agentId) => {
    const agent = await service.readAgent({ agentId }), key = `agent-artifacts-${hash(agentId)}`;
    const doc = await service.store.readDocument({ key })
      ?? { revision: 0, value: { agentId, projectId: agent.projectId, records: [] } };
    if (doc.value.agentId !== agentId || doc.value.projectId !== agent.projectId
        || !Array.isArray(doc.value.records) || doc.value.records.length > 128) fail("source_unavailable");
    for (const record of doc.value.records) {
      exact(record, ["artifactId", "path", "sha256", "sizeBytes", "registeredAtUtc"]);
      assertPublicApplicationProjectPath(record.path);
      if (!SHA.test(record.sha256 ?? "") || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) fail("source_unavailable");
    }
    return { agent, key, doc };
  };
  return {
    // Trusted host/producer only. Never exposed as an Application mutation.
    async register(input) {
      exact(input, ["agentId", "artifactId", "path", "sha256"]);
      assertPublicApplicationProjectPath(input.path);
      if (!SHA.test(input.sha256 ?? "")) fail("conflict");
      for (let attempt = 0; attempt < 8; attempt++) {
        const { agent, key, doc } = await catalog(input.agentId);
        const existing = doc.value.records.find((item) => item.artifactId === input.artifactId);
        if (existing) {
          if (existing.path !== input.path || existing.sha256 !== input.sha256) fail("conflict");
          return structuredClone(existing);
        }
        if (doc.value.records.length >= 128) fail("conflict");
        const page = await projectRead({ input: { projectId: agent.projectId, path: input.path } });
        if (page.contentSha256 !== input.sha256) fail("stale_revision");
        const record = { artifactId: input.artifactId, path: input.path, sha256: input.sha256,
          sizeBytes: page.range.totalBytes, registeredAtUtc: now().toISOString() };
        doc.value.records.push(record);
        if (await service.store.compareAndSwapDocument({ key, expectedRevision: doc.revision, value: doc.value })) return record;
      }
      fail("writer_busy");
    },
    async list(input) {
      exact(input, ["agentId"]);
      const { doc } = await catalog(input.agentId);
      return { schemaVersion: 1, contractVersion: APPLICATION_AGENT_ARTIFACT_VERSION,
        agentId: input.agentId, revision: doc.revision, coverage: "registered-only",
        records: structuredClone(doc.value.records), truncated: false };
    },
    async read(input) {
      exact(input, ["agentId", "artifactId"], ["cursor", "maximumBytes"]);
      const { agent, doc } = await catalog(input.agentId);
      const record = doc.value.records.find((item) => item.artifactId === input.artifactId);
      if (!record) fail("source_unavailable");
      const page = await projectRead({ resourceBindingId: hash({ agentId: input.agentId,
        artifactId: input.artifactId, sha256: record.sha256 }), input: { projectId: agent.projectId, path: record.path,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.maximumBytes === undefined ? {} : { maximumBytes: input.maximumBytes }) } });
      if (page.contentSha256 !== record.sha256) fail("stale_revision");
      return { schemaVersion: 1, contractVersion: APPLICATION_AGENT_ARTIFACT_VERSION,
        agentId: input.agentId, artifactId: input.artifactId, coverage: "registered-reference", page };
    },
  };
}
export function createApplicationAgentArtifactHandlers(artifacts) {
  if (!artifacts) return {};
  return Object.fromEntries(Object.entries(APPLICATION_AGENT_ARTIFACT_OPERATIONS).map(([method, operationId]) =>
    [operationId, async ({ input }) => {
      try {
        validateApplicationPayloadPrivacy(input, { zone: "request-input", operationId });
        const output = await artifacts[method](input);
        validateApplicationPayloadPrivacy(output, { zone: "result-output", operationId });
        return output;
      } catch (error) { throw normalizeApplicationProjectMemoryError(error); }
    }]));
}
