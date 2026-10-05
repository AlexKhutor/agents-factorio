import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export function resolveExtensionCodexCommand(repoRoot) {
  const extensionsRoot = path.join(repoRoot, ".project-runtime", "vscode-extensions");
  if (!existsSync(extensionsRoot)) return null;
  const candidates = readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
    .map((entry) => ({
      name: entry.name,
      command: path.join(extensionsRoot, entry.name, "bin", "windows-x86_64", "codex.exe"),
    }))
    .filter((entry) => existsSync(entry.command))
    .sort((left, right) => right.name.localeCompare(left.name, "en", { numeric: true }));
  return candidates[0]?.command ?? null;
}
