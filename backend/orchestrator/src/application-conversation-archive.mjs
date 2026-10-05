import { CONVERSATION_ARCHIVE_VERSION, conversationArchiveIdentity } from "./conversation-archive.mjs";

export const APPLICATION_CONVERSATION_ARCHIVE_OPERATION_IDS = Object.freeze({
  resolve: "query.conversation.archive.resolve",
  read: "query.conversation.archive.read",
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function input(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !allowed.includes(field))) fail("conflict");
}

export function createApplicationConversationArchiveHandlers({ archive, binding,
  captureStatus = () => ({
    status: "unavailable", reasonCode: "provider_unavailable",
    synchronization: {
      state: "not-started", pagesImported: 0, capturedRecords: 0,
      checkpointRevision: 0, exhausted: false,
    },
  }),
}) {
  const conversationId = conversationArchiveIdentity(binding);
  return Object.freeze({
    [APPLICATION_CONVERSATION_ARCHIVE_OPERATION_IDS.resolve]: async (request) => {
      input(request.input, []);
      return { schemaVersion: 1, contractVersion: CONVERSATION_ARCHIVE_VERSION,
        conversationId, sourceId: binding.sourceId, providerId: binding.providerId,
        coverage: "captured-only", capture: captureStatus() };
    },
    [APPLICATION_CONVERSATION_ARCHIVE_OPERATION_IDS.read]: async (request) => {
      input(request.input, ["conversationId", "cursor", "limit"]);
      if (request.input.conversationId !== conversationId) fail("conflict");
      try {
        const { binding: ignored, ...page } = await archive.read(binding, {
          cursor: request.input.cursor ?? null, limit: request.input.limit ?? 50,
        });
        return page;
      } catch (error) {
        fail(["archive_invalid_input", "archive_invalid_cursor", "archive_identity_conflict"]
          .includes(error?.code) ? "conflict" : "source_unavailable");
      }
    },
  });
}
