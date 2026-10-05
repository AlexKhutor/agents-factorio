# Application Gateway Security

## Scope

A9.4 defines security policy and request preflight for the selected local
gateway before any socket is opened. It reuses the exact A9.3 lifecycle
identity and adds no provider or domain authority.

Canonical artifacts:

- `orchestrator/src/application-gateway-security.mjs`;
- `orchestrator/schemas/application-gateway-security.schema.json`;
- `orchestrator/test/application-gateway-security.test.mjs`.

## Listener And Port

The only allowed first listener configuration is:

- transport `loopback-http-json-ndjson-v1`;
- host `127.0.0.1` and IPv4 only;
- requested port `0`, assigned by the operating system;
- bound unprivileged port `1024..65535`.

`localhost`, `0.0.0.0`, IPv6, LAN interfaces, a caller-selected fixed port and
remote endpoints are rejected. The bound endpoint identity covers transport,
lifecycle instance/hash, session, workspace hash, host and actual port. It
contains no bearer.

## Session Authorization

One session is bound to the exact lifecycle instance identity hash and
workspace-root hash. A caller supplies a random base64url bearer of at least
256 bits; only its SHA-256 enters policy. The raw bearer is accepted ephemerally
for request verification, compared in constant time and never returned in a
decision, status, endpoint, log or projection.

Session lifetime is positive and capped at 24 hours. Restart creates a new
lifecycle instance and therefore requires a new session. A stale instance,
session, workspace or endpoint identity cannot be adopted.

## Host And Origin

Every request must have:

- remote address exactly `127.0.0.1`;
- Host exactly equal to the bound `127.0.0.1:<port>` authority;
- a valid bearer for the exact session;
- either no Origin for a native client or an exact configured browser Origin.

Browser origins are limited to at most eight exact
`http://127.0.0.1:<port>` values. Wildcards, `null`, HTTPS without an approved
local TLS design, `localhost`, remote hosts, credentials, query and fragment
origins are rejected. A future HTTP adapter must emit only the matching Origin
and never wildcard CORS.

## Request Limits

- aggregate headers: 16 KiB;
- declared JSON request: 1,152 KiB, enough for the bounded A1 envelope;
- inbound request timeout: 15 seconds;
- session lifetime: 24 hours;
- allowed browser origins: 8.

Requests without a non-negative bounded content length fail closed. The HTTP
adapter must still count actual received bytes and stop reading at the same
limit; a declared length is not trusted as proof of body size.

## Decisions And Privacy

Preflight returns `allow` or `deny`, a stable reason code and only instance,
lifecycle, session and workspace hashes. Foreign address, Host, Origin,
expired session, large headers/body and bearer mismatch never return raw input
or secret details.

The policy and portable schema reject raw bearer, non-loopback listener and
unknown fields. Provider credentials, chat history, prompts, reasoning, source
bodies and absolute paths are outside this contract.

## Evidence And Next Gate

Combined A9.3/A9.4 lifecycle and security checks pass `16/16`. No listener,
port, process, descriptor, credential file, provider, frontend, VS Code or
SampleApp operation was started.

A9.5 may now build a deterministic in-memory HTTP adapter that maps exact A1
request/result envelopes and A8 read results. It must enforce these controls
before parsing or dispatching a body and still may not publish discovery until
A9.6 readiness is proven.
