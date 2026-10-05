# Application Events

## Scope

- Own-UI milestone: A8.
- Current item: A8.5.
- Contract: `application-event-envelope v0.2.0`.
- Owner: `orchestrator-development`.
- Runtime effect: none; A8.1 adds no publisher, journal, watcher or gateway.

This contract gives a future frontend a renderer-neutral event identity without
replacing the existing causal-event envelope, controller EventJournal, wake
signals, provider lifecycle events or authoritative snapshots.

## Two Identities

An Application event has two independently validated identities.

`eventId` identifies the native factual occurrence. Its canonical hash covers:

- event type, correlation and optional causation;
- exact Application resource revision and authority;
- source occurrence time and event authority;
- data schema and data SHA-256.

Observation and publication facts do not change `eventId`. The same occurrence
can therefore be deduplicated after reconnect or republished in a later stream
position without becoming a new fact.

`publicationId` identifies one exact publication of that event. Its hash covers
the event ID, observation time, stream, epoch, sequence, opaque cursor,
publication time and publisher authority. A changed cursor, sequence, publisher
or observation produces a different publication identity while retaining the
same occurrence identity.

## Explicit Clocks And Scope

The envelope preserves three separate clocks:

- `occurredAtUtc`: time asserted by the native event authority;
- `observedAtUtc`: time the backend observed that occurrence;
- `publishedAtUtc`: time the Application publisher emitted this projection.

They must be monotonically ordered. A recent publication cannot make an old
occurrence or observation look fresh. Display cadence is not represented in
the event and remains frontend-owned; A8.5 defines the clock policy below.

A8.5 now adds a pure timing assessment without a timer or refresh command.
It preserves the three backend evidence clocks and adds client receive/evaluate
times only for local assessment. Occurrence, observation and publication each
receive an independent `live`, `delayed`, `stale` or `unknown` state. Therefore
a fresh publication cannot make an old source change or heartbeat appear live.

Backend/client clock skew yields nullable ages and `unknown`, not fabricated
freshness. Client queue delay may change the assessment but never event or
publication identity. The assessment explicitly records
`displayCadenceOwner=frontend` and contains no refresh interval, frame timing,
polling instruction or layout policy.

Every event names one exact `ApplicationResourceRef`. Service and global events
must later use a bounded backend/event resource rather than omit scope or copy
global state. `correlationId` groups one workflow. `causationId` may reference
an accepted existing `causal-event-*` or prior `application-event-*` identity;
it is never inferred from time or adjacency.

## Closed Event Classes

A8.2 requires one of six semantic classes. Each class owns a distinct event
type namespace, so a producer cannot disguise one meaning as another:

- `factual-change` uses `fact.*` for authoritative state changes;
- `heartbeat-freshness` uses `freshness.*` for liveness/freshness evidence;
- `interaction-request` uses `interaction.*` for owner attention requests;
- `provider-stream-item` uses `provider.*` for provider-visible stream facts;
- `command-outcome` uses `command.*` for accepted or observed command results;
- `service-health` uses `service.*` for bounded backend service health.

The class and namespace are both part of stable event identity. A mismatch
fails closed. A8.2 does not decide transport channels or expose provider
content; A8.4 owns that separation.

## Body-Free Boundary

The envelope contains `dataSchema` plus `dataSha256`, not a `data` or `payload`
member. Project files, prompts, transcripts, provider reasoning, credentials,
raw logs, media bytes and frontend presentation fields cannot enter through
the strict field allowlist. The full envelope is capped at 32 KiB.

This does not prevent an authorized task/thread channel from carrying bounded
provider-visible content later. A8.4 owns that separate channel and must not
place its content in the global work feed.

## Authorized Provider Task/Thread Channel

A8.4 reuses the accepted A4 visible-content allowlist and exact provider
conversation identity binding. Provider text is available only in an
`authorized-task-thread` record that proves all of the following:

- the body-free event class is `provider-stream-item` and identifies the exact
  provider item resource;
- provider thread, turn and item belong to one execution-bound immutable Task
  and local Execution;
- the target actor is a presentation-only frontend process;
- an `allow` decision under `provider-content-channel` binds the exact event,
  publication, task, execution, thread, turn, item, actor and content hash;
- authorization was valid at publication time.

Visible content remains limited to A4 user/assistant messages and bounded tool,
change or interaction summaries. Hidden reasoning, private provider payloads,
unknown items, raw logs, media bytes and unsafe/oversized content remain
body-free omission records. The channel record is capped at 96 KiB.

The global feed receives only the strict Application event. It contains no
channel record, text or content hash from the authorized record. Global event
cursor access is not authorization to read provider content.

## Compatibility And Authority

Creating or publishing an event grants no task, provider, decision or mutation
authority. The resource owner remains authoritative for the referenced state;
the event authority owns the occurrence assertion; the publisher owns only the
publication assertion.

A8.1 does not write to `event-journal.mjs` or change its legacy schema. A later
A8 item may adapt accepted source events into this envelope after cursor,
deduplication, gap and bounded replay rules are defined. It must not replay a
provider action or block an authoritative worker/controller lifecycle.

## Snapshot And Resume Contract

A8.3 adds a deterministic in-memory reference broker, not a production store.
Its startup and reconnect rules are fixed:

1. A caller without a cursor receives `snapshot-required`, an exact snapshot
   resource reference and a cursor for that snapshot boundary.
2. A valid cursor for the same stream and epoch receives only later retained
   events, in sequence order and within the requested replay limit.
3. The same occurrence is deduplicated by stable `eventId`; publication is not
   repeated merely because observation is retried.
4. Invalid, foreign-stream, old-epoch, future or retention-gap cursors receive
   `resync-required`, no event tail and a fresh snapshot reference.

Cursors are canonical, integrity-checked and carry only stream, epoch and
sequence claims. They are resume positions, not credentials or authorization.
Replay is capped at 64 events or 2 MiB per read. The reference broker retains
at most 1,024 events or 32 MiB. Defaults are 32 events/256 KiB per replay and
64 events/2 MiB retained. Every global event remains capped at 32 KiB; every
authorized provider-channel record remains capped at 96 KiB.

`reconcileApplicationEventRead(previousCursor, result)` is the client-side
continuity gate. For a resumed page it requires the same stream and epoch,
contiguous event sequences beginning immediately after the previous cursor,
and a result cursor that ends at the delivered boundary. A syntactically valid
page with an omitted event therefore fails with `replay_gap` before the client
advances its cursor.

The deterministic A8.6 failure matrix fixes these recovery rules:

- disconnect does not alter the cursor or stop backend publication;
- last-known-good snapshot identity may be retained for diagnosis, but is
  explicitly not usable as current state;
- a slow consumer outside retention receives `replay_gap` and fetches a fresh
  authoritative snapshot;
- duplicate publication does not advance sequence or repeat delivery;
- planned epoch rollover and broker restart never invent prior replay;
- a restarted client may resume from its durable same-epoch cursor;
- publication freshness remains independent from stale source evidence.

## Backpressure Boundary

The in-memory broker has no subscriber callback and never awaits a frontend.
An authoritative lifecycle may call synchronous `offer()` as an optional
publication side effect and continue regardless of its bounded result:

- `published` and `duplicate` preserve their normal cursor evidence;
- validation or publication failure returns `dropped`, a stable reason code
  and the unchanged cursor, without raw error text;
- count or byte pressure evicts the oldest replay entries; a lagging client
  receives `replay_gap` and must fetch the exact current snapshot;
- replay stops at the first event that would exceed either page budget and
  reports `hasMore=true` instead of buffering work in the publisher.

These are Application contract limits, not transport queue settings. A9 must
apply equal or tighter gateway limits and preserve this non-authoritative,
non-blocking relationship.

The existing EventJournal remains unchanged. No event read repeats a command,
provider call, wake, task dispatch or mutation. `setSnapshot()` accepts only an
already authoritative Application resource reference; the broker does not
invent snapshot content.

## Failure Rules

- Unknown fields, malformed IDs, non-UTC clocks, reversed clock order,
  noncanonical hashes and changed resource identity fail closed.
- A tampered event or publication ID is re-derived and rejected.
- Sequence is a positive safe integer; stream/epoch and cursor are bounded.
- A later observation may create a new publication, never a second occurrence.
- Missing payload bytes remain unavailable and are not reconstructed by a
  model or inferred from another event.

## Evidence And Next Gate

Implementation:

- `orchestrator/src/application-event-envelope.mjs`;
- `orchestrator/schemas/application-event-envelope.schema.json`;
- `orchestrator/src/application-event-stream.mjs`;
- `orchestrator/src/application-event-timing.mjs`;
- `orchestrator/test/application-event-envelope.test.mjs`;
- `orchestrator/test/application-event-stream.test.mjs`;
- `orchestrator/test/application-event-recovery.test.mjs`.

Focused A8.7 backpressure evidence is `6/6`; the combined A8 event regression
is `38/38`. The remaining gate is milestone A8 acceptance before A9 transport.
