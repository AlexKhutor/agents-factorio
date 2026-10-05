---
name: orchestrate-child-workspace
description: Route a confirmed cross-project intent into one registered child workspace, enforce implementation ownership, open its controller-managed isolated VS Code, bind an explicit OpenAI Codex chat, and start or supervise one immutable task without taking over or repairing a child subsystem.
---

# Orchestrate Child Workspace

Preserve subsystem ownership while making every launch, chat selection, task
delivery, and provider turn explicit and observable.

## Required Reading

Read `docs/task-lifecycle.md`, `docs/child-chat-routing.md`,
`docs/responsibility-boundaries.md`,
`docs/source-editing-on-windows.md`,
`config/source-registry.json`, and the relevant
`knowledge/projects/<source-id>.md` before mutating controller or child state.

## Task Authority

1. Confirm the user's intent before creating a v0.3 task.
2. Select the one registered source whose responsibility contains that intent.
   Split cross-owner work into separate tasks with explicit dependencies.
3. The coordinator defines intent, observable desired outcomes, external
   constraints, responsibility boundary, forbidden paths, and cross-project
   acceptance. It does not choose the child's implementation files,
   architecture, technical plan, or local validation.
4. The child owner inspects its current repository, publishes its own plan,
   and waits for confirmation of that plan before implementation.
5. Keep task packets immutable. A material scope change requires a new task
   or a new child plan revision according to the task contract.
6. The controller coordinates owners; it never implements child source,
   orchestrator-development source, the isolation shell, or SampleApp product
   code. Access to a repository does not transfer ownership.
7. During controller planning, select and show the user the complete return
   contract: one report operation and one post-wake continuation policy. The
   user confirms both before dispatch. Do not defer this choice until
   `RunTask`, report arrival, or wake processing.
8. Select the exact child Codex model and reasoning effort from the active
   catalog during the same planning step. Persist it as task
   `executionProfile` with `fallbackPolicy=deny`; never let `RunTask` or the
   child agent silently choose a replacement.

## Managed Launch

1. Inspect the registered source with `tools\list_child_workspaces.bat`.
2. Open it only through:

   ```powershell
   tools\open_child_workspace.ps1 `
     -SourceId <source-id> `
     -ProposedNewChatName "<plain task chat name>" `
     -RepoRoot <controller-root>
   ```

3. Require a successful result with `ReadyForChat=true` and a non-empty
   `ManagedLaunchId`. `child_chat_control -Action LaunchWorkspace` is the only
   launch and lease owner.
4. Never call the registered child launcher directly, open an arbitrary
   folder, adopt a manually opened window, or infer ownership from a title.
5. If a runtime is unmanaged or `managed-launch-unverified`, stop and ask the
   operator to close the recorded process set before retrying.
6. The normal routine mode is `consolidated`. The preparation command opens
   the managed window and returns title-first chat choices plus the active
   model/effort catalog in the same result.
   A separate "is the window visible?" gate is required only for first-use,
   launcher diagnostics, or an operator-selected `supervised-visual` run.
   Deterministic `ReadyForChat=true` is sufficient in routine mode.

## Explicit Chat Choice

Use the choices returned by managed preparation. Ask for one consolidated
operator decision that includes the chat, complete return contract, and child
execution profile:

1. Show every usable existing chat as a numbered title with its last update.
   Do not present a raw thread ID as the user-facing choice. Keep IDs only in
   structured runtime state, or show a short suffix when duplicate titles
   genuinely require disambiguation.
2. Include one proposed new-chat title only if preparation reports
   `newChatChoice.usable=true`. Otherwise explain its `unavailableReason`;
   do not offer or invoke fresh CreateNew. A missing capability flag is not
   evidence of support. Include the plain-language return behavior, for example
   `Accept the verified report, then stop`, and one exact model and reasoning
   effort from the returned catalog.
3. Apply exactly one operator decision:
   - `SelectExisting` with the internal thread ID mapped from the chosen title;
   - `CreateNew` with the confirmed name only when creation is available;
   - `UseError` to stop without selecting a thread.
4. Do not ask for the return contract or execution profile again after
   creating or opening the chosen chat. The same confirmed decision authorizes
   the remaining deterministic selection and dispatch steps.
5. Never silently create a replacement chat when a binding is missing, stale,
   busy, contaminated, or ambiguous.
6. `CODEX_NEW_CHAT_BOOTSTRAP_UNAVAILABLE` means this installed route cannot
   hand an empty chat to the UI. Do not retry with another name, a longer
   timeout, or another cutover flag. Do not reinterpret this as a quota issue.
   Existing attempts and selected chats must be preserved. Selecting a different
   existing chat still requires the operator's choice.
   An available `CreateNew` must verify its separate visible status monitor before
   invoking the provider. Accept only a bound `found` result with non-null
   materialized history and verified exact-thread open. Identity `found` or
   a visible composer alone is not readiness. `CODEX_THREAD_NOT_RESUMABLE`
   and `CODEX_THREAD_RESUME_FAILED` prohibit Send/RunTask; preserve the attempt.
   Never send dummy input or fabricate rollout files to initialize an empty
   thread. A different existing chat requires an explicit operator choice.
   `pending` is an
   active bounded wait; `timeout` after possible invocation and `ambiguous`
   are unresolved outcomes, not absence.
7. Never issue an automatic second CreateNew after an unresolved result.
   Inspect `Status` and preserve the durable attempt. A deliberate same-name,
   same-launch re-entry may only resume reconciliation; the child chat runtime
   must prove that it did not invoke another provider create.

## Dispatch And Start

1. Create a v0.3 JSON definition from the maintained template. Use confirmed
   intent and outcomes; do not reintroduce coordinator-authored `allowedPaths`
   or a technical implementation plan. Copy the confirmed `executionProfile`
   exactly; do not infer it from the controller chat's own model.
2. Deliver it with `tools\dispatch_child_task.ps1` after the managed launch
   and chat choice. Do not use `-OpenWorkspace` when the managed window is
   already open.
3. Delivery is not execution. Confirm `agentTurnStarted=false` until
   `child_chat_control -Action RunTask -TaskId <task-id>` addresses the exact
   bound Codex thread.
4. Before `RunTask`, open a visible controller status shell for the exact task
   and source with `tools\open_control_status_monitor.ps1`. Require
   `ready=true`, a monitor PID, and its machine-local readiness record. The
   visible child VS Code window shows the child's work, while this shell shows
   the controller lifecycle. Neither a hidden observer nor a JSON file alone
   satisfies supervised observability.
   Also require the persistent controller wake observer. Its deterministic
   engine and reopenable read-only monitor are separate processes. The
   `RunTask` wrapper must restore either one when missing or stale and prove
   that the monitor displays the exact current engine instance before prompt
   submission. Do not ask the user to restart it manually unless this bounded
   recovery fails. Do not bypass the second Node readiness check. Closing the
   monitor never stops the engine; use the explicit stop command for that.
5. Before `RunTask`, verify the return contract already selected in the
   confirmed controller plan. Its report operation may be deterministic
   `Accept`, `Show`, explicitly configured `Summarize`, exceptional `Review`,
   or `ImportOnly`. Its continuation policy is `stop-after-report`,
   `continue-confirmed-plan`, or `require-user-decision`. Legacy bindings use
   `stop-after-report`. `continue-confirmed-plan` requires the exact confirmed
   plan revision and SHA-256; a bounded smoke loop also requires its loop ID
   and generation. Never infer or add these values during `RunTask`.
6. `RunTask` waits only for provider-confirmed `task_started`, not for task
   completion. Require `startConfirmed=true`, `status=running`, a configured
   controller return binding, and a watching detached observer. Then end the
   current controller turn. Do not poll, sleep, or rerun `RunTask` while the
   child works; a normal task may take several hours.
   `RunTask` first verifies the selected profile against the active Codex
   catalog and visible UI. The final task result records provider-observed
   `turn_context`; a mismatch is a stop incident and never a fallback.
7. The child report submitter publishes one verified local wake event. The
   persistent deterministic controller observer discovers it even after the
   task-specific child observer exits, imports it, executes only the
   return-binding operation, and starts a new turn in this exact controller
   chat through the managed Codex UI. It never starts a second App Server
   writer for the open thread. Heartbeats update status but never wake the
   controller.
8. Preserve the resulting task, launch, binding, and turn identities. Report
   `delivered`, `workspace opened`, `chat selected`, `provider turn started`,
   `reported`, and `accepted` as separate states.
9. Deterministic acceptance verifies identity, hashes, workflow completion,
   blockers, and evidence without a model. Formal review remains serialized
   and optional. Never treat report availability alone as acceptance.

## Stop Conditions

Stop without improvising when the source is outside the requested owner
boundary, intent is ambiguous, confirmation is absent, launch ownership is
uncertain, chat selection is unresolved, or provider submission cannot be
proved. Do not switch to Agent Host, Copilot, clipboard, coordinates, or an
unregistered process as a fallback.

If this controller discovers or receives an unexpected bug, invoke
`$handle-coordination-incident` and follow
`docs/responsibility-boundaries.md`. Use
`tools\write_coordination_incident.ps1` to write a bounded incident under
`coordination/drafts/incidents/`, identify the proposed implementation owner,
state that no foreign source was changed, and stop. Operational incidents,
task packets, reports, and decisions are runtime records; never use
`apply_patch` to create them. Do not repair the bug from the control workspace
and do not automatically dispatch corrective work unless the new skill proves
that a previously confirmed smoke-repair loop authorizes the exact route.

For any confirmed controller-owned source or durable documentation change,
invoke `$write-bounded-source-patch`. Never send a multi-file or oversized
patch through the Windows `apply_patch` batch wrapper.

Keep media as project-relative path/hash references. Never copy prompt bodies,
provider history, raw UI trees, credentials, or media bytes into task packets,
controller reports, or diagnostic summaries.

## Confirmed Smoke Repair Loop

Use the loop only when the user confirmed it before the first smoke test.
Invoke `$handle-coordination-incident` for each incident and read
`docs/smoke-repair-loop.md`. Create its policy, managed-open
`orchestrator-development`, let the operator select one existing owner chat by
title, and bind that exact idle chat once. Do not create one service chat per
incident.

When a test publishes an immutable incident for `orchestrator-development`:

1. call `RouteSmokeIncident` for the exact `incident.json`;
2. stop if `dispatchAllowed` is false;
3. dispatch the generated fresh v0.3 definition to the returned source;
4. address the already bound maintenance chat and call `RunTask` once with
   `Accept`, `ContinueConfirmedPlan`, exact plan identity, loop ID, and
   generation;
5. end the controller turn after `startConfirmed=true`;
6. after wake and deterministic acceptance, mark `RepairAccepted`, install
   only the returned versioned controller patch, and start a fresh smoke task;
7. mark `RetestStarted` with that fresh ID, then `Passed` or
   `RetestIncident`.

No extra controller question is needed for the preconfirmed mechanical
routing steps. The owner chat still follows its normal child-owned
implementation-plan confirmation gate; the controller must not impersonate
the user or manufacture that approval. Stop and ask the user on that explicit
child gate, the second occurrence of one fingerprint, owner mismatch,
material plan change, uncertain state, or generation limit. Never retry R2,
R3, or any earlier immutable smoke task.
