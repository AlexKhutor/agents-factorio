// Read-only connection probe. No Electron, no window, no mutation.
//
// It does exactly what the host does on startup - resolve discovery, check
// workspace identity, discover capabilities, read the two catalogs - and prints
// a bounded report. It never prints the bearer, endpoint, port or memory bodies,
// and it never creates an agent or sends anything: a connectivity check must not
// touch provider state.
//
//   node tools/probe-connection.mjs              live controller from config/local.json
//   node tools/probe-connection.mjs --dev-fixture the local development fixture

import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMode } from "../src/host/config.mjs";
import { createSession } from "../src/host/session.mjs";
import { buildWorldView } from "../src/host/memory-view.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function print(label, value) {
  process.stdout.write(`${label}: ${JSON.stringify(value, null, 2)}\n`);
}

const mode = resolveMode();
const session = await createSession({ projectRoot: PROJECT_ROOT, mode });
// The accepted delivery is verified before anything else, exactly as in the
// window: a rejected kit means no connection is attempted at all.
print("delivery", session.delivery);
if (session.gateway === null) {
  print("configuration", session.configuration);
  process.exitCode = 1;
} else {
  print("controllerRuntime", await session.readRuntimeSummary());
  const connection = await session.gateway.connection();
  print("connection", connection);
  if (!connection.available) {
    process.exitCode = 1;
  } else {
    print("operations", await session.gateway.availability({ force: true }));
    const view = await buildWorldView(session.gateway, { desktop: session.kit.desktop });
    print("worldStatus", {
      status: view.status,
      scopes: view.catalogs.scopes.status,
      agents: view.catalogs.agents.status,
    });
    if (view.projection !== null) {
      print("world", {
        consistency: view.projection.consistency,
        agentRevision: view.projection.agentRevision,
        truncated: view.projection.truncated,
        omissions: view.projection.omissions,
        projects: view.projection.projects.map((project) => ({
          projectId: project.projectId,
          memoryRevision: project.memory.revision,
          quarters: project.quarters.map((quarter) => ({
            quarterId: quarter.quarterId,
            memoryRevision: quarter.memory.revision,
            agents: quarter.agents.map((agent) => ({
              agentId: agent.agentId,
              state: agent.state,
              contentState: agent.contentState,
              deliveryState: agent.deliveryState,
              problemCode: agent.problemCode,
              currentOperationId: agent.currentOperationId,
              taskProgress: agent.taskProgress,
              attention: agent.attention,
            })),
          })),
        })),
      });
      print("attention", view.attention);
      print("interactions", view.interactions);
    } else if (view.error) {
      print("worldError", view.error);
      process.exitCode = 1;
    }
  }
}
