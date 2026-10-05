# Backend Maintainer Guide

Use this guide when changing the Application Gateway (`backend/orchestrator`)
or the controller template it ships in. The repository-wide rules are in
[AGENTS.md](../../../AGENTS.md).

## Read first

1. [architecture.md](architecture.md) - the three parts and what each owns.
2. [claude-code-provider.md](claude-code-provider.md) - agents as Claude Code
   sessions, permission modes, plan usage, per-turn commits.
3. [project-memory.md](project-memory.md) - memory scopes, delivery, approval.
4. [application-gateway-operations.md](application-gateway-operations.md) and
   [application-gateway-security.md](application-gateway-security.md).
5. [application-contract.md](application-contract.md) and
   [application-frontend-kit.md](application-frontend-kit.md) when a change
   reaches Atlas.

## Checking a change

```powershell
cd backend/orchestrator
npm ci
node scripts/run-tests.mjs                                   # every suite
node --test test/<suite>.test.mjs                            # one suite
node scripts/build-application-gateway-runtime.mjs           # rebuild the bundle
node scripts/build-application-gateway-runtime.mjs --verify  # bundle matches src
```

After rebuilding, copy `dist/application-gateway-cli.bundle.mjs` to
`controller/.orchestrator/runtime/application-gateway-cli.mjs`: the template
must run the same bytes the tests checked.

## Change discipline

- Keep conversation text, reasoning and provider history out of the
  Gateway's records: journals and receipts carry identities, hashes and
  bounded status, not content.
- Every write is an operation with an identity and a receipt; an uncertain
  outcome is reconciled, never resent.
- Agents act inside their write zones and permission modes; never widen them
  from the backend without the person's confirmation in Atlas.
- Change docs, versions, `CHANGELOG.md`, schemas and tests together.
- Never edit a delivered task packet, an imported report or an acceptance in
  place; a changed scope is a new task.
- Tests use fakes (a fake Claude Agent SDK, fixture controllers). Never start
  a real Claude session or spend quota from a test.
