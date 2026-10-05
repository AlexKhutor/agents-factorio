# Orchestrator Architecture Boundary

## Ownership

The target reuses official owners and adds a narrow private workflow layer
above the stable isolation pipeline:

The canonical per-fact and per-command assignments are maintained in
[authority-matrix.md](authority-matrix.md); the list below is a compact
architecture overview, not an alternate authority table.

```text
VS Code Agent Host/AHP  -> frozen read-only protocol/capability probe
Codex App Server        -> Codex threads, turns, subagents, history, interrupt
OpenAI Codex VS Code UI -> visible child owner-thread execution
Git/Markdown            -> immutable tasks, reports, acceptances, decisions
serialized queue        -> deterministic lifecycle and optional review order
controller wake observer -> model-free signal discovery and exact-chat resume
review service home     -> summaries, review threads, and raw diagnostics
managed child adapter   -> isolated launcher lease and exact Codex thread/PID
context preparation     -> planned provider usage gate and same-thread compact
SampleApp                 -> spatial presentation and input
```

The earlier secondary-App-Server daemon, registry, worktree manager, dashboard,
and HTTP broker remain a frozen tested prototype. New coordination code must
not make that prototype a second provider history or session owner. The current
SQLite workflow state is rebuildable under `.project-local/orchestration/`;
durable authority stays in Git-backed task, report, and decision artifacts.

The controller's user-facing Codex history and automatic reviewer history use
different machine-local `CODEX_HOME` directories. The backend keeps a bounded
diagnostic index linking a service run to its task, report, decision, versions,
summary, problems, and raw rollout hash. It does not copy the transcript into
the operational projection. See `service-review-diagnostics.md`.

Each projected agent may also carry bounded provider-neutral statistics. Live
App Server token events, a provider-supplied terminal cost estimate, and the
exact managed child rollout are normalized without copying conversation text.
Statistics remain telemetry, not authority or billing truth. See
`agent-statistics.md`.

Presentation clients discover that operational surface through the versioned
read-only Backend Consumer API. Its descriptor names the projections, schemas,
queries, consistency rules, timing, and current command-surface availability.
The reference client validates and selects one coherent factual/attention pair
without exposing SQLite or provider history. See `backend-consumer-api.md`.

New feature work follows the versioned intent-confirmation lifecycle in
`intent-confirmation-workflow.md`. The coordinator owns confirmed intent and
cross-project outcomes; the child owner proposes the technical plan. A
plan-bound user approval opens implementation. Neither a coordinator prompt nor
a fresh backend heartbeat is evidence that implementation was authorized.

The same controller planning step also selects the complete return contract:
the report operation and the post-wake continuation policy. The user confirms
that choice before dispatch. A wake signal never chooses policy, and
deterministic acceptance alone never authorizes new work. Automatic
continuation may reference only the same confirmed controller-plan revision;
without a supported persisted policy the controller stops after the bounded
wake turn.

## Evolution Boundary

The confirmed staged direction is defined in the
`integration-first-refactor-master-plan.md` ordering authority and its bound
Part 1 and Part 2 checklists. The current evidence-backed status is maintained
in `integration-first-refactor-component-stage-matrix.md`.

`next-architecture-improvements.md` is retained as the historical predecessor
and source rationale only. Its old versions, stage numbering, and current-state
claims no longer authorize work.

The confirmed direction preserves this ownership model while adding these
bounded changes:

1. report availability, deterministic acceptance, direct display,
   summarization, and optional formal review become distinct operations;
2. active workflow events gain bounded causal identity;
3. each task gains a compact rebuildable workflow checkpoint;
4. child sources advertise provider-neutral capabilities and decision
   provenance;
5. a managed existing thread is measured and, when policy requires it,
   compacted before task delivery through the provider-owned Codex path.

Report operations implement item 1: the wake binding selects `accept`, `show`,
`summarize`, `review`, or `import-only`; normal acceptance is deterministic and
model-free. Continuation support is partial pending the integrity and deployed
observer gaps recorded by M0. Causal and capability foundations are partial;
the rebuildable checkpoint and provider context preparation remain planned;
sandbox work remains deferred. See `report-operations.md` for the implemented
boundary and the confirmed master plan for remaining work and gates.

The controller wake observer is a delivery adapter, not a second control
plane. It continuously discovers immutable child wake signals, verifies them,
serializes the selected report operation, and submits one bounded continuation
prompt to the exact managed controller Codex thread. Because VS Code already
owns that open thread, live delivery uses the exact-PID Codex UI adapter rather
than attaching a second App Server writer. See `controller-wake-observer.md`.

## Managed Child Boundary

The managed child adapter never invokes generic `code` or `Code.exe`. It calls
the child source's registered `tools/open_isolated_vscode.ps1`, verifies that
project's `.project-runtime` paths and launch report, and rejects a live runtime
opened outside the controller.

After launch it opens the exact OpenAI Codex thread by deep link, confirms the
route in the extension log, and uses Windows UI Automation only inside
lease-recorded PIDs. Prompt bodies and provider history are never logged or
persisted by the controller.

The planned context-preparation gate sits between exact thread selection and
task submission. It reads bounded provider token usage, calibrates occupancy
against the operator-visible VS Code indicator, and conditionally invokes the
official same-thread compaction operation while idle. It does not scrape the
indicator, rewrite rollout history, or let a second writer race the Codex UI.
The initial policy is advisory at 60% and requires compaction at 75%, subject
to the supervised Stage 4 calibration. This behavior is not implemented in
the current runtime.

Visible child interruption is a controller workflow signal, not provider
history. The adapter persists its own stop intent before invoking Stop. An
unmatched terminal interruption in the exact managed turn becomes a bounded
`awaiting_operator` record until an explicit resume or cancel decision. Cancel
delivers the normal cooperative child-task sentinel before clearing the chat
binding; a failed delivery keeps the intervention unresolved.

## Current Deployment Boundary

The proof of concept is machine-local, not window-global. Multiple registered
child environments and managed VS Code runtimes may coexist on the same
machine, and one runtime may expose multiple editor windows and Codex sessions.
The lease scopes ownership to a source runtime process set.

Remote discovery, cross-PC lease transfer, and distributed task transport are
deferred until this local workflow is proven live.

This layer is intentionally outside `VsCodeIsolate/`. It may be merged or
extracted only after serialized queue recovery, stop semantics, official Agent
Host/AHP conformance, live Codex App Server review, and VR projection handling
have been validated.
