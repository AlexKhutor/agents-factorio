# Agent-bound conversation reads

> **Reference contract.** Written while the project ran its agents on the Codex App Server,
> and it keeps that era's internal milestone names (A1-A12, release programs, Frontend Kit
> versions) and links to internal reports that are not part of this repository. The contract
> itself still holds: the Claude Code provider presents its sessions in the same shape, so it
> applies to both providers. Start with [architecture.md](architecture.md) and
> [claude-code-provider.md](claude-code-provider.md).

Source v0.128.0; contract v0.1.0; candidate Frontend Kit v0.15.0.
This is a locally implemented part of release-program-20260923, not a full
Codex release, installed controller package or live acceptance.

## Boundary

`query.agent-conversation.resolve` accepts only `{agentId}`. It resolves the
stored agent binding, returning the same conversationId used by the archive,
archiveCoverage=captured-only and a separate liveRead status/reasonCode.
Availability of a provider does not prove completeness of an archive.
No binding means conversationId=null, not an empty or replacement conversation.

`query.agent-conversation.read` accepts `{agentId, limit?, cursor?}`. Limit is
1..128 turns, default 50; cursor is null or an opaque string at most 2048 chars.
The route is exposed only when a provider reader and memory service exist.
Both operations must be checked in discovery/exposedOperations before use.

The caller cannot submit a thread, source, provider, path or workspace selector.
The backend checks stored controller project, Codex provider/source identity,
returned thread identity and the unchanged agent binding after the read.
An archived agent uses the existing query.memory.agent.archive route, not live
read, resume or an automatic fallback. Provider loss does not silently turn a
live read into an archive result. There are no provider writes or thread lists.

## Page semantics

The result contains mode=provider-read, agentId, conversationId, observedAtUtc,
provider revision, thread metadata, turns, filtered content, completeness and
nextCursor. Content is validated by the existing provider reader/content policy
before this application projection: hidden reasoning, raw tool output and
unsafe bodies remain omitted with explicit reasons. No raw provider payload is
added. The portable JSON Schema describes requests, binding and page outputs.
Runtime validation additionally enforces identity, privacy and byte limits.

Completeness describes the provider page traversal, not recovery of omitted
content, provider execution readiness or an archive capture. A page is not a
stream subscription. The route does not start a watcher or poll on its own.

Continuation is authenticated/encrypted with a per-runtime ephemeral key and
bound to agent, conversation, Gateway instance, limit and provider revision.
Native provider cursors are not exposed. A different agent, forged token,
restart, changed limit or changed revision is stale_revision. The consumer must
explicitly discard the old traversal before starting another; there is no
silent retry or merging across revisions. The same reader verifies provider
revision before/after each page. A constantly changing conversation can require
an explicit refresh; event/delta integration is a remaining release work item.

## Failure evidence

Failures record only closed phase/reason/error codes, time, requestId and
correlationId. Gateway CLI adds its instanceId, writes bounded stderr records
and attempts an exclusive first-failure file:
`.project-local/application-gateway/diagnostics/<instanceId>.agent-read.failure.json`.
Later read failures never overwrite it; lifecycle `<instanceId>.failure.json`
is independent. No text, provider cursor, path, credential, raw exception or
stack is retained. A logging failure emits diagnostic_persistence_failed and
does not change the original read refusal or authorize retry.

Phases: input, binding, continuation, provider-read, binding-recheck, output.
Existing Application error codes remain stable; the private reason identifies
the narrower failure. Diagnostics are not delivery receipts or UI evidence.

## Validation and delivery

Offline tests exercise the real read adapter with a fake client, strict schema
validation, encrypted continuation rejection, Gateway wiring, archive survival,
first-failure retention and deterministic Kit schema/type packaging.
No live Codex turn, controller installation or frontend modification is part
of these checks. Kit v0.14.0 and existing immutable controller patches remain
unchanged; v0.15.0 must receive a new accepted-delivery lock before adoption.
