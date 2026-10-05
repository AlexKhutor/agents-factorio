// The operations this application is allowed to invoke, and the client method
// each one must go through.
//
// The allowlist is a floor, not a ceiling: an operation listed here is still
// only offered when capability discovery and the descriptor both advertise it.
// Nothing outside this map can be reached from the renderer.

export const READ_OPERATIONS = Object.freeze({
  "query.memory.scopes.list": "read",
  "query.memory.scope.read": "read",
  "query.memory.agents.list": "read",
  "query.memory.agent.read": "read",
  "query.memory.agent.context": "read",
  "query.memory.agent.archive": "read",
  "query.agent-control.interactions": "read",
  // Codex backend P1 (Kit v0.15.0): the agent's bound conversation, its
  // project's files, its registered artifacts and its observed events. They are
  // reached only through src/host/agent-workspace.mjs, which checks inputs and
  // results against the kit's schemas.
  "query.agent-conversation.resolve": "read",
  "query.agent-conversation.read": "read",
  "query.project-workspace.list": "read",
  "query.project-workspace.read": "read",
  "query.agent-artifacts.list": "read",
  "query.agent-artifacts.read": "read",
  "query.agent-events.read": "read",
  // The connected provider's models with their reasoning efforts: the lists of
  // the create-agent form, read through src/host/provider-models.mjs.
  "query.provider.models.list": "read",
  "receipt.memory.agent.send": "receipt",
  // Kit v0.21.0: everything an agent's turns did, in full - the trace tab.
  "query.memory.agent.trace": "read",
});

// Each of these runs only through src/host/mutations.mjs, which mints the
// operation identity and opens a native confirmation first. Memory writes are
// not here: they go through the trusted Gateway CLI action instead.
export const WRITE_OPERATIONS = Object.freeze({
  "mutation.memory.scope.create": "mutate",
  "mutation.memory.agent.create": "mutate",
  "mutation.memory.agent.send": "mutate",
  "mutation.memory.agent.close": "mutate",
  "approval.agent-control.respond": "approve",
  "mutation.agent-control.interrupt": "mutate",
  // Kit v0.16.1: a hash-guarded UTF-8 file save and an atomic copy of a project,
  // its quarters and their current memory. Both confirm with the person first.
  "mutation.project-workspace.save": "mutate",
  "mutation.memory.project.copy": "mutate",
  // Kit v0.21.0: a message while the agent works (steer now or queue for the
  // turn's end), taking a queued one back, and the model of the next turns.
  // As in Codex and Claude Code, none of them asks first.
  "mutation.memory.agent.steer": "mutate",
  "mutation.memory.agent.unqueue": "mutate",
  "mutation.memory.agent.profile": "mutate",
});

export const ALLOWED_OPERATIONS = Object.freeze({
  ...READ_OPERATIONS,
  ...WRITE_OPERATIONS,
});

/**
 * What the desk expects from the backend but cannot use yet. For each entry the
 * host reports only whether discovery advertises it; none of these operation
 * IDs is in ALLOWED_OPERATIONS, so nothing here can be invoked from the
 * renderer until its route is implemented against a published contract.
 *
 * Some expectations have no operation to look for. They are listed with an
 * empty `operations` array and stay "awaited" until their contract says how to
 * detect them - the desk does not guess a field name or a stream id.
 */
export const EXPECTED_CAPABILITIES = Object.freeze([
  Object.freeze({
    capabilityId: "owner-chat",
    operations: Object.freeze([
      "query.provider.owner-thread.resolve",
      "mutation.provider.owner-turn.start",
      "mutation.provider.owner-turn.steer",
      "receipt.provider.owner-message.read",
      "query.provider.thread.read",
    ]),
  }),
  Object.freeze({
    capabilityId: "provider-interactions",
    operations: Object.freeze([
      "query.application.provider-interactions.read",
      "approval.application.interaction.respond",
    ]),
  }),
  Object.freeze({ capabilityId: "several-sources", operations: Object.freeze([]) }),
]);
// Project files, artifacts, the agent-to-conversation link, agent events and
// the attention counts in the catalog arrived with Kit v0.15.0 and are no
// longer awaited: they are allowlisted reads above or fields of the catalog.

export function methodFor(operationId) {
  return Object.hasOwn(ALLOWED_OPERATIONS, operationId)
    ? ALLOWED_OPERATIONS[operationId]
    : null;
}
