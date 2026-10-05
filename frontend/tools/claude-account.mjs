// PROTOTYPE. Names the Claude account the desk's direct mode works under, the
// way the desk itself asks: the Claude Code program of the SDK, with the same
// settings (config/direct.json, then config/direct.local.json), runs its
// read-only `claude auth status`. No session, no message, no quota.
//
//   node tools/claude-account.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProgramOf, readClaudeAccount } from "../src/direct/claude-driver.mjs";
import { loadDirectConfig } from "../src/direct/direct-gateway.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaded = await loadDirectConfig(PROJECT_ROOT);
if (loaded.status !== "loaded") {
  process.stdout.write(`${JSON.stringify({ state: "config", ...loaded }, null, 2)}\n`);
  process.exit(1);
}
const { config } = loaded;
const env = config.claudeConfigDir === null ? null : { ...process.env, CLAUDE_CONFIG_DIR: config.claudeConfigDir };
const account = await readClaudeAccount({ program: claudeProgramOf(config.claudeSdkPath), env });
process.stdout.write(`${JSON.stringify({ claudeConfigDir: config.claudeConfigDir ?? "(the machine's default sign-in)", ...account }, null, 2)}\n`);
process.exit(account.state === "known" ? 0 : 1);
