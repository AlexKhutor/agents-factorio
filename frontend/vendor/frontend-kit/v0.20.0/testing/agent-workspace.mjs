// Deterministic DTO samples, not a provider, gateway, or runtime-ready claim.
export function createAgentWorkspaceFixture() {
  const base = { schemaVersion: 1, contractVersion: "v0.1.0" };
  const observedAtUtc = "2026-09-23T12:00:00.000Z";
  const agentId = "example-agent", projectId = "example-project";
  const conversationId = `conversation:${"a".repeat(64)}`;
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const file = { ...base, projectId, path: "result.txt", kind: "read", contentSha256: emptyHash,
    observedAtUtc, text: "", range: { offsetBytes: 0, returnedBytes: 0, totalBytes: 0 },
    truncated: false, nextCursor: null };
  return { evidenceKind: "fixture", liveProviderCalls: 0, responses: {
    "query.agent-conversation.resolve": { ...base, agentId, conversationId,
      archiveCoverage: "captured-only", liveRead: { status: "unavailable", reasonCode: "agent_archived" } },
    "query.project-workspace.read": file,
    "query.project-workspace.list": { ...base, projectId, path: "", kind: "list",
      contentSha256: "b".repeat(64), observedAtUtc, entries: [
        { name: "result.txt", kind: "file", sizeBytes: 0, contentSha256: null }],
      totalEntries: 1, omissionCount: 0, truncated: false, nextCursor: null },
    "query.agent-artifacts.list": { ...base, agentId, revision: 1, coverage: "registered-only",
      records: [{ artifactId: "result", path: "result.txt", sha256: emptyHash, sizeBytes: 0, registeredAtUtc: observedAtUtc }], truncated: false },
    "query.agent-artifacts.read": { ...base, agentId, artifactId: "result", coverage: "registered-reference", page: structuredClone(file) },
    "query.agent-events.read": { ...base, agentId, conversationId, mode: "snapshot-required",
      reasonCode: "initial_snapshot_required", coverage: "observed-only", events: [], hasMore: false,
      nextCursor: "fixture-only-not-valid-on-gateway", observedAtUtc },
  } };
}
