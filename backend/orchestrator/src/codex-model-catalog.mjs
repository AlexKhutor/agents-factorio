export class CodexModelCatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodexModelCatalogError";
    this.code = code;
    this.details = details;
    Object.assign(this, details);
  }
}

function advertisedEfforts(model) {
  return (model.supportedReasoningEfforts ?? [])
    .map((entry) => typeof entry === "string" ? entry : entry?.reasoningEffort)
    .filter((value) => typeof value === "string" && value.trim());
}

export function resolveCodexModelProfile(catalog, { model, reasoningEffort } = {}) {
  const models = Array.isArray(catalog?.data) ? catalog.data : [];
  const available = models.filter((entry) => !entry.hidden);
  const requestedModel = String(model ?? "").trim();
  const requestedEffort = String(reasoningEffort ?? "").trim();
  if (!requestedModel) {
    throw new CodexModelCatalogError(
      "MODEL_SELECTION_REQUIRED",
      "Select a model advertised by the active Codex App Server",
      { availableModels: available.map((entry) => entry.model || entry.id).filter(Boolean) },
    );
  }
  const selected = available.find((entry) => entry.model === requestedModel)
    ?? available.find((entry) => entry.id === requestedModel);
  if (!selected) {
    throw new CodexModelCatalogError(
      "MODEL_UNAVAILABLE",
      `Model '${requestedModel}' is not available in this Codex account`,
      { availableModels: available.map((entry) => entry.model || entry.id).filter(Boolean) },
    );
  }
  const efforts = advertisedEfforts(selected);
  if (!requestedEffort) {
    throw new CodexModelCatalogError(
      "REASONING_EFFORT_SELECTION_REQUIRED",
      `Select a reasoning effort advertised for model '${selected.model ?? selected.id}'`,
      { availableReasoningEfforts: efforts },
    );
  }
  if (!efforts.includes(requestedEffort)) {
    throw new CodexModelCatalogError(
      "REASONING_EFFORT_UNAVAILABLE",
      `Reasoning effort '${requestedEffort}' is not available for model '${selected.model ?? selected.id}'`,
      { availableReasoningEfforts: efforts },
    );
  }
  return {
    id: selected.id,
    model: selected.model ?? selected.id,
    displayName: selected.displayName ?? selected.model ?? selected.id,
    reasoningEffort: requestedEffort,
    defaultReasoningEffort: selected.defaultReasoningEffort ?? null,
    supportedReasoningEfforts: efforts,
  };
}

export async function listCodexModels(client, pageSize = 100) {
  const data = [];
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const result = await client.listModels({ cursor, limit: pageSize, includeHidden: false });
    data.push(...(result?.data ?? []));
    cursor = result?.nextCursor;
    if (!cursor) return { data, nextCursor: null };
  }
  throw new CodexModelCatalogError(
    "MODEL_CATALOG_TOO_LARGE",
    "Codex model catalog exceeded the bounded page limit",
  );
}

export function presentCodexModelCatalog(catalog) {
  return (catalog?.data ?? []).filter((entry) => !entry.hidden).map((entry) => ({
    id: entry.id,
    model: entry.model ?? entry.id,
    displayName: entry.displayName ?? entry.model ?? entry.id,
    defaultReasoningEffort: entry.defaultReasoningEffort ?? null,
    supportedReasoningEfforts: advertisedEfforts(entry),
    isDefault: Boolean(entry.isDefault),
  }));
}
