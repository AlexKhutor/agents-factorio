import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createApplicationGatewayFailureLogRecord } from "./application-gateway-runtime.mjs";
import { createProjectMemoryStore } from "./project-memory-store.mjs";
import { bindProjectWorkspace, readProjectWorkspace, rebindProjectWorkspace, resolveProjectWorkspace }
  from "./project-workspace-binding.mjs";
import { createProjectMemoryService } from "./project-memory-service.mjs";
import { createAgentArtifactService } from "./application-agent-artifacts.mjs";
import { createApplicationProjectWorkspaceHandlers } from "./application-project-workspace.mjs";
import { registerDeskAgentSource } from "./desk-agent-sources.mjs";
import { readClaudeProviderConfig } from "./claude-provider-config.mjs";
import { initProjectGit, readAgentCommits } from "./agent-turn-commits.mjs";
import { archiveProject, archiveQuarter, listArchivedProjects, restoreProject, restoreQuarter }
  from "./project-archive.mjs";

export async function runProjectMemoryCommand(options) {
  let phase = "root";
  let root = null;
  try {
  root = await realpath(options["repo-root"]);
  phase = "input-validate";
  const action = options.action;
  const methods = { "list-scopes": "listScopes", "read-scope": "readScope",
    "create-scope": "createScope", "authorize-write": "authorizeWrite", write: "write",
    "bind-workspace": "bindWorkspace", "save-user-edit": "saveUserEdit", "register-artifact": "registerArtifact",
    "set-agent-settings": "setAgentSettings", "preview-memory-document": "previewMemoryDocument",
    "approve-memory-document": "approveMemoryDocument", "register-desk-source": "registerDeskSource",
    "archive-project": "archiveProject", "restore-project": "restoreProject",
    "list-archived-projects": "listArchivedProjects", "archive-quarter": "archiveQuarter",
    "restore-quarter": "restoreQuarter", "read-workspace": "readWorkspace",
    "rebind-workspace": "rebindWorkspace", "set-permission-mode": "setAgentPermissionMode",
    "read-permission-modes": "readPermissionModes", "read-agent-commits": "readAgentCommits",
    "init-project-git": "initProjectGit" };
  if (!Object.hasOwn(methods, action)) throw new Error("unsupported_command");
  let input = {};
  if (options["input-file"]) {
    phase = "input-read";
    const candidate = path.resolve(root, options["input-file"]);
    const canonical = await realpath(candidate);
    const relative = path.relative(root, canonical);
    const info = await lstat(candidate);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)
      || !info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) {
      throw new Error("invalid_argument:input-file");
    }
    input = JSON.parse(await readFile(candidate, "utf8"));
  } else if (!["list-scopes", "list-archived-projects", "read-permission-modes"].includes(action)) {
    throw new Error("missing_argument:input-file");
  }
  phase = "input-validate";
  // Issuance is a trusted local operator action, never a remotely exposed self-grant.
  if (["authorize-write", "save-user-edit", "set-agent-settings", "approve-memory-document"].includes(action)
      && (!input.commandId || options["confirm-user-command"] !== input.commandId)) {
    throw new Error("invalid_argument:confirm-user-command");
  }
  phase = "store-open";
  if (["register-artifact", "register-desk-source", "set-permission-mode"].includes(action) && (typeof input.agentId !== "string"
      || options["confirm-agent"] !== input.agentId)) throw new Error("invalid_argument:confirm-agent");
  const store = await createProjectMemoryStore({ controllerRoot: root });
  phase = "input-validate";
  if (action === "save-user-edit") {
    const expected = ["scopeId", "expectedRevision", "entries", "operationId", "commandId", "actorId"];
    if (Object.keys(input).sort().join() !== expected.sort().join()
        || [input.operationId, input.actorId].some((id) => typeof id !== "string"
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id))) throw new Error("invalid_argument:input-file");
    phase = "authorize";
    await store.authorizeWrite({ commandId: input.commandId, scopeId: input.scopeId,
      expectedRevision: input.expectedRevision, entries: input.entries, requestedBy: input.actorId });
    phase = "write";
    return await store.write(input);
  }
  if (action === "bind-workspace") {
    if (options["confirm-project"] !== input.projectId) throw new Error("invalid_argument:confirm-project");
    phase = "bind-workspace";
    return await bindProjectWorkspace(store, input);
  }
  if (action === "rebind-workspace") {
    // The person confirmed this project and the new folder in the trusted host;
    // refused once the project has a quarter or an agent (memory_workspace_in_use).
    if (options["confirm-project"] !== input.projectId) throw new Error("invalid_argument:confirm-project");
    phase = action;
    return await rebindProjectWorkspace(store, input);
  }
  if (action === "read-workspace") {
    // Read-only: the trusted host shows the person which folder the project is bound to.
    phase = action;
    return await readProjectWorkspace(store, input);
  }
  if (action === "archive-project" || action === "restore-project") {
    // The person confirmed this project in the trusted host; archived projects
    // stay whole and come back unchanged (project-archive.mjs).
    if (Object.keys(input).join() !== "projectId" || options["confirm-project"] !== input.projectId) {
      throw new Error("invalid_argument:confirm-project");
    }
    phase = action;
    return action === "archive-project"
      ? await archiveProject({ store, projectId: input.projectId })
      : await restoreProject({ store, projectId: input.projectId });
  }
  if (action === "archive-quarter" || action === "restore-quarter") {
    // The person confirmed this quarter of this project in the trusted host.
    if (Object.keys(input).sort().join() !== "projectId,quarterId"
        || options["confirm-project"] !== input.projectId || options["confirm-quarter"] !== input.quarterId) {
      throw new Error("invalid_argument:confirm-quarter");
    }
    phase = action;
    return action === "archive-quarter"
      ? await archiveQuarter({ store, projectId: input.projectId, quarterId: input.quarterId })
      : await restoreQuarter({ store, projectId: input.projectId, quarterId: input.quarterId });
  }
  if (action === "list-archived-projects") {
    phase = action;
    return await listArchivedProjects({ store });
  }
  phase = "operation";
  if (["preview-memory-document", "approve-memory-document"].includes(action)) {
    // The trusted host shows the preview, asks the person, then approves the
    // exact document (its SHA-256 from the preview).
    const service = await createProjectMemoryService({ controllerRoot: root, store });
    return await service[methods[action]](input);
  }
  if (action === "register-desk-source") {
    // Makes a desk agent a controller source: tasks of the controller reach it.
    if (Object.keys(input).join() !== "agentId") throw new Error("invalid_argument:input-file");
    const service = await createProjectMemoryService({ controllerRoot: root, store });
    return await registerDeskAgentSource({ controllerRoot: root, service, agentId: input.agentId });
  }
  if (action === "read-agent-commits") {
    // Read-only: the commits of this agent in its project folder (agent-turn-commits.mjs).
    if (Object.keys(input).join() !== "agentId") throw new Error("invalid_argument:input-file");
    const service = await createProjectMemoryService({ controllerRoot: root, store });
    const agent = service.find((await service.catalog()).value, input.agentId);
    const workspace = await resolveProjectWorkspace(store, agent.projectId);
    return { agentId: agent.agentId, ...await readAgentCommits({ folder: workspace.workspacePath, agentId: agent.agentId }) };
  }
  if (action === "init-project-git") {
    // The person agreed in the trusted host: the project folder gets its own git, nothing is committed.
    if (Object.keys(input).join() !== "projectId" || options["confirm-project"] !== input.projectId) {
      throw new Error("invalid_argument:confirm-project");
    }
    const workspace = await resolveProjectWorkspace(store, input.projectId);
    return { projectId: input.projectId, ...await initProjectGit({ folder: workspace.workspacePath }) };
  }
  if (action === "set-permission-mode") {
    // How the agent's tool calls are approved is the person's decision, confirmed
    // by the trusted host for this agent (bypassing every check after a warning).
    const service = await createProjectMemoryService({ controllerRoot: root, store });
    return await service.setAgentPermissionMode(input);
  }
  if (action === "read-permission-modes") {
    // Read-only: each agent's own mode and the provider's, which the others run in.
    const service = await createProjectMemoryService({ controllerRoot: root, store });
    const modes = await service.readPermissionModes();
    const defaultMode = await readClaudeProviderConfig(root).then((config) => config.permissionMode, () => null);
    return { defaultMode, ...modes };
  }
  if (action === "set-agent-settings") {
    // An agent's role and write zone are the person's decision, like memory:
    // confirmed by the trusted host, never set by an agent or a public call.
    const { commandId, ...settings } = input;
    const service = await createProjectMemoryService({ controllerRoot: root, store });
    return await service.setAgentSettings(settings);
  }
  if (action === "register-artifact") {
    const service = await createProjectMemoryService({ controllerRoot: root, store });
    const resources = createApplicationProjectWorkspaceHandlers({ store,
      sourceId: service.archive.projectId, instanceId: "artifact-registration" });
    return await createAgentArtifactService({ service,
      projectRead: resources["query.project-workspace.read"] }).register(input);
  }
  return await store[methods[action]](input);
  } catch (error) {
    // Only a fixed stage crosses the CLI log boundary, never input or file paths.
    if (error && typeof error === "object") {
      error.memoryPhase = phase;
      error.diagnosticId = randomUUID();
      error.diagnosticPersisted = false;
      if (root !== null) {
        try {
          const directory = path.join(root, ".project-local", "memory-cli-diagnostics");
          await mkdir(directory, { recursive: true });
          if (path.relative(directory, await realpath(directory)) !== "") throw new Error("unsafe_diagnostic_path");
          const action = ["list-scopes", "read-scope", "create-scope", "authorize-write",
            "write", "bind-workspace", "save-user-edit", "register-artifact", "set-agent-settings",
            "preview-memory-document", "approve-memory-document", "register-desk-source",
            "archive-project", "restore-project", "list-archived-projects", "archive-quarter",
            "restore-quarter", "read-workspace", "rebind-workspace", "set-permission-mode",
            "read-permission-modes", "read-agent-commits", "init-project-git"]
            .includes(options.action) ? options.action : "unknown";
          const record = { schemaVersion: 1, ...createApplicationGatewayFailureLogRecord(error),
            diagnosticId: error.diagnosticId, action, failedAtUtc: new Date().toISOString(),
            processId: process.pid, nodeVersion: process.versions.node };
          delete record.diagnosticPersisted;
          await writeFile(path.join(directory, `${error.diagnosticId}.json`),
            JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
          error.diagnosticPersisted = true;
        } catch {
          // Preserve the original failure; logging failure never permits a retry.
        }
      }
    }
    throw error;
  }
}
