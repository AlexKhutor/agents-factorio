import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createApplicationAgentControlHandlers } from "../src/application-agent-control.mjs";
import { APPLICATION_DOMAIN_OPERATION_DEFINITIONS } from "../src/application-domain-operations.mjs";

test("control ports are omitted independently, and preserve exact agent input", async () => {
  assert.deepEqual(createApplicationAgentControlHandlers({ provider: null }), {});
  const inputs = [];
  const service = { provider: { interrupt() {} },
    async interrupt(input) { inputs.push(input); return { state: "accepted" }; } };
  const handlers = createApplicationAgentControlHandlers(service);
  assert.deepEqual(Object.keys(handlers), ["mutation.agent-control.interrupt"]);
  const input = { agentId: "a", operationId: "send-1" };
  assert.deepEqual(await handlers["mutation.agent-control.interrupt"]({ input }), { state: "accepted" });
  assert.deepEqual(inputs, [input]);
  assert.equal(APPLICATION_DOMAIN_OPERATION_DEFINITIONS.filter((d) => d.binding.contractId === "application-agent-control").length, 3);
});

test("portable agent-control schema rejects foreign thread authority and malformed input", async () => {
  const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
  const schema = JSON.parse(await readFile(new URL("../schemas/application-agent-control.schema.json", import.meta.url)));
  const validate = ajv.compile(schema);
  const request = { schemaVersion: 1, contractVersion: "v0.1.0",
    operationId: "mutation.agent-control.interrupt", input: { agentId: "a", operationId: "send-1" } };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...request, input: { ...request.input, threadId: "foreign" } }), false);
  assert.equal(validate({ ...request, input: {} }), false);
});
