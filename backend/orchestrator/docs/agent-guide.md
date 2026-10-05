# Orchestrator Maintainer Agent Guide

Use this guide when changing the component under `orchestrator/` or its
controller and worker delivery adapters.

## Workspace Ownership

The agent running in this isolated VS Code owns `orchestrator-development`.
It implements and verifies orchestrator source, adapters, tests, isolation
integration, and component documentation in this repository. Do not redirect
that work to a hypothetical separate orchestrator-development agent.

`Agents_Factorio_Control` owns cross-project coordination, task dispatch,
deterministic report acceptance, optional review policy, and integration
priorities. SampleApp owns its spatial and VR implementation. Neither workspace
silently edits this repository in place of its active owner.

## Required Reading

1. [README.md](README.md)
2. [architecture.md](architecture.md)
3. [next-architecture-improvements.md](next-architecture-improvements.md)
4. [orchestrator-protocol.md](orchestrator-protocol.md)
5. [engineering-rules.md](engineering-rules.md)
6. [source-editing-on-windows.md](source-editing-on-windows.md)
7. [serialized-control-queue.md](serialized-control-queue.md)
8. [report-operations.md](report-operations.md)
9. [child-chat-routing.md](child-chat-routing.md)
10. [controller-wake-observer.md](controller-wake-observer.md)
11. [intent-confirmation-workflow.md](intent-confirmation-workflow.md)
12. [incident-handling.md](incident-handling.md)
13. [model-selection-policy.md](model-selection-policy.md)
14. [../../docs/workspace/context-and-media.md](../../docs/workspace/context-and-media.md)

Read the attention and VR documents only when the task touches those contracts.

## Validation Setup

Create the project-local Python environment and install validation
dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
```

Validate repository-owned orchestration skills with Codex's official
validator:

```powershell
$validator = ".project-runtime\codex-home\skills\.system\skill-creator\scripts\quick_validate.py"
.\.venv\Scripts\python.exe $validator ".agents\skills\execute-orchestrated-task"
.\.venv\Scripts\python.exe $validator "orchestrator\coordination-kit\controller\.agents\skills\review-child-report"
.\.venv\Scripts\python.exe $validator "orchestrator\coordination-kit\controller\.agents\skills\write-bounded-source-patch"
.\.venv\Scripts\python.exe $validator "orchestrator\coordination-kit\controller\.agents\skills\handle-coordination-incident"
```

## Change Discipline

- preserve official provider ownership;
- keep coordinator intent separate from child-owned implementation choices;
- keep full chat history and reasoning traces out of orchestration records;
- fail closed before implementation when the current plan lacks explicit user
  confirmation, and reread the bounded workflow rules at required checkpoints;
- update component docs, versions, changelog, schemas, and tests together;
- use `gpt-5.6-sol` with reasoning effort `max` and denied fallback for every
  orchestrator-development corrective task; fail closed if unavailable;
- record start identity, bounded progress, and completion evidence through the
  existing task/progress/report contracts rather than a duplicate diary;
- build a new immutable patch for delivery changes;
- use `$write-bounded-source-patch` for every manual Windows controller source
  or durable documentation edit;
- never edit historical task, report, decision, or patch artifacts in place.
