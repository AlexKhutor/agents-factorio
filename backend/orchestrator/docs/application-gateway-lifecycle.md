# Application Gateway Lifecycle

> **Reference contract.** Written while the project ran its agents on the Codex App Server,
> and it keeps that era's internal milestone names (A1-A12, release programs, Frontend Kit
> versions) and links to internal reports that are not part of this repository. The contract
> itself still holds: the Claude Code provider presents its sessions in the same shape, so it
> applies to both providers. Start with [architecture.md](architecture.md) and
> [claude-code-provider.md](claude-code-provider.md).

## Scope

A9.3 defines the public process/workspace identity and lifecycle state machine
for the selected `loopback-http-json-ndjson-v1` gateway. It does not start a
process, open a listener, allocate a port, create a descriptor or enable
headless startup.

Canonical artifacts:

- `orchestrator/src/application-gateway-lifecycle.mjs`;
- `orchestrator/schemas/application-gateway-lifecycle.schema.json`;
- `orchestrator/test/application-gateway-lifecycle.test.mjs`.

## Exact Identity

Every instance binds:

- lowercase instance UUID;
- positive generation and optional exact predecessor instance UUID;
- fixed transport ID;
- project ID, source ID and canonical workspace-root SHA-256;
- positive process ID, process start time and executable SHA-256;
- canonical identity SHA-256 over all preceding identity facts.

PID alone is never instance identity. Process start time and executable hash
prevent stale PID reuse from being treated as the gateway. Workspace binding
uses a canonical root hash; the public lifecycle status carries no absolute
path. Endpoint, port and session authorization belong to A9.4/A9.6 and are not
accepted by this status contract.

## State Machine

| State | Ready | Terminal | Allowed next action |
| --- | --- | --- | --- |
| `starting` | no | no | mark ready, request Stop, fail, uncertain |
| `ready` | yes | no | heartbeat, request Stop, fail, uncertain |
| `stop-requested` | no | no | heartbeat, confirm stopped, fail, uncertain |
| `stopped` | no | yes | create a new restart generation |
| `failed` | no | yes | create a new restart generation |
| `uncertain` | no | yes | diagnose, then create a new restart generation |

The same Stop request ID is idempotent. A different request conflicts. Stop
may terminate startup without claiming that readiness was ever reached.
Terminal instances cannot heartbeat or transition in place.

## Clocks And Restart

Started, updated, heartbeat, optional ready, Stop and failure times are UTC and
monotonic inside the instance timeline. Imported status is validated with the
same rules as locally produced status.

Restart requires a terminal predecessor. It creates a new UUID, increments
generation, binds `restartOf`, preserves the exact workspace binding and
requires a new process whose start is later than the predecessor's terminal
update. Restart never edits or reactivates the old instance.

## Failure And Privacy

`failed` means a known terminal failure. `uncertain` means startup or shutdown
could not be proven and is also terminal. Both expose only a stable lowercase
reason code and UTC time. Raw exceptions, stack traces, paths, endpoints,
tokens, provider payloads and credentials are forbidden. Public status is
capped at 16 KiB.

Readiness here means lifecycle prerequisites have been confirmed by the future
gateway adapter. It does not yet prove listener security, endpoint discovery
or capability publication; those gates are A9.4-A9.6.

## Evidence And Next Gate

Focused runtime and portable-schema checks pass `8/8`, including startup,
readiness, heartbeat, Stop during ready/startup, terminal failure/uncertainty,
restart generation, process/workspace tampering and clock regression.

A9.4 next defines the exact loopback listener, origin/session authorization,
port discovery and request-size protection before any socket may be opened.
