# Application Frontend Kit

Candidate v0.16.1 supersedes the unadopted v0.16.0 candidate. For failed
`query.project-workspace.list/read`, `error.code=source_unavailable` may now
include one of three safe `error.reasonCode` values: `workspace_not_bound`,
`workspace_binding_conflict`, or `workspace_path_missing`. An absent reason
remains unknown, not success. No native path or exception text is published.
Use the v0.16.1 lock; do not combine this Kit with the v0.16.0 lock.

Candidate v0.16.0 adds portable contracts and generated types for a hash-guarded
UTF-8 project-file save and atomic project/quarter/current-memory copy. These
are explicit mutations: inspect discovery, preserve receipts and refusals, and
do not infer live acceptance from this package. A consumer needs a separate
v0.16.0 adoption/lock; the installed v0.15.0 delivery stays immutable.

v0.15.0 also includes bound project/artifact reads, observed agent events,
captured attention and requested-profile projection. These are Codex backend
extensions, not a live/UI acceptance claim. See docs/desktop-integration.md;
testing/agent-workspace supplies deterministic DTO samples. Old Kit v0.14.0
remains a separate immutable delivery, not an upgrade-by-file-copy target.

Candidate v0.15.0 includes agent-bound conversation reads. After discovery,
use client.read('query.agent-conversation.resolve', {agentId}) to resolve the
stored binding; client.read('query.agent-conversation.read', {agentId, limit})
returns a bounded provider page, not an archive or event stream. Continue with
the returned nextCursor and the same limit. A stale_revision requires an
explicit new traversal; never silently append refreshed pages to old ones.
Archived agents stay on query.memory.agent.archive. Missing availability is
not an empty chat. Read does not resume/start/replace a provider thread.
Types: ApplicationAgentConversationBinding and ApplicationAgentConversationPage;
schema: application-agent-conversation.v1.json. Candidate build is not adoption.

This package is the small renderer-neutral integration surface for a future
first-party UI. It contains the dependency-free `ApplicationFrontendClient`,
schema-bound TypeScript declarations, accepted Application JSON Schemas, one
capability example, an in-memory fake backend, a package-native conformance
runner, a bounded diagnostic client, exact SDK/backend compatibility policy,
migration-receipt helpers, the stable error catalog and the supervised gateway
lifecycle guide. The package also contains
`docs/migration-and-rollback.md`, which defines exact admission, interrupted
migration and bounded rollback without moving provider-owned state.

Build from this directory:

```powershell
npm run build
```

The deterministic output is written to `dist/`. `npm pack` runs the same build
and creates a locally installable package. Consumers need neither orchestrator
source nor provider history, SQLite, VS Code internals or SampleApp knowledge.

The package does not grant authority and does not imply that every schema is
currently exposed by the production gateway. Read capability discovery first;
unsupported operations must remain disabled in the UI.

Import the client and its generated types from the package root or `./client`.
Supply a descriptor resolver owned by the host application; the client
validates the exact workspace-bound descriptor, discovers capabilities, and invokes only
operations named in both capability data and gateway `exposedOperations`.
It never retries a request automatically.

Kit `v0.13.0` adds exact provider-interaction DTOs and retains the independent
conversation archive reads from `v0.12.0` and exact owner-conversation route
from `v0.11.0`. A host first resolves the backend-selected child binding, then
supplies the
returned `provider` and `threadRef` unchanged when starting an idle turn. If
that binding reports an active turn, the host may steer only that exact
`activeTurnRef`, when the respective send capability is true. Durable command
receipts contain only hashes and lengths; submitted text now has a separate
private backend archive. This does not grant any extra frontend authority.

For captured history, use `query.conversation.archive.resolve`, then
`query.conversation.archive.read` with the returned `conversationId`. Follow
`nextCursor` within one revision, or begin a new snapshot. `coverage` is
`captured-only`: no claim of complete pre-existing provider history. Archive
reads may remain available with capture/provider unavailable; keep sending
disabled unless the separate owner binding and exposed operations allow it.

When discovery advertises `query.application.provider-interactions.read`, a
host may show bounded requests for the exact configured conversation. Submit a
real operator decision only through
`approval.application.interaction.respond`, preserving `interactionId` and the
request SHA-256. Command/file approvals are one-shot, permission grants remain
turn-scoped, and question/MCP answer bodies are not returned by later reads.
Never retry a stale, expired or uncertain response.

```js
const selected = await client.read("query.provider.owner-thread.resolve", {});
const binding = selected.output;
const sent = binding.startAvailable
  ? await client.mutate("mutation.provider.owner-turn.start", {
      provider: binding.provider, threadRef: binding.threadRef, text,
    }, { requestId })
  : binding.steerAvailable ? await client.mutate("mutation.provider.owner-turn.steer", {
      provider: binding.provider, threadRef: binding.threadRef,
      turnRef: binding.activeTurnRef, text,
    }, { requestId }) : null;
```

Use `receipt.provider.owner-message.read` with the same `requestId` after an
ambiguous client-side observation. Never retry `steer` automatically; its
uncertain outcome is intentionally non-replayable.

Import `createFakeApplicationBackend` from `./testing` to exercise the real
client against `live`, `delayed`, `stale`, `unavailable`, `contradictory`,
`blocked`, `approval-required`, `uncertain` and `recovered` states. The fake
opens no listener, changes state only when explicitly requested and records no
request payloads. It is not a production backend or authority.

Run `runApplicationFrontendConformance()` from `./testing` before integrating
the kit. It checks all nine fake states plus A8 snapshot/resume through the
real client and returns one bounded report. A custom frontend-compatible
client factory may be supplied; thrown messages, stack traces and payloads are
not copied into failure results.

Import `ApplicationFrontendDiagnosticClient` from `./diagnostics` for a
one-shot read-only inspection. It reports bounded gateway/capability identity,
operation availability and optional event snapshot metadata. It never invokes
an advertised operation, exposes bearer/cursor/event bodies or acts as a
product frontend.

Import `APPLICATION_FRONTEND_COMPATIBILITY_POLICY` and the assessment/receipt
helpers from `./compatibility`. Compatibility is an exact tuple of SDK,
Application, capability, gateway-descriptor and event-contract versions. The
current `v0.13.0` kit and supported
`v0.12.0`/`v0.11.0`/`v0.10.0`/`v0.9.2`/`v0.9.1`/`v0.9.0`/
`v0.8.0`/`v0.7.0`/`v0.6.0`
predecessors are
listed explicitly; an absent tuple is `unsupported` and never triggers a
downgrade. The additive `v0.13.0` release adds provider-interaction contracts
and types; `v0.12.0` added archive reads and `v0.11.0` added owner chat. The
`v0.10.0` handoff includes the A12 migration and rollback runbook, while
the `v0.9.2` schema set added A11 decision-shadow
evidence alongside the domain operation vocabulary; runtime discovery still
exposes only handlers installed for the exact gateway instance.
There are no active deprecation notices or invented retirement dates.

Migration receipts bind source, target, policy and kit-manifest SHA-256 values.
They record committed, rolled-back, failed or uncertain outcomes and optional
rollback evidence, but do not perform installation, migration or rollback.
They contain no paths, credentials, prompts or history.

The client supports bounded resource reads, provider-scoped operations,
interactions, anchored-review operations, receipts and abortable A8 cursor
reads. Current production gateway adds bounded read/domain bridges, while
authority-dependent operations remain unavailable until the gateway
advertises them. Generated types improve build-time feedback but never replace
runtime schema validation.
