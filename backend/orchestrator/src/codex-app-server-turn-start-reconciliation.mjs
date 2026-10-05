import {
  adapterOperationRequestHash,
  validateAdapterOperationRequest,
} from "./adapter-contracts.mjs";
import { validateProviderTurnStartBinding } from "./provider-turn-start-binding.mjs";

export const CODEX_APP_SERVER_TURN_START_RECONCILIATION_VERSION = "v0.1.0";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const PAGE_SIZE = 128;
const MAX_PAGES = 8;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("invalid_identity", `${label} must be a bounded identifier`);
  }
  return value;
}

function revision(thread, expectedThreadId) {
  if (thread?.id !== expectedThreadId) return null;
  const value = thread.updatedAt ?? thread.updatedAtUtc;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0 && value.length <= 64) return value;
  return null;
}

function result({
  requestId,
  threadId,
  status,
  reasonCode,
  turnId = null,
  turnStatus = null,
  searchedPages = 0,
  searchedTurns = 0,
  providerRevision = null,
  observedAtUtc,
}) {
  return Object.freeze({
    schemaVersion: 1,
    contractVersion: CODEX_APP_SERVER_TURN_START_RECONCILIATION_VERSION,
    requestId,
    threadId,
    status,
    reasonCode,
    turnId,
    turnStatus,
    searchedPages,
    searchedTurns,
    providerRevision,
    repeatsProviderAction: false,
    observedAtUtc,
  });
}

export function providerTurnClientUserMessageId(startBinding, adapterRequest) {
  const binding = validateProviderTurnStartBinding(startBinding);
  validateAdapterOperationRequest(adapterRequest, "execution-provider");
  if (adapterRequest.operationId !== binding.requestId
      || adapterOperationRequestHash(adapterRequest, "execution-provider")
        !== binding.requestSha256) {
    fail("request_identity_mismatch", "Turn start request differs from its exact binding");
  }
  return binding.requestId;
}

export async function reconcileCodexAppServerTurnStart({
  client,
  requestId,
  threadId,
  now = () => new Date(),
}) {
  identifier(requestId, "requestId");
  identifier(threadId, "threadId");
  if (!client || typeof client.readThread !== "function"
      || typeof client.listThreadTurns !== "function" || typeof now !== "function") {
    fail("invalid_dependency", "Reconciliation requires App Server read methods and a clock");
  }
  const observedAtUtc = now().toISOString();
  let initial;
  try {
    initial = await client.readThread(threadId, false);
  } catch (error) {
    if (error?.code === -32601) {
      return result({
        requestId, threadId, status: "unsupported", reasonCode: "thread_read_unsupported",
        observedAtUtc,
      });
    }
    throw error;
  }
  const initialRevision = revision(initial?.thread, threadId);
  if (initialRevision === null) {
    return result({
      requestId, threadId, status: "incomplete", reasonCode: "thread_revision_unavailable",
      observedAtUtc,
    });
  }

  const matches = [];
  const cursors = new Set();
  let cursor;
  let searchedPages = 0;
  let searchedTurns = 0;
  let complete = false;
  for (; searchedPages < MAX_PAGES; searchedPages += 1) {
    let page;
    try {
      page = await client.listThreadTurns(threadId, {
        cursor, limit: PAGE_SIZE, sortDirection: "desc", itemsView: "full",
      });
    } catch (error) {
      if (error?.code === -32601) {
        return result({
          requestId, threadId, status: "unsupported", reasonCode: "turn_list_unsupported",
          searchedPages, searchedTurns, providerRevision: initialRevision, observedAtUtc,
        });
      }
      throw error;
    }
    if (!Array.isArray(page?.data) || page.data.length > PAGE_SIZE) {
      return result({
        requestId, threadId, status: "incomplete", reasonCode: "invalid_turn_page",
        searchedPages, searchedTurns, providerRevision: initialRevision, observedAtUtc,
      });
    }
    searchedTurns += page.data.length;
    for (const turn of page.data) {
      if (!ID.test(turn?.id ?? "") || !Array.isArray(turn.items)) {
        return result({
          requestId, threadId, status: "incomplete", reasonCode: "invalid_turn_record",
          searchedPages: searchedPages + 1, searchedTurns,
          providerRevision: initialRevision, observedAtUtc,
        });
      }
      for (const item of turn.items) {
        if (item?.type === "userMessage" && item.clientId === requestId) {
          const turnStatus = typeof turn.status === "string" && turn.status.length <= 64
            ? turn.status : null;
          matches.push({ turnId: turn.id, turnStatus });
        }
      }
    }
    const next = page.nextCursor ?? null;
    if (next === null) {
      searchedPages += 1;
      complete = true;
      break;
    }
    if (typeof next !== "string" || next.length > 512 || cursors.has(next)) {
      return result({
        requestId, threadId, status: "incomplete", reasonCode: "invalid_turn_cursor",
        searchedPages: searchedPages + 1, searchedTurns,
        providerRevision: initialRevision, observedAtUtc,
      });
    }
    cursors.add(next);
    cursor = next;
  }

  const final = await client.readThread(threadId, false);
  const finalRevision = revision(final?.thread, threadId);
  if (finalRevision === null || finalRevision !== initialRevision) {
    return result({
      requestId, threadId, status: "incomplete", reasonCode: "thread_changed_during_read",
      searchedPages, searchedTurns, providerRevision: finalRevision, observedAtUtc,
    });
  }
  if (!complete) {
    return result({
      requestId, threadId, status: "incomplete", reasonCode: "turn_search_limit",
      searchedPages, searchedTurns, providerRevision: finalRevision, observedAtUtc,
    });
  }
  if (matches.length > 1) {
    return result({
      requestId, threadId, status: "ambiguous", reasonCode: "multiple_client_message_matches",
      searchedPages, searchedTurns, providerRevision: finalRevision, observedAtUtc,
    });
  }
  if (matches.length === 0) {
    return result({
      requestId, threadId, status: "not-observed", reasonCode: "client_message_not_observed",
      searchedPages, searchedTurns, providerRevision: finalRevision, observedAtUtc,
    });
  }
  return result({
    requestId, threadId, status: "matched", reasonCode: "exact_client_message_match",
    ...matches[0], searchedPages, searchedTurns, providerRevision: finalRevision, observedAtUtc,
  });
}
