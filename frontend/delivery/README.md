# Accepted backend delivery

Files that come from the backend, byte for byte. They are a trusted part of
the application - not settings, not renderer data - and are not edited here:
a new backend delivery replaces them together with the pins in
`src/host/kit.mjs`.

| File | What it is | SHA-256 |
| --- | --- | --- |
| `contracts/accepted-delivery-claude-port-20261003.v1.json` | lock of the active delivery (Frontend Kit v0.21.0) | `f85c8f09b361ab1d23ccdc03d03132a709e03cd6ec0c46aee7228e37d6bf6d36` |
| `contracts/accepted-delivery-claude-port-20261002.v1.json` | lock of the retained delivery (Frontend Kit v0.20.0) | `f460828a4ad27a9cd423494e4b16e78cd2427d35f092997aae83d18299f7efdd` |
| `scripts/verify-accepted-delivery.mjs` | the backend's delivery verifier | `adc66a1e276e74024bb075e3c893977699b8af1901ecb1375da4ea3673371c70` |

Active: release `claude-port-backend-20261003` (the agent chat: steer and
queue, the model picker, the trace), Application Frontend Kit v0.21.0 in
`vendor/frontend-kit/v0.21.0`, manifest SHA-256
`d8915644f708ac4401cb8653b7424974f3e5aff94ea16812eb8f20d8dda883b7`, contracts
application v0.1.0, gateway descriptor v0.2.0, capabilities v0.2.0.

Retained for rollback: release `claude-port-backend-20261002`, Application
Frontend Kit v0.20.0 in `vendor/frontend-kit/v0.20.0`, manifest SHA-256
`d945c73ad6ff6d062481a4d68f368fc8713b650f94112370b0bb2ae3ccae1d66`. The v0.21.0
backend still serves it. The delivery tests verify it; the application never
loads it.

How it is checked: `npm run verify:kit` (and every start of Atlas) reads the
lock pinned in `src/host/kit.mjs`, checks the verifier's hash, then checks
every kit file against the manifest the lock names. Any other bytes and Atlas
refuses to start, with the reason in the readiness panel.
