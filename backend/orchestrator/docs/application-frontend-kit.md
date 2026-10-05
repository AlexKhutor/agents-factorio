# Application Frontend Kit

> **Reference contract.** Written while the project ran its agents on the Codex App Server,
> and it keeps that era's internal milestone names (A1-A12, release programs, Frontend Kit
> versions) and links to internal reports that are not part of this repository. The contract
> itself still holds: the Claude Code provider presents its sessions in the same shape, so it
> applies to both providers. Start with [architecture.md](architecture.md) and
> [claude-code-provider.md](claude-code-provider.md).

2026-09-24 S1 revision: candidate `v0.16.1` replaces the unadopted v0.16.0
candidate. The optional bounded `error.reasonCode` for project-workspace
source refusal has three safe values; other source failures stay generic.
The v0.16.0 payload and lock remain historical and are not silently reused.
No controller installation or consumer adoption is implied.

2026-09-24 source update: candidate `v0.16.0` adds the project-file save and
atomic project/quarter/current-memory copy contracts. Its 74-file build is a
source candidate, not controller installation or 2D adoption. The controller
reports installed `v0.15.0` and its separate accepted lock. Keep that delivery
immutable; a new lock and consumer verification are required for `v0.16.0`.
See [S1 backend package](codex-r2-s1-backend-package-20260924.md).

Candidate v0.15.0 also carries application-project-workspace,
application-agent-artifacts and application-agent-events schemas/types.
See [semantics and limitations](application-agent-workspace-resources.md).
These are additions to the same unpublished candidate, not an immutable
installed payload replacement. Full agent question counters remain pending.


Candidate v0.15.0 adds application-agent-conversation.v1.json and generated
agent binding/page declarations. The source Gateway resolves agentId to its
stored Codex conversation; callers cannot supply a foreign thread selector.
See [agent conversation semantics](application-agent-conversation.md).
This candidate is not the installed/accepted v0.14.0 kit and does not supersede
its immutable manifest or lock. Consolidated release delivery is pending.

## Purpose

`orchestrator/frontend-kit` is the versioned renderer-neutral package for a
future first-party frontend. A frontend consumes the package instead of
reading orchestrator source, provider history, SQLite or maintainer docs.

A10.1 packages contracts and onboarding assets, A10.2 adds the dependency-free
reference client, A10.3 adds schema-bound TypeScript declarations, A10.4 adds
a contract-valid in-memory fake backend, A10.5 adds consumer conformance, and
A10.6 adds a bounded read-only diagnostic client, and A10.7 binds exact SDK
and backend versions with deprecation and migration-receipt contracts:

- `ApplicationFrontendClient` as the package root and `./client` export;
- generated `types/index.d.ts` for the package root and client export;
- `FakeApplicationBackend` and a canonical default fixture through
  the isolated `./testing` export;
- `runApplicationFrontendConformance` through the same testing export;
- `ApplicationFrontendDiagnosticClient` through `./diagnostics`;
- compatibility assessment and migration-receipt helpers through
  `./compatibility`;
- every canonical `application-*` JSON Schema;
- every local schema reached through their `$ref` closure;
- a deterministic capability discovery example;
- the A1 stable error catalog with consumer actions;
- a minimal gateway lifecycle and resynchronization guide;
- an exact migration and rollback runbook;
- a content-addressed manifest and installable npm package metadata.

It does not include a product UI, background service or mutation console.
Frontend work remains a separate owner program.

## Build

From `orchestrator/frontend-kit`:

```powershell
npm run build
npm pack --dry-run
```

The builder discovers schema dependencies from canonical `$id`/`$ref` values;
there is no manually maintained schema copy list. Output goes to ignored
`dist/`. A short package build may overwrite only that generated directory;
canonical source/schema roots are explicitly rejected as output.

The current `v0.14.0` build contains 47 schemas and 65 manifest-addressed
files plus `manifest.json` (66 files total). Its manifest SHA-256 is
`970b08f7ea26b25b75656d8acfe15eb9222826bf608293132f150596574bd406`.
The schema closure includes application-project-memory.v1.json and the new
application-agent-control.schema.json. Relative schema IDs are resolved against
the canonical schema base. Historical v0.13.0 packages remain unchanged.

## 2D Prototype Handoff

Start the separate frontend owner with packaged docs/desktop-integration.md,
then connection/error guidance and only the schemas for its advertised actions.
The ./desktop export provides projectDesktopMemory and createDesktopMemoryFixture
for World -> Project -> Feature/quarter -> Agent. The fixture's withAgent option
is schema-valid synthetic data, not a live session or permission to submit.

The guide defines native-host-only workspace binding and user-confirmed memory
saving, per-agent question/approval/interrupt, receipt reconciliation, archive
and one-writer-per-folder limits. It does not require reading backend source,
Claude integration material or SampleApp documents. Backend source v0.126.0 is
offline-verified; installation and a supervised live scenario remain separate.
See [the source report](backend-2d-source-report-20260918.md).

## Reference Client

The host supplies a trusted project-local descriptor resolver. The client
then validates the exact loopback endpoint, workspace identity, bearer expiry,
routes and descriptor lifetime before any request. Capability discovery is
cached only for its advertised validity interval.

The client exposes capability status plus bounded methods for query,
proposal, approval, mutation, provider operation, interaction, review and
receipt families. An invocation requires the same operation identity in both
the A2 descriptor and gateway `exposedOperations`. Provider operations also
require exactly one selectable provider state; ambiguity and permission or
health failures remain explicit unavailable states.

A8 reads accept one canonical NDJSON frame, verify stream/epoch/cursor
identity and checksum, and preserve snapshot/resync outcomes. The async
subscription requires an `AbortSignal` and bounded polling interval. It never
runs without cancellation and never replays a mutation or transport request.

## Exact Owner Conversation

Kit `v0.13.0` packages the owner-chat and independent archive schemas and typed
payloads. The generic client methods remain sufficient; no UI-specific client
or provider bypass is added:

1. `read("query.provider.owner-thread.resolve", {})` returns the one exact
   backend-selected child `provider`, `threadRef`, current `activeTurnRef`, and
   start/steer availability.
2. `mutate("mutation.provider.owner-turn.start", input, { requestId })` sends
   text only when that exact thread is idle.
3. `mutate("mutation.provider.owner-turn.steer", input, { requestId })` sends
   text only to the exact active turn.
4. `receipt("receipt.provider.owner-message.read", { requestId })` recovers the
   durable command observation without resubmitting text.

Mutation input repeats the exact `provider` and references returned by resolve.
The backend consumes `text` ephemerally and persists only SHA-256 and bounded
length metadata. A `steer` with an uncertain outcome is never replayed. The
provider transcript remains conversation-history authority; the kit does not
create a second transcript store.

## Exact Provider Interactions

Kit `v0.13.0` also packages the provider-interaction schema and typed read,
response and one-shot receipt DTOs. When the active descriptor advertises
`query.application.provider-interactions.read`, the frontend may present only
those exact bounded records. It submits a real owner choice through
`approval.application.interaction.respond` with unchanged interaction and
request-hash identity.

The bridge limits command/file decisions to one-shot choices, permission grants
to the exact requested turn scope, and question/MCP responses to their native
closed shapes. Answer bodies are not returned in later reads. Stale, expired or
uncertain responses are not retried. See
[Application Provider Interactions](application-provider-interactions.md).

## Generated Types

`types/index.d.ts` is generated during the same atomic kit build. Contract
versions, operation families, resource kinds, stable errors, result outcomes,
event modes/reasons and every packaged schema ID come directly from canonical
JSON Schemas. Public class methods come from the runtime client's exported
method inventory, which tests compare with its actual prototype.

The generator intentionally covers the frontend entry envelopes, client
surface, owner-chat profile/binding/input/receipt payloads, archive reads and
provider-interaction request/response/receipt payloads instead of implementing
a second general JSON-Schema compiler. Other nested domain payloads stay
bounded JSON and are validated at runtime with the packaged canonical schemas.
Types improve editor/build feedback; they are not runtime authority,
validation, permission or capability evidence.

## Fake Backend

Import `createFakeApplicationBackend` from `./testing`. It uses the same
gateway descriptor, capability, request/result and A8 cursor contracts as the
reference client, but keeps all state in memory and opens no listener. The
packaged canonical capability example is extended only inside the fixture with
explicit `application-fixture` operations; production gateway capabilities
remain unchanged.

The supported states are `live`, `delayed`, `stale`, `unavailable`,
`contradictory`, `blocked`, `approval-required`, `uncertain` and `recovered`.
Delayed requests use one bounded configured delay. Stale and unavailable fail
at descriptor discovery. Contradictory responses preserve a deliberate
identity mismatch. Blocked, approval-required and uncertain return the stable
error semantics `access_denied`, `continuation_required` and
`uncertain_outcome`. Recovery requires an explicit `setState("recovered")`;
the fixture never retries or heals itself silently.

The fake exposes a fetch-compatible transport and descriptor resolver for the
real `ApplicationFrontendClient`. Its bounded snapshot records only state,
operation identity and timestamps, never request input. It does not read a
provider, project files, credentials, transcripts, SQLite, VS Code or SampleApp.
It is test infrastructure, not an alternate backend authority or writer.

## Consumer Conformance

`runApplicationFrontendConformance()` is a dependency-free async function in
`./testing`. Its ten fixed cases cover all nine A10.4 states plus A8
snapshot/resume. The default run constructs only packaged assets. It needs no
orchestrator source, Codex, VS Code, controller SQLite, project path, provider
history or network listener.

The result contains suite version, aggregate counts and one `passed` or
`failed` record per stable case ID. Failures preserve only a bounded code; raw
exception messages, stack traces, payloads and paths are discarded. The
runner performs no retry and has no authority to mutate production state.

A frontend may supply a compatible `clientFactory` or `backendFactory` to
check its boundary wiring while retaining the same cases. Passing this suite
proves contract behavior against the packaged fake only. It does not prove a
live provider, production gateway capability, user permission or frontend UX.

## Diagnostic Client

`ApplicationFrontendDiagnosticClient` accepts a configured compatible client
and performs one bounded inspection: connect, capability discovery, requested
operation-status reads and an optional initial event snapshot. Operation
status never invokes the advertised operation, including mutation, proposal or
approval families. There is no polling, retry, listener or background state.

The report includes only gateway/capability identity, availability metadata,
resource kinds, bounded provider identity and event mode/count. Bearer tokens,
endpoint secrets, event cursors/bodies, request input, exception text, stacks
and local paths are excluded. Connection/discovery failure is `unavailable`;
an optional event-read failure is `degraded` with an allowlisted problem code.

This proves that the integration boundary can be inspected coherently. It is
not a product frontend, mutation console, service health authority or UX
acceptance surface.

## Compatibility And Migration

The `./compatibility` export publishes one generated policy plus dependency-free
assessment and receipt helpers. A compatible pair is an exact tuple of SDK,
Application contract, capability contract, gateway descriptor and event
contract versions. A missing tuple is `unsupported`; ranges and silent
downgrades are not inferred.

Kit `v0.13.0` is `current`; `v0.12.0`, `v0.11.0`, `v0.10.0`, `v0.9.2`,
`v0.9.1`, `v0.9.0`, `v0.8.0`, `v0.7.0` and `v0.6.0` are explicitly
`supported` against the same accepted backend contracts. This release adds
provider-interaction contracts and types; v0.12 added archive reads and v0.11
added owner chat. Runtime discovery still lists only handlers installed for
the exact gateway instance. Older kits are not declared compatible.
There are no active deprecation notices and no invented retirement date.
A future deprecation must identify its owner, replacement SDK, announcement
time and support deadline. At the deadline assessment becomes `unsupported`.

`createApplicationFrontendMigrationReceipt` records source and target tuples,
their kit-manifest hashes, policy hash, exact outcome, bounded problem codes
and rollback evidence. Its content-derived receipt ID detects modification.
The helper does not install, migrate, retry or roll back anything; the caller
must perform the separately authorized operation first. Receipts deliberately
exclude paths, credentials, provider data, prompts and history.

The packaged `docs/migration-and-rollback.md` binds adoption to manifest
verification, exact compatibility assessment, fake conformance, read-only
diagnostics and a fresh workspace-owned gateway descriptor. Interrupted work
stays `uncertain`; rollback starts the retained source as a new gateway
generation and records an exact `rolled-back` receipt. Neither path mutates or
copies provider-owned state.

## Consumer Rules

1. Resolve the current gateway descriptor and capability discovery first.
2. Treat the packaged schemas as contract knowledge, not proof that an
   operation is currently available.
3. Enable only operations advertised by the active capability descriptor.
4. Apply the error catalog without inventing retries. In particular,
   `uncertain_outcome` is never replayed automatically.
5. On changed gateway instance/session or event epoch, reacquire discovery and
   a fresh snapshot.
6. Treat `operation_not_exposed`, provider ambiguity, stale capabilities and
   response identity mismatch as fail-closed states; the client performs no
   automatic retry.

## Determinism And Privacy

The manifest has no build timestamp or machine path. Every packaged file has a
relative path, byte count and SHA-256. Capability data is synthetic and fixed;
the kit contains no bearer, provider credential, prompt, conversation history,
private project path or account data.

The package is not an authority. User confirmation, policy, writer leases,
provider adapters and receipts remain backend-owned contracts.
