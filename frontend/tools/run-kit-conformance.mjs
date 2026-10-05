// Runs the kit's own conformance suite: the real ApplicationFrontendClient
// against the kit's in-memory fake backend, across its nine states.
//
// This proves the client and this Node runtime agree on the transport contract.
// It proves nothing about the installed gateway, and starts no listener. The
// testing module comes from the verified accepted delivery, like everything
// else of the kit (src/host/kit.mjs).

import { loadAcceptedKit } from "../src/host/kit.mjs";

const kit = await loadAcceptedKit();
const { runApplicationFrontendConformance } = await kit.loadTesting();

const report = await runApplicationFrontendConformance();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;
