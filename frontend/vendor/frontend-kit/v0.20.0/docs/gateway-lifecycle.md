# Gateway Lifecycle For Consumers

1. Read the project-local connection descriptor. Missing, malformed, expired
   or stale discovery means unavailable; do not guess a port or token.
2. Confirm the descriptor is `ready`, belongs to the expected workspace and
   advertises the operation before enabling a UI action.
3. Send exact A1 requests to `POST /v1/operations` and bounded A8 cursor reads
   to `POST /v1/events/read` with the descriptor bearer.
4. Treat connection loss, changed instance/session/epoch and cursor gaps as a
   resynchronization boundary. Fetch fresh discovery and a fresh snapshot.
5. Never replay a mutation after `uncertain_outcome`. Reconcile authoritative
   state and require a new request identity when the contract permits it.
6. Keep source occurrence, backend observation/publication and client receive
   times separate. A fresh response cannot make stale source evidence current.

The frontend cannot start, stop or recover the gateway by killing processes.
Operator lifecycle commands remain project-scoped. Closing a status monitor is
presentation-only; it does not stop the gateway.

Capability discovery is authoritative for availability, not authority. A
listed mutation still requires its actor, authorization, preview, decision,
lease and receipt contracts. An unlisted operation is unsupported even if its
schema is included in this kit for compatibility or future development.
