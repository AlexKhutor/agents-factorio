import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { inspect } from "node:util";

import {
  createEphemeralProviderSubmission,
  EPHEMERAL_PROVIDER_SUBMISSION_VERSION,
} from "../src/ephemeral-provider-submission.mjs";

test("ephemeral submission exposes only stable body-free metadata", () => {
  const input = "private provider input: alpha\nsecond line";
  const submission = createEphemeralProviderSubmission(input);

  assert.deepEqual(submission.metadata, {
    schemaVersion: 1,
    contractVersion: EPHEMERAL_PROVIDER_SUBMISSION_VERSION,
    inputSha256: createHash("sha256").update(input, "utf8").digest("hex"),
    inputByteLength: Buffer.byteLength(input, "utf8"),
    inputCharacterLength: input.length,
  });
  assert.equal(submission.consumed, false);
  assert.doesNotMatch(JSON.stringify(submission), /private provider input|second line/);
  assert.doesNotMatch(inspect(submission), /private provider input|second line/);
});

test("ephemeral submission delivers input to exactly one writer", async () => {
  const input = "one-shot input";
  const submission = createEphemeralProviderSubmission(input);
  let writes = 0;

  const result = await submission.consume(async (observed, metadata) => {
    writes += 1;
    assert.equal(observed, input);
    assert.equal(metadata, submission.metadata);
    return { accepted: true };
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(submission.consumed, true);
  assert.equal(writes, 1);
  await assert.rejects(
    submission.consume(async () => {}),
    (error) => error.code === "EPHEMERAL_INPUT_ALREADY_CONSUMED",
  );
  assert.equal(writes, 1);
});

test("writer failures cannot reflect raw input into persisted diagnostics", async () => {
  const input = "do-not-persist-this-provider-input";
  const submission = createEphemeralProviderSubmission(input);

  await assert.rejects(
    submission.consume(async (observed) => {
      const error = Object.assign(new Error(`provider echoed: ${observed}`), {
        code: "CODEX_SEND_FAILED",
        submissionMayHaveOccurred: true,
      });
      throw error;
    }),
    (error) => {
      assert.equal(error.code, "CODEX_SEND_FAILED");
      assert.equal(error.submissionMayHaveOccurred, true);
      assert.doesNotMatch(error.message, /do-not-persist/);
      assert.doesNotMatch(error.stack, /do-not-persist/);
      return true;
    },
  );
});
