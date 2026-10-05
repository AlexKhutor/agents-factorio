export const APP_SERVER_SPAWN_FORBIDDEN = "app_server_spawn_forbidden";

export function isAppServerSpawnForbidden(error) {
  return ["EPERM", "EACCES"].includes(error?.code)
    && String(error?.message ?? "").toLowerCase().includes("spawn");
}

export function classifyAppServerStartupFailure(error, {
  unavailableReason = "app_server_unavailable",
} = {}) {
  return isAppServerSpawnForbidden(error)
    ? APP_SERVER_SPAWN_FORBIDDEN
    : unavailableReason;
}
