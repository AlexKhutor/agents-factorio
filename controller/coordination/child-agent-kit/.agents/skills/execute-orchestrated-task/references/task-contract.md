# Task Contract Reference

The task packet is immutable after dispatch. Read both `task.md` and
`task.json`; treat `task.json` as the structured authority.

## Authority Split

The coordinator owns the task intent, observable cross-project outcomes,
priority, safety constraints, and final cross-project acceptance. The target
project owns:

- the implementation approach;
- the concrete files and local modules to change inside its documented owner
  boundary;
- the local validation plan and tests;
- local architecture and UX choices that are not explicit owner requirements.

An implementation suggestion, example path, or proposed mechanism from the
coordinator is advisory unless the project owner explicitly recorded it as a
product or compatibility requirement. The child must block or request a
contract change when the requested outcome requires another owning project to
change; it must not implement across that boundary.

## Contract v0.3.0

New behavior-changing tasks use the confirmed-plan contract:

- `intent` and `desiredOutcomes` retain the coordinator-owned purpose;
- `intentConfirmation` proves that the user confirmed the understood intent
  before dispatch;
- `workflowPolicy` is `intent-confirm-plan-v1`;
- the child performs read-only inspection and publishes its own plan;
- an immutable approval bound to the task and plan hashes is required before
  implementation, validation, reporting, or completion;
- a structural plan change invalidates the approval and returns the task to
  `awaiting_confirmation`.

v0.2.0 and v0.3.0 may include an `executionProfile` selected and confirmed by
the controller before dispatch:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-5-5",
  "reasoningEffort": "medium",
  "fallbackPolicy": "deny"
}
```

The provider is the one of the child's route: `anthropic` for a Claude Code
desk agent, `openai` for a Codex child.

This field controls the provider turn, not the child's implementation choices.
The managed router validates and applies it before prompt submission. The
child must not replace it, request a silent fallback, or treat its own UI
default as authoritative. Provider-observed model/effort is controller
telemetry and a mismatch is reported as an orchestration incident.

An incident-repair task targeting `orchestrator-development` carries the
exact profile the controller fixed for incident repair, with
`fallbackPolicy=deny`. The router validates the exact pair against the
current catalog. Unavailability blocks the task; it does not authorize a
fallback.

Corrective work records start and completion through the existing task,
progress, changelog, version, and immutable report artifacts. Durable source,
contract, tool, or behavior changes require a version update, `CHANGELOG.md`,
and affected canonical documentation. State-only recovery requires only its
normal receipt/log and must not create artificial source-version churn.

Technical choices inside a confirmed plan remain target-owned. A material
change to intent, scope, visible behavior, owner, constraints, outcomes, or
plan structure requires a new confirmation. Read
`orchestrator/docs/intent-confirmation-workflow.md` in the source workspace or
the installed `.orchestrator/docs/` copy for the complete lifecycle.

## Contract v0.2.0

New tasks use an intent-first packet:

- `intent` states why the change is needed;
- `desiredOutcomes` contains observable behavior or interface results, not a
  prescribed implementation;
- `responsibilityBoundary` names the owning subsystem and adjacent owners;
- `forbiddenPaths` protects provider state and other known non-owned areas;
- `constraints` contains explicit safety, compatibility, and owner decisions;
- `deliverables` requests bounded evidence or owned outputs;
- `executionAuthority` records that implementation and local validation belong
  to the target while cross-project acceptance belongs to the coordinator.

There is no coordinator-authored `allowedPaths` list in v0.2.0. The target's
documented responsibility boundary and filesystem sandbox are the maximum
write boundary; the child chooses the actual files. There is also no
coordinator-authored technical `acceptanceCriteria` list. The child derives a
local validation plan and reports the tests actually run. The coordinator
reviews the observable `desiredOutcomes` and cross-project constraints.

## Legacy Contract v0.1.0

Already-dispatched v0.1.0 packets remain valid and immutable. For those tasks:

- `objective` is interpreted as the intent;
- `acceptanceCriteria` is interpreted as requested observable outcomes;
- `allowedPaths` is only a maximum safety ceiling, never a list of files that
  must be edited;
- implementation-specific wording is advisory unless it records an explicit
  owner, safety, or compatibility requirement.

Required checks before acceptance:

- `targetId` matches `.orchestrator/contract.json` `sourceId`;
- the contract version is supported;
- the task hash matches `task.sha256`;
- the objective belongs to this project's documented owner scope;
- required reading exists and is relevant;
- the declared responsibility and safety boundaries do not conflict;
- all media and artifacts are project-relative references, never embedded data.

For v0.2.0 and v0.3.0, also verify that `executionAuthority` assigns
implementation and local validation to the target. Before implementation,
derive a bounded local plan from the current repository state. The task packet
stays immutable; the local plan belongs in progress/report evidence, not in a
rewritten task. For v0.3.0, record required rule checkpoints and do not enter
implementation until the matching plan approval exists.

Subagents receive only the bounded subtask, required text, and relative artifact
references. They do not accept the parent task, change its scope, or submit the
final coordinator report.

Workers supporting v0.3.0 must continue to read legacy v0.1.0 and v0.2.0
packets. Worker progress and report output remain independently versioned.
