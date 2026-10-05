# Application Provider Interactions

> **Reference contract.** Written while the project ran its agents on the Codex App Server,
> and it keeps that era's internal milestone names (A1-A12, release programs, Frontend Kit
> versions) and links to internal reports that are not part of this repository. The contract
> itself still holds: the Claude Code provider presents its sessions in the same shape, so it
> applies to both providers. Start with [architecture.md](architecture.md) and
> [claude-code-provider.md](claude-code-provider.md).

## Scope

Source contract and bridge version `v0.1.0` connects the five supported Codex
App Server request families to renderer-neutral Application interactions for
one exactly configured owner conversation. It does not answer a question,
grant permission, approve an action, start a turn, or install a general
provider writer by itself.

The gateway exposes these operations only after authenticated provider
preflight and exact source/thread/archive binding:

| Operation | Meaning |
| --- | --- |
| `query.application.provider-interactions.read` | Read at most 64 recent bounded request records. |
| `approval.application.interaction.respond` | Submit one exact owner response while the matching provider request is still live. |

Capability discovery and the gateway descriptor remain the availability
authority. A packaged schema is contract knowledge, not evidence that a live
instance exposes either operation.

## Provider Requests

The bridge accepts only these Codex server-request methods:

- `item/commandExecution/requestApproval`;
- `item/fileChange/requestApproval`;
- `item/tool/requestUserInput`;
- `item/permissions/requestApproval`;
- `mcpServer/elicitation/request`.

Every record binds adapter, adapter version, child source, provider runtime,
transport generation and request ID. Item requests additionally require the
exact thread, turn and item identities. The record also binds the independent
archive conversation and a canonical request hash. A request for another
thread or malformed identity fails closed.

Command approval deliberately removes session-wide choices such as
`acceptForSession`; only provider-advertised one-shot `accept`, `decline` and
`cancel` choices may be presented. File approval uses the same one-shot set.
Permission approval is either a turn-scoped grant equal to the requested
permission object or a denial granting an empty object. Questions require one
answer object for every exact question ID. MCP elicitation returns only its
matching `accept`, `decline` or `cancel` shape.

## One-Shot Lifecycle

The request is persisted before it becomes visible to the frontend. The
initial state is `awaiting-owner`. A valid response is first recorded, then
returned through the still-open App Server request, and finally marked
resolved only after provider transport evidence arrives.

The bridge never retries or synthesizes a response. Duplicate responses,
changed request hashes, expired requests and responses without a matching
live waiter fail closed. If a response was recorded but delivery cannot be
proven, the state is `uncertain`; it must not be resent. On gateway/provider
restart, unanswered requests become `stale`, while response-recorded or
response-returned requests become `uncertain`. Recovery scans the complete
bounded record inventory, not only the recent index.

Storage is partitioned by exact archive conversation and stable provider
source/adapter identity. A new provider runtime may recover old evidence, but
new requests retain their new runtime and generation identity. Different
conversation scopes never merge.

## Archive And Privacy

The independent conversation archive receives bounded request/response
activity tied to the same interaction, turn and item. The public interaction
record may include the provider's displayable question, command, path,
permission or form fields because those facts are required for a real owner
decision. It rejects inline media and control characters and caps every
record.

Actual question answers and accepted MCP form content are transient provider
response bodies. Durable Application state stores their canonical SHA-256 and
the selected response, not the answer text. Ordinary status, Work Projection,
logs and receipts never contain the response body. This is not universal
redaction of text the provider itself included in the request display.

## Frontend Rules

Frontend Kit `v0.13.0` packages the closed schema and generated DTOs. A client
must read capability discovery, show the exact current request, preserve its
`interactionId` and request SHA-256, collect a real operator decision, and
submit at most once. It must reacquire state after gateway generation change
and must not reinterpret `stale`, `expired` or `uncertain` as approval.

The normal `-ProviderSourceId` gateway composition installs this bridge only
for the controller-selected materialized owner thread. It does not enable
generic chat creation, provider interrupt, review-comment, Keep/Undo, a
scheduler, or VS Code fallback. Source/fake tests are not live provider or
cross-project acceptance; installed and live evidence is reported separately.
