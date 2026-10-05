// Generated from canonical Application JSON Schemas. Do not edit.
// Generator contract: v0.9.1

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue; }
export type ApplicationSchemaId = "https://isolate-vscode.local/schemas/adapter-common.v1.json" | "https://isolate-vscode.local/schemas/application-action-preview.v0.1.0.json" | "https://isolate-vscode.local/schemas/application-actor-ref.v1.json" | "https://isolate-vscode.local/schemas/application-agent-artifacts.v1.json" | "https://isolate-vscode.local/schemas/application-agent-control.v1.json" | "https://isolate-vscode.local/schemas/application-agent-conversation.v1.json" | "https://isolate-vscode.local/schemas/application-agent-events.v1.json" | "https://isolate-vscode.local/schemas/application-artifact-resource.v1.json" | "https://isolate-vscode.local/schemas/application-authentication-state.v1.json" | "https://isolate-vscode.local/schemas/application-authorization-ref.v1.json" | "https://isolate-vscode.local/schemas/application-capabilities.v2.json" | "https://isolate-vscode.local/schemas/application-capability-surface.v1.json" | "https://isolate-vscode.local/schemas/application-change-proposal.v0.1.0.json" | "https://isolate-vscode.local/schemas/application-change-receipt.v0.1.0.json" | "https://isolate-vscode.local/schemas/application-common.v1.json" | "https://isolate-vscode.local/schemas/application-compatibility.v1.json" | "https://isolate-vscode.local/schemas/application-concept-map.v1.json" | "https://isolate-vscode.local/schemas/application-conversation-archive.v1.json" | "https://isolate-vscode.local/schemas/application-event-envelope.v1.json" | "https://isolate-vscode.local/schemas/application-event-read-result.v1.json" | "https://isolate-vscode.local/schemas/application-event-timing.v1.json" | "https://isolate-vscode.local/schemas/application-frontend-compatibility.v1.json" | "https://isolate-vscode.local/schemas/application-frontend-migration-receipt.v1.json" | "https://isolate-vscode.local/schemas/application-gateway-descriptor.v2.json" | "https://isolate-vscode.local/schemas/application-gateway-lifecycle.v1.json" | "https://isolate-vscode.local/schemas/application-gateway-security.v1.json" | "https://isolate-vscode.local/schemas/application-interaction-authority-view.v0.1.0.json" | "https://isolate-vscode.local/schemas/application-interaction-request.v0.1.0.json" | "https://isolate-vscode.local/schemas/application-interaction-response.v0.1.0.json" | "https://isolate-vscode.local/schemas/application-interaction-status.v0.1.0.json" | "https://isolate-vscode.local/schemas/application-inverse-proposal.v0.1.0.json" | "https://isolate-vscode.local/schemas/application-operation-ref.v1.json" | "https://isolate-vscode.local/schemas/application-owner-chat.v1.json" | "https://isolate-vscode.local/schemas/application-project-copy.schema.json" | "https://isolate-vscode.local/schemas/application-project-memory.v1.json" | "https://isolate-vscode.local/schemas/application-project-resource.v1.json" | "https://isolate-vscode.local/schemas/application-project-workspace-save.v1.json" | "https://isolate-vscode.local/schemas/application-project-workspace.v1.json" | "https://isolate-vscode.local/schemas/application-provider-interaction.v1.json" | "https://isolate-vscode.local/schemas/application-provider-operations.v1.json" | "https://isolate-vscode.local/schemas/application-provider-state.v1.json" | "https://isolate-vscode.local/schemas/application-request.v1.json" | "https://isolate-vscode.local/schemas/application-resource-read-result.v1.json" | "https://isolate-vscode.local/schemas/application-resource-ref.v1.json" | "https://isolate-vscode.local/schemas/application-resource-service-response.v1.json" | "https://isolate-vscode.local/schemas/application-result.v1.json" | "https://isolate-vscode.local/schemas/application-review-anchor.v0.1.0.json" | "https://isolate-vscode.local/schemas/application-review-comment.v0.1.0.json" | "https://isolate-vscode.local/schemas/application-review-target.v0.1.0.json" | "https://isolate-vscode.local/schemas/application-shadow-decision-report.v1.json" | "https://isolate-vscode.local/schemas/application-shadow-read-report.v1.json" | "https://isolate-vscode.local/schemas/application-shadow-workflow-catalog.v2.json" | "https://isolate-vscode.local/schemas/authority-reference.v1.json" | "https://isolate-vscode.local/schemas/external-reference.v1.json";
export type ApplicationMemoryOperationId = "query.memory.scopes.list" | "query.memory.scope.read" | "mutation.memory.scope.create" | "mutation.memory.scope.write" | "query.memory.agents.list" | "query.memory.agent.read" | "query.memory.agent.context" | "mutation.memory.agent.create" | "mutation.memory.agent.close" | "query.memory.agent.archive" | "mutation.memory.agent.send" | "receipt.memory.agent.send" | "mutation.memory.agent.steer" | "mutation.memory.agent.unqueue" | "mutation.memory.agent.profile" | "query.memory.agent.trace";
export type ApplicationAgentControlOperationId = "query.agent-control.interactions" | "approval.agent-control.respond" | "mutation.agent-control.interrupt";
export type ApplicationAgentConversationOperationId = "query.agent-conversation.resolve" | "query.agent-conversation.read";
export type ApplicationOperationFamily = "discovery" | "query" | "subscription" | "proposal" | "approval" | "mutation" | "receipt-lookup";
export type ApplicationResourceKind = "work-projection" | "backend-snapshot" | "provider-thread" | "provider-turn" | "provider-item" | "artifact" | "project-file" | "project-directory" | "review-operation" | "change-proposal" | "command" | "interaction" | "receipt" | "event";
export type ApplicationErrorCode = "unsupported_capability" | "source_unavailable" | "stale_revision" | "conflict" | "ambiguous" | "access_denied" | "writer_busy" | "uncertain_outcome" | "continuation_required";
export type ApplicationResultOutcome = "succeeded" | "accepted" | "failed" | "uncertain";
export type ApplicationEventMode = "snapshot-required" | "resumed" | "resync-required";
export type ApplicationEventReason = "initial_snapshot_required" | "cursor_invalid" | "stream_mismatch" | "epoch_mismatch" | "cursor_ahead" | "replay_gap";
export type ApplicationExternalReferenceKind = "provider-thread" | "provider-turn" | "provider-item" | "provider-subagent" | "semantic-workstream" | "semantic-work-item" | "semantic-decision" | "presentation-surface" | "artifact";
export type ApplicationOwnerChatOperationId = "query.provider.owner-thread.resolve" | "mutation.provider.owner-turn.start" | "mutation.provider.owner-turn.steer" | "receipt.provider.owner-message.read";
export type ApplicationOwnerChatBindingState = "idle" | "submitting" | "running" | "cancelling" | "awaiting_operator" | "stop_unconfirmed" | "unknown" | "not-started";
export type ApplicationOwnerChatDeliveryState = "requested" | "accepted" | "started" | "completed" | "failed" | "interrupted" | "uncertain" | "unknown";
export type ApplicationProviderInteractionOperationId = "query.application.provider-interactions.read" | "approval.application.interaction.respond";
export type ApplicationProviderInteractionMethod = "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/tool/requestUserInput" | "item/permissions/requestApproval" | "mcpServer/elicitation/request";
export type ApplicationProviderInteractionState = "awaiting-owner" | "response-recorded" | "response-returned" | "resolved" | "expired" | "stale" | "uncertain";
export type ApplicationProviderInteractionKind = "command-approval" | "file-change-approval" | "user-input" | "permission-approval" | "mcp-elicitation";

export type ApplicationProjectWorkspaceOperationId = "query.project-workspace.list" | "query.project-workspace.read";
export type ApplicationAgentArtifactOperationId = "query.agent-artifacts.list" | "query.agent-artifacts.read";
export interface ApplicationProjectWorkspaceListInput { readonly projectId: string; readonly path?: string; readonly limit?: number; readonly cursor?: string | null; }
export interface ApplicationProjectWorkspaceReadInput { readonly projectId: string; readonly path: string; readonly maximumBytes?: number; readonly cursor?: string | null; }
export interface ApplicationProjectWorkspacePageBase { readonly schemaVersion: 1; readonly contractVersion: "v0.1.0"; readonly projectId: string; readonly path: string; readonly contentSha256: string; readonly observedAtUtc: string; readonly truncated: boolean; readonly nextCursor: string | null; }
export interface ApplicationProjectWorkspaceFilePage extends ApplicationProjectWorkspacePageBase { readonly kind: "read"; readonly text: string; readonly range: { readonly offsetBytes: number; readonly returnedBytes: number; readonly totalBytes: number; }; }
export interface ApplicationProjectWorkspaceDirectoryPage extends ApplicationProjectWorkspacePageBase { readonly kind: "list"; readonly omissionCount: number; readonly totalEntries: number; readonly entries: readonly { readonly name: string; readonly kind: "file" | "directory"; readonly sizeBytes: number | null; readonly contentSha256: null; }[]; }
export type ApplicationProjectWorkspacePage = ApplicationProjectWorkspaceFilePage | ApplicationProjectWorkspaceDirectoryPage;
export type ApplicationProjectWorkspaceSaveOperationId = "mutation.project-workspace.save";
export interface ApplicationProjectWorkspaceSaveInput { readonly projectId: string; readonly path: string; readonly expectedSha256: string; readonly text: string; readonly operationId: string; }
export interface ApplicationProjectWorkspaceSaveReceipt { readonly schemaVersion: 1; readonly contractVersion: "v0.1.0"; readonly projectId: string; readonly path: string; readonly operationId: string; readonly previousSha256: string; readonly contentSha256: string; readonly bytesWritten: number; readonly completedAtUtc: string; }
export type ApplicationProjectCopyOperationId = "mutation.memory.project.copy";
export interface ApplicationProjectCopyInput { readonly sourceProjectId: string; readonly targetProjectId: string; readonly targetProjectScopeId: string; readonly quarterScopeIds: Readonly<Record<string, string>>; readonly operationId: string; }
export interface ApplicationProjectCopyReceipt { readonly schemaVersion: 1; readonly outcome: "complete"; readonly sourceProjectId: string; readonly targetProjectId: string; readonly operationId: string; readonly copiedAtUtc: string; readonly scopes: readonly { readonly sourceScopeId: string; readonly targetScopeId: string; readonly kind: "project" | "quarter"; readonly quarterId: string | null; readonly sourceRevision: number; readonly sourceSha256: string; readonly targetRevision: 1; readonly targetSha256: string; }[]; }
export interface ApplicationAgentArtifactRecord { readonly artifactId: string; readonly path: string; readonly sha256: string; readonly sizeBytes: number; readonly registeredAtUtc: string; }
export interface ApplicationAgentArtifactCatalog { readonly schemaVersion: 1; readonly contractVersion: "v0.1.0"; readonly agentId: string; readonly revision: number; readonly coverage: "registered-only"; readonly records: readonly ApplicationAgentArtifactRecord[]; readonly truncated: false; }
export interface ApplicationAgentArtifactPage { readonly schemaVersion: 1; readonly contractVersion: "v0.1.0"; readonly agentId: string; readonly artifactId: string; readonly coverage: "registered-reference"; readonly page: ApplicationProjectWorkspaceFilePage; }
export interface ApplicationAgentEventsPage { readonly schemaVersion: 1; readonly contractVersion: "v0.1.0"; readonly agentId: string; readonly conversationId: string;
 readonly mode: "resumed" | "snapshot-required" | "resync-required";
 readonly reasonCode: null | "initial_snapshot_required" | "cursor_invalid" | "replay_gap"; readonly coverage: "observed-only"; readonly hasMore: boolean; readonly nextCursor: string; readonly observedAtUtc: string;
 readonly events: readonly { readonly sequence: number; readonly turnId: string | null; readonly itemId: string | null; readonly observedAtUtc: string;
 readonly kind: "turn-started" | "turn-completed" | "item-started" | "item-completed" | "interaction-changed"; }[];
}
export interface ApplicationAgentConversationReadInput {
  readonly agentId: string; readonly cursor?: string | null; readonly limit?: number;
}
export interface ApplicationAgentConversationBinding {
  readonly schemaVersion: 1; readonly contractVersion: "v0.1.0";
  readonly agentId: string; readonly conversationId: string | null;
  readonly archiveCoverage: "captured-only";
  readonly liveRead: { readonly status: "available" | "unavailable";
    readonly reasonCode: "available" | "agent_unbound" | "agent_archived" | "provider_unavailable" | "provider_identity_mismatch"; };
}
export interface ApplicationAgentConversationPage {
  readonly schemaVersion: 1; readonly contractVersion: "v0.1.0";
  readonly agentId: string; readonly conversationId: string; readonly mode: "provider-read";
  readonly revision: string; readonly nextCursor: string | null; readonly observedAtUtc: string;
  readonly thread: JsonObject; readonly turns: readonly JsonObject[]; readonly content: readonly JsonObject[];
  readonly completeness: { readonly status: "complete" | "partial" | "metadata-only"; readonly reasonCode: string | null; };
}
export interface ApplicationOperationRef {
  readonly schemaVersion: 1;
  readonly contractVersion: "v0.1.0";
  readonly family: ApplicationOperationFamily;
  readonly operationId: string;
}
export interface ApplicationError {
  readonly code: ApplicationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly phase: "precondition" | "execution" | "observation" | "unknown";
  readonly reasonCode?: "workspace_not_bound" | "workspace_binding_conflict" | "workspace_path_missing";
}
export interface ApplicationRequestEnvelope<TInput extends object = JsonObject> {
  readonly schemaVersion: 1;
  readonly contractVersion: "v0.1.0";
  readonly requestId: string; readonly correlationId: string;
  readonly causationId?: string; readonly operation: ApplicationOperationRef;
  readonly requestedAtUtc: string; readonly deadlineAtUtc?: string;
  readonly input: TInput;
}
export interface ApplicationResultBase {
  readonly schemaVersion: 1;
  readonly contractVersion: "v0.1.0";
  readonly requestId: string; readonly correlationId: string;
  readonly causationId?: string; readonly operation: ApplicationOperationRef;
  readonly startedAtUtc: string; readonly completedAtUtc: string;
  readonly diagnostics: readonly JsonObject[];
}
export type ApplicationResultEnvelope<TOutput = JsonObject> = ApplicationResultBase & (
  | { readonly outcome: "succeeded" | "accepted"; readonly output?: TOutput; readonly error?: never; }
  | { readonly outcome: "failed" | "uncertain"; readonly output?: never; readonly error: ApplicationError; }
);
export interface ApplicationGatewayDescriptor {
  readonly schemaVersion: 1;
  readonly contractVersion: "v0.2.0";
  readonly descriptorId: string; readonly transportId: "loopback-http-json-ndjson-v1";
  readonly publishedAtUtc: string; readonly validUntilUtc: string;
  readonly instance: JsonObject; readonly workspace: JsonObject; readonly endpoint: JsonObject;
  readonly authorization: JsonObject; readonly routes: readonly JsonObject[];
  readonly capabilityDiscovery: JsonObject;
  readonly exposedOperations: readonly ApplicationOperationRef[];
}
export interface ApplicationCapabilityDescriptor {
  readonly schemaVersion: 1;
  readonly contractVersion: "v0.2.0";
  readonly descriptorId: string; readonly sourceId: string; readonly sequence: number;
  readonly publishedAtUtc: string; readonly validForSeconds: number;
  readonly authority: JsonObject; readonly contractRefs: readonly JsonObject[];
  readonly surface: JsonObject; readonly providerOperations: JsonObject;
  readonly providerStates: readonly JsonObject[]; readonly authenticationStates: readonly JsonObject[];
  readonly compatibility: JsonObject; readonly extensions: readonly string[];
}
export interface ApplicationProviderIdentity {
  readonly adapterId: string; readonly adapterVersion: string;
  readonly sourceId: string; readonly runtimeInstanceId: string;
}
export interface ApplicationExecutionProfile {
  readonly model: string; readonly reasoningEffort: string; readonly fallbackPolicy: "deny";
}
export interface ApplicationExternalReference {
  readonly schemaVersion: 1; readonly kind: ApplicationExternalReferenceKind;
  readonly relationship: string; readonly authority: JsonObject;
  readonly locator?: string; readonly label?: string;
}
export interface ApplicationOwnerChatBinding {
  readonly schemaVersion: 1; readonly contractVersion: "v0.2.0";
  readonly sourceId: string; readonly provider: ApplicationProviderIdentity;
  readonly threadRef: ApplicationExternalReference; readonly selection: "existing" | "created";
  readonly selectedAtUtc: string; readonly bindingState: ApplicationOwnerChatBindingState;
  readonly activeTaskId: string | null; readonly activeTurnRef: ApplicationExternalReference | null;
  readonly threadState: "idle" | "active";
  readonly startAvailable: boolean; readonly steerAvailable: boolean;
}
export interface ApplicationOwnerChatReceipt {
  readonly schemaVersion: 1; readonly contractVersion: "v0.2.0";
  readonly receiptId: string; readonly requestId: string; readonly correlationId: string;
  readonly mode: "start" | "steer"; readonly sourceId: string;
  readonly provider: ApplicationProviderIdentity; readonly threadRef: ApplicationExternalReference;
  readonly turnRef: ApplicationExternalReference | null;
  readonly commandState: "prepared" | "accepted" | "not-applied" | "uncertain";
  readonly deliveryState: ApplicationOwnerChatDeliveryState; readonly reasonCode: string | null;
  readonly inputSha256: string; readonly inputByteLength: number; readonly inputCharacterLength: number;
  readonly executionProfile: ApplicationExecutionProfile | null;
  readonly profileCatalogSha256: string | null; readonly profileCatalogObservedAtUtc: string | null;
  readonly requestedAtUtc: string; readonly updatedAtUtc: string; readonly acceptedAtUtc: string | null;
  readonly replay: boolean; readonly automaticRetryAllowed: false; readonly recordSha256: string;
}
export interface ApplicationOwnerChatStartInput {
  readonly provider: ApplicationProviderIdentity; readonly threadRef: ApplicationExternalReference;
  readonly executionProfile: ApplicationExecutionProfile; readonly text: string;
}
export interface ApplicationOwnerChatSteerInput {
  readonly provider: ApplicationProviderIdentity; readonly threadRef: ApplicationExternalReference;
  readonly turnRef: ApplicationExternalReference; readonly text: string;
}
export interface ApplicationOwnerChatReceiptInput { readonly requestId: string; }
export interface ApplicationProviderRequestIdentity {
  readonly method: ApplicationProviderInteractionMethod; readonly requestId: string;
  readonly requestIdType: "number" | "string"; readonly generation: number;
  readonly threadId: string; readonly turnId: string | null; readonly itemId: string | null;
  readonly requestSha256: string;
}
export interface ApplicationProviderInteractionDisplay {
  readonly kind: ApplicationProviderInteractionKind; readonly title: string;
  readonly fields: JsonObject;
}
export interface ApplicationProviderInteractionRecord {
  readonly schemaVersion: 1; readonly contractVersion: "v0.1.0";
  readonly interactionId: string; readonly conversationId: string;
  readonly provider: ApplicationProviderIdentity;
  readonly providerRequest: ApplicationProviderRequestIdentity;
  readonly interactionRequest: JsonObject; readonly display: ApplicationProviderInteractionDisplay;
  readonly state: ApplicationProviderInteractionState; readonly response: JsonObject | null;
  readonly providerResponseSha256: string | null; readonly requestedAtUtc: string;
  readonly deadlineAtUtc: string; readonly updatedAtUtc: string;
  readonly automaticRetryAllowed: false; readonly recordSha256: string;
}
export interface ApplicationAgentAttention { readonly availability: "available" | "unavailable"; readonly coverage: "captured-only";
  readonly sourceSequence: number | null; readonly sourceRevision: number | null; readonly observedAtUtc: string | null;
  readonly pendingQuestions: number | null; readonly pendingApprovals: number | null; readonly recoveryRequired: number | null; }
export interface ApplicationProviderInteractionReadInput { readonly limit?: number; }
export interface ApplicationProviderInteractionReadResult {
  readonly schemaVersion: 1; readonly contractVersion: "v0.1.0";
  readonly conversationId: string; readonly sourceSequence: number;
  readonly truncated?: boolean; readonly omissionCount?: number;
  readonly records: readonly ApplicationProviderInteractionRecord[];
}
export interface ApplicationProviderInteractionResponseInput {
  readonly interactionId: string; readonly requestSha256: string; readonly responseId: string;
  readonly operator: JsonObject; readonly selectedResponse: string;
  readonly providerResponse: JsonObject; readonly respondedAtUtc: string;
}
export interface ApplicationProviderInteractionReceipt {
  readonly schemaVersion: 1; readonly contractVersion: "v0.1.0";
  readonly interactionId: string; readonly requestSha256: string; readonly responseSha256: string;
  readonly providerResponseSha256: string; readonly deliveryState: "response-returned";
  readonly automaticRetryAllowed: false;
}
export interface ApplicationProviderInteractionResponseResult {
  readonly interaction: ApplicationProviderInteractionRecord; readonly response: JsonObject;
  readonly receipt: ApplicationProviderInteractionReceipt;
}
export type ApplicationArchiveState = "requested" | "accepted" | "started" | "completed" | "failed" | "interrupted" | "uncertain" | "unknown";
export type ApplicationArchiveKind = "submission" | "message" | "activity" | "delivery" | "interaction" | "omission";
export type ApplicationArchiveOmission = "hidden_reasoning" | "unsupported_content" | "oversized_content" | "inline_media" | "private_content" | "content_not_provided" | "history_not_imported" | "provider_unavailable";
export interface ApplicationArchiveRecord {
  readonly recordId: string; readonly kind: ApplicationArchiveKind;
  readonly role: "user" | "assistant" | "tool" | "system" | null;
  readonly state: ApplicationArchiveState; readonly text: string | null;
  readonly providerTurnId: string | null; readonly providerItemId: string | null;
  readonly requestId: string | null; readonly occurredAtUtc: string | null;
  readonly omissions: readonly ApplicationArchiveOmission[];
}
export interface ApplicationArchiveResolution {
  readonly schemaVersion: 1; readonly contractVersion: "v0.2.0";
  readonly conversationId: string; readonly sourceId: string; readonly providerId: string;
  readonly coverage: "captured-only";
  readonly capture: { readonly status: "available" | "unavailable";
    readonly reasonCode: "available" | "provider_unavailable" | "archive_capture_failed";
    readonly synchronization: { readonly state: "not-started" | "running" | "caught-up" | "partial" | "failed";
      readonly pagesImported: number; readonly capturedRecords: number;
      readonly checkpointRevision: number; readonly exhausted: boolean; }; };
}
export interface ApplicationArchiveReadInput {
  readonly conversationId: string; readonly cursor?: string | null; readonly limit?: number;
}
export interface ApplicationArchivePage {
  readonly schemaVersion: 1; readonly contractVersion: "v0.2.0";
  readonly conversationId: string; readonly revision: number; readonly coverage: "captured-only";
  readonly items: readonly { readonly firstSequence: number; readonly sequence: number;
    readonly contentSha256: string; readonly observedAtUtc: string; readonly record: ApplicationArchiveRecord; }[];
  readonly nextCursor: string | null;
}
export interface ApplicationEventReadResult {
  readonly schemaVersion: 1;
  readonly contractVersion: "v0.1.0";
  readonly mode: ApplicationEventMode; readonly streamId: string; readonly epoch: string;
  readonly cursor: string; readonly events: readonly JsonObject[]; readonly hasMore: boolean;
  readonly snapshotRef?: JsonObject; readonly reasonCode?: ApplicationEventReason;
}
export type ApplicationProviderSelector = string | Readonly<Partial<{
  adapterId: string; adapterVersion: string; sourceId: string; runtimeInstanceId: string;
}>>;
export type ApplicationOperationStatus =
  | { readonly status: "available"; readonly reasonCode: "available"; readonly operation: ApplicationOperationRef; readonly resourceKinds: readonly ApplicationResourceKind[]; readonly provider: JsonObject | null; }
  | { readonly status: "unavailable"; readonly reasonCode: string; readonly operationId: string; }
  | { readonly status: "ambiguous"; readonly reasonCode: string; readonly operationId: string; readonly candidateCount: number; };
export interface ApplicationRequestOptions {
  readonly requestId?: string; readonly correlationId?: string; readonly causationId?: string;
  readonly deadlineAtUtc?: string; readonly provider?: ApplicationProviderSelector;
  readonly forceDiscovery?: boolean; readonly signal?: AbortSignal;
}
export interface ApplicationEventReadOptions {
  readonly streamId: string; readonly cursor?: string | null; readonly limit?: number;
  readonly byteLimit?: number; readonly signal?: AbortSignal;
}
export interface ApplicationEventSubscriptionOptions extends ApplicationEventReadOptions {
  readonly cursor: string; readonly pollIntervalMs?: number; readonly signal: AbortSignal;
}
export interface ApplicationFrontendClientOptions {
  readonly resolveDescriptor: () => ApplicationDescriptorResolution | Promise<ApplicationDescriptorResolution>;
  readonly fetchImpl?: typeof fetch; readonly now?: () => Date;
  readonly idFactory?: (prefix: string) => string;
  readonly expectedWorkspace?: Readonly<{ projectId: string; workspaceRootSha256: string }> | null;
}
export type ApplicationDescriptorResolution = ApplicationGatewayDescriptor | Readonly<{
  status: string; reasonCode?: string; descriptor?: ApplicationGatewayDescriptor;
}>;
export declare const APPLICATION_FRONTEND_CLIENT_VERSION: "v0.1.1";
export declare const APPLICATION_CONTRACT_VERSION: "v0.1.0";
export declare const APPLICATION_GATEWAY_DESCRIPTOR_VERSION: "v0.2.0";
export declare const APPLICATION_FRONTEND_CLIENT_METHODS: readonly string[];
export declare class ApplicationFrontendClientError extends Error {
  readonly code: string; readonly details: Readonly<Record<string, unknown>>;
}
export declare class ApplicationFrontendClient {
  constructor(options: ApplicationFrontendClientOptions);
  connect(options?: { readonly force?: boolean }): Promise<ApplicationGatewayDescriptor>;
  disconnect(): void;
  discoverCapabilities(options?: ApplicationRequestOptions & { readonly force?: boolean }): Promise<ApplicationResultEnvelope<{ readonly capabilities: ApplicationCapabilityDescriptor }>>;
  operationStatus(operationId: string, options?: { readonly provider?: ApplicationProviderSelector; readonly forceDiscovery?: boolean }): Promise<ApplicationOperationStatus>;
  invoke<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;
  read<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;
  propose<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;
  approve<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;
  mutate<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;
  provider<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;
  interaction<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;
  review<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;
  receipt<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;
  readEvents(options: ApplicationEventReadOptions): Promise<ApplicationEventReadResult>;
  subscribeEvents(options: ApplicationEventSubscriptionOptions): AsyncGenerator<ApplicationEventReadResult, void, void>;
}

