# Serialized Control Queue

The control workspace owns a deterministic review queue, not provider chat
history. SQLite under `.project-local/orchestration/` is the machine-local
operational authority. Git-backed task packets, reports, decisions, and compact
execution summaries remain the durable authority.

New behavior-changing task packets use confirmed-plan contract `v0.3.0` and
policy `intent-confirm-plan-v1`. The coordinator supplies user-confirmed
intent, observable cross-project outcomes, owner boundaries, forbidden areas,
and explicit safety or compatibility constraints. The target project chooses
the concrete files, implementation, local architecture, and validation plan.
It publishes that plan and waits for explicit confirmation bound to the task
and plan hashes before implementation. Structural plan changes close the gate.
Legacy `v0.1.0` and `v0.2.0` packets remain readable; `allowedPaths` in v0.1.0
is only a maximum safety ceiling.

One cycle performs this order:

1. collect latest bounded worker progress;
2. collect and integrity-check immutable child reports;
3. enqueue unseen report hashes;
4. lease at most one review item;
5. register one diagnostic service run and start its fresh Codex App Server
   thread in `.project-runtime/reviewer-codex-home`;
6. write bounded heartbeats while polling cancellation independently;
7. validate one structured decision and retain its SHA-256;
8. write compact result/problem metadata and the completed task/agent
   projection for other clients;
9. compact eligible events and old tool logs.

For supervised operation, a visible foreground `monitor` republishes bounded
worker and projection state every 10-15 seconds, with 15 seconds as the
default. Worker heartbeat is a separate 30-60 second signal and never rewrites
semantic progress text. The hidden scheduler stays disabled until the VR
consumer and stop lifecycle pass their supervised gates. If later enabled, it
uses `IgnoreNew`; SQLite also rejects a second active lease.
`pause` prevents new work, `drain` finishes the active review then pauses,
`cancel-agent` targets one provider-owned agent, and emergency stop persists
the kill switch before provider interruption. File-handoff workers receive a
cooperative cancellation file and remain unconfirmed until their next progress
heartbeat. Explicit resume also re-enables an existing scheduler task that
emergency stop disabled. Stopping only the scheduler does not pause manual
cycle invocations; persist `paused` when no new lease may be claimed.
Address task cancellation by both `sourceId` and `taskId`; an unqualified
duplicate task ID is rejected as ambiguous.
After confirmed task-level interruption, all projected reviewers and
subagents in that provider tree must be terminal; no actionable child agent
may remain after the task itself is `cancelled`.

Backend consumers, including SampleApp, read
`.project-local/projections/control-status.v1.json`. It is a provider-neutral
contract containing task summaries, explicit plan progress, agent hierarchy,
freshness, blockers, capabilities, and unresolved child interventions. A
manual Stop in an exact managed Codex turn is projected as
`initiator=operator-ui, attribution=correlated, state=awaiting_operator` with
explicit `resume` and `cancel` actions. It contains no VR layout fields and no
raw provider events.

The interactive controller remains on `.project-runtime/codex-home`. Startup
fails before a review turn if the configured reviewer home resolves to the
same path. The normal projection exposes only a diagnostic lookup key, bounded
summary/problems, and evidence availability. Full service threads remain
provider-owned and are opened only through `open_review_diagnostics.bat`.

The same cycle writes
`.project-local/projections/attention-status.v1.json` as a derived strategic
view. It ranks only current exceptions and dependency impact, keeps at most
three top event IDs, and records the exact factual `controlSequence` used to
derive it. Consumers must wait for matching sequences and must not treat this
snapshot as provider history or a VR layout contract.

The child router persists controller stop intent before invoking Stop. A
matching terminal interruption is therefore attributed to the orchestrator;
an unmatched terminal interruption is attributed to the local operator only
inside the one-machine POC. One latest-only intervention file per source lives
under `.project-local/orchestration/child-interventions/`, so this signal does
not become another event or chat archive. Resolve it with
`child_chat_control.ps1 -Action ResolveInterruption` before retrying.
An explicit Cancel first writes the normal cooperative
`.orchestrator/control/inbox/<task-id>.cancel.json` into the child workspace;
delivery failure leaves the intervention unresolved.
The exact same Cancel may be repeated to repair this file idempotently; it
does not reopen the task or authorize another provider turn.
After a resolved Cancel, the factual read model changes matching stale worker
progress to terminal `cancelled` only when the intervention also contains a
correlated or confirmed terminal provider event. It never treats the request
or sentinel alone as proof of termination, and it does not rewrite the child
progress file.

Worker patch `serialized-control-v0.5.5` preserves empty and single-item
collections as JSON arrays under Windows PowerShell 5.1 and validates mutable
progress against the installed worker schema before immutable report
publication. It fixes the implementation without changing report contract
`v0.2.0`.

Patch `serialized-control-v0.9.1` adds task/progress contract `v0.3.0`,
immutable child-plan approval, required rule checkpoints, distinct semantic
and heartbeat timestamps, and the visible foreground projection monitor.
Completed v0.3 progress is accepted as evidence inside the compatible
immutable report contract `v0.2.0`.
It supersedes immutable `v0.9.0` by allowing an empty source registry to
produce a valid empty projection while still rejecting missing bindings for
configured sources.

The supervised single-machine POC accepted the corrective worker report
through a real Codex App Server review and projected all five review steps as
complete. Pause/resume, targeted task cancellation, and emergency stop also
passed against an isolated deterministic test database. Controller patch
`serialized-control-v0.5.7` prevents that stop path from leaving a projected
subagent actionable after its parent task is terminal.
Controller patch `serialized-control-v0.6.0` adds the operator-intervention
contract and decision gate.
The supervised real-provider test confirmed App Server `turn/interrupt` and a
manual Stop in the exact managed SampleApp Codex thread. The intervention
appeared in the backend projection and explicit Cancel restored ready state.
Bugfix patch `serialized-control-v0.6.1` adds fail-closed child cancellation
delivery and exact idempotent repair, installs the reusable logged App Server
probe, and carries this validated documentation into the controller workspace.
Intent-first patch `serialized-control-v0.7.0` moves implementation and local
validation choices to the target project while retaining legacy task reads.
Controller bugfix `serialized-control-v0.7.1` makes the installed coordination
test publish the mandatory final progress snapshot before its immutable report.
Attention patch `serialized-control-v0.8.0` adds a separate strategic
attention snapshot, deterministic dependency-impact ranking, and shared
read-only VR contracts without changing the factual control snapshot schema.
Attention bugfix `serialized-control-v0.8.1` suppresses false human-attention
events for stale reports that are only waiting in the automatic review queue.
Projection bugfix `serialized-control-v0.8.2` removes the remaining false
stale signal after a resolved, provider-confirmed child Cancel without changing
projection contract `v0.1.0`.
Patch `serialized-control-v0.10.0` separates interactive and automated Codex
history, adds a bounded service-review diagnostic index, provides explicit
inspection and backup-first migration tools, and extends the shared task
projection with provider-neutral diagnostic availability.
