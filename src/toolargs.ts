/**
 * Tool arguments in the type the tool's schema names.
 *
 * Models do not always send arguments in the JSON types a tool's input schema
 * names: a boolean arrives as "true", a number as "30", an array or a map as
 * its JSON text, or the whole arguments object as one JSON string; the other
 * way round, a value for a string parameter arrives as a number or an object.
 * The SDK validates arguments against the schema before the handler runs, so
 * every such call would fail outright and the model would read the error as a
 * broken tool.
 *
 * registerTool registers a tool whose every parameter first takes a JSON
 * string sent for a non-string parameter as the value it encodes, and a value
 * sent for a string parameter (or for an element of a list or map of strings)
 * as its compact JSON text. A string sent for a parameter that takes strings
 * is never reinterpreted, and a string that does not encode the wanted type is
 * left as it arrived, so validation still refuses it naming the parameter.
 * The schema a host lists is unchanged.
 *
 * connectServer connects a server to its transport and unwraps a call's
 * arguments object sent as one JSON string, which the protocol would
 * otherwise refuse before any tool sees it.
 */

import type {
  McpServer,
  RegisteredTool,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";

type ZodType = z.core.$ZodType;

interface ToolConfig<Shape extends ZodRawShape> {
  title?: string;
  description?: string;
  inputSchema?: Shape;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

/** server.registerTool, with each parameter of the input shape taken as its schema's type. */
export function registerTool<Shape extends ZodRawShape>(
  server: McpServer,
  name: string,
  config: ToolConfig<Shape>,
  cb: ToolCallback<Shape>,
): RegisteredTool {
  const { inputSchema, ...rest } = config;
  if (!inputSchema) return server.registerTool(name, rest, cb as ToolCallback);
  const loose = Object.fromEntries(
    Object.entries(inputSchema).map(([key, schema]) => [
      key,
      z.preprocess((value) => coerce(schema, value), schema),
    ]),
  ) as unknown as Shape;
  return server.registerTool(name, { ...rest, inputSchema: loose }, cb);
}

/** server.connect, with a tools/call whose arguments are one JSON string unwrapped. */
export async function connectServer(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(transport);
  const deliver = transport.onmessage;
  if (!deliver) return;
  transport.onmessage = (message, extra) => deliver(unwrapArguments(message), extra);
}

function unwrapArguments<T extends JSONRPCMessage>(message: T): T {
  if (!("method" in message) || message.method !== "tools/call") return message;
  const params = message.params;
  if (typeof params?.arguments !== "string") return message;
  const parsed = parseJson(params.arguments);
  if (!isPlainObject(parsed)) return message;
  return { ...message, params: { ...params, arguments: parsed } };
}

type Kind = "string" | "number" | "boolean" | "array" | "object" | "any";

interface Def {
  type: string;
  innerType?: ZodType;
  in?: ZodType;
  out?: ZodType;
  getter?: () => ZodType;
  element?: ZodType;
  valueType?: ZodType;
  shape?: Record<string, ZodType>;
  options?: ZodType[];
  left?: ZodType;
  right?: ZodType;
  entries?: Record<string, unknown>;
  values?: unknown[];
}

function def(schema: ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

/** The schema under the wrappers that do not change what JSON type it takes. */
function unwrap(schema: ZodType): ZodType {
  for (;;) {
    const d = def(schema);
    switch (d.type) {
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "nonoptional":
      case "readonly":
      case "catch":
        schema = d.innerType!;
        continue;
      case "pipe":
        schema = def(d.in!).type === "transform" ? d.out! : d.in!;
        continue;
      case "lazy":
        schema = d.getter!();
        continue;
      default:
        return schema;
    }
  }
}

/** The JSON types a schema takes. */
function kinds(schema: ZodType): Set<Kind> {
  const s = unwrap(schema);
  const d = def(s);
  switch (d.type) {
    case "string":
    case "template_literal":
      return new Set(["string"]);
    case "number":
    case "bigint":
      return new Set(["number"]);
    case "boolean":
      return new Set(["boolean"]);
    case "array":
    case "tuple":
    case "set":
      return new Set(["array"]);
    case "object":
    case "record":
    case "map":
      return new Set(["object"]);
    case "any":
    case "unknown":
      return new Set(["any"]);
    case "enum":
      return kindsOfValues(Object.values(d.entries ?? {}));
    case "literal":
      return kindsOfValues(d.values ?? []);
    case "union":
      return new Set((d.options ?? []).flatMap((o) => [...kinds(o)]));
    case "intersection":
      return new Set([...kinds(d.left!), ...kinds(d.right!)]);
    default:
      return new Set();
  }
}

function kindsOfValues(values: unknown[]): Set<Kind> {
  const out = new Set<Kind>();
  for (const v of values) {
    const k = jsonKind(v);
    if (k) out.add(k);
  }
  return out;
}

function jsonKind(value: unknown): Kind | undefined {
  if (Array.isArray(value)) return "array";
  if (isPlainObject(value)) return "object";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return undefined;
  }
}

/**
 * The value a parameter's schema was sent, in the JSON type the schema takes
 * where the value encodes it; otherwise the value as it arrived.
 */
export function coerce(schema: ZodType, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const want = kinds(schema);
  if (want.has("any")) {
    // A parameter that takes any JSON: a string holding an object or an
    // array is that object or array, since the parameter is JSON.
    if (typeof value !== "string") return value;
    const parsed = parseJson(value);
    return Array.isArray(parsed) || isPlainObject(parsed) ? parsed : value;
  }
  if (typeof value === "string") {
    if (want.has("string")) return value;
    const parsed = parseJson(value);
    if (parsed === NOT_JSON) return value;
    const inner = coerceInside(schema, parsed);
    return z.safeParse(schema, inner).success ? inner : value;
  }
  const kind = jsonKind(value);
  if (kind && want.has(kind)) return coerceInside(schema, value);
  if (want.has("string")) return JSON.stringify(value);
  return value;
}

/** Each element of a list, value of a map or field of an object, coerced to its own schema. */
function coerceInside(schema: ZodType, value: unknown): unknown {
  const kind = jsonKind(value);
  if (kind !== "array" && kind !== "object") return value;
  const s = containerFor(schema, kind);
  if (!s) return value;
  const d = def(s);
  if (Array.isArray(value)) {
    return d.type === "array" ? value.map((e) => coerce(d.element!, e)) : value;
  }
  const obj = value as Record<string, unknown>;
  if (d.type === "record") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, coerce(d.valueType!, v)]));
  }
  if (d.type === "object") {
    const shape = d.shape ?? {};
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, shape[k] ? coerce(shape[k], v) : v]),
    );
  }
  return value;
}

/** The one schema, under wrappers and union members, that takes this JSON type. */
function containerFor(schema: ZodType, kind: Kind): ZodType | undefined {
  const s = unwrap(schema);
  const d = def(s);
  if (d.type !== "union") return kinds(s).has(kind) ? s : undefined;
  const matching = (d.options ?? []).filter((o) => kinds(o).has(kind));
  return matching.length === 1 ? containerFor(matching[0]!, kind) : undefined;
}

const NOT_JSON = Symbol("not JSON");

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
