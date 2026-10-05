# Frontend Handoff Migration And Rollback

## Boundary

This package is the complete renderer-neutral backend handoff. Its
content-addressed manifest binds the client, generated types, schemas, fake
backend, conformance runner, diagnostics, compatibility policy and gateway
lifecycle guide. It contains no credential, provider history, project path or
authority to perform a migration.

Migration changes the selected frontend kit/backend version tuple. It does not
move or rewrite provider sessions, conversations, authentication material,
project content or orchestration authority.

## Admission

1. Retain the exact currently selected kit manifest and gateway generation as
   the rollback candidate.
2. Build or unpack the candidate and verify every file against its manifest.
3. Assess the exact SDK, Application, capability, gateway-descriptor and event
   contract tuple. An absent tuple is unsupported; do not infer a range or
   downgrade.
4. Run package conformance against the fake backend, then run the diagnostic
   client against the candidate gateway. Diagnostics are read-only.
5. Switch only after the candidate gateway is ready and its fresh descriptor
   belongs to the expected workspace. A stale descriptor or bearer is never
   reused.
6. Record a `committed` migration receipt with source, target, policy and both
   manifest hashes. The receipt records evidence; it does not perform the
   switch.

## Interrupted Or Uncertain Migration

If process loss or missing evidence prevents a definitive result, record an
`uncertain` receipt with a bounded problem code. Do not retry a mutation,
reuse a stale gateway descriptor or claim the candidate current. Reconcile
the selected package and exact gateway generation before a later operation.

If failure is definitive before cutover, record `failed`. Keep the source
selection unchanged. Never convert missing evidence into success.

## Rollback

1. Stop the candidate through the exact project gateway lifecycle; do not kill
   arbitrary Node, Codex or VS Code processes.
2. Start the retained source backend/package as a new gateway generation.
3. Resolve a fresh descriptor and rerun conformance plus bounded diagnostics.
4. Verify the exact retained manifest hash and supported compatibility tuple.
5. Record a `rolled-back` receipt whose rollback evidence is `applied` and
   bound to that source SDK and manifest.

Rollback restores the selected application package and gateway generation. It
does not undo provider mutations or rewrite provider history. An uncertain
provider operation remains governed by its operation-specific reconciliation
contract.

## Fail-Closed Rules

- Never copy provider auth or conversation data to make migration portable.
- Never select an older package merely because the candidate is unavailable.
- Never invoke a VS Code compatibility launcher as an automatic fallback.
- Never synthesize a receipt from logs after an unobserved transition.
- Keep frontend presentation acceptance separate from backend compatibility.
