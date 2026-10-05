// PROTOTYPE. The session the host builds under --direct: the same parts as under
// --paperclip (src/paperclip/session.mjs), over the bridge in direct-gateway.mjs.

import { createBridgeSession } from "../paperclip/session.mjs";
import { createDirectGateway, loadDirectConfig } from "./direct-gateway.mjs";

export const createDirectSession = (options) => createBridgeSession({
  ...options, loadConfig: loadDirectConfig, createBridge: createDirectGateway,
  folderNote: "Claude Code will be started in this folder.",
});
