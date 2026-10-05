import { CodexConversationArchive } from "./codex-conversation-archive.mjs";
import { listCodexModels, resolveCodexModelProfile } from "./codex-model-catalog.mjs";
import { createFileProviderMutationLease } from "./provider-mutation-lease-store.mjs";
import { applicationCanonicalSha256 as hash } from "./application-contract.mjs";
import { createApplicationProviderInteractionBridge } from "./application-provider-interaction-bridge.mjs";

function fail(code) { throw Object.assign(new Error(code), { code }); }
function verifyProfile(result, profile) {
  const model = result?.model ?? result?.thread?.model;
  const effort = result?.reasoningEffort ?? result?.thread?.reasoningEffort
    ?? result?.thread?.config?.model_reasoning_effort;
  if (model !== profile.model || effort !== profile.reasoningEffort) fail("memory_profile_conflict");
}
export async function createProjectMemoryCodex({ client, controllerRoot, sourceId,
  providerSourceId, workspacePath, instanceId, archive, assertVisible, resolveWorkspace, descriptor, onInteractionChanged }) {
  const captures = new Map(), localThreads = new Set();
  const interactions = new Map();
  const { lease } = await createFileProviderMutationLease({ controllerRoot, projectId: sourceId });
  const captureFor = (agent) => {
    let capture = captures.get(agent.agentId);
    if (!capture) {
      capture = new CodexConversationArchive({ archive, client, binding: agent.binding });
      capture.observe(); captures.set(agent.agentId, capture);
    }
    return capture;
  };
  const preflight = async (profile) => {
    if (profile.provider !== "openai" || profile.fallbackPolicy !== "deny") fail("memory_provider_unavailable");
    await assertVisible();
    const selected = resolveCodexModelProfile(await listCodexModels(client), profile);
    if (selected.model !== profile.model) fail("memory_profile_conflict");
  };
  const interactionFor = async (agent) => {
    if (!descriptor) fail("memory_provider_unavailable");
    if (!interactions.has(agent.agentId)) {
      const capture = captureFor(agent);
      interactions.set(agent.agentId, createApplicationProviderInteractionBridge({
        controllerRoot, projectId: sourceId, client, descriptor,
        target: { sourceId: providerSourceId, threadId: agent.binding.threadId },
        conversationId: capture.conversationId, archive: capture,
        onChanged: onInteractionChanged,
      }));
    }
    return interactions.get(agent.agentId);
  };
  return {
    preflight,
    ...(resolveWorkspace ? { resolveWorkspace } : {}),
    async create(agent) {
      const workspace = resolveWorkspace ? await resolveWorkspace(agent) : { workspacePath };
      const result = await client.startThread({ cwd: workspace.workspacePath, model: agent.profile.model,
        ...(descriptor ? { approvalPolicy: "on-request" } : {}),
        allowProviderModelFallback: false, config: { model_reasoning_effort: agent.profile.reasoningEffort } });
      const threadId = result?.thread?.id;
      if (typeof threadId !== "string" || !threadId) fail("memory_invalid_observation");
      verifyProfile(result, agent.profile);
      localThreads.add(threadId);
      return { projectId: sourceId, sourceId: providerSourceId, providerId: "codex", threadId };
    },
    async send({ agent, operation, text }) {
      await preflight(agent.profile);
      const workspace = resolveWorkspace ? await resolveWorkspace(agent) : { workspacePath };
      if (resolveWorkspace && workspace.workspaceKey !== agent.workspaceKey) fail("memory_workspace_conflict");
      const threadId = agent.binding.threadId;
      if (!localThreads.has(threadId)) {
        const resumed = await client.resumeThread(threadId, {
          cwd: workspace.workspacePath,
          ...(descriptor ? { approvalPolicy: "on-request" } : {}),
          model: agent.profile.model, allowProviderModelFallback: false,
          config: { model_reasoning_effort: agent.profile.reasoningEffort },
        });
        if (resumed?.thread?.id !== threadId) fail("memory_identity_conflict");
        verifyProfile(resumed, agent.profile);
        localThreads.add(threadId);
      }
      const capture = captureFor(agent);
      if (descriptor) await interactionFor(agent);
      await capture.flush();
      const owner = { sourceId: providerSourceId, runtimeInstanceId: instanceId, threadId,
        operation: "memory.agent.send", operationId: operation.operationId, correlationId: operation.operationId };
      const intentSha256 = hash({ agentId: agent.agentId, ...operation });
      const acquired = await lease.acquire({ owner, intentSha256 });
      if (!acquired.mutationAllowed) fail("memory_uncertain_outcome");
      try {
        const result = await client.startTurn(threadId, [{ type: "text", text }], {
          model: agent.profile.model, effort: agent.profile.reasoningEffort,
          clientUserMessageId: operation.operationId,
          allowProviderModelFallback: false,
        });
        const turnId = result?.turn?.id;
        if (typeof turnId !== "string" || !turnId) fail("memory_invalid_observation");
        capture.recordDelivery({ requestId: operation.operationId, deliveryState: "accepted", turnId });
        await capture.flush();
        await lease.release({ owner, intentSha256, leaseId: acquired.record.leaseId,
          outcome: "applied", receiptSha256: hash({ threadId, turnId }) });
        return { turnId, state: result.turn.status === "inProgress" ? "started" : "accepted" };
      } catch (error) {
        await lease.release({ owner, intentSha256, leaseId: acquired.record.leaseId,
          outcome: "uncertain" }).catch(() => {});
        throw error;
      }
    },
    async observe({ agent, operation }) {
      const result = await client.readThread(agent.binding.threadId, true);
      if (result?.thread?.id !== agent.binding.threadId) fail("memory_identity_conflict");
      const turn = result.thread.turns?.find((entry) => entry.id === operation.turnId);
      if (!turn) fail("memory_invalid_observation");
      const capture = captureFor(agent);
      for (const item of turn.items ?? []) await capture.recordItem(turn, item);
      await capture.flush();
      return { turnId: turn.id, state: turn.status === "inProgress" ? "started" : turn.status };
    },
    async capture(agent) {
      const capture = captureFor(agent);
      if (agent.operations?.length) await capture.synchronize({ limit: 32, maxPages: 64 });
      await capture.flush();
    },
    async interrupt({ agent, operation }) {
      await assertVisible();
      await client.interruptTurn(agent.binding.threadId, operation.turnId);
    },
    ...(descriptor ? {
      // A catalog read must not instantiate a bridge, recover its journal, or
      // subscribe a session. Unknown observation remains unavailable, not zero.
      async interactionSummary(agent) {
        const bridge = await interactions.get(agent.agentId);
        if (!bridge) fail("memory_provider_unavailable");
        return bridge.summary();
      },
      async listInteractions(agent, input) { return (await interactionFor(agent)).list(input); },
      async respondInteraction(agent, input) {
        await assertVisible();
        return (await interactionFor(agent)).respond(input);
      },
    } : {}),
    async close() {
      for (const pending of interactions.values()) {
        const bridge = await pending.catch(() => null);
        await bridge?.close();
      }
      for (const capture of captures.values()) await capture.close();
    },
  };
}
