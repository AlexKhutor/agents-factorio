export const APPLICATION_EVENT_TYPE_CONTRACT_VERSION = "v0.1.0";

export const APPLICATION_EVENT_CLASSES = Object.freeze([
  "factual-change",
  "heartbeat-freshness",
  "interaction-request",
  "provider-stream-item",
  "command-outcome",
  "service-health",
]);

export const APPLICATION_EVENT_CLASS_PREFIXES = Object.freeze({
  "factual-change": "fact",
  "heartbeat-freshness": "freshness",
  "interaction-request": "interaction",
  "provider-stream-item": "provider",
  "command-outcome": "command",
  "service-health": "service",
});

const TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){1,5}$/;

export class ApplicationEventTypeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApplicationEventTypeError";
    this.code = code;
  }
}

export function validateApplicationEventType(eventClass, eventType) {
  if (!APPLICATION_EVENT_CLASSES.includes(eventClass)) {
    throw new ApplicationEventTypeError(
      "unsupported_event_class",
      "Application event class is not supported",
    );
  }
  if (typeof eventType !== "string" || eventType.length > 128
      || !TYPE_PATTERN.test(eventType)) {
    throw new ApplicationEventTypeError(
      "invalid_event_type",
      "Application event type is not a bounded namespace",
    );
  }
  const prefix = APPLICATION_EVENT_CLASS_PREFIXES[eventClass];
  if (!eventType.startsWith(`${prefix}.`)) {
    throw new ApplicationEventTypeError(
      "event_class_mismatch",
      "Application event type does not belong to its declared class",
    );
  }
  return { eventClass, eventType };
}

export function applicationEventClassForType(eventType) {
  if (typeof eventType !== "string" || !TYPE_PATTERN.test(eventType)) return null;
  const prefix = eventType.split(".", 1)[0];
  return Object.entries(APPLICATION_EVENT_CLASS_PREFIXES)
    .find(([, value]) => value === prefix)?.[0] ?? null;
}
