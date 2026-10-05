import path from "node:path";

// An agent's write zone: the paths of its project folder it may change.
//
// Several desk agents share one project folder, each owning its own part of it
// (the joint solver, the UI, ...). A provider that holds zones checks every
// tool call before it runs: an edit outside the zone is refused, reading stays
// open (an agent has to see the parts it plugs into), and a shell command that
// may change files goes to the person unless the agent's permission mode hands
// that over (claudeWriteZoneHook). Two agents of one folder may work at the
// same time only when both have zones and the zones cannot meet.
//
// A pattern is a path from the root of the project folder with forward
// slashes: `tools/jointsolver/**` (everything below), `tools/ui/*.py` (one
// level), `docs/jointsolver.md` (one file), `tools/jointsolver` (that path and
// everything below it).

export const AGENT_WRITE_ZONE_VERSION = "v0.2.0";
export const WRITE_ZONE_LIMITS = Object.freeze({ patterns: 32, patternLength: 200 });

/** Tools that write a file, and the input field that names it. */
export const FILE_TOOLS = Object.freeze(new Map([
  ["Edit", "file_path"], ["MultiEdit", "file_path"], ["Write", "file_path"], ["NotebookEdit", "notebook_path"],
]));
/** Tools that run a command: they can change any file. */
export const SHELL_TOOLS = Object.freeze(new Set(["Bash", "PowerShell"]));

function fail(code) { throw Object.assign(new Error(code), { code }); }

/** Patterns as a person writes them: trimmed, forward slashes, no leading "./", no duplicates. */
export function normalizeWriteZone(patterns) {
  if (!Array.isArray(patterns)) fail("memory_invalid_input");
  const seen = new Set();
  const out = [];
  for (const raw of patterns) {
    if (typeof raw !== "string") fail("memory_invalid_input");
    const pattern = raw.trim().replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
    if (pattern === "" || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  if (out.length < 1 || out.length > WRITE_ZONE_LIMITS.patterns) fail("memory_invalid_input");
  for (const pattern of out) {
    // A zone lies inside the project folder: no drive, no root, no way up.
    if (pattern.length > WRITE_ZONE_LIMITS.patternLength || /[\u0000-\u001f\u007f]/u.test(pattern)
        || /^[A-Za-z]:/u.test(pattern) || pattern.startsWith("/")
        || pattern.split("/").includes("..")) fail("memory_invalid_input");
  }
  return out;
}

function matcherOf(pattern, caseless) {
  let source = pattern;
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
      if (source[index + 2] === "/") { expression += "(?:.*/)?"; index += 2; }
      else { expression += ".*"; index += 1; }
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  const regex = new RegExp(`^${expression}$`, caseless ? "iu" : "u");
  return (relative) => regex.test(relative);
}

/**
 * The zone of one agent in one folder. `check(file)` says whether a file
 * (absolute, or relative to the folder) may be changed, and names it relative
 * to the folder (null when it lies outside the folder altogether).
 */
export function createWriteZone({ root, patterns, platform = process.platform }) {
  const caseless = platform === "win32";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const matchers = patterns.map((pattern) => matcherOf(pattern, caseless));
  return {
    check(file) {
      const relative = pathApi.relative(root, pathApi.resolve(root, String(file)));
      if (relative === "" || relative.startsWith("..") || pathApi.isAbsolute(relative)) {
        return { allowed: false, relative: null };
      }
      const forward = relative.split(pathApi.sep).join("/");
      return { allowed: matchers.some((matches) => matches(forward)), relative: forward };
    },
  };
}

/** The folder every match of a pattern lies in: the segments before the first wildcard. */
function literalPrefix(pattern) {
  const segments = pattern.replace(/\/$/u, "").split("/");
  const literal = [];
  for (const segment of segments) {
    if (/[*?]/u.test(segment)) break;
    literal.push(segment);
  }
  return literal;
}

/**
 * Whether two zones may share a file. Conservative: two patterns are taken to
 * meet when the folder of one contains the folder of the other, so a false
 * "they meet" only costs parallelism, never safety.
 */
export function writeZonesOverlap(left, right, platform = process.platform) {
  const fold = (segment) => (platform === "win32" ? segment.toLowerCase() : segment);
  const prefixes = (zone) => zone.map((pattern) => literalPrefix(pattern).map(fold));
  for (const a of prefixes(left)) {
    for (const b of prefixes(right)) {
      const shorter = a.length <= b.length ? a : b;
      const longer = shorter === a ? b : a;
      if (shorter.every((segment, index) => longer[index] === segment)) return true;
    }
  }
  return false;
}

const decision = (permissionDecision, permissionDecisionReason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason },
});

// Commands that only read, by their program (and, for git, its subcommand).
// Conservative: anything not recognised counts as one that may write.
const READ_ONLY_PROGRAMS = new Set(["ls", "dir", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg",
  "find", "pwd", "echo", "printf", "which", "where", "type", "file", "stat", "du", "df", "tree", "sort", "cut",
  "tr", "basename", "dirname", "realpath", "readlink", "date", "whoami", "hostname", "true", "test", "cd"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "describe",
  "blame", "shortlog", "cat-file", "grep"]);
const READ_ONLY_POWERSHELL = new Set(["get-childitem", "gci", "ls", "dir", "get-content", "gc", "cat", "type",
  "select-string", "sls", "get-item", "gi", "get-location", "pwd", "test-path", "resolve-path", "measure-object",
  "select-object", "where-object", "sort-object", "format-table", "format-list", "out-string", "get-command",
  "write-output", "echo", "set-location", "cd", "get-date", "split-path", "join-path"]);
// Options by which a reading program writes after all (find's actions, git's
// --output; sort and tree write to the file after -o).
const WRITING_OPTIONS = /(?:^|\s)(?:-exec|-execdir|-ok|-okdir|-delete|-fprint\S*|-fls|--output\S*)(?:\s|=|$)/u;
const OUTPUT_FILE_OPTION = /(?:^|\s)-o(?:\s|$)/u;

/**
 * Whether a shell command only reads: every part of it (split on `&&`, `||`,
 * `;`, `|` and new lines outside quotes) runs a reading program, nothing is
 * redirected into a file and nothing is substituted. Redirections to /dev/null
 * ($null in PowerShell) and 2>&1 are reading too. Not recognised - a loop, a
 * script, an unknown program - means it may write.
 */
export function readOnlyShellCommand(command, { powershell = false } = {}) {
  if (typeof command !== "string" || command.trim() === "" || command.length > 8192) return false;
  // Substitution runs a command even inside double quotes.
  if (/`|\$\(|<\(|>\(/u.test(command)) return false;
  const text = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/gu, "Q")
    .replace(/\d?&?>{1,2}\s*(?:\/dev\/null|\$null)|2>&1/giu, " ");
  if (text.includes(">") || (powershell && /\bOut-File\b|\bTee-Object\b|\bSet-Content\b/iu.test(text))) return false;
  const parts = text.split(/&&|\|\||;|\||\r?\n/u).map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length === 0) return false;
  return parts.every((part) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(part) || /^[&.]\s/u.test(part)) return false;
    const words = part.split(/\s+/u);
    const program = words[0].replace(/\.exe$/iu, "");
    if (powershell) return READ_ONLY_POWERSHELL.has(program.toLowerCase());
    if (WRITING_OPTIONS.test(part)) return false;
    if (program === "git") {
      // The subcommand: the first word that is not an option (-C and -c take a value).
      let sub = null;
      for (let index = 1; index < words.length && sub === null; index += 1) {
        if (words[index] === "-C" || words[index] === "-c") index += 1;
        else if (!words[index].startsWith("-")) sub = words[index];
      }
      return READ_ONLY_GIT.has(sub);
    }
    if ((program === "sort" || program === "tree") && OUTPUT_FILE_OPTION.test(part)) return false;
    return READ_ONLY_PROGRAMS.has(program);
  });
}

/**
 * Claude Code's PreToolUse hook that holds a zone. Its refusal is what the
 * agent reads, so it says what to do instead. An edit outside the zone is
 * refused in every permission mode: the zone is the agent's part of a shared
 * folder, not a prompt. A shell command that only reads is left to the mode
 * (Claude Code runs reading commands without asking). One that may write goes
 * to the person while the person approves changes - in the manual mode and
 * in "accept edits", which would otherwise accept some file commands on its
 * own; in the auto and bypass modes the person handed that over.
 */
export function claudeWriteZoneHook({ root, patterns, platform = process.platform, permissionMode = "acceptEdits" }) {
  const zone = createWriteZone({ root, patterns, platform });
  const named = patterns.join(", ");
  const delegated = ["auto", "bypassPermissions"].includes(permissionMode);
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
      if (delegated || readOnlyShellCommand(input?.tool_input?.command, { powershell: tool === "PowerShell" })) return {};
      return decision("ask", `A command can change files outside the write zone (${named}), so the person decides.`);
    }
    return {};
  };
}
