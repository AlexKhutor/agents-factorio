#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const testRoot = path.join(root, "test");
const files = readdirSync(testRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => entry.name)
  .sort();

if (files.length === 0 || files.length > 512) {
  process.stderr.write(`Invalid discovered test count: ${files.length}\n`);
  process.exitCode = 1;
} else {
  for (const [index, file] of files.entries()) {
    process.stdout.write(`[test ${index + 1}/${files.length}] ${file}\n`);
    const result = spawnSync(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-force-exit",
      ...process.argv.slice(2),
      path.join("test", file),
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: "inherit",
      timeout: 180_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      if (result.error) {
        process.stderr.write(
          `Test process failed for ${file}: ${result.error.code ?? result.error.message}\n`,
        );
      }
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
