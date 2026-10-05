import {
  APPLICATION_FRONTEND_CLIENT_METHODS,
  APPLICATION_FRONTEND_CLIENT_VERSION,
} from "../frontend-kit/source/client.mjs";
import { APPLICATION_OWNER_CHAT_OPERATION_IDS } from "../src/application-owner-chat.mjs";
import {
  APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS,
} from "../src/application-provider-interaction-bridge.mjs";

export const APPLICATION_FRONTEND_TYPES_VERSION = "v0.9.1";

function named(schemas, name) {
  const record = schemas.find((candidate) => candidate.name === name);
  if (!record?.schema || typeof record.id !== "string") {
    throw new Error(`frontend_type_schema_missing:${name}`);
  }
  return record.schema;
}

function union(values, label) {
  if (!Array.isArray(values) || values.length < 1
      || new Set(values).size !== values.length
      || values.some((value) => typeof value !== "string")) {
    throw new Error(`frontend_type_enum_invalid:${label}`);
  }
  return values.map((value) => JSON.stringify(value)).join(" | ");
}

function constant(value, label) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`frontend_type_const_invalid:${label}`);
  }
  return JSON.stringify(value);
}

export function generateApplicationFrontendTypes({ schemas } = {}) {
  if (!Array.isArray(schemas) || schemas.length < 1) {
    throw new Error("frontend_type_schemas_required");
  }
  const common = named(schemas, "application-common.schema.json");
  const result = named(schemas, "application-result.schema.json");
  const gateway = named(schemas, "application-gateway-descriptor.schema.json");
  const capabilities = named(schemas, "application-capabilities.schema.json");
  const events = named(schemas, "application-event-read-result.schema.json");
  const externalReference = named(schemas, "external-reference.schema.json");
  const ownerChat = named(schemas, "application-owner-chat.schema.json");
  const archive = named(schemas, "application-conversation-archive.schema.json");
  const providerInteraction = named(schemas, "application-provider-interaction.schema.json");
  const memory = named(schemas, "application-project-memory.v1.json");
  const agentControl = named(schemas, "application-agent-control.schema.json");
  const agentConversation = named(schemas, "application-agent-conversation.schema.json");
  const workspace = named(schemas, "application-project-workspace.schema.json");
  const artifacts = named(schemas, "application-agent-artifacts.schema.json");
  const agentEvents = named(schemas, "application-agent-events.schema.json");
  const schemaIds = schemas.map((record) => record.id).sort();
  if (new Set(schemaIds).size !== schemaIds.length) {
    throw new Error("frontend_type_schema_id_duplicate");
  }
  const lines = [
    "// Generated from canonical Application JSON Schemas. Do not edit.",
    `// Generator contract: ${APPLICATION_FRONTEND_TYPES_VERSION}`,
    "",
    "export type JsonPrimitive = null | boolean | number | string;",
    "export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];",
    "export interface JsonObject { readonly [key: string]: JsonValue; }",
    `export type ApplicationSchemaId = ${schemaIds.map(JSON.stringify).join(" | ")};`,
    `export type ApplicationMemoryOperationId = ${union(memory.properties.operationId.enum, "memory-operation")};`,
    `export type ApplicationAgentControlOperationId = ${union(agentControl.properties.operationId.enum, "agent-control-operation")};`,
    `export type ApplicationAgentConversationOperationId = ${union(agentConversation.properties.operationId.enum, "agent-conversation-operation")};`,
    `export type ApplicationOperationFamily = ${union(common.$defs.operationFamily.enum, "operation-family")};`,
    `export type ApplicationResourceKind = ${union(common.$defs.resourceKind.enum, "resource-kind")};`,
    `export type ApplicationErrorCode = ${union(common.$defs.applicationErrorCode.enum, "error-code")};`,
    `export type ApplicationResultOutcome = ${union(result.properties.outcome.enum, "result-outcome")};`,
    `export type ApplicationEventMode = ${union(events.properties.mode.enum, "event-mode")};`,
    `export type ApplicationEventReason = ${union(events.properties.reasonCode.enum, "event-reason")};`,
    `export type ApplicationExternalReferenceKind = ${union(externalReference.properties.kind.enum, "external-reference-kind")};`,
    `export type ApplicationOwnerChatOperationId = ${Object.values(APPLICATION_OWNER_CHAT_OPERATION_IDS).map(JSON.stringify).join(" | ")};`,
    `export type ApplicationOwnerChatBindingState = ${union(ownerChat.$defs.binding.properties.bindingState.enum, "owner-chat-binding-state")};`,
    `export type ApplicationOwnerChatDeliveryState = ${union(ownerChat.$defs.receipt.properties.deliveryState.enum, "owner-chat-delivery-state")};`,
    `export type ApplicationProviderInteractionOperationId = ${Object.values(APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS).map(JSON.stringify).join(" | ")};`,
    `export type ApplicationProviderInteractionMethod = ${union(providerInteraction.$defs.providerRequest.properties.method.enum, "provider-interaction-method")};`,
    `export type ApplicationProviderInteractionState = ${union(providerInteraction.$defs.record.properties.state.enum, "provider-interaction-state")};`,
    `export type ApplicationProviderInteractionKind = ${union(providerInteraction.$defs.display.properties.kind.enum, "provider-interaction-kind")};`,
    "",
  ];
  lines.push(
    `export type ApplicationProjectWorkspaceOperationId = ${union(workspace.properties.operationId.enum, "workspace-operation")};`,
    `export type ApplicationAgentArtifactOperationId = ${union(artifacts.properties.operationId.enum, "artifact-operation")};`,
    "export interface ApplicationProjectWorkspaceListInput { readonly projectId: string; readonly path?: string; readonly limit?: number; readonly cursor?: string | null; }",
    "export interface ApplicationProjectWorkspaceReadInput { readonly projectId: string; readonly path: string; readonly maximumBytes?: number; readonly cursor?: string | null; }",
    "export interface ApplicationProjectWorkspacePageBase { readonly schemaVersion: 1; readonly contractVersion: \"v0.1.0\"; readonly projectId: string; readonly path: string; readonly contentSha256: string; readonly observedAtUtc: string; readonly truncated: boolean; readonly nextCursor: string | null; }",
    "export interface ApplicationProjectWorkspaceFilePage extends ApplicationProjectWorkspacePageBase { readonly kind: \"read\"; readonly text: string; readonly range: { readonly offsetBytes: number; readonly returnedBytes: number; readonly totalBytes: number; }; }",
    "export interface ApplicationProjectWorkspaceDirectoryPage extends ApplicationProjectWorkspacePageBase { readonly kind: \"list\"; readonly omissionCount: number; readonly totalEntries: number; readonly entries: readonly { readonly name: string; readonly kind: \"file\" | \"directory\"; readonly sizeBytes: number | null; readonly contentSha256: null; }[]; }",
    "export type ApplicationProjectWorkspacePage = ApplicationProjectWorkspaceFilePage | ApplicationProjectWorkspaceDirectoryPage;",
    "export type ApplicationProjectWorkspaceSaveOperationId = \"mutation.project-workspace.save\";",
    "export interface ApplicationProjectWorkspaceSaveInput { readonly projectId: string; readonly path: string; readonly expectedSha256: string; readonly text: string; readonly operationId: string; }",
    "export interface ApplicationProjectWorkspaceSaveReceipt { readonly schemaVersion: 1; readonly contractVersion: \"v0.1.0\"; readonly projectId: string; readonly path: string; readonly operationId: string; readonly previousSha256: string; readonly contentSha256: string; readonly bytesWritten: number; readonly completedAtUtc: string; }",
    "export type ApplicationProjectCopyOperationId = \"mutation.memory.project.copy\";",
    "export interface ApplicationProjectCopyInput { readonly sourceProjectId: string; readonly targetProjectId: string; readonly targetProjectScopeId: string; readonly quarterScopeIds: Readonly<Record<string, string>>; readonly operationId: string; }",
    "export interface ApplicationProjectCopyReceipt { readonly schemaVersion: 1; readonly outcome: \"complete\"; readonly sourceProjectId: string; readonly targetProjectId: string; readonly operationId: string; readonly copiedAtUtc: string; readonly scopes: readonly { readonly sourceScopeId: string; readonly targetScopeId: string; readonly kind: \"project\" | \"quarter\"; readonly quarterId: string | null; readonly sourceRevision: number; readonly sourceSha256: string; readonly targetRevision: 1; readonly targetSha256: string; }[]; }",
    "export interface ApplicationAgentArtifactRecord { readonly artifactId: string; readonly path: string; readonly sha256: string; readonly sizeBytes: number; readonly registeredAtUtc: string; }",
    "export interface ApplicationAgentArtifactCatalog { readonly schemaVersion: 1; readonly contractVersion: \"v0.1.0\"; readonly agentId: string; readonly revision: number; readonly coverage: \"registered-only\"; readonly records: readonly ApplicationAgentArtifactRecord[]; readonly truncated: false; }",
    "export interface ApplicationAgentArtifactPage { readonly schemaVersion: 1; readonly contractVersion: \"v0.1.0\"; readonly agentId: string; readonly artifactId: string; readonly coverage: \"registered-reference\"; readonly page: ApplicationProjectWorkspaceFilePage; }",
    "export interface ApplicationAgentEventsPage { readonly schemaVersion: 1; readonly contractVersion: \"v0.1.0\"; readonly agentId: string; readonly conversationId: string;",
    ` readonly mode: ${union(agentEvents.$defs.page.properties.mode.enum, "agent-event-mode")};`,
    " readonly reasonCode: null | \"initial_snapshot_required\" | \"cursor_invalid\" | \"replay_gap\"; readonly coverage: \"observed-only\"; readonly hasMore: boolean; readonly nextCursor: string; readonly observedAtUtc: string;",
    " readonly events: readonly { readonly sequence: number; readonly turnId: string | null; readonly itemId: string | null; readonly observedAtUtc: string;",
    ` readonly kind: ${union(agentEvents.$defs.event.properties.kind.enum, "agent-event-kind")}; }[];`,
    "}",
    "export interface ApplicationAgentConversationReadInput {",
    "  readonly agentId: string; readonly cursor?: string | null; readonly limit?: number;",
    "}",
    "export interface ApplicationAgentConversationBinding {",
    "  readonly schemaVersion: 1; readonly contractVersion: \"v0.1.0\";",
    "  readonly agentId: string; readonly conversationId: string | null;",
    "  readonly archiveCoverage: \"captured-only\";",
    `  readonly liveRead: { readonly status: ${union(agentConversation.$defs.binding.properties.liveRead.properties.status.enum, "agent-live-status")};`,
    `    readonly reasonCode: ${union(agentConversation.$defs.binding.properties.liveRead.properties.reasonCode.enum, "agent-live-reason")}; };`,
    "}",
    "export interface ApplicationAgentConversationPage {",
    "  readonly schemaVersion: 1; readonly contractVersion: \"v0.1.0\";",
    "  readonly agentId: string; readonly conversationId: string; readonly mode: \"provider-read\";",
    "  readonly revision: string; readonly nextCursor: string | null; readonly observedAtUtc: string;",
    "  readonly thread: JsonObject; readonly turns: readonly JsonObject[]; readonly content: readonly JsonObject[];",
    "  readonly completeness: { readonly status: \"complete\" | \"partial\" | \"metadata-only\"; readonly reasonCode: string | null; };",
    "}",
    "export interface ApplicationOperationRef {",
    "  readonly schemaVersion: 1;",
    `  readonly contractVersion: ${constant(common.$defs.operationRef.properties.contractVersion.const, "operation-version")};`,
    "  readonly family: ApplicationOperationFamily;",
    "  readonly operationId: string;",
    "}",
    "export interface ApplicationError {",
    "  readonly code: ApplicationErrorCode;",
    "  readonly message: string;",
    "  readonly retryable: boolean;",
    "  readonly phase: \"precondition\" | \"execution\" | \"observation\" | \"unknown\";",
    `  readonly reasonCode?: ${union(common.$defs.error.properties.reasonCode.enum, "error-reason")};`,
    "}",
    "export interface ApplicationRequestEnvelope<TInput extends object = JsonObject> {",
    "  readonly schemaVersion: 1;",
    `  readonly contractVersion: ${constant(result.properties.contractVersion.const, "application-version")};`,
    "  readonly requestId: string; readonly correlationId: string;",
    "  readonly causationId?: string; readonly operation: ApplicationOperationRef;",
    "  readonly requestedAtUtc: string; readonly deadlineAtUtc?: string;",
    "  readonly input: TInput;",
    "}",
    "export interface ApplicationResultBase {",
    "  readonly schemaVersion: 1;",
    `  readonly contractVersion: ${constant(result.properties.contractVersion.const, "result-version")};`,
    "  readonly requestId: string; readonly correlationId: string;",
    "  readonly causationId?: string; readonly operation: ApplicationOperationRef;",
    "  readonly startedAtUtc: string; readonly completedAtUtc: string;",
    "  readonly diagnostics: readonly JsonObject[];",
    "}",
    "export type ApplicationResultEnvelope<TOutput = JsonObject> = ApplicationResultBase & (",
    "  | { readonly outcome: \"succeeded\" | \"accepted\"; readonly output?: TOutput; readonly error?: never; }",
    "  | { readonly outcome: \"failed\" | \"uncertain\"; readonly output?: never; readonly error: ApplicationError; }",
    ");",
    "export interface ApplicationGatewayDescriptor {",
    "  readonly schemaVersion: 1;",
    `  readonly contractVersion: ${constant(gateway.properties.contractVersion.const, "gateway-version")};`,
    "  readonly descriptorId: string; readonly transportId: \"loopback-http-json-ndjson-v1\";",
    "  readonly publishedAtUtc: string; readonly validUntilUtc: string;",
    "  readonly instance: JsonObject; readonly workspace: JsonObject; readonly endpoint: JsonObject;",
    "  readonly authorization: JsonObject; readonly routes: readonly JsonObject[];",
    "  readonly capabilityDiscovery: JsonObject;",
    "  readonly exposedOperations: readonly ApplicationOperationRef[];",
    "}",
    "export interface ApplicationCapabilityDescriptor {",
    "  readonly schemaVersion: 1;",
    `  readonly contractVersion: ${constant(capabilities.properties.contractVersion.const, "capability-version")};`,
    "  readonly descriptorId: string; readonly sourceId: string; readonly sequence: number;",
    "  readonly publishedAtUtc: string; readonly validForSeconds: number;",
    "  readonly authority: JsonObject; readonly contractRefs: readonly JsonObject[];",
    "  readonly surface: JsonObject; readonly providerOperations: JsonObject;",
    "  readonly providerStates: readonly JsonObject[]; readonly authenticationStates: readonly JsonObject[];",
    "  readonly compatibility: JsonObject; readonly extensions: readonly string[];",
    "}",
  );
  lines.push(
    "export interface ApplicationProviderIdentity {",
    "  readonly adapterId: string; readonly adapterVersion: string;",
    "  readonly sourceId: string; readonly runtimeInstanceId: string;",
    "}",
    "export interface ApplicationExecutionProfile {",
    "  readonly model: string; readonly reasoningEffort: string; readonly fallbackPolicy: \"deny\";",
    "}",
    "export interface ApplicationExternalReference {",
    "  readonly schemaVersion: 1; readonly kind: ApplicationExternalReferenceKind;",
    "  readonly relationship: string; readonly authority: JsonObject;",
    "  readonly locator?: string; readonly label?: string;",
    "}",
    "export interface ApplicationOwnerChatBinding {",
    `  readonly schemaVersion: 1; readonly contractVersion: ${constant(ownerChat.$defs.binding.properties.contractVersion.const, "owner-chat-binding-version")};`,
    "  readonly sourceId: string; readonly provider: ApplicationProviderIdentity;",
    "  readonly threadRef: ApplicationExternalReference; readonly selection: \"existing\" | \"created\";",
    "  readonly selectedAtUtc: string; readonly bindingState: ApplicationOwnerChatBindingState;",
    "  readonly activeTaskId: string | null; readonly activeTurnRef: ApplicationExternalReference | null;",
    "  readonly threadState: \"idle\" | \"active\";",
    "  readonly startAvailable: boolean; readonly steerAvailable: boolean;",
    "}",
    "export interface ApplicationOwnerChatReceipt {",
    `  readonly schemaVersion: 1; readonly contractVersion: ${constant(ownerChat.$defs.receipt.properties.contractVersion.const, "owner-chat-receipt-version")};`,
    "  readonly receiptId: string; readonly requestId: string; readonly correlationId: string;",
    "  readonly mode: \"start\" | \"steer\"; readonly sourceId: string;",
    "  readonly provider: ApplicationProviderIdentity; readonly threadRef: ApplicationExternalReference;",
    "  readonly turnRef: ApplicationExternalReference | null;",
    "  readonly commandState: \"prepared\" | \"accepted\" | \"not-applied\" | \"uncertain\";",
    "  readonly deliveryState: ApplicationOwnerChatDeliveryState; readonly reasonCode: string | null;",
    "  readonly inputSha256: string; readonly inputByteLength: number; readonly inputCharacterLength: number;",
    "  readonly executionProfile: ApplicationExecutionProfile | null;",
    "  readonly profileCatalogSha256: string | null; readonly profileCatalogObservedAtUtc: string | null;",
    "  readonly requestedAtUtc: string; readonly updatedAtUtc: string; readonly acceptedAtUtc: string | null;",
    "  readonly replay: boolean; readonly automaticRetryAllowed: false; readonly recordSha256: string;",
    "}",
    "export interface ApplicationOwnerChatStartInput {",
    "  readonly provider: ApplicationProviderIdentity; readonly threadRef: ApplicationExternalReference;",
    "  readonly executionProfile: ApplicationExecutionProfile; readonly text: string;",
    "}",
    "export interface ApplicationOwnerChatSteerInput {",
    "  readonly provider: ApplicationProviderIdentity; readonly threadRef: ApplicationExternalReference;",
    "  readonly turnRef: ApplicationExternalReference; readonly text: string;",
    "}",
    "export interface ApplicationOwnerChatReceiptInput { readonly requestId: string; }",
  );
  lines.push(
    "export interface ApplicationProviderRequestIdentity {",
    "  readonly method: ApplicationProviderInteractionMethod; readonly requestId: string;",
    "  readonly requestIdType: \"number\" | \"string\"; readonly generation: number;",
    "  readonly threadId: string; readonly turnId: string | null; readonly itemId: string | null;",
    "  readonly requestSha256: string;",
    "}",
    "export interface ApplicationProviderInteractionDisplay {",
    "  readonly kind: ApplicationProviderInteractionKind; readonly title: string;",
    "  readonly fields: JsonObject;",
    "}",
    "export interface ApplicationProviderInteractionRecord {",
    `  readonly schemaVersion: 1; readonly contractVersion: ${constant(providerInteraction.$defs.record.properties.contractVersion.const, "provider-interaction-version")};`,
    "  readonly interactionId: string; readonly conversationId: string;",
    "  readonly provider: ApplicationProviderIdentity;",
    "  readonly providerRequest: ApplicationProviderRequestIdentity;",
    "  readonly interactionRequest: JsonObject; readonly display: ApplicationProviderInteractionDisplay;",
    "  readonly state: ApplicationProviderInteractionState; readonly response: JsonObject | null;",
    "  readonly providerResponseSha256: string | null; readonly requestedAtUtc: string;",
    "  readonly deadlineAtUtc: string; readonly updatedAtUtc: string;",
    "  readonly automaticRetryAllowed: false; readonly recordSha256: string;",
    "}",
    "export interface ApplicationAgentAttention { readonly availability: \"available\" | \"unavailable\"; readonly coverage: \"captured-only\";",
    "  readonly sourceSequence: number | null; readonly sourceRevision: number | null; readonly observedAtUtc: string | null;",
    "  readonly pendingQuestions: number | null; readonly pendingApprovals: number | null; readonly recoveryRequired: number | null; }",
    "export interface ApplicationProviderInteractionReadInput { readonly limit?: number; }",
    "export interface ApplicationProviderInteractionReadResult {",
    `  readonly schemaVersion: 1; readonly contractVersion: ${constant(providerInteraction.$defs.readResult.properties.contractVersion.const, "provider-interaction-read-version")};`,
    "  readonly conversationId: string; readonly sourceSequence: number;",
    "  readonly truncated?: boolean; readonly omissionCount?: number;",
    "  readonly records: readonly ApplicationProviderInteractionRecord[];",
    "}",
    "export interface ApplicationProviderInteractionResponseInput {",
    "  readonly interactionId: string; readonly requestSha256: string; readonly responseId: string;",
    "  readonly operator: JsonObject; readonly selectedResponse: string;",
    "  readonly providerResponse: JsonObject; readonly respondedAtUtc: string;",
    "}",
    "export interface ApplicationProviderInteractionReceipt {",
    `  readonly schemaVersion: 1; readonly contractVersion: ${constant(providerInteraction.$defs.receipt.properties.contractVersion.const, "provider-interaction-receipt-version")};`,
    "  readonly interactionId: string; readonly requestSha256: string; readonly responseSha256: string;",
    "  readonly providerResponseSha256: string; readonly deliveryState: \"response-returned\";",
    "  readonly automaticRetryAllowed: false;",
    "}",
    "export interface ApplicationProviderInteractionResponseResult {",
    "  readonly interaction: ApplicationProviderInteractionRecord; readonly response: JsonObject;",
    "  readonly receipt: ApplicationProviderInteractionReceipt;",
    "}",
  );
  lines.push(
    `export type ApplicationArchiveState = ${union(archive.$defs.state.enum, "archive-state")};`,
    `export type ApplicationArchiveKind = ${union(archive.$defs.kind.enum, "archive-kind")};`,
    `export type ApplicationArchiveOmission = ${union(archive.$defs.omission.enum, "archive-omission")};`,
    "export interface ApplicationArchiveRecord {",
    "  readonly recordId: string; readonly kind: ApplicationArchiveKind;",
    "  readonly role: \"user\" | \"assistant\" | \"tool\" | \"system\" | null;",
    "  readonly state: ApplicationArchiveState; readonly text: string | null;",
    "  readonly providerTurnId: string | null; readonly providerItemId: string | null;",
    "  readonly requestId: string | null; readonly occurredAtUtc: string | null;",
    "  readonly omissions: readonly ApplicationArchiveOmission[];",
    "}",
    "export interface ApplicationArchiveResolution {",
    `  readonly schemaVersion: 1; readonly contractVersion: ${constant(archive.$defs.resolution.properties.contractVersion.const, "archive-resolution-version")};`,
    "  readonly conversationId: string; readonly sourceId: string; readonly providerId: string;",
    "  readonly coverage: \"captured-only\";",
    "  readonly capture: { readonly status: \"available\" | \"unavailable\";",
    "    readonly reasonCode: \"available\" | \"provider_unavailable\" | \"archive_capture_failed\";",
    "    readonly synchronization: { readonly state: \"not-started\" | \"running\" | \"caught-up\" | \"partial\" | \"failed\";",
    "      readonly pagesImported: number; readonly capturedRecords: number;",
    "      readonly checkpointRevision: number; readonly exhausted: boolean; }; };",
    "}",
    "export interface ApplicationArchiveReadInput {",
    "  readonly conversationId: string; readonly cursor?: string | null; readonly limit?: number;",
    "}",
    "export interface ApplicationArchivePage {",
    `  readonly schemaVersion: 1; readonly contractVersion: ${constant(archive.$defs.page.properties.contractVersion.const, "archive-page-version")};`,
    "  readonly conversationId: string; readonly revision: number; readonly coverage: \"captured-only\";",
    "  readonly items: readonly { readonly firstSequence: number; readonly sequence: number;",
    "    readonly contentSha256: string; readonly observedAtUtc: string; readonly record: ApplicationArchiveRecord; }[];",
    "  readonly nextCursor: string | null;",
    "}",
  );
  lines.push(
    "export interface ApplicationEventReadResult {",
    "  readonly schemaVersion: 1;",
    `  readonly contractVersion: ${constant(events.properties.contractVersion.const, "event-version")};`,
    "  readonly mode: ApplicationEventMode; readonly streamId: string; readonly epoch: string;",
    "  readonly cursor: string; readonly events: readonly JsonObject[]; readonly hasMore: boolean;",
    "  readonly snapshotRef?: JsonObject; readonly reasonCode?: ApplicationEventReason;",
    "}",
    "export type ApplicationProviderSelector = string | Readonly<Partial<{",
    "  adapterId: string; adapterVersion: string; sourceId: string; runtimeInstanceId: string;",
    "}>>;",
    "export type ApplicationOperationStatus =",
    "  | { readonly status: \"available\"; readonly reasonCode: \"available\"; readonly operation: ApplicationOperationRef; readonly resourceKinds: readonly ApplicationResourceKind[]; readonly provider: JsonObject | null; }",
    "  | { readonly status: \"unavailable\"; readonly reasonCode: string; readonly operationId: string; }",
    "  | { readonly status: \"ambiguous\"; readonly reasonCode: string; readonly operationId: string; readonly candidateCount: number; };",
    "export interface ApplicationRequestOptions {",
    "  readonly requestId?: string; readonly correlationId?: string; readonly causationId?: string;",
    "  readonly deadlineAtUtc?: string; readonly provider?: ApplicationProviderSelector;",
    "  readonly forceDiscovery?: boolean; readonly signal?: AbortSignal;",
    "}",
    "export interface ApplicationEventReadOptions {",
    "  readonly streamId: string; readonly cursor?: string | null; readonly limit?: number;",
    "  readonly byteLimit?: number; readonly signal?: AbortSignal;",
    "}",
    "export interface ApplicationEventSubscriptionOptions extends ApplicationEventReadOptions {",
    "  readonly cursor: string; readonly pollIntervalMs?: number; readonly signal: AbortSignal;",
    "}",
    "export interface ApplicationFrontendClientOptions {",
    "  readonly resolveDescriptor: () => ApplicationDescriptorResolution | Promise<ApplicationDescriptorResolution>;",
    "  readonly fetchImpl?: typeof fetch; readonly now?: () => Date;",
    "  readonly idFactory?: (prefix: string) => string;",
    "  readonly expectedWorkspace?: Readonly<{ projectId: string; workspaceRootSha256: string }> | null;",
    "}",
    "export type ApplicationDescriptorResolution = ApplicationGatewayDescriptor | Readonly<{",
    "  status: string; reasonCode?: string; descriptor?: ApplicationGatewayDescriptor;",
    "}>;",
    `export declare const APPLICATION_FRONTEND_CLIENT_VERSION: ${JSON.stringify(APPLICATION_FRONTEND_CLIENT_VERSION)};`,
    "export declare const APPLICATION_CONTRACT_VERSION: \"v0.1.0\";",
    `export declare const APPLICATION_GATEWAY_DESCRIPTOR_VERSION: ${constant(gateway.properties.contractVersion.const, "client-gateway-version")};`,
    "export declare const APPLICATION_FRONTEND_CLIENT_METHODS: readonly string[];",
    "export declare class ApplicationFrontendClientError extends Error {",
    "  readonly code: string; readonly details: Readonly<Record<string, unknown>>;",
    "}",
  );
  const signatures = {
    connect: "connect(options?: { readonly force?: boolean }): Promise<ApplicationGatewayDescriptor>;",
    disconnect: "disconnect(): void;",
    discoverCapabilities: "discoverCapabilities(options?: ApplicationRequestOptions & { readonly force?: boolean }): Promise<ApplicationResultEnvelope<{ readonly capabilities: ApplicationCapabilityDescriptor }>>;",
    operationStatus: "operationStatus(operationId: string, options?: { readonly provider?: ApplicationProviderSelector; readonly forceDiscovery?: boolean }): Promise<ApplicationOperationStatus>;",
    invoke: "invoke<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;",
    read: "read<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;",
    propose: "propose<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;",
    approve: "approve<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;",
    mutate: "mutate<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;",
    provider: "provider<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;",
    interaction: "interaction<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;",
    review: "review<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;",
    receipt: "receipt<T = JsonObject>(operationId: string, input?: object, options?: ApplicationRequestOptions): Promise<ApplicationResultEnvelope<T>>;",
    readEvents: "readEvents(options: ApplicationEventReadOptions): Promise<ApplicationEventReadResult>;",
    subscribeEvents: "subscribeEvents(options: ApplicationEventSubscriptionOptions): AsyncGenerator<ApplicationEventReadResult, void, void>;",
  };
  const declared = Object.keys(signatures).sort();
  const implemented = [...APPLICATION_FRONTEND_CLIENT_METHODS].sort();
  if (JSON.stringify(declared) !== JSON.stringify(implemented)) {
    throw new Error("frontend_type_client_method_drift");
  }
  lines.push("export declare class ApplicationFrontendClient {", "  constructor(options: ApplicationFrontendClientOptions);");
  for (const method of APPLICATION_FRONTEND_CLIENT_METHODS) {
    lines.push(`  ${signatures[method]}`);
  }
  lines.push("}", "");
  return `${lines.join("\n")}\n`;
}
