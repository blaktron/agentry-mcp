#!/usr/bin/env node
// Builds src/catalog.generated.ts from spec/openapi.yaml.
//
// The catalog is what agentry_search_actions and agentry_execute_action work
// from: every operation in the Agentry API, with its method, path, parameters
// and request-body schema flattened into plain JSON. Keeping it generated —
// rather than hand-listing endpoints — means a spec refresh plus `npm run
// generate` is the whole cost of tracking the API, and CI can prove the two
// are in step.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "spec", "openapi.yaml");
const sessionOnlyPath = join(root, "spec", "session-only.json");
const outPath = join(root, "src", "catalog.generated.ts");

const raw = readFileSync(specPath, "utf8");
const spec = parse(raw);
const specSha = createHash("sha256").update(raw).digest("hex");

// Which operations refuse a PAT outright. Not expressible in OpenAPI, so it is
// extracted from the server's authz table by scripts/sync-spec.sh.
const sessionOnly = new Set(JSON.parse(readFileSync(sessionOnlyPath, "utf8")).operationIds);

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

/** Follow a local `#/components/...` pointer. Remote refs are not used by this spec. */
function lookup(ref) {
  if (!ref.startsWith("#/")) throw new Error(`non-local $ref: ${ref}`);
  let node = spec;
  for (const seg of ref.slice(2).split("/")) {
    node = node?.[seg.replaceAll("~1", "/").replaceAll("~0", "~")];
    if (node === undefined) throw new Error(`unresolvable $ref: ${ref}`);
  }
  return node;
}

// Schemas in this spec are shallow, but Problem and a few others recurse
// through allOf/items. `seen` breaks cycles and `depth` stops the catalog from
// growing a tail of detail no caller reads; either way the truncated node keeps
// the component name so a reader can look it up in the spec.
function deref(node, seen = new Set(), depth = 0) {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((v) => deref(v, seen, depth + 1));

  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    const name = ref.split("/").pop();
    if (seen.has(ref) || depth > 8) return { type: "object", title: name, truncatedRef: ref };
    const next = new Set(seen);
    next.add(ref);
    const resolved = deref(lookup(ref), next, depth + 1);
    // Preserve the component name; tool descriptions cite it.
    return resolved && typeof resolved === "object" && !Array.isArray(resolved)
      ? { title: name, ...resolved }
      : resolved;
  }

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "example" || k === "examples") continue; // context weight, no value here
    out[k] = deref(v, seen, depth + 1);
  }
  return out;
}

/** Collapse whitespace so folded YAML descriptions stay one tidy line. */
function tidy(s) {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : undefined;
}

function jsonBody(requestBody) {
  if (!requestBody) return undefined;
  const body = deref(requestBody);
  const schema = body.content?.["application/json"]?.schema;
  if (!schema) {
    const type = Object.keys(body.content ?? {})[0];
    return type ? { required: !!body.required, contentType: type } : undefined;
  }
  return { required: !!body.required, contentType: "application/json", schema };
}

const actions = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  const shared = (item.parameters ?? []).map((p) => deref(p));
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    if (!op.operationId) throw new Error(`${method.toUpperCase()} ${path} has no operationId`);

    const params = [...shared, ...(op.parameters ?? []).map((p) => deref(p))].map((p) => ({
      name: p.name,
      in: p.in,
      required: !!p.required || p.in === "path",
      description: tidy(p.description),
      schema: p.schema,
    }));

    actions.push({
      id: op.operationId,
      method: method.toUpperCase(),
      path,
      tags: op.tags ?? [],
      summary: tidy(op.summary) ?? "",
      description: tidy(op.description),
      // `security: []` on an operation opts out of the document-level
      // requirement, i.e. the endpoint is readable without a token.
      public: Array.isArray(op.security) && op.security.length === 0,
      // A PAT is refused here whatever its scopes; only a browser session works.
      sessionOnly: sessionOnly.has(op.operationId),
      deprecated: !!op.deprecated,
      params,
      body: jsonBody(op.requestBody),
      responses: Object.entries(op.responses ?? {})
        .filter(([code]) => code !== "default")
        .map(([code, res]) => ({ code, description: tidy(deref(res).description) })),
    });
  }
}
actions.sort((a, b) => a.id.localeCompare(b.id));

const unknownSessionOnly = [...sessionOnly].filter((id) => !actions.some((a) => a.id === id));
if (unknownSessionOnly.length) {
  throw new Error(
    `spec/session-only.json names operations the spec does not define: ${unknownSessionOnly.join(", ")}`,
  );
}

const dupes = actions.map((a) => a.id).filter((id, i, all) => all.indexOf(id) !== i);
if (dupes.length) throw new Error(`duplicate operationIds: ${[...new Set(dupes)].join(", ")}`);

const banner = `// Code generated by scripts/generate-catalog.mjs from spec/openapi.yaml. DO NOT EDIT.
//
// Regenerate with \`npm run generate\` after refreshing the vendored spec
// (scripts/sync-spec.sh). CI fails when this file and the spec disagree.
`;

const source = `${banner}
export interface ActionParam {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface ActionBody {
  required: boolean;
  contentType: string;
  schema?: Record<string, unknown>;
}

export interface ActionResponse {
  code: string;
  description?: string;
}

export interface Action {
  /** The spec's operationId; the handle agentry_execute_action takes. */
  id: string;
  method: string;
  /** Path template relative to the API base, e.g. "/agents/{ns}/{name}". */
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  /** True when the endpoint is readable without a token. */
  public: boolean;
  /**
   * True when the API rejects personal access tokens on this route whatever
   * their scopes (token minting, SSH keys, sessions, 2FA, account erasure).
   * Such calls need AGENTRY_SESSION_COOKIE.
   */
  sessionOnly: boolean;
  deprecated: boolean;
  params: ActionParam[];
  body?: ActionBody;
  responses: ActionResponse[];
}

/** OpenAPI \`info.version\` of the spec this catalog was built from. */
export const API_VERSION = ${JSON.stringify(spec.info?.version ?? "unknown")};

/** Server-relative base path the operations hang off, e.g. "/api/v1". */
export const API_BASE_PATH = ${JSON.stringify(spec.servers?.[0]?.url ?? "/api/v1")};

/** sha256 of spec/openapi.yaml, so a drifted catalog is detectable. */
export const SPEC_SHA256 = ${JSON.stringify(specSha)};

export const ACTIONS: readonly Action[] = ${JSON.stringify(actions, null, 2)} as const;

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

export function findAction(id: string): Action | undefined {
  return BY_ID.get(id);
}
`;

writeFileSync(outPath, source);
console.log(
  `catalog: ${actions.length} actions (${sessionOnly.size} session-only) from ` +
    `${Object.keys(spec.paths ?? {}).length} paths (API ${spec.info?.version}) -> ` +
    outPath.replace(root + "/", ""),
);
