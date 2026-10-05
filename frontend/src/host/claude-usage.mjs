// The Claude plan's usage for the window's header menu, as Claude Code's
// /usage shows it: the 5-hour session, the week and the per-model limits.
//
// The Gateway learns it from turns that run anyway (claude-usage.mjs of the
// backend) and keeps the last reading in the controller's machine-local
// `.project-local/application-gateway/claude-usage.v1.json`: percentages and
// times only. The host reads that one file - never the connection file next to
// it - and passes on only the known fields.

import { readFile } from "node:fs/promises";
import path from "node:path";

const MAX_WINDOWS = 16;
const word = (value, length = 64) => (typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, length) : null);
const time = (value) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);
const percent = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null);

/** The reading as the window may show it, or null when the file is not one. */
export function sanitizeClaudeUsage(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1 || !Array.isArray(value.windows)) return null;
  return {
    observedAtUtc: time(value.observedAtUtc),
    statusObservedAtUtc: time(value.statusObservedAtUtc),
    subscriptionType: word(value.subscriptionType),
    available: value.available === true,
    windows: value.windows.slice(0, MAX_WINDOWS).filter((item) => typeof item?.id === "string").map((item) => ({
      id: word(item.id), label: word(item.label) ?? word(item.id), utilization: percent(item.utilization),
      resetsAtUtc: time(item.resetsAtUtc),
      status: ["allowed", "allowed_warning", "rejected"].includes(item.status) ? item.status : null,
    })),
  };
}

/** `read()` gives `{ state: "known", usage }`, `{ state: "none" }` (no turn reported it yet) or `{ state: "failed" }`. */
export function createClaudeUsageReader({ controllerRoot }) {
  const file = path.join(controllerRoot, ".project-local", "application-gateway", "claude-usage.v1.json");
  return {
    async read() {
      let text;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        return error?.code === "ENOENT" ? { state: "none" } : { state: "failed", reason: "usage_unreadable" };
      }
      if (text.length > 64 * 1024) return { state: "failed", reason: "usage_too_large" };
      let usage = null;
      try { usage = sanitizeClaudeUsage(JSON.parse(text)); } catch { usage = null; }
      return usage === null ? { state: "failed", reason: "usage_invalid" } : { state: "known", usage };
    },
  };
}
