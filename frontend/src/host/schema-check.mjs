// Checks inputs and results against the kit's own JSON schemas.
//
// The generic kit client carries the new agent-workspace reads (conversation,
// project files, artifacts, events) as plain envelopes: it does not check what
// their output looks like. The host does, against the exact schema files the
// accepted delivery ships, read through the verified kit (kit.readText). A value
// that does not match is never handed on as data.
//
// This is a deliberately small validator for the subset of JSON Schema 2020-12
// those files use. It fails closed: a keyword it does not know is reported as a
// problem, so a new schema feature can never be silently ignored.

const IGNORED = new Set(["$schema", "$id", "$comment", "title", "description", "format", "$defs", "examples"]);
const BASE = "https://isolate-vscode.local/schemas/";

/** The schema files the agent-workspace reads need, with the files they refer to. */
export const WORKSPACE_SCHEMA_FILES = Object.freeze([
  "application-agent-conversation.v1.json",
  "application-project-workspace.v1.json",
  "application-agent-artifacts.v1.json",
  "application-agent-events.v1.json",
  "application-project-workspace-save.v1.json",
  "application-project-copy.schema.json",
  "adapter-common.v1.json",
  "external-reference.v1.json",
  "authority-reference.v1.json",
]);

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

const matchesType = (value, type) => {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
};

function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

export function createSchemaSet(documents) {
  const byId = new Map();
  for (const document of documents) byId.set(document.$id, document);

  function resolve(ref, current) {
    const [file, pointer = ""] = ref.split("#");
    const document = file === "" ? current : byId.get(file.startsWith("http") ? file : `${BASE}${file}`);
    if (document === undefined) return { schema: null, document: null };
    let schema = document;
    for (const part of pointer.split("/").filter((item) => item !== "")) {
      schema = schema?.[part.replace(/~1/gu, "/").replace(/~0/gu, "~")];
    }
    return { schema: schema ?? null, document };
  }

  // Returns the property names this schema (with its applicators) evaluated,
  // and pushes problems. `document` is the file a local $ref resolves in.
  function walk(schema, value, where, document, problems) {
    if (schema === true) return;
    if (schema === false) {
      problems.push({ path: where, keyword: "false" });
      return;
    }
    if (schema === null || typeof schema !== "object") {
      problems.push({ path: where, keyword: "schema_invalid" });
      return;
    }
    for (const [keyword, rule] of Object.entries(schema)) {
      if (IGNORED.has(keyword)) continue;
      const fail = () => problems.push({ path: where, keyword });
      switch (keyword) {
        case "$ref": {
          const target = resolve(rule, document);
          if (target.schema === null) fail();
          else walk(target.schema, value, where, target.document, problems);
          break;
        }
        case "type":
          if (!(Array.isArray(rule) ? rule : [rule]).some((type) => matchesType(value, type))) fail();
          break;
        case "const":
          if (!equal(value, rule)) fail();
          break;
        case "enum":
          if (!rule.some((item) => equal(value, item))) fail();
          break;
        case "required":
          if (typeOf(value) === "object" && rule.some((key) => !Object.hasOwn(value, key))) fail();
          break;
        case "properties":
          if (typeOf(value) === "object") {
            for (const [key, sub] of Object.entries(rule)) {
              if (Object.hasOwn(value, key)) walk(sub, value[key], `${where}/${key}`, document, problems);
            }
          }
          break;
        case "additionalProperties":
          if (typeOf(value) === "object") {
            const known = new Set(Object.keys(schema.properties ?? {}));
            for (const key of Object.keys(value)) {
              if (known.has(key)) continue;
              if (rule === false) problems.push({ path: `${where}/${key}`, keyword });
              else walk(rule, value[key], `${where}/${key}`, document, problems);
            }
          }
          break;
        case "propertyNames":
          if (typeOf(value) === "object") {
            for (const key of Object.keys(value)) walk(rule, key, `${where}/${key}`, document, problems);
          }
          break;
        case "maxProperties":
          if (typeOf(value) === "object" && Object.keys(value).length > rule) fail();
          break;
        case "pattern":
          if (typeof value === "string" && !new RegExp(rule, "u").test(value)) fail();
          break;
        case "minLength":
          if (typeof value === "string" && [...value].length < rule) fail();
          break;
        case "maxLength":
          if (typeof value === "string" && [...value].length > rule) fail();
          break;
        case "minimum":
          if (typeof value === "number" && value < rule) fail();
          break;
        case "maximum":
          if (typeof value === "number" && value > rule) fail();
          break;
        case "items":
          if (Array.isArray(value)) value.forEach((item, index) => walk(rule, item, `${where}/${index}`, document, problems));
          break;
        case "minItems":
          if (Array.isArray(value) && value.length < rule) fail();
          break;
        case "maxItems":
          if (Array.isArray(value) && value.length > rule) fail();
          break;
        case "uniqueItems":
          if (rule === true && Array.isArray(value)
              && value.some((item, index) => value.findIndex((other) => equal(other, item)) !== index)) fail();
          break;
        case "allOf":
          for (const sub of rule) walk(sub, value, where, document, problems);
          break;
        case "anyOf":
          if (!rule.some((sub) => passes(sub, value, document))) fail();
          break;
        case "oneOf":
          if (rule.filter((sub) => passes(sub, value, document)).length !== 1) fail();
          break;
        case "not":
          if (passes(rule, value, document)) fail();
          break;
        case "if":
          if (passes(rule, value, document)) {
            if ("then" in schema) walk(schema.then, value, where, document, problems);
          } else if ("else" in schema) {
            walk(schema.else, value, where, document, problems);
          }
          break;
        case "then":
        case "else":
          break;
        default:
          // Fail closed: an unknown keyword may be a constraint this check would skip.
          problems.push({ path: where, keyword: `unsupported:${keyword}` });
      }
    }
  }

  function passes(schema, value, document) {
    const problems = [];
    walk(schema, value, "", document, problems);
    return problems.length === 0;
  }

  /**
   * Checks `value` against `#/$defs/<definition>` of `file` (or the whole file
   * when definition is null). Problems name a JSON path and a keyword only -
   * never the offending value, which may be conversation or file text.
   */
  function check(file, definition, value) {
    const document = byId.get(`${BASE}${file}`);
    if (document === undefined) return { ok: false, problems: [{ path: "", keyword: "schema_missing" }] };
    const schema = definition === null ? document : document.$defs?.[definition];
    if (schema === undefined) return { ok: false, problems: [{ path: "", keyword: "definition_missing" }] };
    const problems = [];
    walk(schema, value, "", document, problems);
    return problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems: problems.slice(0, 8) };
  }

  return { check };
}

/** Reads the named schema files from the verified kit and builds one set. */
export async function loadSchemaSet(kit, files = WORKSPACE_SCHEMA_FILES) {
  const documents = [];
  for (const file of files) documents.push(JSON.parse(await kit.readText(`schemas/${file}`)));
  return createSchemaSet(documents);
}
