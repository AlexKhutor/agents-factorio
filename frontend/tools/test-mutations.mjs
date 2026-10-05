// Regression test for gateway mutations, against the development fixture.
//
// It drives the real host path - real kit client, real capability gating, real
// confirmation step - and checks the rules that matter: archiving asks first,
// an uncertain send is reconciled instead of repeated, an
// interrupt carries the original send identity, and an answered question cannot
// be answered twice.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/host/session.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];

function check(caseId, condition, detail) {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
}

let answer = true;
const asked = [];
const session = await createSession({
  projectRoot: PROJECT_ROOT,
  mode: "dev-fixture",
  confirm: async (request) => { asked.push(request.title); return answer; },
  chooseDirectory: async () => null,
});
const { mutations, gateway } = session;

// A headless session - one with no confirmation surface - can mutate nothing.
{
  const headless = await createSession({ projectRoot: PROJECT_ROOT, mode: "dev-fixture" });
  const refused = await headless.mutations.send({ agentId: "data-ingest-2", text: "hello" });
  check("no-confirmation-surface-means-no-mutation",
    refused.ok === false && refused.error.reasonCode === "confirmation_surface_unavailable",
    refused);
}

// Archiving asks first, and a declined confirmation archives nothing.
{
  answer = false;
  const before = asked.length;
  const declined = await mutations.closeAgent({ agentId: "data-ingest-2" });
  answer = true;
  check("declined-archive-does-nothing",
    declined.ok === false && declined.error.code === "user_declined" && asked.length === before + 1,
    declined);
}

// Input is validated before anything is sent.
{
  const before = asked.length;
  const empty = await mutations.send({ agentId: "data-ingest-2", text: "" });
  const tooLong = await mutations.send({ agentId: "data-ingest-2", text: "x".repeat(16385) });
  check("invalid-send-never-reaches-a-confirmation",
    empty.ok === false && empty.error.reasonCode === "text_invalid"
      && tooLong.ok === false && tooLong.error.reasonCode === "text_invalid"
      && asked.length === before,
    { empty, tooLong });
}

// A confirmed send is accepted and carries a host-minted identity.
let sendIdentity = null;
{
  const sent = await mutations.send({ agentId: "data-ingest-2", text: "Please start." });
  sendIdentity = sent.ok ? sent.data.identity : null;
  check("confirmed-send-is-accepted-with-its-identity",
    sent.ok === true && sent.data.outcome === "accepted"
      && sendIdentity.operationId.startsWith("atlas-send-")
      && sent.data.output.state === "started",
    sent);
}

// The receipt is read with that identity, not by resending.
{
  const receipt = await mutations.sendReceipt(sendIdentity);
  check("receipt-is-read-by-the-send-identity",
    receipt.ok === true && receipt.data.output.operationId === sendIdentity.operationId
      && receipt.data.output.automaticRetryAllowed === false,
    receipt);
}

// An uncertain outcome is reported as uncertain, never as success, and the
// receipt - not a second send - is what resolves it.
{
  const uncertain = await mutations.send({ agentId: "core-scheduler-2", text: "Please start." });
  const receipt = uncertain.identity === undefined
    ? null
    : await mutations.sendReceipt(uncertain.identity);
  check("uncertain-send-is-reconciled-not-repeated",
    uncertain.ok === false && uncertain.error.code === "uncertain_outcome"
      && uncertain.identity.operationId.startsWith("atlas-send-")
      && receipt !== null && receipt.ok === true && receipt.data.output.state === "uncertain",
    { uncertain, receipt });
}

// An interrupt carries the original send operation id and is only "accepted".
{
  const stopped = await mutations.interrupt({
    agentId: "data-ingest-2", operationId: sendIdentity.operationId,
  });
  const unknown = await mutations.interrupt({
    agentId: "data-ingest-2", operationId: "atlas-send-made-up",
  });
  check("interrupt-uses-the-send-identity",
    stopped.ok === true && stopped.data.output.state === "accepted"
      && stopped.data.output.operationId === sendIdentity.operationId
      && stopped.data.output.automaticRetryAllowed === false
      && unknown.ok === false,
    { stopped, unknown });
}

// A question is answered with a choice the record allows, once.
{
  const notAllowed = await mutations.respond({
    agentId: "data-ingest-1", interactionId: "fixture-interaction-command", selectedResponse: "grant",
  });
  const answered = await mutations.respond({
    agentId: "data-ingest-1", interactionId: "fixture-interaction-command", selectedResponse: "accept",
  });
  const again = await mutations.respond({
    agentId: "data-ingest-1", interactionId: "fixture-interaction-command", selectedResponse: "accept",
  });
  check("question-is-answered-once-with-an-allowed-choice",
    notAllowed.ok === false && notAllowed.error.reasonCode === "choice_not_allowed"
      && answered.ok === true
      && answered.data.output.receipt.deliveryState === "response-returned"
      && answered.data.output.response.operator.actorType === "local-operator"
      && again.ok === false && again.error.code === "interaction_not_pending",
    { notAllowed, answered, again });
}

// Creating an agent needs both memories, and the profile denies fallback.
{
  const orphan = await mutations.createAgent({
    agentId: "atlas-test-agent", projectId: "platform-core", quarterId: "core-q9",
    profile: { provider: "codex", model: "gpt-5.6-sol", reasoningEffort: "max" },
  });
  const created = await mutations.createAgent({
    agentId: "atlas-test-agent", projectId: "platform-core", quarterId: "core-q2",
    profile: { provider: "codex", model: "gpt-5.6-sol", reasoningEffort: "max" },
  });
  check("agent-creation-requires-both-memories",
    orphan.ok === false
      && created.ok === true
      && created.data.output.profile.fallbackPolicy === "deny"
      && created.data.output.deliveryState === "pending",
    { orphan, created });
}

// Closing is for terminal work only.
{
  const sent = await mutations.send({ agentId: "atlas-test-agent", text: "Start." });
  const tooEarly = await mutations.closeAgent({ agentId: "atlas-test-agent" });
  await mutations.interrupt({ agentId: "atlas-test-agent", operationId: sent.data.identity.operationId });
  const closed = await mutations.closeAgent({ agentId: "atlas-test-agent" });
  check("closing-needs-a-terminal-turn",
    tooEarly.ok === false && tooEarly.error.code === "writer_busy" && tooEarly.error.reasonCode === null
      && closed.ok === true && closed.data.output.state === "archived",
    { tooEarly, closed });
  // The close carries its identity, as the contract's agentOperationInput requires,
  // and the same agent always gets the same one: a retry finishes the same close.
  const again = await mutations.closeAgent({ agentId: "atlas-test-agent" });
  check("close-carries-one-identity-per-agent",
    /^atlas-close-[a-f0-9]{32}$/.test(closed.data.identity.operationId ?? "")
      && again.ok === true && again.data.identity.operationId === closed.data.identity.operationId,
    { closed: closed.data.identity, again });
}

// A project and a feature are placed at once, without a confirmation.
{
  answer = true;
  const before = asked.length;
  const project = await mutations.createScope({ kind: "project", projectId: "atlas-rts-project", title: "RTS" });
  const quarter = await mutations.createScope({
    kind: "quarter", projectId: "atlas-rts-project", quarterId: "atlas-rts-q1", title: "Q1",
  });
  check("project-and-feature-are-created-without-a-confirmation",
    project.ok === true && quarter.ok === true && asked.length === before,
    { project, quarter, asked: asked.slice(before) });
}

// Archiving an agent asks first; creating, sending, answering and stopping do
// not - the button in the chat is the decision, as in Codex and Claude Code.
{
  check("only-archiving-asks-first",
    asked.includes("Archive agent")
      && !asked.some((title) => /Send to agent|Answer the question|Stop|Create agent/u.test(title)),
    asked);
}

// The archive is read one bounded page at a time, following its cursor.
{
  const first = await gateway.run("query.memory.agent.archive", { agentId: "data-ingest-2", limit: 32 });
  const cursor = first.ok ? first.result.output.nextCursor : null;
  const second = cursor === null
    ? null
    : await gateway.run("query.memory.agent.archive", { agentId: "data-ingest-2", cursor, limit: 32 });
  check("archive-pages-follow-the-cursor",
    first.ok === true && first.result.output.coverage === "captured-only"
      && typeof cursor === "string"
      && second !== null && second.ok === true
      && second.result.output.revision === first.result.output.revision
      && second.result.output.nextCursor === null
      && second.result.output.items[0].record.omissions.includes("hidden_reasoning"),
    { first, second });
}

// The catalog reflects what happened, and no progress was invented.
{
  const list = await gateway.run("query.memory.agents.list", {});
  const created = (list.result.output.agents ?? [])
    .find((item) => item.agentId === "atlas-test-agent") ?? null;
  check("catalog-shows-the-archived-agent",
    created !== null && created.state === "archived" && created.currentOperationId === null,
    created);
}

const passed = cases.filter(({ status }) => status === "passed").length;
const report = {
  suite: "mutations",
  status: passed === cases.length ? "passed" : "failed",
  caseCount: cases.length,
  passedCount: passed,
  failedCount: cases.length - passed,
  cases,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;
