import { createHash } from "node:crypto";

export const EPHEMERAL_PROVIDER_SUBMISSION_VERSION = "v0.1.0";

const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,128}$/u;

export class EphemeralProviderSubmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EphemeralProviderSubmissionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new EphemeralProviderSubmissionError(code, message);
}

function safeWriterError(error) {
  const code = typeof error?.code === "string" && SAFE_ERROR_CODE.test(error.code)
    ? error.code
    : "PROVIDER_SUBMISSION_FAILED";
  const safe = new EphemeralProviderSubmissionError(
    code,
    `Provider submission failed (${code})`,
  );
  if (error?.submissionMayHaveOccurred === true) {
    safe.submissionMayHaveOccurred = true;
  }
  return safe;
}

export class EphemeralProviderSubmission {
  #input;
  #metadata;
  #consumed = false;

  constructor(input, { maxInputBytes = DEFAULT_MAX_INPUT_BYTES } = {}) {
    if (typeof input !== "string" || input.length === 0) {
      fail("INVALID_EPHEMERAL_INPUT", "Provider input must be a non-empty string");
    }
    if (!Number.isInteger(maxInputBytes) || maxInputBytes < 1) {
      fail("INVALID_EPHEMERAL_LIMIT", "Provider input limit must be a positive integer");
    }
    const inputByteLength = Buffer.byteLength(input, "utf8");
    if (inputByteLength > maxInputBytes) {
      fail("EPHEMERAL_INPUT_TOO_LARGE", "Provider input exceeds its bounded byte limit");
    }
    this.#input = input;
    this.#metadata = Object.freeze({
      schemaVersion: 1,
      contractVersion: EPHEMERAL_PROVIDER_SUBMISSION_VERSION,
      inputSha256: createHash("sha256").update(input, "utf8").digest("hex"),
      inputByteLength,
      inputCharacterLength: input.length,
    });
  }

  get metadata() {
    return this.#metadata;
  }

  get consumed() {
    return this.#consumed;
  }

  toJSON() {
    return this.#metadata;
  }

  async consume(writer) {
    if (typeof writer !== "function") {
      fail("INVALID_EPHEMERAL_WRITER", "Provider submission writer must be a function");
    }
    if (this.#consumed) {
      fail("EPHEMERAL_INPUT_ALREADY_CONSUMED", "Provider input cannot be consumed twice");
    }
    this.#consumed = true;
    const input = this.#input;
    this.#input = null;
    try {
      return await writer(input, this.#metadata);
    } catch (error) {
      throw safeWriterError(error);
    }
  }
}

export function createEphemeralProviderSubmission(input, options) {
  return new EphemeralProviderSubmission(input, options);
}
