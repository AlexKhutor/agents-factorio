import { validateApplicationPayloadPrivacy } from "./application-contract.mjs";
import { normalizeApplicationProjectMemoryError } from "./application-project-memory.mjs";

export const APPLICATION_AGENT_CONTROL_VERSION = "v0.1.0";
export const APPLICATION_AGENT_CONTROL_OPERATIONS = Object.freeze({
  interactions: "query.agent-control.interactions",
  respond: "approval.agent-control.respond",
  interrupt: "mutation.agent-control.interrupt",
});
export function createApplicationAgentControlHandlers(service) {
  if (!service?.provider) return {};
  const ports = { interactions: "listInteractions", respond: "respondInteraction", interrupt: "interrupt" };
  const handlers = {};
  for (const [method, operationId] of Object.entries(APPLICATION_AGENT_CONTROL_OPERATIONS)) {
    if (typeof service.provider[ports[method]] !== "function") continue;
    handlers[operationId] = async ({ input }) => {
      try {
        validateApplicationPayloadPrivacy(input, { zone: "request-input", operationId });
        const result = await service[method](input);
        validateApplicationPayloadPrivacy(result, { zone: "result-output", operationId });
        return structuredClone(result);
      } catch (error) { throw normalizeApplicationProjectMemoryError(error); }
    };
  }
  return handlers;
}
