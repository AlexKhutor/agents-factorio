import path from "node:path";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const orchestratorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(orchestratorRoot, "dist");
const outputPath = path.join(outputDirectory, "application-gateway-cli.bundle.mjs");
const argumentsSet = new Set(process.argv.slice(2));

if ([...argumentsSet].some((value) => value !== "--verify")) {
  throw new Error("Only --verify is supported by the runtime bundle builder");
}

const verifyOnly = argumentsSet.has("--verify");
await mkdir(outputDirectory, { recursive: true });

const result = await build({
  absWorkingDir: path.resolve(orchestratorRoot, ".."),
  entryPoints: [path.join(orchestratorRoot, "src", "application-gateway-cli.mjs")],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  mainFields: ["module", "main"],
  target: "node20",
  charset: "utf8",
  legalComments: "none",
  sourcemap: false,
  treeShaking: true,
  logLevel: verifyOnly ? "silent" : "info",
  write: !verifyOnly,
  banner: {
    js: 'import { createRequire as __bundleCreateRequire } from "node:module"; const require = __bundleCreateRequire(import.meta.url);',
  },
});

if (verifyOnly) {
  if (result.outputFiles?.length !== 1) {
    throw new Error("Gateway runtime verification returned an unexpected output set");
  }
  const checkedIn = await readFile(outputPath);
  if (!checkedIn.equals(Buffer.from(result.outputFiles[0].contents))) {
    const generated = Buffer.from(result.outputFiles[0].contents);
    let firstDifference = 0;
    while (firstDifference < Math.min(checkedIn.length, generated.length)
      && checkedIn[firstDifference] === generated[firstDifference]) firstDifference++;
    throw new Error(`Runtime bundle is stale: dist/application-gateway-cli.bundle.mjs`
      + ` (checkedInBytes=${checkedIn.length}, generatedBytes=${generated.length}, firstDifference=${firstDifference})`);
  }
}

// SQLite bridges must travel beside the standalone installed bundle.
for (const archiveBridge of ["conversation-archive-store.py", "project-memory-store.py"]) {
  const bridgeSource = path.join(orchestratorRoot, "src", archiveBridge);
  const bridgeOutput = path.join(outputDirectory, archiveBridge);
  if (verifyOnly) {
    if (!(await readFile(bridgeSource)).equals(await readFile(bridgeOutput))) {
      throw new Error(`Runtime bridge is stale: dist/${archiveBridge}`);
    }
  } else {
    await copyFile(bridgeSource, bridgeOutput);
  }
}

const smoke = spawnSync(process.execPath, [outputPath], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 15_000,
});
const diagnostic = `${smoke.stdout ?? ""}\n${smoke.stderr ?? ""}`;
if (smoke.status !== 1 || !diagnostic.includes('"code":"unsupported_command"')) {
  throw new Error(
    `Standalone Application Gateway runtime smoke failed (exit ${smoke.status ?? "unknown"}): ${diagnostic.trim()}`,
  );
}

if (verifyOnly) console.log("application_gateway_runtime_bundle_parity: passed");
