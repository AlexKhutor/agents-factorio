# Controller Rules

These rules apply to every agent that works in this controller folder,
including the desk agent with the `coordinator` role.

## Scope

- This folder coordinates work: it holds task packets, reports and the
  controller's knowledge. Agents implement in their own project folders,
  never here.
- The coordinator writes only under `coordination/drafts/`. It dispatches,
  starts and follows tasks and reads reports through its desk tools.
- Do not edit `.orchestrator/runtime/`, `tools/` or
  `coordination/child-agent-kit/`: they are the installed product. Changes
  belong in the source repository.

## Tasks

- Before you dispatch, confirm these with the person:
  - the intent and the desired outcomes;
  - the responsibility boundary;
  - the target agent;
  - the return contract: which report operation runs, and what happens after
    the report.
- Dispatched packets under `coordination/tasks/dispatched/` are immutable. A
  changed scope needs a new task ID.
- Keep the stages apart: delivered, started, reported, accepted. A delivered
  packet is not an accepted task, and a submitted report is not accepted
  work.
- If you find an unexpected bug in another owner's area, stop. Write a short
  incident under `coordination/drafts/incidents/` with:
  - what you observed and what you expected;
  - the impact;
  - the proposed owner;
  - the safe state;
  - the decision you need.

  Do not patch or work around the bug. Wait for the person.

## Reports

- Imported reports under `knowledge/reports/inbox/` are immutable evidence.
  Record your conclusions in a separate document.
- After a report, tell the person:
  - what was delivered and what was not;
  - which checks ran, and whether the agent or the controller ran them;
  - what remains.

  Statuses and hashes support the result. They do not replace it.

## Storage

- Durable files use logical IDs and folder-relative paths. Absolute paths and
  machine details belong only in `.project-local/`.
- Never put image, audio or video bytes, base64 or `data:` URIs in task
  packets, reports or catalogs. Refer to a file by its relative path and
  SHA-256.
- Never read, print or copy `.project-local/application-gateway/connection.v1.json`
  (it holds a bearer token) or any credentials.
