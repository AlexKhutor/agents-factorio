# Application Capabilities

## Status

- Capability contract: `v0.2.0`.
- Current implemented items: A2.1-A2.7 plus A3 application-resource reads.
- Authority: `coordination-core` source that publishes the descriptor.

## Reference-Only Baseline

The application capability descriptor is additive metadata. Its first version
references these existing authorities:

| Contract | Version | Role |
| --- | --- | --- |
| Application Contract | `v0.1.0` | Common renderer/transport-neutral boundary. |
| Work Projection v2 | `v0.2.0` | Semantic projection with per-fact authority. |
| Backend Consumer | `v0.1.0` | Existing compatibility read surface. |
| Application Resource | `v0.1.0` | Bounded artifact/project summary, full and slice reads. |

Each contract reference contains only contract ID/version, role and canonical
schema IDs. It does not copy Work Projection layers, Backend Consumer queries,
artifacts, timing, limits or feature meanings. Runtime versions are imported
from their canonical source modules and validated against the frozen refs.

## Descriptor Identity

The descriptor contains its own source-qualified ID, monotonic sequence,
publication time, validity interval, coordination authority, required contract
refs and an initially empty additive extension list. Re-publication with the
same inputs has the same canonical SHA-256.

The descriptor now carries a separate strict `surface` object. Contract refs
still identify semantic authorities; the surface names only operations that
have a current backend binding. Provider vocabulary is separate, while actual
support and availability are added by A2.4-A2.7 without changing referenced
definitions.

## Supported Application Surface

The surface advertises six current resource kinds:

- `work-projection` through Work Projection v2 filesystem queries;
- `backend-snapshot` through Backend Consumer v1 filesystem queries;
- `artifact`, `project-file` and `project-directory` through the bounded
  Application Resource local query service;
- `command` through the local-process Stop/Resume/Cancel adapter.

Every public operation has an `ApplicationOperationRef` and a separate binding
to its existing contract operation ID and transport. Work Projection and
Backend Consumer query IDs are imported from their canonical modules. Command
action IDs and bounded read limits are likewise exported by Backend Consumer,
so the capability publisher cannot silently drift from the implementation.

The supported transports are exactly:

| Transport | Access | Current families |
| --- | --- | --- |
| `filesystem-json` | read-only | discovery, query |
| `local-query-json` | read-only | query |
| `local-process-json` | write | mutation |

Both are machine-local. IPC, HTTP, WebSocket and stdio conformance encodings
from A1 are not advertised as runtime transports.

`subscription`, `proposal`, `approval` and `receipt-lookup` are required keys
with empty arrays. This is explicit evidence that no application-facing
implementation exists yet; a client must not infer support from related
internal artifacts. Provider operation definitions are separate and do not
make these backend-owned families non-empty.

The surface lists schema identities and namespaced limits, never schema bodies
or project paths. Unknown resource kinds, operations, bindings, transports,
limits or schema fields fail closed.

## Provider Operation Vocabulary

Provider operations are declared in `providerOperations`, outside the
backend-owned application surface. The catalog defines stable application
identities for model listing; thread list/read/create/fork/archive; turn
start/stream/interrupt; tool approval; usage read; and attachment submission.

Where the generic execution-provider adapter already has a matching operation,
the definition references adapter contract `v0.3.0`. Thread archive, provider
tool approval and attachment submission intentionally have a null adapter
binding because no provider-neutral operation exists yet.

The vocabulary does not contain `support`, `available`, permission or provider
failure fields. A known operation is not evidence that a particular provider
or runtime can execute it. A2.4 adds that evidence as a separate observation;
without such an observation clients treat the operation as not selectable.

## Provider Operation State

`providerStates` contains zero or more exact runtime observations. An empty
array means that no current provider evidence was supplied; it does not mean
that every catalog operation is supported.

Each operation has four independent axes:

| Axis | Values | Meaning |
| --- | --- | --- |
| Support | `supported`, `unsupported` | Whether the generic adapter exposes the operation. |
| Availability | `available`, `temporarily-unavailable`, `unknown` | Whether fresh runtime evidence permits an attempt now. |
| Permission | `allowed`, `denied`, `not-evaluated` | Whether bounded authorization was evaluated for the caller. |
| Provider health | `healthy`, `failed`, `unknown` | Whether provider failure evidence affects this operation. |

`selectable=true` is valid only when support is present, availability is
current, permission is allowed and provider health is healthy. A missing
generic binding or adapter capability is `unsupported`; expired capability
evidence is `temporarily-unavailable`; denial does not masquerade as provider
failure; and provider failure carries only a stable bounded adapter error code.

The projector consumes a validated execution-provider descriptor and optional
bounded permission/failure observations. It never reads provider storage or UI
state. Capability timestamps stay separate from operation and task liveness.

## Compatibility And Negotiation

The descriptor publishes an explicit compatibility policy:

- choose the highest exact contract version supported by both sides;
- reject a client below the minimum client version;
- require every enabled `required` feature ID;
- ignore only unknown features marked optional;
- require clients to reject unknown required behavior and unsupported contract
  versions, preserve operation semantics and deny silent fallback;
- publish contract support windows and bounded deprecation notices separately.

The first compatibility profile supports Application Contract `v0.1.0` and
requires `application-surface-v1`, `provider-operation-catalog-v1` and
`provider-state-axes-v1`, plus `application-resource-reads-v1`. Work Projection
v2, Backend Consumer v1 and Application Resource v0.1 remain supported
compatibility contracts without becoming alternate application semantics. No
current contract has an end date or deprecation notice.

Negotiation returns a selected version only when version, client version,
required features and minimum behaviors all match. Otherwise it returns one
deterministic reason and no selected contract. It never changes provider,
model, effort, transport or operation meaning to make a client appear
compatible.

## Compatibility Fixtures

Four deterministic fixtures execute both directions:

| Scenario | Expected result |
| --- | --- |
| Old client omits a required new-backend feature | incompatible; no selected version |
| Old client ignores an unknown optional feature | compatible on `v0.1.0` |
| New client and old backend share no contract version | incompatible; no invented downgrade |
| New client and old backend share `v0.1.0` with fewer required features | compatible |

Each result records canonical backend/client input hashes. The fixture runner
does not start a provider, transport or service and cannot change runtime
state.

## Bounded Authentication Observation

`authenticationStates` contains only provider/runtime identity, one closed
status, observation validity and four bounded capability states:
status observation, interactive login, machine-local session reuse and logout.
The status vocabulary is authenticated, unauthenticated, expired, unavailable
or unknown. Only unauthenticated and expired require a user action.

The contract cannot contain account email or ID, credential/token/cookie,
password, auth file/path, login URL, storage locator or provider payload.
Authentication remains provider-owned and machine-local. The future frontend
may present that sign-in is required, but it must not persist or replay the
provider credential.

Authenticated is not authorization. It does not change the independent
provider-operation permission axis and cannot make an operation selectable.
The empty array means auth was not observed, not that the provider is signed
out or signed in.

## Failure Boundary

- Unknown descriptor fields fail closed.
- A missing or changed required contract ref fails closed.
- Foreign/presentation/provider authority cannot publish this descriptor.
- Expired descriptor validity is evaluated by the future client; publication
  time never refreshes provider or task liveness.
- Schema IDs are identities, not filesystem paths or network fetch permission.

## Implementation

- Publisher/validator: `orchestrator/src/application-capabilities.mjs`.
- Surface/validator: `orchestrator/src/application-capability-surface.mjs`.
- Portable schema: `orchestrator/schemas/application-capabilities.schema.json`.
- Surface schema:
  `orchestrator/schemas/application-capability-surface.schema.json`.
- Provider catalog/validator:
  `orchestrator/src/application-provider-operations.mjs`.
- Provider catalog schema:
  `orchestrator/schemas/application-provider-operations.schema.json`.
- Provider state projector/validator:
  `orchestrator/src/application-provider-state.mjs`.
- Provider state schema:
  `orchestrator/schemas/application-provider-state.schema.json`.
- Compatibility policy/negotiator:
  `orchestrator/src/application-compatibility.mjs`.
- Compatibility schema:
  `orchestrator/schemas/application-compatibility.schema.json`.
- Compatibility fixtures:
  `orchestrator/src/application-compatibility-fixtures.mjs`.
- Authentication state/validator:
  `orchestrator/src/application-authentication-state.mjs`.
- Authentication schema:
  `orchestrator/schemas/application-authentication-state.schema.json`.
- Regression: `orchestrator/test/application-capabilities.test.mjs`.
