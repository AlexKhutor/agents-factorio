import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CodexAppServerExecutionProviderAdapter,
} from "../src/codex-app-server-execution-provider-adapter.mjs";
import {
  PROVIDER_CONVERSATION_READ_EXTENSION_ID,
  PROVIDER_CONVERSATION_READ_OPERATIONS,
  assessProviderConversationReadCapabilities,
  createProviderConversationReadRequirements,
} from "../src/provider-conversation-read-contract.mjs";

class FakeClient extends EventEmitter {
  async listModels() {
    return { data: [] };
  }

  async listThreads() {
    return { data: [] };
  }

  async readThread(threadId) {
    return { thread: { id: threadId, name: "Thread", status: "idle" } };
  }
}

function descriptor() {
  const adapter = new CodexAppServerExecutionProviderAdapter({
    client: new FakeClient(),
    sourceId: "orchestrator-development",
    runtimeInstanceId: "conversation-read-test",
    capabilitiesObservedAtUtc: "2026-08-30T16:00:00.000Z",
  });
  const value = adapter.descriptor;
  adapter.dispose();
  return value;
}

test("conversation reads reuse bounded execution-provider operations", () => {
  const requirements = createProviderConversationReadRequirements();
  assert.deepEqual(
    requirements.map((item) => item.operation),
    PROVIDER_CONVERSATION_READ_OPERATIONS,
  );
  assert.deepEqual(
    requirements.find((item) => item.operation === "readThread").requiredRecovery,
    ["reconnect", "read-after-disconnect"],
  );
  assert.deepEqual(
    requirements.find((item) => item.operation === "observeLifecycle").acceptableVisibility,
    ["provider-observed"],
  );
});

test("App Server descriptor explicitly satisfies the conversation-read extension", () => {
  const value = descriptor();
  const assessment = assessProviderConversationReadCapabilities(value);
  assert.equal(assessment.compatible, true);
  assert.equal(assessment.failures.length, 0);
  for (const operation of PROVIDER_CONVERSATION_READ_OPERATIONS) {
    const capability = value.capabilities.find((item) => item.operation === operation);
    assert.equal(
      capability.extensions.some(
        (item) => item.extensionId === PROVIDER_CONVERSATION_READ_EXTENSION_ID,
      ),
      true,
    );
  }
  assert.deepEqual(
    value.capabilities.find((item) => item.operation === "discoverCapabilities").extensions,
    [],
  );
});

test("missing or wrong extension version fails closed", () => {
  const missing = descriptor();
  missing.capabilities.find((item) => item.operation === "readThread").extensions = [];
  const missingAssessment = assessProviderConversationReadCapabilities(missing, ["readThread"]);
  assert.equal(missingAssessment.compatible, false);
  assert.deepEqual(missingAssessment.failures, [{
    operation: "readThread", reasonCode: "extension_unavailable",
  }]);

  const wrongVersion = descriptor();
  wrongVersion.capabilities.find(
    (item) => item.operation === "readThread",
  ).extensions[0].contractVersion = "v9.0.0";
  const versionAssessment = assessProviderConversationReadCapabilities(
    wrongVersion,
    ["readThread"],
  );
  assert.equal(versionAssessment.compatible, false);
  assert.equal(versionAssessment.failures[0].reasonCode, "extension_version_unsupported");
});

test("weak recovery and mutation operations are rejected", () => {
  const weak = descriptor();
  weak.capabilities.find((item) => item.operation === "readThread").recovery = ["reconnect"];
  const assessment = assessProviderConversationReadCapabilities(weak, ["readThread"]);
  assert.equal(assessment.compatible, false);
  assert.equal(assessment.failures[0].reasonCode, "recovery_unavailable");
  assert.throws(
    () => createProviderConversationReadRequirements(["createThread"]),
    /unsupported operation/,
  );
});
