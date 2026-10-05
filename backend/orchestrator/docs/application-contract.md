# Application Contract

## Status

- Contract version: `v0.1.0`.
- Milestone A1 status: implemented; acceptance is recorded separately.
- Owner: `orchestrator-development`.
- Scope: renderer-, transport- and provider-neutral backend meaning.

Later A1 items extend this document additively. A resource reference alone
does not authorize a read, mutation, provider action or filesystem lookup.

## ApplicationResourceRef

`ApplicationResourceRef` gives the application one strict identity shape for a
backend resource without replacing the resource owner's native identity.

Required fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Shape version, currently `1`. |
| `contractVersion` | Application Contract version, currently `v0.1.0`. |
| `resourceKind` | Stable application classification, not an implementation class. |
| `sourceId` | Canonical source that owns the native namespace. |
| `nativeId` | Bounded source-native identity; never an absolute locator. |
| `authority` | Existing strict `AuthorityRef` identifying the owning authority. |
| `revision` | Exact sequence, hash, commit, provider version or opaque revision. |
| `contentSha256` | Optional exact body hash when content identity is known. |

The reference requires `sourceId` to match `authority.sourceId`. A SHA-256
revision and `contentSha256`, when both supplied, must be identical. Unknown
fields and unsupported kinds are rejected.

## Revision Semantics

- `sequence`: non-negative safe integer from the authoritative sequence.
- `sha256`: lowercase full SHA-256 and optionally the exact content identity.
- `git-commit`: lowercase full 40- or 64-character commit hash.
- `provider-version`: bounded version issued by the provider.
- `immutable-id`: immutable source-native revision identity.
- `opaque`: bounded owner-defined revision that consumers compare exactly.

Consumers never compare unlike revision kinds and never infer freshness from a
label, path, publication timestamp or UI state.

## Security Boundary

The reference contains no token, credential, permission, filesystem root,
absolute path, provider transcript or content body. `nativeId` rejects absolute
paths, URI locators, backslashes and parent traversal. Source-specific readers
will add stronger policy in A3.

Authorization is a separate A1 contract and every operation must still pass a
capability and policy check. `AuthorityRef` establishes ownership evidence; it
does not grant access.

## Current Resource Kinds

The initial closed set covers work/backend projections, provider thread/turn/
item identity, artifacts, project files/directories, review operations, change
proposals, commands, interactions, receipts and events. A1.4 will publish the
exact mapping and authority rules for those concepts.

## Operation Families

`ApplicationOperationRef` binds every operation ID to one closed family and a
matching namespace. This prevents a read from being presented as a write or an
approval from silently executing an approved change.

| Family | Namespace | Meaning |
| --- | --- | --- |
| `discovery` | `discovery.*` | Enumerate bounded metadata and supported surfaces. |
| `query` | `query.*` | Read bounded state without changing authority or source state. |
| `subscription` | `subscription.*` | Open or continue an event stream; no decision authority. |
| `proposal` | `proposal.*` | Create a non-authoritative proposed change or action. |
| `approval` | `approval.*` | Record an explicit authority decision; no implicit mutation. |
| `mutation` | `mutation.*` | Request a state-changing action through its writer gate. |
| `receipt-lookup` | `receipt.*` | Read the immutable or durable outcome of an earlier operation. |

Operation IDs use at least three lowercase dot-separated segments, for example
`query.resource.read` or `mutation.command.execute`. Transport methods and UI
controls map to these IDs; they do not redefine their family.

## Request, Result, And Error Envelopes

Every application request carries:

- exact `requestId` and `correlationId`;
- optional `causationId` naming a prior request, never itself;
- the full `ApplicationOperationRef`;
- `requestedAtUtc`, optional later deadline, and bounded JSON `input`.

Every result repeats the same identity and operation, records start/completion
UTC timestamps, one outcome, bounded diagnostics, and optional bounded output.
The outcomes are `succeeded`, `accepted`, `failed` and `uncertain`.

Failed and uncertain results require a structured error and cannot carry
output. Succeeded and accepted results cannot carry an error. This prevents a
frontend from presenting stale fallback data as the result of a failed call.

Errors expose only stable-shaped `code`, bounded user-safe `message`,
`retryable` and phase. Diagnostics expose only code, severity, bounded message
and optional field. Raw stack, provider payload and arbitrary details are not
part of the envelope. A1.7 adds the complete privacy allowlist and canonical
hashing rules.

### Stable Errors

| Code | Phase | Same request retryable | Required handling |
| --- | --- | --- | --- |
| `unsupported_capability` | precondition | no | Select a supported operation or wait for a new capability revision. |
| `source_unavailable` | precondition | yes | Retry only under the operation retry policy. |
| `stale_revision` | precondition | no | Refresh state and issue a new bound request. |
| `conflict` | precondition | no | Resolve the competing authoritative state. |
| `ambiguous` | precondition | no | Supply an exact target; never guess. |
| `access_denied` | precondition | no | Obtain a new authoritative decision. |
| `writer_busy` | precondition | yes | Preserve operation identity and follow writer policy. |
| `uncertain_outcome` | observation | no | Reconcile by authoritative read; never replay automatically. |
| `continuation_required` | observation | no | Follow the bounded continuation contract, not a blind retry. |

`uncertain` result accepts only `uncertain_outcome`; that code cannot be
reported as ordinary `failed`. Phase and retryability are part of each stable
definition and cannot be overridden by adapters or transports.

Runtime validation caps input/output JSON at 1 MiB, 32 levels, 1024 array
items and 256 object fields. Operation-specific contracts may impose smaller
limits.

### Provider Turn Start Planning Reference

`mutation.provider.turn.start` is narrowed by the A5 planning-policy guard.
Its Application input contains only the exact start request ID/SHA-256 and the
confirmed planning-policy SHA-256. It cannot carry replacement model,
reasoning effort, fallback, report operation or continuation policy fields.
The earlier `mutation.provider-turn.start` spelling is accepted only as a
legacy input alias and is not advertised by the provider operation catalog.

The referenced policy binds one confirmed plan revision/hash, the exact A5.2
Task/profile-bound start request, `fallbackPolicy=deny` and the planning-time
return contract. The backend resolves and compares those immutable values;
the frontend-provided hashes are references, not authority or bearer grants.
Changed policy bytes, a changed start request, a pre-confirmation request or an
override field fails before provider submission.

## Concept And Authority Map

The versioned concept map tells a frontend which existing contract remains
authoritative. It is not a converter that copies all source fields into one
record.

| Concept | Existing source contract | Resource kinds | Authority rule |
| --- | --- | --- | --- |
| Work Projection | `work-projection-v2/v0.2.0` | `work-projection` | Coordination-owned container; every fact retains provenance. |
| Backend Consumer | `backend-consumer/v0.1.0` | `backend-snapshot` | Coordination-owned snapshot; source facts retain provenance. |
| Provider conversation | `adapter-contract/v0.3.1` | provider thread/turn/item | Provider owns each exact native resource. |
| Artifact | `work-authority/v0.1.0` | `artifact` | Each ref selects one explicit resource owner. |
| Project resource | `application-contract/v0.1.0` | project file/directory | Ref selects working-tree or repository authority, never both. |
| Review | `report-operations/v0.2.1` | review operation/receipt | Coordination operation authority; approval stays separate. |
| Command | `backend-command/v0.1.0` | command/receipt | Coordination writer authority through mutation gates. |

Review and command may both produce a `receipt`, but their source contract,
native ID and exact authority remain in the resource ref. Provider conversation
state is never rewritten as a controller task, and a projection container never
becomes the authority for the facts it presents.

## Actor And Authorization References

`ApplicationActorRef` separates actor identity from task, provider execution
and UI process identity:

| Actor | Required authority type |
| --- | --- |
| `local-operator` | `human` |
| `controller` | `coordination-core` |
| `child-agent` | `child-workspace` |
| `provider` | `provider` |
| `frontend-process` | `presentation` |

A frontend process can present and submit a request, but cannot claim human or
controller authority. A type/authority mismatch fails closed.

`ApplicationAuthorizationRef` identifies an `allow` or `deny` decision for an
exact actor. It contains authorization ID, authoritative issuer, policy ID,
policy SHA-256, scope SHA-256, issue time and optional expiry. It deliberately
contains neither scope body nor credential/token. Presentation authority cannot
issue a decision.

The ref is evidence, not a bearer grant. A backend operation must resolve the
current policy and exact scope hash again; expiration, revision and operation
checks cannot be delegated to the frontend.

## Canonical Identity And Privacy

Application Canonical JSON v1 recursively sorts object keys, preserves array
order, accepts only finite JSON values, maps negative zero to zero, requires NFC
strings and rejects cycles, undefined values and excessive nesting. SHA-256 is
computed over its UTF-8 bytes. The golden conformance request and result pin
those hashes so an implementation cannot silently change canonical meaning.

Exact envelope, diagnostic and error fields are exported as frozen privacy
allowlists and are already enforced by strict validators/schemas. Recursive
input/output privacy validation additionally rejects:

- credential, token, cookie and authorization-header fields;
- rollout, transcript, prompt-history, SQLite/Codex-home and raw-log/event
  fields;
- UI layout/style fields and a second task-authority field;
- inline image/audio/video data URIs and high-confidence token strings;
- absolute values under path/root fields.

Request input may carry user-visible `prompt` text for a future mutation.
Result output must use normalized `text` or `content`; it cannot return a raw
prompt/history field. Operation-specific contracts may only narrow this base
policy.

## Conformance Fixture

The model-free fake application boundary runs the same canonical request
through filesystem JSON, stdio JSONL, structured IPC clone and loopback JSON
encodings. Every encoding must preserve request and normalized result hashes,
identity, operation and outcome. The conformance report contains only hashes,
transport names and outcomes, not request/result bodies.

## Implementation

- Runtime validator: `orchestrator/src/application-contract.mjs`.
- Common schema: `orchestrator/schemas/application-common.schema.json`.
- Standalone schema:
  `orchestrator/schemas/application-resource-ref.schema.json`.
- Operation schema:
  `orchestrator/schemas/application-operation-ref.schema.json`.
- Request/result schemas: `orchestrator/schemas/application-request.schema.json`
  and `orchestrator/schemas/application-result.schema.json`.
- Concept map runtime/schema: `orchestrator/src/application-concept-map.mjs`
  and `orchestrator/schemas/application-concept-map.schema.json`.
- Actor/authorization schemas:
  `orchestrator/schemas/application-actor-ref.schema.json` and
  `orchestrator/schemas/application-authorization-ref.schema.json`.
- Canonical/privacy runtime: `orchestrator/src/application-contract.mjs`.
- Fake boundary and transport conformance:
  `orchestrator/src/application-conformance.mjs` and the matching test fixtures.
- Frontend presentation rules:
  [application-frontend-authority-boundary.md](application-frontend-authority-boundary.md).
- Contract regression: `orchestrator/test/application-contract.test.mjs`.
