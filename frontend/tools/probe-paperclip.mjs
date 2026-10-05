// PROTOTYPE. Read-only check of the Paperclip bridge. No Electron, no window, no change.
//
// It builds the same session the window builds under --paperclip and exercises
// every read the desk makes, through the real host path: the verified kit
// client, the gateway wrapper and the schema checks of the agent workspace. It
// prints a bounded report and exits with 1 when any read fails.
//
//   node tools/probe-paperclip.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../src/host/session.mjs";
import { buildWorldView } from "../src/host/memory-view.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const note = (name, ok, detail) => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}\n`);
};
const clip = (text, limit = 110) => (text === null ? "(omitted)" : text.replace(/\s+/g, " ").slice(0, limit));

const session = await createSession({ projectRoot: PROJECT_ROOT, mode: "paperclip" });
note("kit delivery", session.delivery?.status === "verified", session.delivery?.status);
if (session.gateway === null) {
  note("configuration", false, session.configuration);
  process.exit(1);
}
const connection = await session.gateway.connection();
note("connection", connection.available === true, connection.available ? connection.projectId : connection.error);
if (!connection.available) process.exit(1);

const operations = await session.gateway.availability({ force: true });
const available = operations.filter((entry) => entry.status === "available").map((entry) => entry.operationId);
note("operations", available.length > 0, `${available.length} available of ${operations.length}`);
for (const entry of operations.filter((item) => item.status !== "available")) {
  process.stdout.write(`       not offered: ${entry.operationId} (${entry.reasonCode})\n`);
}

const view = await buildWorldView(session.gateway, { desktop: session.kit.desktop });
note("world", view.status === "ready", view.status === "ready" ? undefined : (view.error ?? view.catalogs));
if (view.status !== "ready") process.exit(1);
for (const project of view.projection.projects) {
  process.stdout.write(`     project ${project.projectId} «${project.memory.title}» memory rev ${project.memory.revision}\n`);
  for (const quarter of project.quarters) {
    process.stdout.write(`       quarter ${quarter.quarterId} «${quarter.memory.title}» memory rev ${quarter.memory.revision}\n`);
    for (const agent of quarter.agents) {
      process.stdout.write(`         agent ${agent.agentId}: ${agent.state}, delivery ${agent.deliveryState}, `
        + `profile ${agent.profile.provider}/${agent.profile.model}/${agent.profile.reasoningEffort}, `
        + `last ${agent.lastOperation?.state ?? "none"}, questions ${agent.attention?.pendingQuestions}\n`);
    }
  }
}
note("omissions", true, view.projection.omissions);
note("attention list", true, view.attention.map((item) => `${item.kind}:${item.agentId}`));
note("interaction reads", view.interactions?.status === "delivered", view.interactions?.status);

const agents = view.projection.projects.flatMap((project) => project.quarters.flatMap((quarter) => quarter.agents));
const project = view.projection.projects[0];
if (project !== undefined) {
  const scope = await session.gateway.run("query.memory.scope.read", { scopeId: project.memory.scopeId });
  const entries = scope.ok && scope.result.outcome === "succeeded" ? scope.result.output.entries : null;
  note("project memory read", entries !== null, entries === null ? scope : entries.map((entry) => `${entry.id}: ${entry.title}`));
  const quarter = project.quarters[0];
  if (quarter !== undefined) {
    const read = await session.gateway.run("query.memory.scope.read", { scopeId: quarter.memory.scopeId });
    const list = read.ok && read.result.outcome === "succeeded" ? read.result.output.entries : null;
    note("quarter memory read", list !== null, list === null ? read : list.map((entry) => `${entry.id}: ${entry.title}`));
  }
  const files = await session.agentWorkspace.listProjectFiles({ projectId: project.projectId });
  note("project files", files.ok, files.ok ? files.data.entries.map((entry) => entry.name) : files.error);
  if (files.ok) {
    const first = files.data.entries.find((entry) => entry.kind === "file");
    if (first !== undefined) {
      const file = await session.agentWorkspace.readProjectFile({ projectId: project.projectId, path: first.name });
      note(`file read ${first.name}`, file.ok, file.ok ? `${file.data.range.totalBytes} bytes: ${clip(file.data.text, 60)}` : file.error);
    }
    const escape = await session.agentWorkspace.readProjectFile({ projectId: project.projectId, path: "../outside.txt" });
    note("path outside the project is refused", !escape.ok, escape.ok ? "READ SUCCEEDED" : escape.error.code);
  }
}

for (const agent of agents) {
  const context = await session.gateway.run("query.memory.agent.context", { agentId: agent.agentId });
  note(`context ${agent.agentId}`, context.ok && context.result.outcome === "succeeded");
  const conversation = await session.agentWorkspace.conversation({ agentId: agent.agentId });
  note(`conversation ${agent.agentId}`, conversation.ok && conversation.data.route === "live" && conversation.data.traversal?.status === "complete",
    conversation.ok ? { route: conversation.data.route, traversal: conversation.data.traversal, completeness: conversation.data.completeness,
      turns: conversation.data.turns?.length, items: conversation.data.content?.length } : conversation.error);
  if (conversation.ok && conversation.data.content) {
    for (const item of conversation.data.content) {
      process.stdout.write(`         ${item.contentClass.padEnd(19)} ${clip(item.text)}\n`);
    }
  }
  const interactions = await session.gateway.run("query.agent-control.interactions", { agentId: agent.agentId, limit: 16 });
  const records = interactions.ok && interactions.result.outcome === "succeeded" ? interactions.result.output.records : null;
  note(`questions ${agent.agentId}`, records !== null, records === null ? interactions : records.map((record) => `${record.state}: ${record.display.title}`));
  const artifacts = await session.agentWorkspace.listArtifacts({ agentId: agent.agentId });
  note(`artifacts ${agent.agentId}`, artifacts.ok, artifacts.ok ? artifacts.data.records.length : artifacts.error);
  const first = await session.agentWorkspace.pollEvents({ agentId: agent.agentId });
  const second = await session.agentWorkspace.pollEvents({ agentId: agent.agentId });
  note(`events ${agent.agentId}`, first.ok && second.ok, first.ok && second.ok ? `${first.data.action} then ${second.data.action}` : (first.error ?? second.error));
  const archive = await session.gateway.run("query.memory.agent.archive", { agentId: agent.agentId, limit: 100 });
  note(`archive ${agent.agentId}`, archive.ok && archive.result.outcome === "succeeded",
    archive.ok && archive.result.outcome === "succeeded" ? `${archive.result.output.items.length} records` : archive);
}

// This probe has no confirmation surface, so the host must refuse every change.
const refused = await session.mutations.send({ agentId: agents[0]?.agentId ?? "none", text: "must not be sent" });
note("sending is refused without a confirmation surface", refused.ok === false, refused.error?.reasonCode);

const failed = checks.filter((check) => !check.ok);
process.stdout.write(`\n${checks.length - failed.length} of ${checks.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
