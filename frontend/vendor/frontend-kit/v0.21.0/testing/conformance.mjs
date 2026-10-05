export const APPLICATION_FRONTEND_CONFORMANCE_VERSION = "v0.1.0";
export const APPLICATION_FRONTEND_CONFORMANCE_CASES = Object.freeze([
  "live-read",
  "delayed-read",
  "stale-descriptor",
  "unavailable-descriptor",
  "contradictory-identity",
  "blocked-result",
  "approval-required-result",
  "uncertain-result",
  "explicit-recovery",
  "event-snapshot-resume",
]);

const NOW = "2026-08-31T01:00:00.000Z";
const READ_OPERATION = "query.application-fixture.state";

function fail(code) {
  const error = new Error(code);
  error.name = "ApplicationFrontendConformanceError";
  error.code = code;
  throw error;
}

function check(condition, code) {
  if (!condition) fail(code);
}

async function expectedError(action, code, reasonCode = null) {
  try {
    await action();
  } catch (error) {
    check(error?.code === code, "unexpected_error_code");
    if (reasonCode !== null) {
      check(error?.details?.reasonCode === reasonCode, "unexpected_reason_code");
    }
    return;
  }
  fail("expected_error_missing");
}

function resultCase(state, outcome, errorCode = null) {
  return async ({ environment }) => {
    const { backend, client } = environment(state);
    const result = await client.read(READ_OPERATION);
    check(result.outcome === outcome, "unexpected_outcome");
    if (errorCode === null) {
      check(result.output?.state === state, "unexpected_fixture_state");
    } else {
      check(result.error?.code === errorCode, "unexpected_result_error");
      check(result.error?.retryable === false, "unsafe_retry_semantics");
    }
    check(backend.snapshot().requestCount === 2, "unexpected_request_count");
  };
}

const CASES = Object.freeze({
  "live-read": resultCase("live", "succeeded"),
  "delayed-read": resultCase("delayed", "succeeded"),
  "stale-descriptor": async ({ environment }) => {
    const { backend, client } = environment("stale");
    await expectedError(() => client.connect(), "descriptor_unavailable");
    check(backend.snapshot().requestCount === 0, "stale_request_dispatched");
  },
  "unavailable-descriptor": async ({ environment }) => {
    const { backend, client } = environment("unavailable");
    await expectedError(
      () => client.connect(), "descriptor_unavailable", "fixture_unavailable",
    );
    check(backend.snapshot().requestCount === 0, "unavailable_request_dispatched");
  },
  "contradictory-identity": async ({ environment }) => {
    const { backend, client } = environment("contradictory");
    await expectedError(
      () => client.discoverCapabilities(), "response_identity_mismatch",
    );
    check(backend.snapshot().requestCount === 1, "contradiction_retried");
  },
  "blocked-result": resultCase("blocked", "failed", "access_denied"),
  "approval-required-result": resultCase(
    "approval-required", "failed", "continuation_required",
  ),
  "uncertain-result": resultCase("uncertain", "uncertain", "uncertain_outcome"),
  "explicit-recovery": async ({ environment }) => {
    const { backend, client } = environment("unavailable");
    await expectedError(
      () => client.connect(), "descriptor_unavailable", "fixture_unavailable",
    );
    backend.setState("recovered");
    client.disconnect();
    const result = await client.read(READ_OPERATION);
    check(result.outcome === "succeeded" && result.output?.recovered === true,
      "recovery_not_observed");
    check(backend.snapshot().requestCount === 2, "recovery_request_count_invalid");
  },
  "event-snapshot-resume": async ({ environment }) => {
    const { backend, client } = environment("live");
    const snapshot = await client.readEvents({ streamId: "application-global" });
    check(snapshot.mode === "snapshot-required", "snapshot_mode_invalid");
    const resumed = await client.readEvents({
      streamId: "application-global",
      cursor: snapshot.cursor,
    });
    check(resumed.mode === "resumed" && resumed.cursor === snapshot.cursor,
      "resume_cursor_invalid");
    check(backend.snapshot().requestCount === 2, "event_request_count_invalid");
  },
});

function normalizeFailure(error) {
  const code = error?.name === "ApplicationFrontendConformanceError"
    && typeof error.code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : "conformance_case_failed";
  return Object.freeze({ code });
}

export async function runApplicationFrontendConformanceCore({
  createBackend,
  createClient,
  delayMs = 10,
} = {}) {
  if (typeof createBackend !== "function" || typeof createClient !== "function"
      || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 1_000) {
    fail("invalid_conformance_configuration");
  }
  let idSequence = 0;
  const now = () => new Date(NOW);
  const environment = (state) => {
    const backend = createBackend({ state, delayMs, now });
    const client = createClient(backend, {
      now,
      idFactory: (prefix) => {
        idSequence += 1;
        return `${prefix}-00000000-0000-4000-8000-${String(idSequence).padStart(12, "0")}`;
      },
    });
    check(backend && client, "invalid_conformance_environment");
    return { backend, client };
  };

  const cases = [];
  for (const caseId of APPLICATION_FRONTEND_CONFORMANCE_CASES) {
    try {
      await CASES[caseId]({ environment });
      cases.push(Object.freeze({ caseId, status: "passed" }));
    } catch (error) {
      cases.push(Object.freeze({
        caseId,
        status: "failed",
        failure: normalizeFailure(error),
      }));
    }
  }
  const passedCount = cases.filter(({ status }) => status === "passed").length;
  return Object.freeze({
    schemaVersion: 1,
    suiteVersion: APPLICATION_FRONTEND_CONFORMANCE_VERSION,
    status: passedCount === cases.length ? "passed" : "failed",
    caseCount: cases.length,
    passedCount,
    failedCount: cases.length - passedCount,
    cases: Object.freeze(cases),
  });
}
