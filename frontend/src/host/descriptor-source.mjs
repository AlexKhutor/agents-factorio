// Reads the controller's connection descriptor. Host process only.
//
// The descriptor carries the bearer token and the loopback endpoint. It is read
// here, handed straight to the kit client, and never logged, serialised into a
// renderer message, or written anywhere. Callers get bounded summaries instead.

import { readFile } from "node:fs/promises";
import path from "node:path";

const RUNTIME_RELATIVE = path.join(".project-local", "application-gateway");

async function readJson(filePath) {
  try {
    return { status: "read", value: JSON.parse(await readFile(filePath, "utf8")) };
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
}

/**
 * A descriptor resolver for ApplicationFrontendClient, plus a safe status
 * summary for the UI. Unavailability is always a bounded reason code - never a
 * guessed port, never a cached descriptor from an earlier instance.
 */
export function createControllerDescriptorSource({ controllerRoot, expectedWorkspace }) {
  const runtimeDirectory = path.join(controllerRoot, RUNTIME_RELATIVE);
  const paths = Object.freeze({
    status: path.join(runtimeDirectory, "status.v1.json"),
    descriptor: path.join(runtimeDirectory, "connection.v1.json"),
    monitor: path.join(runtimeDirectory, "monitor-status.v1.json"),
  });

  async function resolveDescriptor() {
    const status = await readJson(paths.status);
    if (status.status !== "read") {
      return { status: "unavailable", reasonCode: `status_${status.status}` };
    }
    const lifecycle = status.value?.lifecycle ?? "unknown";
    if (lifecycle !== "ready") {
      // starting, stopped, uncertain: there is nothing to connect to, and an
      // older descriptor left on disk must not be used.
      return { status: "unavailable", reasonCode: `lifecycle_${lifecycle}` };
    }
    const descriptor = await readJson(paths.descriptor);
    if (descriptor.status !== "read") {
      return { status: "unavailable", reasonCode: `descriptor_${descriptor.status}` };
    }
    const value = descriptor.value;
    if (value?.workspace?.projectId !== expectedWorkspace.projectId
        || value?.workspace?.workspaceRootSha256 !== expectedWorkspace.workspaceRootSha256) {
      return { status: "unavailable", reasonCode: "workspace_mismatch" };
    }
    const expectedInstance = status.value?.identity?.instanceId;
    if (typeof expectedInstance === "string"
        && value?.instance?.instanceId !== expectedInstance) {
      // A descriptor from a replaced process: the running instance is not the
      // one that published this file.
      return { status: "unavailable", reasonCode: "instance_mismatch" };
    }
    return { status: "available", descriptor: value };
  }

  /** Bounded, bearer-free view of controller runtime state for the UI. */
  async function readRuntimeSummary() {
    const [status, monitor, descriptor] = await Promise.all([
      readJson(paths.status), readJson(paths.monitor), readJson(paths.descriptor),
    ]);
    return {
      controllerRootConfigured: true,
      status: status.status,
      lifecycle: status.value?.lifecycle ?? null,
      health: status.value?.health ?? null,
      heartbeatAtUtc: status.value?.heartbeatAtUtc ?? null,
      failureReasonCode: status.value?.failure?.reasonCode ?? null,
      failedAtUtc: status.value?.failure?.failedAtUtc ?? null,
      generation: status.value?.identity?.generation ?? null,
      projectId: status.value?.identity?.workspace?.projectId ?? null,
      monitorState: monitor.value?.state ?? null,
      monitorHealth: monitor.value?.health ?? null,
      monitorUpdatedAtUtc: monitor.value?.updatedAtUtc ?? null,
      descriptorPresent: descriptor.status === "read",
    };
  }

  return { resolveDescriptor, readRuntimeSummary };
}
