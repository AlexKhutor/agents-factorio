# Report Contract Reference

Use `.orchestrator/templates/report.md`. Keep the required headings unchanged.

Report facts separately from proposals. State:

- what changed and what did not;
- tests actually run, including failures or skipped checks;
- source revision or an explicit uncommitted-state marker;
- cross-project contract impact;
- artifacts as project-relative paths and optional SHA-256 hashes;
- risks and unresolved questions;
- an `Unexpected Bug` section using `none` or the bounded incident fields from
  `.orchestrator/docs/responsibility-boundaries.md`;
- the exact decision requested from the coordinator.

Do not include raw chat history, copied tool transcripts, base64, data URIs, or
machine-local absolute paths. The final report is immutable after submission.

Report contract `v0.2.0` adds two immutable, bounded JSON companions:

- `progress.json` contains the final task plan and per-agent/subagent preview;
- `execution-summary.json` contains what finished, what remains, blockers,
  final agent summaries, and stop confirmations.

`report.json` stores project-relative file names and SHA-256 hashes for both.
Run `update_task_progress.ps1` with the matching terminal state before
`submit_report.ps1`. The submitter validates the mutable progress snapshot
against `.orchestrator/schemas/worker-progress.schema.json` before it creates
any immutable report artifact. Provider history, reasoning traces, screenshots,
and raw logs remain outside this contract.

After the package is immutable, the submitter invokes the installed
`signal-orchestrator` script. It writes one task-local hashed event under
`.orchestrator/events/outbox/<task-id>/`. The event contains identities and
hashes only; it does not contain report prose, provider history, raw logs, or
media. A missing return binding is reported as `not-configured` and must not be
replaced with a guessed controller path or thread ID.

Progress and execution-summary agent entries may contain a conforming
`statistics` object from `.orchestrator/schemas/agent-statistics.schema.json`.
Report only provider-observed values. Never derive a monetary charge from a
local price table or use zero for unavailable tokens or cost. The controller
may independently overlay statistics collected from the exact managed Codex
task, so a worker is not required to discover or scan provider rollouts.

For task contract `v0.3.0`, the final progress evidence also retains confirmed
intent, lifecycle stage, plan revision/hash, implementation authorization,
rule-review checkpoints, heartbeat time, and semantic-update time. It references
the immutable approval but does not copy user chat text or model reasoning.
Progress contract `v0.3.0` remains a valid companion of report contract
`v0.2.0`; the task, progress, and report contracts are versioned independently.

`submit_report.ps1` rejects `completed` publication unless every plan step is
also `completed`. Historical packages remain immutable. The exceptional
`report-completion-correction.v1` contract may be used only after explicit
project-owner authorization and only when a completed package has exactly one
`running` plan step whose title is the sole `remainingSteps` entry. Its three
new artifacts live under `.orchestrator/reports/corrections/<task-id>/`, bind
the original hashes, and may change only that step to `completed` plus the two
derived execution-summary arrays. The controller must import the correction
and explicitly recover processing; publishing it is not acceptance or retry
permission.
