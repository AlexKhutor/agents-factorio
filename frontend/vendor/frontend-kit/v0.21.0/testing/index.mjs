import { ApplicationFrontendClient } from "../client/index.mjs";
import { FakeApplicationBackend } from "./fake-backend.mjs";
import { DEFAULT_FAKE_APPLICATION_CAPABILITIES } from "./default-capabilities.mjs";
import { runApplicationFrontendConformanceCore } from "./conformance.mjs";
export * from "./fake-backend.mjs";
export * from "./conformance.mjs";
export { DEFAULT_FAKE_APPLICATION_CAPABILITIES };
export function createFakeApplicationBackend(options = {}) {
  const { capabilities = DEFAULT_FAKE_APPLICATION_CAPABILITIES, ...rest } = options;
  return new FakeApplicationBackend({ capabilities: structuredClone(capabilities), ...rest });
}
function createConformanceClient(backend, { now, idFactory }) {
  return new ApplicationFrontendClient({
    resolveDescriptor: backend.resolveDescriptor, fetchImpl: backend.fetch,
    expectedWorkspace: backend.workspace, now, idFactory,
  });
}
export function runApplicationFrontendConformance({
  backendFactory = createFakeApplicationBackend,
  clientFactory = createConformanceClient,
  delayMs = 10,
} = {}) {
  return runApplicationFrontendConformanceCore({
    createBackend: backendFactory, createClient: clientFactory, delayMs,
  });
}
