import {
  ADAPTER_CONTRACT_VERSION,
  validateAdapterDescriptor,
} from "../../src/adapter-contracts.mjs";
import { createApplicationAuthenticationState } from "../../src/application-authentication-state.mjs";
import {
  createOmittedProviderConversationContent,
  createVisibleProviderConversationContent,
} from "../../src/provider-conversation-content-policy.mjs";
import { createProviderConversationReadData } from "../../src/provider-conversation-read-data.mjs";
import { conversationReadCapabilityExtension } from "../../src/provider-conversation-read-contract.mjs";
import { createProviderConversationThreadReadResult } from "../../src/provider-conversation-reader.mjs";

const OBSERVED = "2026-08-30T17:00:00.000Z";
const COMPLETE = Object.freeze({ status: "complete", reasonCode: null, nextCursor: null });

function capability(operation, {
  visibility = "headless", recovery = ["none"], conversationRead = true,
} = {}) {
  return {
    operation,
    support: "native",
    contractVersions: [ADAPTER_CONTRACT_VERSION],
    guarantees: [
      "exact-native-identity",
      ...(operation === "observeLifecycle"
        ? ["provider-observed-start", "provider-observed-terminal", "ordered-lifecycle"]
        : []),
    ],
    visibility,
    interruptBehavior: "not-applicable",
    recovery,
    limits: operation === "listThreads" ? { maximumItems: 128 } : {},
    extensions: conversationRead ? [conversationReadCapabilityExtension()] : [],
  };
}

function descriptor() {
  const identity = {
    adapterId: "fake-conversation-provider",
    adapterFamily: "execution-provider",
    adapterVersion: "v0.1.0",
    sourceId: "fake-conversation-provider",
    runtimeInstanceId: "fake-conversation-runtime",
  };
  return validateAdapterDescriptor({
    schemaVersion: 1,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    identity,
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: identity.sourceId,
      externalId: identity.runtimeInstanceId,
      contractVersion: identity.adapterVersion,
    },
    capabilities: [
      capability("discoverCapabilities", { conversationRead: false }),
      capability("listModels"),
      capability("listThreads", { recovery: ["reconnect"] }),
      capability("readThread", { recovery: ["reconnect", "read-after-disconnect"] }),
      capability("getUsage", { recovery: ["reconnect"] }),
      capability("observeLifecycle", {
        visibility: "provider-observed", recovery: ["reconnect"],
      }),
    ],
    capabilitiesObservedAtUtc: OBSERVED,
    capabilitiesValidForSeconds: 3600,
    extensions: [],
  });
}

function ref(provider, kind, externalId) {
  return {
    schemaVersion: 1,
    kind,
    relationship: "provider-owner",
    authority: {
      schemaVersion: 1,
      authorityType: "provider",
      sourceId: provider.sourceId,
      externalId,
      contractVersion: provider.adapterVersion,
    },
  };
}

export class FakeProviderConversationReader {
  #descriptor = descriptor();

  get descriptor() {
    return structuredClone(this.#descriptor);
  }

  get #provider() {
    return this.#descriptor.identity;
  }

  #envelope(kind, data) {
    return createProviderConversationReadData({
      kind,
      provider: this.#provider,
      observedAtUtc: OBSERVED,
      freshness: { status: "fresh", ageSeconds: 0, staleAfterSeconds: 60 },
      data,
    });
  }

  #thread() {
    return {
      threadRef: ref(this.#provider, "provider-thread", "fake-thread"),
      parentThreadRef: null,
      title: "Fake conversation",
      state: "idle",
      archived: false,
      updatedAtUtc: OBSERVED,
      activeTurnRef: null,
    };
  }

  async listModels() {
    return this.#envelope("model-catalog", {
      records: [{
        modelRef: ref(this.#provider, "provider-item", "fake-model"),
        name: "Fake model",
        supportedReasoningEfforts: ["medium", "max"],
        defaultReasoningEffort: "medium",
      }],
      completeness: COMPLETE,
    });
  }

  async readAuthentication() {
    return this.#envelope("authentication", {
      state: createApplicationAuthenticationState({
        providerId: this.#provider.adapterId,
        providerVersion: this.#provider.adapterVersion,
        runtimeInstanceId: this.#provider.runtimeInstanceId,
        status: "authenticated",
        observedAtUtc: OBSERVED,
        capabilities: [{ capabilityId: "status-observation", support: "supported" }],
      }),
    });
  }

  async listThreads() {
    return this.#envelope("thread-catalog", {
      records: [this.#thread()],
      completeness: COMPLETE,
    });
  }

  async readThread() {
    const turnRef = ref(this.#provider, "provider-turn", "fake-turn");
    const threadRead = this.#envelope("thread-read", {
      thread: this.#thread(),
      turns: [{
        turnRef,
        threadRef: ref(this.#provider, "provider-thread", "fake-thread"),
        state: "completed",
        startedAtUtc: "2026-08-30T16:59:00.000Z",
        completedAtUtc: OBSERVED,
        itemCount: 3,
      }],
      completeness: COMPLETE,
    });
    const base = { provider: this.#provider, turnRef, observedAtUtc: OBSERVED };
    return createProviderConversationThreadReadResult({
      provider: this.#provider,
      threadRead,
      content: [
        createVisibleProviderConversationContent({
          ...base,
          itemRef: ref(this.#provider, "provider-item", "fake-user"),
          contentClass: "user-message",
          text: "Inspect the current state",
        }),
        createVisibleProviderConversationContent({
          ...base,
          itemRef: ref(this.#provider, "provider-item", "fake-assistant"),
          contentClass: "assistant-message",
          text: "The state is coherent",
        }),
        createOmittedProviderConversationContent({
          ...base,
          itemRef: ref(this.#provider, "provider-item", "fake-reasoning"),
          omissionReason: "hidden_reasoning",
        }),
      ],
      contentCompleteness: COMPLETE,
    });
  }

  async readUsage() {
    return this.#envelope("usage", {
      availability: "available",
      threadRef: ref(this.#provider, "provider-thread", "fake-thread"),
      turnRef: ref(this.#provider, "provider-turn", "fake-turn"),
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: 120,
      contextWindow: 200_000,
      measuredAtUtc: OBSERVED,
    });
  }
}
