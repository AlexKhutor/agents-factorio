---
name: handle-coordination-incident
description: Handle exactly one coordination incident in Agents_Factorio_Control by verifying its immutable evidence, determining the responsible owner, and either routing it through a previously confirmed smoke-repair loop or returning one bounded user decision; never repair a child subsystem or retry a failed operation implicitly.
---

# Handle One Coordination Incident

Use this skill whenever the controller receives, discovers, or is asked to
process an incident. Handle one incident per invocation. An incident is
evidence about a failure, not permission to fix it or repeat the failed action.

Read `docs/responsibility-boundaries.md`. Read
`docs/smoke-repair-loop.md` only when a confirmed loop may apply.

## Intake

1. Identify the exact `coordination/drafts/incidents/<id>/incident.json`.
   Verify that the path is inside the controller workspace, parse the JSON,
   calculate its SHA-256, and inspect only its bounded evidence references.
2. Require observed behavior, expected behavior, impact, current owner,
   proposed owner, required decision, and either `incidentCode` or a stable
   `fingerprintSha256`. Never infer missing evidence from provider history.
3. If the controller itself discovered the incident and no immutable artifact
   exists, create it with `tools\write_coordination_incident.ps1`. Do not use
   `apply_patch` for runtime incident records.
4. Do not rewrite, delete, merge, or supersede the original incident.

## Route Selection

Choose exactly one route:

- **Confirmed smoke loop:** use only when an enabled persisted loop names the
  same test and repair owners, confirmed plan, bound owner chat, execution
  profile, return contract, and remaining limits. Call `RouteSmokeIncident`
  for the exact JSON. If `dispatchAllowed=true`, invoke
  `$orchestrate-child-workspace` for the returned fresh task and exact existing
  chat. Do not ask again about mechanical choices already in the loop policy.
- **Explicit owner task:** when no confirmed loop applies, show the proposed
  owner, evidence, impact, and recommended next action. Obtain one explicit
  user decision before creating or dispatching corrective work.
- **Controller state operation:** a previously authorized deterministic state
  action such as exact import, acceptance, or queue recovery may continue only
  when its existing contract proves identity and idempotence. This route never
  includes source or durable documentation edits.
- **Unresolved:** when ownership, evidence, plan identity, or transport state is
  uncertain, return `attention-required` and one consolidated user question.

The controller coordinates the route. It does not implement
`orchestrator-development` or SampleApp source changes.

Every corrective task whose owner is `orchestrator-development` must request
the exact OpenAI Codex profile `gpt-5.6-sol` with reasoning effort `max` and
`fallbackPolicy=deny`. Validate it against the active child `model/list`
catalog before submission. If that exact profile is unavailable, stop with
`attention-required`; never substitute Terra, Luna, another reasoning effort,
or the controller chat's current model.

## Engineering Record

For a corrective owner task, require the existing task artifacts to record the
work without creating a parallel diary:

- at acceptance/start: incident ID and SHA-256, confirmed intent and plan,
  owning workspace, `startedAtUtc`, branch, and baseline commit or explicit
  non-Git snapshot;
- during work: bounded `now`, `done`, `next`, blockers, heartbeat, and material
  plan revisions in the normal progress contract;
- before completion: changed behavior, files selected by the owner, validation
  actually run, remaining risks, resulting version, and patch/report hashes.

Every durable code, contract, tool, or documented-behavior change must update
the owning project's version, `CHANGELOG.md`, and only the canonical documents
whose truth changed. A deterministic state-only recovery records its normal
receipt/log but does not manufacture a source changelog entry or version bump.
Do not create duplicate session reports when task progress, changelog, and the
immutable completion report already provide the required evidence.

Before accepting a repair, verify that these records agree with the incident,
the confirmed plan, the Git diff, and the delivered patch. Missing durable
documentation is an incomplete result, not permission for the controller to
edit the owner's source.

## Mandatory Stops

Stop without retry or workaround when:

- the same incident fingerprint already entered the active loop;
- the proposed owner conflicts with the affected subsystem;
- the owner chat is missing, stale, busy, or manually opened;
- a task, report, wake, acceptance, or provider submission is ambiguous;
- the confirmed intent, plan, model profile, or responsibility boundary must
  change;
- a user or child implementation-plan gate is reached;
- the loop cycle limit is exhausted.

Never replay an old task, create a replacement chat silently, inspect unrelated
queue items, change Git remotes, push automatically, or edit a neighboring
workspace.

## Result

Return a compact incident disposition containing:

- user-facing incident title and stable code/fingerprint;
- verified incident SHA-256;
- proposed owner and why it matches the boundary;
- selected route and current state;
- exact action performed, if any;
- actions explicitly not performed;
- the single next decision or expected wake event.

Use titles for user-facing chats and tasks. Keep thread IDs and raw provider
identities as bounded technical metadata only.
