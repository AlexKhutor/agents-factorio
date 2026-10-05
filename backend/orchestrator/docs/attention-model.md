# Human Attention Model

## Purpose

The attention model is a provider-neutral derived read model for human
supervisory control. It answers one bounded question:

> Which current situations require the operator's attention, why, and what
> actions are available?

It does not replace the factual control projection and it is not a UI model.
SampleApp continues to own spatial presentation, grouping, focus, animation,
and input.

## Inputs And Outputs

The factual input remains:

```text
.project-local/projections/control-status.v1.json
```

The control cycle derives and atomically writes:

```text
.project-local/projections/attention-status.v1.json
```

Schemas:

- `orchestrator/schemas/attention-snapshot.schema.json`
- `orchestrator/schemas/attention-event.schema.json`
- `orchestrator/schemas/control-snapshot.schema.json`

`control-status.v1.json` is written first. The attention snapshot records the
exact source control sequence. A consumer accepts a pair only when:

```text
attention.source.controlSchemaVersion == control.schemaVersion
attention.source.controlSequence == control.sequence
```

A sequence mismatch is a short publication race, not permission to merge two
different snapshots. The consumer should wait for the next atomic file update
and report degraded/stale state if convergence does not occur within its
bounded retry interval.

## Ownership Boundary

The orchestrator owns:

- deterministic attention classification;
- dependency impact calculation;
- ranking and urgency;
- bounded reasons, signals, evidence references, and available actions;
- source sequence and freshness evidence.

SampleApp owns:

- which event is visible in the first viewport;
- spatial location, scale, color, sound, animation, and grouping;
- strategic/tactical/operational navigation;
- how a user confirms an advertised action.

The attention model contains no VR geometry, room state, controller binding,
raw Codex transcript, chain-of-thought, media bytes, process ID, secret, or
machine authentication state.

## Event Types

Current model version `v0.1.0` emits:

| Type | Meaning | Base score |
|---|---|---:|
| `decision_required` | An unresolved intervention requires explicit Resume or Cancel | 1000 |
| `stop_unconfirmed` | The provider or worker did not confirm termination | 950 |
| `recovery_required` | A crashed or ambiguous review requires an operator decision | 900 |
| `dependency_blocked` | A blocked task affects one or more dependent tasks | 700 |
| `failed` | A task or projected agent failed | 680 |
| `blocked` | A task or projected agent is blocked locally | 520 |
| `critical_stale` | Active task or agent data is stale or unavailable | 480 |
| `agent_idle` | A desk agent has had no message running for at least its idle threshold: it waits for a task | 200 |

`agent_idle` (source v0.134.0, Claude Code port stage 3) comes from desk
agents, the agents of `project-memory.md`, not from controller tasks. The
control cycle reads their activity from the memory catalog when the memory
database exists (`ProjectMemoryService.listActivity`); `createAttentionProjection`
takes them as `deskAgents` with `idleAfterSeconds` (default 600). The score is
200 plus one per idle minute and stops at 499, so the event stays `low`,
always below every exception; `waitingForHuman` is false: it is a count of
free agents, not a decision the person owes. Its subject is the agent itself:
`sourceId` is the project, `taskId` the agent, `taskKey` `projectId:agentId`,
and `agentIds` is empty because desk agents are not controller agents. An agent
working, waiting for an answer inside a running message, uncertain or closed
raises none. The snapshot contract and its `modelVersion` are unchanged; the
event type set gained `agent_idle` in the event schema and the v2 bridge.

The workflow projection also identifies a task waiting for initial or renewed
plan confirmation. That is a human decision, not a generic blocked state, and
retains the task's intent and current plan reference without including chat
history. Backend publication freshness, agent heartbeat freshness, and
semantic progress age remain distinct signals.

Healthy running, waiting without a blocker, completed, reviewed, integrated,
and cancelled work remains situational background. The model does not emit a
completion event merely because a task completed.

A report in the serialized `queued` review state also remains background even
when its worker progress has become stale. The controller owns that wait and
will process it without a human decision. Stale data becomes an attention
event only for work that should currently be executing, integrating, waiting
on an unresolved condition, or stopping.

An unresolved intervention suppresses a second task-level event for the same
task. This prevents a single human decision from occupying multiple top slots.

A resolved `cancel` decision is also an input to the factual read model when
the intervention contains correlated or confirmed terminal provider evidence
(`turn_aborted` or `turn_cancelled`). The projection then reconciles stale
worker progress to terminal `cancelled` and any matching active worker agent to
`interrupted`. The source progress file is not rewritten. A cancellation
request, an unresolved intervention, or a resolved record without terminal
provider evidence never receives this reconciliation.

## Impact

Impact is derived from the current task dependency graph. It includes:

- transitive `affectedTaskKeys`;
- total and currently active affected task counts;
- affected source IDs;
- maximum dependency depth;
- `local`, `multi_task`, or `cross_workstream` level;
- an ambiguity marker.

Dependencies currently refer to `taskId`. When the same task ID exists in
multiple sources, the model first prefers one unambiguous same-source match.
If no unique match exists, it does not assert a false edge and sets
`dependencyAmbiguous=true` on the candidate source events. A future task
contract may use full task keys, but model `v0.1.0` remains compatible with the
existing contract.

## Ranking

The deterministic score is:

```text
base event score
+ dependency impact bonus, capped at 250
+ non-negative coordinator priority bonus, capped at 100
+ observed-age bonus, capped at 100
```

Urgency thresholds:

| Score | Urgency |
|---:|---|
| 900 or greater | `critical` |
| 700-899 | `high` |
| 500-699 | `medium` |
| below 500 | `low` |

Ties are resolved by whether the event explicitly waits for a human, then by
the oldest observation and stable event ID. At most 256 events are retained in
one snapshot; `topEventIds` contains at most three.

The score is diagnostic backend data. SampleApp may use urgency and rank but
must not reinterpret a numeric score as a spatial coordinate or visual size.

## Event Lifecycle

Attention events are current-state projections, not a second event database.
Their IDs are deterministic for the source signal. The control cycle reads the
previous attention snapshot and preserves `firstObservedAtUtc` while the same
event remains active. Each update supplies:

- `firstObservedAtUtc`;
- `lastObservedAtUtc`;
- `sourceUpdatedAtUtc`;
- `ageSeconds`.

When the underlying condition resolves, the event disappears. Durable task,
report, decision, and stop summaries remain the historical authority. A
future metrics collector may observe these transitions, but raw attention
history must not be injected into agent prompts.

`longestWaitingForHumanSeconds` is a current snapshot measure. It is not a
claim about total historical operator delay.

## Agent Attribution

The factual control projection does not add `agentId` to interventions.
Attention model `v0.1.0` correlates an intervention with projected agents only
when `threadId` or `turnId` matches. The result appears as bounded
`agentIds[]`.

Task IDs can exist in more than one source while the v1 agent preview does not
carry `sourceId`. Agent exceptions are attributed to a task only when that
task ID is unique in the current control snapshot. Ambiguous attribution is
omitted rather than guessed.

## Available Actions

An event advertises only semantic actions supported by its source state:

- `open`;
- `resume`;
- `cancel`;
- `retry`;
- `interrupt`.

Attention events are not command execution. Backend Command Adapter `v0.1.1`
now validates the current control sequence, fresh projection, exact
intervention event, and advertised action before forwarding one existing
managed-child command. SampleApp has not yet been wired to that adapter. Command
acknowledgement and provider stop confirmation remain separate states.

## VR Consumer Sequence

The first SampleApp integration is read-only:

1. watch or poll both projection files;
2. validate supported schema/model versions;
3. require matching control sequence numbers;
4. show overall mode/health from the factual projection;
5. use attention `topEventIds` for the first strategic view;
6. allow drill-down from attention event to task and then agents;
7. preserve stale, ambiguity, attribution, and stop-unconfirmed warnings;
8. never read SQLite, Codex rollouts, or provider auth state.

No non-VR human-supervision experiment is required before this integration.
Automated contract and ranking tests remain required because they protect the
data handed to SampleApp.

This sequence does not set a VR polling or redraw interval. SampleApp owns both.
The orchestrator only publishes timestamps, ages, next-due information, and
supported backend intervals.

The supervised VR test starts only after the child owner reports that the
read-only consumer is ready. The backend command adapter is available, but its
SampleApp UI/client binding and joint control test remain a later phase.

## Metrics For The Later VR Test

The backend exposes timestamps needed for later observation of:

- exception response time;
- current time waiting for a human;
- missed critical events;
- false attention events;
- concurrently supervised workstreams.

If a human-attention bottleneck percentage is calculated, its direction is:

```text
machine time waiting for human / total available machine time
```

Metric collection and acceptance thresholds must be defined with the VR owner
before the supervised test. Model `v0.1.0` does not claim a product result.
