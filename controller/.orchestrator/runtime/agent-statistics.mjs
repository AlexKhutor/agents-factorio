const TOKEN_FIELDS = Object.freeze([
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
]);

const TERMINAL_AGENT_STATES = new Set([
  "completed",
  "failed",
  "interrupted",
  "stop_unconfirmed",
]);

const TOKEN_SOURCES = new Set([
  "codex-app-server-event",
  "codex-rollout",
  "worker-report",
  "none",
]);

const COST_SOURCES = new Set([
  "codex-app-server-query",
  "worker-report",
  "none",
]);

function boundedText(value, limit = 128) {
  const text = String(value ?? "").replaceAll(/\s+/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}

function validUtc(value) {
  return Number.isFinite(Date.parse(value ?? "")) ? new Date(value).toISOString() : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function nullableNonNegativeInteger(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function decimalString(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    const text = typeof value === "bigint" ? value.toString() : String(value).trim();
    return /^\d+$/.test(text) ? BigInt(text).toString() : null;
  } catch {
    return null;
  }
}

function tokenValue(value, camelName, snakeName) {
  return value?.[camelName] ?? value?.[snakeName];
}

export function normalizeTokenBreakdown(value) {
  if (!value || typeof value !== "object") return null;
  return {
    inputTokens: nonNegativeInteger(tokenValue(value, "inputTokens", "input_tokens")),
    cachedInputTokens: nonNegativeInteger(tokenValue(value, "cachedInputTokens", "cached_input_tokens")),
    cacheWriteInputTokens: nonNegativeInteger(tokenValue(value, "cacheWriteInputTokens", "cache_write_input_tokens")),
    outputTokens: nonNegativeInteger(tokenValue(value, "outputTokens", "output_tokens")),
    reasoningOutputTokens: nonNegativeInteger(tokenValue(value, "reasoningOutputTokens", "reasoning_output_tokens")),
    totalTokens: nonNegativeInteger(tokenValue(value, "totalTokens", "total_tokens")),
  };
}

export function subtractTokenBreakdowns(currentValue, baselineValue) {
  const current = normalizeTokenBreakdown(currentValue);
  if (!current) return null;
  const baseline = normalizeTokenBreakdown(baselineValue) ?? Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, Math.max(0, current[field] - baseline[field])]));
}

function unavailableTokens() {
  return {
    status: "unavailable",
    source: "none",
    scope: "agent-task",
    cumulative: null,
    lastTurn: null,
    modelContextWindow: null,
  };
}

function unavailableCost() {
  return {
    status: "unavailable",
    source: "none",
    estimatedCreditsMicros: null,
    estimatedUsdMicros: null,
    currency: null,
    groups: [],
  };
}

function normalizeLimitations(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => boundedText(value, 160))
    .filter(Boolean))]
    .slice(0, 20);
}

export function createAgentStatistics({
  updatedAtUtc = new Date().toISOString(),
  startedAtUtc = null,
  tokens = null,
  cost = null,
  limitations = [],
} = {}) {
  const updated = validUtc(updatedAtUtc) ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    updatedAtUtc: updated,
    timing: {
      startedAtUtc: validUtc(startedAtUtc),
      measuredAtUtc: updated,
      wallClockSeconds: null,
    },
    tokens: tokens ?? unavailableTokens(),
    cost: cost ?? unavailableCost(),
    limitations: normalizeLimitations(limitations),
  };
}

export function statisticsFromTokenUsage(tokenUsage, {
  source = "codex-app-server-event",
  updatedAtUtc = new Date().toISOString(),
  startedAtUtc = null,
  baseline = null,
  scope = "agent-task",
} = {}) {
  const usage = tokenUsage?.info ?? tokenUsage;
  const total = usage?.total ?? usage?.total_token_usage;
  const last = usage?.last ?? usage?.last_token_usage;
  const cumulative = subtractTokenBreakdowns(total, baseline);
  const normalizedSource = TOKEN_SOURCES.has(source) ? source : "worker-report";
  return createAgentStatistics({
    updatedAtUtc,
    startedAtUtc,
    tokens: cumulative ? {
      status: "available",
      source: normalizedSource,
      scope,
      cumulative,
      lastTurn: normalizeTokenBreakdown(last),
      modelContextWindow: nullableNonNegativeInteger(
        usage?.modelContextWindow ?? usage?.model_context_window,
      ),
    } : unavailableTokens(),
  });
}

function normalizeUsageGroup(value) {
  return {
    model: boundedText(value?.model, 96),
    reasoningEffort: boundedText(value?.reasoningEffort, 32),
    speed: boundedText(value?.speed, 32),
    estimatedCreditsMicros: decimalString(
      value?.estimatedCreditsMicros ?? value?.estimatedUsageCreditsMicros,
    ),
    netNewInputTokens: decimalString(value?.netNewInputTokens),
    cachedInputTokens: decimalString(value?.cachedInputTokens),
    inputTokens: decimalString(value?.inputTokens),
    outputTokens: decimalString(value?.outputTokens),
    totalTokens: decimalString(value?.totalTokens),
  };
}

export function statisticsFromThreadUsage(threadUsage, {
  source = "codex-app-server-query",
  updatedAtUtc = new Date().toISOString(),
  startedAtUtc = null,
} = {}) {
  if (!threadUsage || typeof threadUsage !== "object") {
    return createAgentStatistics({ updatedAtUtc, startedAtUtc });
  }
  const groups = (Array.isArray(threadUsage.groups) ? threadUsage.groups : [])
    .slice(0, 32)
    .map(normalizeUsageGroup);
  const estimatedCreditsMicros = decimalString(threadUsage.estimatedUsageCreditsMicros);
  const estimatedUsdMicros = decimalString(threadUsage.estimatedUsageUsdMicros);
  const hasEstimate = estimatedCreditsMicros !== null
    || estimatedUsdMicros !== null
    || groups.some((group) => group.estimatedCreditsMicros !== null);
  if (!hasEstimate) {
    return createAgentStatistics({
      updatedAtUtc,
      startedAtUtc,
      limitations: ["provider-cost-estimate-unavailable"],
    });
  }
  const normalizedSource = COST_SOURCES.has(source) ? source : "worker-report";
  return createAgentStatistics({
    updatedAtUtc,
    startedAtUtc,
    cost: {
      status: "estimated",
      source: normalizedSource,
      estimatedCreditsMicros,
      estimatedUsdMicros,
      currency: estimatedUsdMicros === null ? null : "USD",
      groups,
    },
  });
}

export function mergeAgentStatistics(current, incoming) {
  const left = normalizeAgentStatistics(current);
  const right = normalizeAgentStatistics(incoming);
  const updatedAtUtc = [left.updatedAtUtc, right.updatedAtUtc]
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? new Date().toISOString();
  return createAgentStatistics({
    updatedAtUtc,
    startedAtUtc: right.timing.startedAtUtc ?? left.timing.startedAtUtc,
    tokens: right.tokens.status === "available" ? right.tokens : left.tokens,
    cost: right.cost.status === "estimated" ? right.cost : left.cost,
    limitations: [...left.limitations, ...right.limitations],
  });
}

export function normalizeAgentStatistics(value) {
  if (!value || typeof value !== "object") return createAgentStatistics();
  const tokenStatus = value.tokens?.status === "available" ? "available" : "unavailable";
  const tokenSource = TOKEN_SOURCES.has(value.tokens?.source) ? value.tokens.source : "none";
  const costStatus = value.cost?.status === "estimated" ? "estimated" : "unavailable";
  const costSource = COST_SOURCES.has(value.cost?.source) ? value.cost.source : "none";
  return createAgentStatistics({
    updatedAtUtc: value.updatedAtUtc,
    startedAtUtc: value.timing?.startedAtUtc,
    tokens: tokenStatus === "available" ? {
      status: tokenStatus,
      source: tokenSource,
      scope: value.tokens?.scope === "provider-thread" ? "provider-thread" : "agent-task",
      cumulative: normalizeTokenBreakdown(value.tokens?.cumulative),
      lastTurn: normalizeTokenBreakdown(value.tokens?.lastTurn),
      modelContextWindow: nullableNonNegativeInteger(value.tokens?.modelContextWindow),
    } : unavailableTokens(),
    cost: costStatus === "estimated" ? {
      status: costStatus,
      source: costSource,
      estimatedCreditsMicros: decimalString(value.cost?.estimatedCreditsMicros),
      estimatedUsdMicros: decimalString(value.cost?.estimatedUsdMicros),
      currency: value.cost?.currency === "USD" ? "USD" : null,
      groups: (Array.isArray(value.cost?.groups) ? value.cost.groups : [])
        .slice(0, 32)
        .map(normalizeUsageGroup),
    } : unavailableCost(),
    limitations: value.limitations,
  });
}

export function projectAgentStatistics(value, agent, now = new Date()) {
  const statistics = normalizeAgentStatistics(value);
  const start = validUtc(statistics.timing.startedAtUtc ?? agent?.startedAtUtc);
  const terminal = TERMINAL_AGENT_STATES.has(agent?.state);
  const measured = terminal
    ? validUtc(agent?.updatedAtUtc ?? statistics.updatedAtUtc) ?? now.toISOString()
    : now.toISOString();
  const wallClockSeconds = start
    ? Math.max(0, Math.floor((Date.parse(measured) - Date.parse(start)) / 1000))
    : null;
  const limitations = [...statistics.limitations];
  if (statistics.tokens.status !== "available") limitations.push("token-usage-unavailable");
  if (statistics.cost.status !== "estimated") limitations.push("cost-estimate-unavailable");
  limitations.push("active-and-waiting-time-not-separated");
  return {
    ...statistics,
    timing: {
      startedAtUtc: start,
      measuredAtUtc: measured,
      wallClockSeconds,
    },
    limitations: normalizeLimitations(limitations),
  };
}
