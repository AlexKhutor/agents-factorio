---
name: signal-orchestrator
description: Publish one verified local completion, blocked, or failed event after an orchestrated child report is immutable, so the detached controller observer can resume the exact controller workflow without active chat polling.
---

# Signal Orchestrator

Use this only for the current orchestrated task after `submit_report.ps1` has
successfully published its immutable report. The report submitter normally
invokes the signal automatically.

Run:

```powershell
& ".agents\skills\signal-orchestrator\scripts\signal_orchestrator.ps1" `
  -TaskId <task-id>
```

The script validates the task-specific controller return binding, report
identity, task hash, and existing signal before atomically writing
`.orchestrator/events/outbox/<task-id>/wake.json` plus its SHA-256 companion.
It never writes controller files, starts another task, transmits raw provider
history, or wakes on progress heartbeats.

If no valid return binding exists, report `not-configured` and stop. Do not
invent a controller path or thread ID. If a different immutable signal already
exists, report the conflict instead of replacing it.
