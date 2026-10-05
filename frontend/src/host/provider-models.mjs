// The models a new agent can be given, as the connected provider lists them.
//
// The Gateway answers query.provider.models.list from the provider's own
// catalog - for Claude Code, the controller's claude-provider.json, the same
// list the backend checks every new agent's profile against. This module turns
// that envelope into the bounded list the create-agent form shows: the
// provider, each model's id and name, the reasoning efforts it accepts and its
// default. Nothing is added here: a model or effort the provider did not list
// is never offered, so the form cannot suggest a profile the backend refuses.

export const MODELS_OPERATION = "query.provider.models.list";

// An agent profile names its provider by the backend's own id; the adapter that
// answered the model list says which one that is. The labels are the official
// product names. An adapter not listed here gets no lists: the form then falls
// back to typed fields instead of guessing a provider id.
const PROVIDERS = Object.freeze({
  "claude-code-sdk": Object.freeze({ profileProvider: "claude", label: "Anthropic API · Claude Code" }),
  "codex-app-server": Object.freeze({ profileProvider: "codex", label: "OpenAI Codex" }),
});

const MAX_MODELS = 64;
const MAX_EFFORTS = 8;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/u;
const EFFORT = /^[a-z][a-z0-9-]{0,15}$/u;

const refuse = (code, reasonCode = null) => ({ ok: false, error: { code, reasonCode } });

function modelOf(record) {
  const id = record?.modelRef?.authority?.externalId;
  if (typeof id !== "string" || !MODEL_ID.test(id)) return null;
  const efforts = Array.isArray(record.supportedReasoningEfforts)
    ? [...new Set(record.supportedReasoningEfforts.filter((value) => typeof value === "string" && EFFORT.test(value)))]
      .slice(0, MAX_EFFORTS)
    : [];
  if (efforts.length === 0) return null;
  const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim().slice(0, 128) : id;
  const defaultEffort = efforts.includes(record.defaultReasoningEffort) ? record.defaultReasoningEffort : efforts[0];
  return { id, name, efforts, defaultEffort };
}

/**
 * `response` is what gateway.run returned for MODELS_OPERATION; `adapterId` is
 * the adapter discovery named for it. Returns `{ ok, data: { provider, models,
 * complete } }` or `{ ok: false, error }`.
 */
export function summarizeProviderModels(response, adapterId) {
  const provider = typeof adapterId === "string" ? PROVIDERS[adapterId] ?? null : null;
  if (provider === null) return refuse("provider_unknown", typeof adapterId === "string" ? adapterId.slice(0, 64) : null);
  if (!response?.ok) return refuse(response?.error?.code ?? "models_unreadable", response?.error?.reasonCode ?? null);
  const envelope = response.result;
  if (envelope?.outcome !== "succeeded") {
    return refuse("models_unreadable", envelope?.error?.code ?? envelope?.outcome ?? null);
  }
  const records = envelope.output?.data?.records;
  if (!Array.isArray(records)) return refuse("models_unreadable", "records_missing");
  const seen = new Set();
  const models = [];
  for (const record of records.slice(0, MAX_MODELS)) {
    const model = modelOf(record);
    if (model === null || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (models.length === 0) return refuse("models_empty");
  return {
    ok: true,
    data: {
      provider: { adapterId, profileProvider: provider.profileProvider, label: provider.label },
      models,
      complete: envelope.output.data.completeness?.status === "complete" && records.length <= MAX_MODELS,
    },
  };
}
