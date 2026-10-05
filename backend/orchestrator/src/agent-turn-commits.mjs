import path from "node:path";
import { execFile } from "node:child_process";
import { createWriteZone } from "./agent-write-zone.mjs";

// The work of a desk agent's turn, committed to the git of its project folder:
// the history of what the agents changed, by agent, turn and the person's
// message, without the agent having to remember to commit.
//
// Before a turn the provider takes a snapshot of the folder's uncommitted files
// (path -> content hash); after it, another. What changed between them, inside
// the project folder and the agent's write zone, is that turn's work: only those
// paths are staged and committed (`git commit -- <paths>`), so changes the person
// or another agent left uncommitted are not taken along. The author is the
// agent; the committer the Gateway. A folder that is not under git is reported,
// never initialised here (the trusted host asks the person first). Nothing is
// pushed.

export const AGENT_TURN_COMMITS_VERSION = "v0.1.0";
export const AGENT_COMMIT_DOMAIN = "agents.atlas.local";
const MAX_PATHS = 5000;
const GIT_TIMEOUT_MS = 60_000;
const COMMITTER = Object.freeze(["-c", "user.name=Atlas Gateway", "-c", `user.email=gateway@${AGENT_COMMIT_DOMAIN}`]);

/** The e-mail an agent's commits are authored with: one per agent, searchable in `git log --author`. */
export const agentCommitEmail = (agentId) => `${agentId}@${AGENT_COMMIT_DOMAIN}`;

function runGit(args, { cwd, input = null, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = execFile("git", ["--literal-pathspecs", ...args], { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024, encoding: "utf8", env: { ...env, GIT_TERMINAL_PROMPT: "0" } },
    (error, stdout, stderr) => resolve({ ok: !error, code: error?.code ?? 0, stdout: stdout ?? "", stderr: stderr ?? "" }));
    if (input !== null) child.stdin.end(input);
  });
}

const forward = (value) => value.split(path.sep).join("/");

/**
 * `snapshot(folder)` -> { versioned: false } or { versioned: true, top, inside,
 * files: Map(path from the repository root -> hash | "deleted") } of the
 * folder's uncommitted files; { versioned: true, tooLarge: true } past the limit.
 * `commitTurn(...)` -> { state: "committed", sha, files } | { state: "nothing" }
 * | { state: "not-versioned" } | { state: "failed", reason }.
 */
export function createAgentTurnCommits({ git = runGit } = {}) {
  const queues = new Map();
  // One commit at a time per repository: two agents of one folder finish at once.
  const serial = (key, task) => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(key, next.catch(() => {}));
    return next;
  };

  async function snapshot(folder) {
    const top = await git(["rev-parse", "--show-toplevel"], { cwd: folder });
    if (!top.ok) return { versioned: false };
    const root = path.resolve(top.stdout.trim());
    const inside = forward(path.relative(root, path.resolve(folder)));
    const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", inside === "" ? "." : inside],
      { cwd: root });
    if (!status.ok) return { versioned: true, failed: "status" };
    const fields = status.stdout.split("\0");
    const dirty = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      if (field.length < 4) continue;
      const code = field.slice(0, 2);
      dirty.push({ path: field.slice(3), deleted: code.includes("D") });
      // A rename names its source next; the source is the old path, gone now.
      if (code.includes("R") || code.includes("C")) {
        const source = fields[index + 1];
        if (source) dirty.push({ path: source, deleted: true });
        index += 1;
      }
    }
    if (dirty.length > MAX_PATHS) return { versioned: true, top: root, inside, tooLarge: true };
    const files = new Map();
    const present = dirty.filter((item) => !item.deleted).map((item) => item.path);
    for (const item of dirty.filter((entry) => entry.deleted)) files.set(item.path, "deleted");
    if (present.length > 0) {
      const hashed = await git(["hash-object", "--stdin-paths"], { cwd: root, input: `${present.join("\n")}\n` });
      const hashes = hashed.ok ? hashed.stdout.trim().split(/\r?\n/u) : [];
      present.forEach((file, index) => files.set(file, hashes[index] ?? "unreadable"));
    }
    return { versioned: true, top: root, inside, files };
  }

  /** The paths the turn changed: in the after snapshot and different from before. */
  function changedPaths(before, after) {
    const changed = [];
    for (const [file, hash] of after.files) {
      if (before.files?.get(file) !== hash) changed.push(file);
    }
    return changed;
  }

  async function commitTurn({ folder, before, zone = null, agent, operationId, turnId, status = "completed",
    displayText = null }) {
    if (before?.versioned === false) return { state: "not-versioned" };
    if (!before?.versioned || before.tooLarge || before.failed) return { state: "failed", reason: "no_snapshot" };
    return serial(before.top, async () => {
      const after = await snapshot(folder);
      if (!after.versioned) return { state: "not-versioned" };
      if (after.tooLarge || after.failed || after.top !== before.top) return { state: "failed", reason: "snapshot" };
      const holds = zone === null ? null : createWriteZone({ root: path.resolve(folder), patterns: zone });
      const files = changedPaths(before, after).filter((file) => {
        const inFolder = after.inside === "" || file === after.inside || file.startsWith(`${after.inside}/`);
        if (!inFolder || file.startsWith(".git/") || file.split("/").includes(".project-local")) return false;
        return holds === null || holds.check(path.join(after.top, file)).allowed;
      }).sort();
      if (files.length === 0) return { state: "nothing" };
      const added = await git(["add", "-A", "--", ...files], { cwd: after.top });
      if (!added.ok) return { state: "failed", reason: "add" };
      const words = typeof displayText === "string" ? displayText.trim().split(/\r?\n/u)[0].slice(0, 72) : "";
      const message = [`${agent.agentId}: ${words || "agent turn"}`, "",
        `Project ${agent.projectId} · quarter ${agent.quarterId} · turn ${status}`, "",
        `Atlas-Agent: ${agent.agentId}`, `Atlas-Operation: ${operationId}`, `Atlas-Turn: ${turnId}`].join("\n");
      const committed = await git([...COMMITTER, "commit", "--quiet", "-m", message,
        `--author=${agent.agentId} <${agentCommitEmail(agent.agentId)}>`, "--", ...files], { cwd: after.top });
      if (!committed.ok) return { state: "failed", reason: "commit" };
      const head = await git(["rev-parse", "HEAD"], { cwd: after.top });
      return { state: "committed", sha: head.ok ? head.stdout.trim() : null, files };
    });
  }

  return { snapshot, commitTurn };
}

/**
 * The commits of one agent in a project folder, newest first, for the
 * person's window: hash, time, subject and how many files each changed.
 */
export async function readAgentCommits({ folder, agentId, limit = 20, git = runGit }) {
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: folder });
  if (!top.ok) return { versioned: false, commits: [] };
  const root = path.resolve(top.stdout.trim());
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root });
  if (!head.ok) return { versioned: true, commits: [] };
  const log = await git(["log", `--author=<${agentCommitEmail(agentId)}>`, "-n", String(Math.min(100, Math.max(1, limit))),
    "--format=%x1e%H%x1f%aI%x1f%s", "--name-only"], { cwd: root });
  if (!log.ok) return { versioned: true, commits: [], failed: true };
  const commits = log.stdout.split("\x1e").map((block) => block.trim()).filter(Boolean).map((block) => {
    const [header, ...names] = block.split(/\r?\n/u);
    const [sha, atUtc, subject] = header.split("\x1f");
    return { sha, atUtc, subject: (subject ?? "").slice(0, 200), files: names.filter(Boolean).length };
  });
  return { versioned: true, commits };
}

/** A project folder that is not under git becomes one, after the person agreed: `git init`, nothing committed. */
export async function initProjectGit({ folder, git = runGit }) {
  const top = await git(["rev-parse", "--show-toplevel"], { cwd: folder });
  if (top.ok) return { initialised: false, versioned: true };
  const init = await git(["init", "--quiet"], { cwd: folder });
  if (!init.ok) {
    throw Object.assign(new Error("memory_git_init_failed"), { code: "memory_git_init_failed" });
  }
  return { initialised: true, versioned: true };
}
