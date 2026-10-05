// PROTOTYPE. An agent's write zone: the paths of the project folder it may change.
//
// Several agents share one project folder, each owning its own part of it (the
// joint solver, the UI, ...). The zone is held by code, not by the model:
// Claude Code asks the desk before every tool call (a PreToolUse hook), and an
// edit of a file outside the zone is refused before it runs. Reading stays
// open - an agent has to see the parts it plugs into. A shell command can change
// any file, so while a zone is set every command goes to the person, whatever
// Claude Code's permission mode would allow on its own.
//
// A pattern is a path from the root of the project folder with forward slashes:
// `tools/jointsolver/**` (everything below), `tools/ui/*.py` (one level),
// `docs/jointsolver.md` (one file), `tools/jointsolver` (that path and below).

import path from "node:path";

/** Tools that write a file, and the input field that names it. */
export const FILE_TOOLS = Object.freeze(new Map([
  ["Edit", "file_path"], ["MultiEdit", "file_path"], ["Write", "file_path"], ["NotebookEdit", "notebook_path"],
]));
/** Tools that run a command: they can change any file. */
export const SHELL_TOOLS = Object.freeze(new Set(["Bash", "PowerShell"]));

const MAX_PATTERNS = 32;
const MAX_PATTERN_LENGTH = 200;

/** The patterns as the person typed them: one per line, trimmed, backslashes turned forward, no duplicates. */
export function normalizeZone(patterns) {
  const seen = new Set();
  const out = [];
  for (const raw of patterns) {
    const pattern = String(raw).trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
    if (pattern === "" || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

/** Why a zone cannot be saved, or null. */
export function zoneProblem(patterns) {
  if (!Array.isArray(patterns)) return "zone_not_a_list";
  if (patterns.length > MAX_PATTERNS) return "zone_too_many_paths";
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return "zone_path_invalid";
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/u.test(pattern)) return "zone_path_invalid";
    // A zone is inside the project folder: no drive, no root, no way up.
    if (/^[A-Za-z]:/u.test(pattern) || pattern.startsWith("/") || pattern.startsWith("\\")) return "zone_path_invalid";
    if (pattern.replace(/\\/gu, "/").split("/").includes("..")) return "zone_path_invalid";
  }
  return null;
}

function matcherOf(pattern, caseless) {
  let source = pattern.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (source.endsWith("/")) source += "**";
  const fold = (text) => (caseless ? text.toLowerCase() : text);
  if (!/[*?]/u.test(source)) {
    const exact = fold(source);
    return (relative) => fold(relative) === exact || fold(relative).startsWith(`${exact}/`);
  }
  let expression = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*" && source[index + 1] === "*") {
      if (source[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  const regex = new RegExp(`^${expression}$`, caseless ? "iu" : "u");
  return (relative) => regex.test(relative);
}

/**
 * The zone of one agent in one folder. `check(file)` says whether a file -
 * absolute, or relative to the folder - may be changed, and names it relative
 * to the folder (null when it lies outside the folder altogether).
 */
export function createZone({ root, patterns, platform = process.platform }) {
  const caseless = platform === "win32";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const matchers = patterns.map((pattern) => matcherOf(pattern, caseless));
  return {
    check(file) {
      const relative = pathApi.relative(root, pathApi.resolve(root, String(file)));
      if (relative === "" || relative.startsWith("..") || pathApi.isAbsolute(relative)) return { allowed: false, relative: null };
      const forward = relative.split(pathApi.sep).join("/");
      return { allowed: matchers.some((matches) => matches(forward)), relative: forward };
    },
  };
}

const decision = (permissionDecision, permissionDecisionReason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason },
});

/**
 * The PreToolUse hook that holds the zone. Its refusal is what the agent reads,
 * so it says what to do instead.
 */
export function zoneHook({ root, patterns, platform = process.platform }) {
  const zone = createZone({ root, patterns, platform });
  const named = patterns.join(", ");
  return async (input) => {
    const tool = input?.tool_name;
    if (FILE_TOOLS.has(tool)) {
      const target = input?.tool_input?.[FILE_TOOLS.get(tool)];
      if (typeof target !== "string" || target === "") return decision("deny", "The file to change is not named.");
      const verdict = zone.check(target);
      if (verdict.allowed) return {};
      return decision("deny", verdict.relative === null
        ? `"${target}" is outside the project folder. You may change files only in your write zone: ${named}.`
        : `"${verdict.relative}" is outside your write zone (${named}). Other agents own the rest of this folder: read it, but do not change it. If a change is needed there, say so in your answer.`);
    }
    if (SHELL_TOOLS.has(tool)) {
      return decision("ask", `A command can change files outside the write zone (${named}), so the person decides.`);
    }
    return {};
  };
}
