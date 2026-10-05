import assert from "node:assert/strict";
import test from "node:test";
import { createAgentArtifactService, createApplicationAgentArtifactHandlers } from "../src/application-agent-artifacts.mjs";

function fixture() {
  const docs = new Map(); let sha = "a".repeat(64), writes = 0;
  const store = { async readDocument({ key }) { return structuredClone(docs.get(key) ?? null); },
    async compareAndSwapDocument({ key, expectedRevision, value }) {
      if ((docs.get(key)?.revision ?? 0) !== expectedRevision) return false;
      docs.set(key, { revision: expectedRevision + 1, value: structuredClone(value) }); writes++; return true;
    } };
  const service = { store, async readAgent({ agentId }) { return { agentId, projectId: agentId === "b" ? "other" : "project" }; } };
  const projectRead = async ({ input }) => ({ projectId: input.projectId, path: input.path,
    contentSha256: sha, text: "public result", range: { totalBytes: 13, returnedBytes: 13, offsetBytes: 0 },
    nextCursor: null, truncated: false });
  const artifacts = createAgentArtifactService({ service, projectRead });
  return { artifacts, handlers: createApplicationAgentArtifactHandlers(artifacts),
    change: () => { sha = "b".repeat(64); }, writes: () => writes };
}
const record = { agentId: "a", artifactId: "result", path: "output/report.md", sha256: "a".repeat(64) };
test("trusted artifact registration is hash-bound, idempotent and never an HTTP writer", async () => {
  const f = fixture();
  await f.artifacts.register(record); await f.artifacts.register(record);
  assert.equal(f.writes(), 1);
  assert.ok(Object.keys(f.handlers).every((key) => key.startsWith("query.")));
  const listed = await f.artifacts.list({ agentId: "a" });
  assert.equal(listed.records.length, 1); assert.equal(listed.coverage, "registered-only");
  assert.equal((await f.artifacts.list({ agentId: "b" })).records.length, 0);
  assert.equal((await f.artifacts.read({ agentId: "a", artifactId: "result" })).page.text, "public result");
  await assert.rejects(f.artifacts.read({ agentId: "b", artifactId: "result" }), { code: "source_unavailable" });
  await assert.rejects(f.artifacts.register({ ...record, path: "another.md" }), { code: "conflict" });
  f.change();
  await assert.rejects(f.artifacts.read({ agentId: "a", artifactId: "result" }), { code: "stale_revision" });
  await assert.rejects(f.artifacts.register({ ...record, artifactId: "new" }), { code: "stale_revision" });
  assert.equal(f.writes(), 1);
});
