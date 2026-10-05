import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  classifyAppServerStartupFailure,
} from "./app-server-failure-classification.mjs";
import { BackendConsumerClient } from "./backend-consumer-api.mjs";
import { createApplicationGatewayReadHandlers } from "./application-gateway-read-bridge.mjs";
import {
  createApplicationGatewayDomainHandlers,
} from "./application-gateway-domain-bridge.mjs";
import {
  createApplicationGatewayProviderMutationBridge,
} from "./application-gateway-provider-mutation-bridge.mjs";
import {
  createApplicationOwnerChatBridge,
  resolveApplicationOwnerChatTarget,
} from "./application-owner-chat.mjs";
import {
  createApplicationProviderInteractionBridge,
} from "./application-provider-interaction-bridge.mjs";
import { ApplicationResourceReader } from "./application-resource-reader.mjs";
import { ApplicationResourceService } from "./application-resource-service.mjs";
import { createConversationArchive } from "./conversation-archive.mjs";
import { CodexConversationArchive } from "./codex-conversation-archive.mjs";
import { createApplicationConversationArchiveHandlers } from "./application-conversation-archive.mjs";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import {
  CodexAppServerConversationReadAdapter,
} from "./codex-app-server-conversation-read-adapter.mjs";
import {
  CodexAppServerExecutionProviderAdapter,
} from "./codex-app-server-execution-provider-adapter.mjs";
import { projectApplicationProviderOperationState } from "./application-provider-state.mjs";
import { resolveExtensionCodexCommand } from "./codex-executable-resolution.mjs";
import { WorkProjectionV2Client } from "./work-projection-v2-client.mjs";
import { createProjectMemoryService } from "./project-memory-service.mjs";
import { createProjectMemoryCodex } from "./project-memory-codex.mjs";
import { resolveProjectWorkspace } from "./project-workspace-binding.mjs";
import { createApplicationAgentControlHandlers } from "./application-agent-control.mjs";
import { createApplicationAgentConversationHandlers } from "./application-agent-conversation.mjs";
import { createApplicationAgentEventBridge } from "./application-agent-events.mjs";
import { createApplicationProjectWorkspaceHandlers } from "./application-project-workspace.mjs";
import { APPLICATION_PROJECT_WORKSPACE_SAVE_OPERATION,
  createApplicationProjectWorkspaceSaveHandler } from "./application-project-workspace-save.mjs";
import { createAgentArtifactService, createApplicationAgentArtifactHandlers } from "./application-agent-artifacts.mjs";
import { createApplicationProjectMemoryHandlers } from "./application-project-memory.mjs";
import { APPLICATION_PROJECT_COPY_OPERATION,
  createApplicationProjectCopyHandler } from "./application-project-copy.mjs";
import { ApplicationGatewayRuntimeFiles, applicationGatewayWorkspaceHash } from "./application-gateway-runtime.mjs";
import { createClaudeProviderRuntime } from "./application-gateway-claude-runtime.mjs";

export const APPLICATION_GATEWAY_READ_RUNTIME_VERSION = "v0.13.0";
export const APPLICATION_GATEWAY_PROVIDERS = Object.freeze(["codex", "claude"]);

const READ_PERMISSIONS = Object.freeze({
  "query.provider.models.list": "allowed",
  "query.provider.threads.list": "allowed",
  "query.provider.thread.read": "allowed",
  "subscription.provider.turn.stream": "allowed",
  "query.provider.usage.read": "allowed",
});
const MUTATION_ADAPTER_FIELDS = new Set([
  "createThreadOptions", "startExecutionHandler", "interruptExecutionHandler",
]);
const DOMAIN_AUTHORITY_FIELDS = new Set([
  "interactionAuthority", "reviewCommentAuthority", "keepCoordinator", "receiptAuthority",
]);

function invalid(message) {
  const error = new Error(message);
  error.code = "source_unavailable";
  throw error;
}

function mutationConfiguration(options, authorityFactory) {
  if (options === null || options === undefined) {
    if (authorityFactory !== null && authorityFactory !== undefined
        && typeof authorityFactory !== "function") {
      invalid("provider mutation authority factory is invalid");
    }
    return {};
  }
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((field) => !MUTATION_ADAPTER_FIELDS.has(field))
      || typeof authorityFactory !== "function") {
    invalid("provider mutation configuration is invalid");
  }
  return { ...options };
}

function domainConfiguration(value) {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !DOMAIN_AUTHORITY_FIELDS.has(field))) {
    invalid("gateway domain authority configuration is invalid");
  }
  return { ...value };
}

function clock(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid("runtime clock is invalid");
  return value;
}

async function resourceService({ repoRoot, sourceId, instanceId, now }) {
  const reader = await ApplicationResourceReader.create({
    now,
    policies: [
      {
        scope: "artifact",
        rootId: "controller-workspace",
        rootPath: repoRoot,
        readPolicyId: "artifact-owner-read-v1",
        sourceId,
        authorityTypes: ["child-workspace", "coordination-core"],
        allowedPrefixes: [
          "knowledge/reports/inbox",
          "coordination/acceptances",
          "coordination/drafts/incidents",
          "coordination/reviews",
        ],
        revision: null,
      },
      {
        scope: "project",
        rootId: "controller-workspace",
        rootPath: repoRoot,
        readPolicyId: "project-owner-read-v1",
        sourceId,
        authorityTypes: ["child-workspace"],
        allowedPrefixes: [
          "orchestrator/src", "orchestrator/docs", "docs",
          "CHANGELOG.md", "project-version.json",
        ],
        revision: {
          schemaVersion: 1,
          kind: "opaque",
          value: `gateway-instance:${instanceId}`,
        },
      },
    ],
  });
  return new ApplicationResourceService({
    reader,
    backendInstanceId: instanceId,
    continuationSecret: randomBytes(32),
    now,
  });
}

// Model-backed work runs only while the Gateway's visible monitor proves this
// exact Gateway process ready (operator-observability.md).
function gatewayVisibility({ repoRoot, instanceId, projectId, now }) {
  const files = new ApplicationGatewayRuntimeFiles({ repoRoot });
  return async () => {
    const monitor = await files.readMonitor();
    const age = monitor ? clock(now).getTime() - Date.parse(monitor.heartbeatAtUtc) : Infinity;
    if (!monitor || monitor.state !== "ready" || monitor.gatewayInstanceId !== instanceId
        || monitor.gatewayProcessId !== process.pid || monitor.projectId !== projectId
        || monitor.workspaceRootSha256 !== applicationGatewayWorkspaceHash(repoRoot)
        || !Number.isFinite(age) || age < -5000 || age > 15000) invalid("observability_unavailable");
    try { process.kill(monitor.processId, 0); } catch { invalid("observability_unavailable"); }
  };
}

async function providerRuntime({
  repoRoot,
  sourceId,
  instanceId,
  now,
  clientFactory,
  mutationAdapterOptions,
  mutationAuthorityFactory,
  ownerChatTarget,
  conversationArchive,
  archiveBinding,
  memoryService,
}) {
  const providerRoot = ownerChatTarget?.workspacePath ?? repoRoot;
  const providerSourceId = ownerChatTarget?.sourceId ?? sourceId;
  const command = process.env.CODEX_EXECUTABLE
    ?? resolveExtensionCodexCommand(providerRoot)
    ?? "codex";
  const codexHome = ownerChatTarget?.codexHome
    ?? path.join(repoRoot, ".project-runtime", "codex-home");
  const client = clientFactory
    ? clientFactory({ command, codexHome, cwd: providerRoot })
    : new CodexAppServerClient({
      command,
      codexHome,
      cwd: providerRoot,
      clientVersion: "0.99.0",
      requestTimeoutMs: 15_000,
      serverRequestTimeoutMs: 24 * 60 * 60 * 1000,
    });
  let executionProvider = null;
  let conversationCapture = null;
  let interactionBridge = null;
  let memoryProvider = null;
  let agentEvents = null;
  try {
    await client.connect();
    const observedAtUtc = clock(now).toISOString();
    executionProvider = new CodexAppServerExecutionProviderAdapter({
      client,
      sourceId: providerSourceId,
      runtimeInstanceId: `gateway-app-server-${instanceId}`,
      capabilitiesObservedAtUtc: observedAtUtc,
      now,
      ...mutationAdapterOptions,
    });
    const conversationReader = new CodexAppServerConversationReadAdapter({
      client,
      descriptor: executionProvider.descriptor,
      now,
    });
    const authentication = await conversationReader.readAuthentication();
    const authenticated = authentication.data.state.status === "authenticated";
    if (authenticated && conversationArchive !== null) {
      conversationCapture = new CodexConversationArchive({
        archive: conversationArchive, binding: archiveBinding, client,
      });
      await conversationCapture.synchronize({ limit: 32, maxPages: 64 });
    }
    const authorities = authenticated && typeof mutationAuthorityFactory === "function"
      ? await mutationAuthorityFactory({ executionProvider, client })
      : {};
    const mutation = createApplicationGatewayProviderMutationBridge({
      executionProvider: authenticated ? executionProvider : null,
      authorities,
    });
    const ownerChat = authenticated && ownerChatTarget !== null
      ? await createApplicationOwnerChatBridge({
        controllerRoot: repoRoot,
        gatewaySourceId: sourceId,
        target: ownerChatTarget,
        client,
        descriptor: executionProvider.descriptor,
        now,
        conversationCapture,
      }) : null;
    interactionBridge = authenticated && ownerChatTarget !== null
        && conversationCapture !== null
      ? await createApplicationProviderInteractionBridge({
        controllerRoot: repoRoot,
        projectId: memoryService?.archive.projectId ?? sourceId,
        client,
        descriptor: executionProvider.descriptor,
        target: { sourceId: ownerChatTarget.sourceId, threadId: ownerChatTarget.threadId },
        conversationId: conversationCapture.conversationId,
        archive: conversationCapture,
        now,
      }) : null;
    const mutationPermissions = Object.fromEntries(mutation.operations
      .filter(({ status }) => status === "enabled")
      .map(({ operationId }) => [operationId, "allowed"]));
    if (authenticated && memoryService) {
      memoryProvider = await createProjectMemoryCodex({ client, controllerRoot: repoRoot,
        sourceId: memoryService.archive.projectId, providerSourceId, workspacePath: providerRoot, instanceId,
        archive: memoryService.archive,
        descriptor: executionProvider.descriptor,
        onInteractionChanged: (record) => agentEvents?.interactionChanged(record),
        resolveWorkspace: (agent) => resolveProjectWorkspace(memoryService.store, agent.projectId),
        assertVisible: gatewayVisibility({ repoRoot, instanceId,
          projectId: memoryService.archive.projectId, now }),
      });
      memoryService.provider = memoryProvider;
      agentEvents = createApplicationAgentEventBridge({ service: memoryService,
        client, providerSourceId, instanceId, now });
    }
    return {
      status: authenticated ? "available" : "unavailable",
      reasonCode: authenticated ? "available" : "provider_authentication_required",
      executionProvider: authenticated ? executionProvider : null,
      conversationReader: authenticated ? conversationReader : null,
      providerStates: authenticated ? [projectApplicationProviderOperationState({
        descriptor: executionProvider.descriptor,
        asOfUtc: clock(now).toISOString(),
        permissions: { ...READ_PERMISSIONS, ...mutationPermissions },
      })] : [],
      authenticationStates: [authentication.data.state],
      mutationHandlers: mutation.handlers,
      mutationStatus: mutation.operations,
      ownerChatHandlers: ownerChat?.handlers ?? {},
      interactionHandlers: interactionBridge?.handlers ?? {},
      agentEventHandlers: agentEvents?.handlers ?? {},
      conversationCapture,
      ownerChatStatus: Object.freeze({
        configured: ownerChatTarget !== null,
        status: ownerChat === null ? "disabled" : "available",
        reasonCode: ownerChat === null ? "not_configured" : "available",
        sourceId: ownerChat?.sourceId ?? null,
      }),
      close: async () => {
        agentEvents?.close();
        await memoryProvider?.close();
        await interactionBridge?.close();
        executionProvider?.dispose();
        await client.close().catch(() => undefined);
        await conversationCapture?.close();
      },
    };
  } catch (error) {
    agentEvents?.close();
    await memoryProvider?.close();
    await interactionBridge?.close();
    executionProvider?.dispose();
    await client.close().catch(() => undefined);
    await conversationCapture?.close();
    return {
      status: "unavailable",
      reasonCode: classifyAppServerStartupFailure(error, {
        unavailableReason: "provider_app_server_unavailable",
      }),
      executionProvider: null,
      conversationReader: null,
      providerStates: [],
      authenticationStates: [],
      mutationHandlers: {},
      mutationStatus: createApplicationGatewayProviderMutationBridge().operations,
      ownerChatHandlers: {},
      interactionHandlers: {},
      agentEventHandlers: {},
      conversationCapture: null,
      ownerChatStatus: Object.freeze({
        configured: ownerChatTarget !== null,
        status: "unavailable",
        reasonCode: ownerChatTarget === null
          ? "not_configured" : "provider_app_server_unavailable",
        sourceId: ownerChatTarget?.sourceId ?? null,
      }),
      close: async () => {},
    };
  }
}

export async function createApplicationGatewayReadRuntime({
  repoRoot,
  sourceId,
  instanceId,
  now = () => new Date(),
  providerClientFactory,
  providerMutationAdapterOptions = null,
  providerMutationAuthorityFactory = null,
  domainAuthorities = null,
  providerSourceId = null,
  provider: providerKind = "codex",
  claude = null,
  onDiagnostic = () => {},
  onProviderDiagnostic = () => {},
} = {}) {
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)
      || typeof sourceId !== "string" || sourceId.length < 1
      || typeof instanceId !== "string" || instanceId.length < 1
      || typeof now !== "function"
      || (providerSourceId !== null
        && (typeof providerSourceId !== "string" || providerSourceId.length < 1))
      || !APPLICATION_GATEWAY_PROVIDERS.includes(providerKind)
      // Claude Code runs the desk agents; the owner chat stays on its own route.
      || (providerKind === "claude" && (providerSourceId !== null || !claude || typeof claude !== "object"))) {
    invalid("gateway read runtime configuration is invalid");
  }
  const mutationAdapterOptions = mutationConfiguration(
    providerMutationAdapterOptions,
    providerMutationAuthorityFactory,
  );
  const configuredDomainAuthorities = domainConfiguration(domainAuthorities);
  const ownerChatTarget = providerSourceId === null ? null
    : await resolveApplicationOwnerChatTarget({
      controllerRoot: repoRoot,
      sourceId: providerSourceId,
    });
  const archiveBinding = ownerChatTarget === null ? null : {
    projectId: sourceId, sourceId: ownerChatTarget.sourceId,
    providerId: "codex", threadId: ownerChatTarget.threadId,
  };
  const conversationArchive = ownerChatTarget === null ? null
    : await createConversationArchive({ controllerRoot: repoRoot, projectId: sourceId, now });
  let memoryService = null;
  try { memoryService = await createProjectMemoryService({ controllerRoot: repoRoot, sourceId, now }); }
  catch { /* Memory availability does not disable existing independent read resources. */ }
  const workProjectionClient = new WorkProjectionV2Client({
    controllerRoot: repoRoot,
    now,
  });
  const backendConsumerClient = new BackendConsumerClient({
    controllerRoot: repoRoot,
    now,
  });
  const resource = await resourceService({ repoRoot, sourceId, instanceId, now });
  const provider = providerKind === "claude" ? await createClaudeProviderRuntime({
    repoRoot, sourceId, instanceId, now, claude, memoryService,
    assertVisible: memoryService ? gatewayVisibility({ repoRoot, instanceId,
      projectId: memoryService.archive.projectId, now }) : async () => invalid("observability_unavailable"),
    readPermissions: READ_PERMISSIONS, onDiagnostic: onProviderDiagnostic,
  }) : await providerRuntime({
    repoRoot,
    sourceId,
    instanceId,
    now,
    clientFactory: providerClientFactory,
    mutationAdapterOptions,
    mutationAuthorityFactory: providerMutationAuthorityFactory,
    ownerChatTarget,
    conversationArchive,
    archiveBinding,
    memoryService,
  });
  const readHandlers = createApplicationGatewayReadHandlers({
    workProjectionClient,
    backendConsumerClient,
    resourceService: resource,
    conversationReader: provider.conversationReader,
    executionProvider: provider.executionProvider,
  });
  const domainHandlers = createApplicationGatewayDomainHandlers({
    conversationReader: provider.conversationReader,
    ...configuredDomainAuthorities,
  });
  const projectResources = createApplicationProjectWorkspaceHandlers({ store: memoryService?.store,
    sourceId, instanceId, now, onDiagnostic });
  const projectSave = memoryService ? {
    [APPLICATION_PROJECT_WORKSPACE_SAVE_OPERATION]: createApplicationProjectWorkspaceSaveHandler({
      store: memoryService.store, readProject: projectResources["query.project-workspace.read"], now,
    }),
  } : {};
  const projectCopy = memoryService ? {
    [APPLICATION_PROJECT_COPY_OPERATION]: createApplicationProjectCopyHandler({ store: memoryService.store }),
  } : {};
  const artifacts = memoryService ? createAgentArtifactService({ service: memoryService, now,
    projectRead: projectResources["query.project-workspace.read"] }) : null;
  const handlers = Object.freeze({
    ...projectResources,
    ...projectSave,
    ...projectCopy,
    ...provider.agentEventHandlers,
    ...createApplicationAgentArtifactHandlers(artifacts),
    ...createApplicationAgentConversationHandlers({ service: memoryService,
      reader: provider.conversationReader, instanceId, now, onDiagnostic,
      ...(provider.conversationProvider ?? {}) }),
    ...createApplicationAgentControlHandlers(memoryService),
    ...(memoryService ? createApplicationProjectMemoryHandlers({ service: memoryService }) : {}),
    ...readHandlers,
    ...domainHandlers,
    ...provider.interactionHandlers,
    ...provider.mutationHandlers,
    ...provider.ownerChatHandlers,
    ...(conversationArchive === null ? {} : createApplicationConversationArchiveHandlers({
      archive: conversationArchive, binding: archiveBinding,
      captureStatus: () => provider.conversationCapture?.captureStatus
        ?? {
          status: "unavailable", reasonCode: "provider_unavailable",
          synchronization: {
            state: "not-started", pagesImported: 0, capturedRecords: 0,
            checkpointRevision: 0, exhausted: false,
          },
        },
    })),
  });
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: APPLICATION_GATEWAY_READ_RUNTIME_VERSION,
    handlers,
    providerStates: structuredClone(provider.providerStates),
    authenticationStates: structuredClone(provider.authenticationStates),
    provider: providerKind,
    providerStatus: Object.freeze({
      status: provider.status,
      reasonCode: provider.reasonCode,
    }),
    mutationStatus: Object.freeze(structuredClone(provider.mutationStatus)),
    ownerChatStatus: provider.ownerChatStatus,
    memoryStatus: { storage: memoryService ? "available" : "unavailable",
      execution: memoryService?.provider ? "available" : "unavailable" },
    projectResourceBinding: Object.freeze({
      rootId: "controller-workspace",
      readPolicyId: "project-owner-read-v1",
      sourceId,
      revision: Object.freeze({
        schemaVersion: 1,
        kind: "opaque",
        value: `gateway-instance:${instanceId}`,
      }),
    }),
    close: provider.close,
  });
}
