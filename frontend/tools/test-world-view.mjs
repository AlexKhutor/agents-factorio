// Building the world: the agents' questions are read in parallel, and the result is the same.
//
// The questions used to be read one agent at a time: twenty-seven requests
// in a row on every fixture refresh. Now they go in parallel, but no more than
// the set limit at once - and what lands on the map must not
// change by a single record because of it.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/host/session.mjs";
import {
  INTERACTION_READ_CONCURRENCY, buildWorldView, mapBounded,
} from "../src/host/memory-view.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// --- mapBounded -----------------------------------------------------------------

{
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, index) => index);
  const results = await mapBounded(items, 4, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await delay((item * 7) % 11);
    inFlight -= 1;
    return item * 10;
  });
  check("result-order-kept",
    results.every((value, index) => value === index * 10), results);
  check("no-more-than-limit-at-once", peak <= 4 && peak > 1, { peak });
  check("empty-list-starts-nothing",
    (await mapBounded([], 4, async () => { throw new Error("must not run"); })).length === 0, null);
}

// --- buildWorldView -------------------------------------------------------------

const session = await createSession({ projectRoot: PROJECT_ROOT, mode: "dev-fixture" });
const INTERACTIONS_OPERATION = "query.agent-control.interactions";

function measured({ serial }) {
  let inFlight = 0;
  let peak = 0;
  let chain = Promise.resolve();
  const gateway = {
    peak: () => peak,
    run(operationId, input) {
      if (operationId !== INTERACTIONS_OPERATION) return session.gateway.run(operationId, input);
      const call = async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await delay(3);
        try { return await session.gateway.run(operationId, input); }
        finally { inFlight -= 1; }
      };
      if (!serial) return call();
      const next = chain.then(call);
      chain = next.catch(() => {});
      return next;
    },
  };
  return gateway;
}

const stable = (view) => ({
  perAgent: view.interactions.perAgent,
  attention: view.attention.map((item) => [
    item.kind, item.agentId, item.interactionId ?? null, item.problemCode ?? null,
    item.field ?? null, item.value ?? null,
  ]),
});

const serialGateway = measured({ serial: true });
const parallelGateway = measured({ serial: false });
const serialView = await buildWorldView(serialGateway, { desktop: session.kit.desktop });
const parallelView = await buildWorldView(parallelGateway, { desktop: session.kit.desktop });

check("world-assembled", serialView.status === "ready" && parallelView.status === "ready",
  { serial: serialView.status, parallel: parallelView.status });
check("questions-read-in-parallel-within-limit",
  parallelGateway.peak() > 1 && parallelGateway.peak() <= INTERACTION_READ_CONCURRENCY,
  { peak: parallelGateway.peak(), limit: INTERACTION_READ_CONCURRENCY });
check("sequential-build-really-sequential", serialGateway.peak() === 1,
  { peak: serialGateway.peak() });
check("result-same-as-one-by-one",
  JSON.stringify(stable(serialView)) === JSON.stringify(stable(parallelView)),
  { serial: stable(serialView), parallel: stable(parallelView) });

const catalogOrder = parallelView.projection.projects
  .flatMap((project) => project.quarters.flatMap((quarter) => quarter.agents.map((agent) => agent.agentId)));
check("records-in-catalog-order",
  JSON.stringify(parallelView.interactions.perAgent.map((entry) => entry.agentId)) === JSON.stringify(catalogOrder),
  { perAgent: parallelView.interactions.perAgent.map((entry) => entry.agentId), catalogOrder });

// --- the agent's profile and binding reach the map ------------------------------------
//
// The agent catalog returns the run profile and the binding, but the kit's projection does not
// carry them. So the window used to assume that “the catalog does not report the profile”, and
// put in its own default profile. The world carries both fields exactly as
// the catalog returned them, and makes nothing up when they are missing.

{
  const raw = (await session.gateway.run("query.memory.agents.list", {})).result.output.agents;
  const byId = new Map(raw.map((agent) => [agent.agentId, agent]));
  const agents = parallelView.projection.projects
    .flatMap((project) => project.quarters.flatMap((quarter) => quarter.agents));
  const mismatched = agents.filter((agent) => {
    const source = byId.get(agent.agentId);
    return JSON.stringify(agent.profile ?? null) !== JSON.stringify(source?.profile ?? null)
      || JSON.stringify(agent.binding ?? null) !== JSON.stringify(source?.binding ?? null);
  }).map((agent) => agent.agentId);
  check("profile-and-binding-from-catalog-reach-world",
    agents.length > 0 && mismatched.length === 0 && agents.every((agent) => agent.profile !== undefined),
    { mismatched, sample: agents[0] });
}

const failed = cases.filter((item) => item.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "world-view",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
