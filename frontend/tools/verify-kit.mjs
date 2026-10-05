// Verifies the vendored Application Frontend Kit against the accepted backend
// delivery - the same check the application runs before it imports any kit
// file (src/host/kit.mjs). No constants of its own: the release, the version
// and the manifest hash all come from the lock named by ACCEPTED_DELIVERY in src/host/kit.mjs,
// whose own hash is pinned in kit.mjs.
//
// A kit copy that fails this check is not a contract: it is an unknown file set.
// A pass says the files are the accepted ones; it says nothing about a gateway.

import { verifyKitDelivery } from "../src/host/kit.mjs";

try {
  const verified = await verifyKitDelivery();
  process.stdout.write(`${JSON.stringify({
    check: "accepted-frontend-delivery",
    status: verified.status,
    releaseId: verified.releaseId,
    kitVersion: verified.version,
    manifestSha256: verified.manifestSha256,
    lockSha256: verified.lockSha256,
    filesChecked: verified.filesChecked,
    contracts: verified.contracts,
    runtimeReadiness: "not-checked",
  }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    check: "accepted-frontend-delivery",
    status: "rejected",
    reasonCode: error?.code ?? "invalid_delivery",
  }, null, 2)}\n`);
  process.exitCode = 1;
}
