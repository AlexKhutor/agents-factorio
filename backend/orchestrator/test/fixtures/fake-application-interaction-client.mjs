import {
  authorizeApplicationInteractionResponse,
  deriveApplicationInteractionStatus,
  validateApplicationInteractionRequest,
  validateApplicationInteractionResponse,
} from "../../src/application-interaction-contract.mjs";

export class FakeApplicationInteractionClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FakeApplicationInteractionClientError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FakeApplicationInteractionClientError(code, message);
}

function initialState() {
  return {
    schemaVersion: 1,
    request: null,
    response: null,
    application: {
      status: "idle",
      outcome: null,
      retryAllowed: false,
    },
  };
}

export class FakeApplicationInteractionClient {
  constructor({ state = null } = {}) {
    this.state = structuredClone(state ?? initialState());
    if (this.state.request !== null) validateApplicationInteractionRequest(this.state.request);
    if (this.state.response !== null) validateApplicationInteractionResponse(this.state.response);
  }

  publish(request) {
    validateApplicationInteractionRequest(request);
    if (this.state.request !== null) fail("request_slot_occupied", "A request is already published");
    this.state.request = structuredClone(request);
    return structuredClone(this.state.request);
  }

  submit({
    request = this.state.request,
    response,
    currentSourceSequence,
    observedAtUtc,
    applicationOutcome = "completed",
  }) {
    if (this.state.request === null) fail("request_missing", "No request is published");
    if (request.requestId !== this.state.request.requestId
        || request.requestSha256 !== this.state.request.requestSha256) {
      fail("interaction_request_changed", "Published request changed before response submission");
    }
    authorizeApplicationInteractionResponse({
      request,
      response,
      currentSourceSequence,
      existingResponse: this.state.response,
      observedAtUtc,
    });
    this.state.response = structuredClone(response);
    if (applicationOutcome === "response-lost") {
      this.state.application = {
        status: "completed",
        outcome: "response-persisted-acknowledgement-lost",
        retryAllowed: false,
      };
      fail("response_acknowledgement_lost", "Response persisted but acknowledgement was lost");
    }
    if (applicationOutcome === "provider-timeout") {
      this.state.application = {
        status: "uncertain",
        outcome: "provider-timeout-after-owner-response",
        retryAllowed: false,
      };
      fail("provider_application_timeout", "Provider outcome is uncertain after owner response");
    }
    if (applicationOutcome !== "completed") {
      fail("unsupported_fake_outcome", "Fake application outcome is unsupported");
    }
    this.state.application = {
      status: "completed",
      outcome: "applied",
      retryAllowed: false,
    };
    return this.snapshot();
  }

  interactionStatus({ currentSourceSequence, observedAtUtc }) {
    return deriveApplicationInteractionStatus({
      request: this.state.request,
      response: this.state.response,
      currentSourceSequence,
      observedAtUtc,
    });
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
