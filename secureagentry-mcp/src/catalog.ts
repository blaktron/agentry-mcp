/**
 * Search and execution over the whole generated action catalog.
 *
 * The hand-written tools cover the account and repository work this server
 * exists for. The catalog is the rest of the API — review queues, org policy,
 * SSO and SCIM, webhooks, domain claims, advisories, platform trust-and-safety
 * — reachable without spending well over a hundred tool schemas of context on endpoints most
 * sessions never touch. The model searches, reads one action's schema, and
 * executes it.
 */

import { ACTIONS, type Action, type ActionParam } from "./catalog.generated.js";

export interface SearchHit {
  action: Action;
  score: number;
}

/** Split camelCase so "listOrgMembers" reads as "list org members". */
function words(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** Words worth ignoring: they match everything and rank nothing. */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "for",
  "of",
  "to",
  "in",
  "on",
  "by",
  "with",
  "my",
  "get",
  "list",
  "show",
  "all",
  "agentry",
  "api",
  "please",
  "how",
  "do",
  "i",
]);

function terms(query: string): string[] {
  // Split camelCase in the query as well as in the ids: the commonest query
  // this tool gets is a nearly-right operationId ("listWebhook"), which as one
  // opaque token matches nothing at all.
  return words(query)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function scoreAction(action: Action, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;
  const id = words(action.id);
  const path = action.path.toLowerCase();
  const summary = action.summary.toLowerCase();
  const description = (action.description ?? "").toLowerCase();
  const tags = action.tags.join(" ").toLowerCase();

  let score = 0;
  for (const term of queryTerms) {
    if (id.includes(term)) score += 8;
    if (path.includes(term)) score += 5;
    if (tags.includes(term)) score += 4;
    if (summary.includes(term)) score += 3;
    if (description.includes(term)) score += 1;
  }
  // An operation matching every term beats one matching a single term twice.
  const covered = queryTerms.filter(
    (t) =>
      id.includes(t) ||
      path.includes(t) ||
      tags.includes(t) ||
      summary.includes(t) ||
      description.includes(t),
  ).length;
  score += covered === queryTerms.length ? 6 : 0;
  if (action.deprecated) score -= 10;
  return score;
}

export interface SearchFilters {
  /** Restrict to one OpenAPI tag, e.g. "orgs", "webhooks", "reviews". */
  tag?: string;
  /** Restrict to one HTTP method. */
  method?: string;
  /** When true, only operations that read (GET/HEAD). */
  readOnly?: boolean;
}

export function searchActions(
  query: string,
  limit: number,
  filters: SearchFilters = {},
): SearchHit[] {
  const queryTerms = terms(query);
  const tag = filters.tag?.toLowerCase();
  const method = filters.method?.toUpperCase();

  return (
    ACTIONS.filter((a) => {
      if (tag && !a.tags.some((t) => t.toLowerCase() === tag)) return false;
      if (method && a.method !== method) return false;
      if (filters.readOnly && a.method !== "GET" && a.method !== "HEAD") return false;
      return true;
    })
      .map((action) => ({ action, score: scoreAction(action, queryTerms) }))
      // With no usable query the filters alone are the selection, so keep
      // everything; with a query, a zero score means nothing matched.
      .filter((hit) => queryTerms.length === 0 || hit.score > 0)
      .sort((a, b) => b.score - a.score || a.action.id.localeCompare(b.action.id))
      .slice(0, limit)
  );
}

/** The one-line form a search result takes, kept short on purpose. */
export function summariseHit(action: Action): Record<string, unknown> {
  const required = action.params.filter((p) => p.required).map((p) => `${p.name}:${p.in}`);
  return {
    id: action.id,
    call: `${action.method} ${action.path}`,
    summary: action.summary,
    tags: action.tags,
    ...(required.length ? { requiredParams: required } : {}),
    ...(action.body ? { requiresBody: true } : {}),
    ...(action.public ? { public: true } : {}),
    ...(action.sessionOnly ? { sessionOnly: true } : {}),
    ...(action.deprecated ? { deprecated: true } : {}),
  };
}

/** The full form, returned when the model asks for one action's detail. */
export function describeAction(action: Action): Record<string, unknown> {
  return {
    id: action.id,
    call: `${action.method} ${action.path}`,
    summary: action.summary,
    ...(action.description ? { description: action.description } : {}),
    tags: action.tags,
    public: action.public,
    sessionOnly: action.sessionOnly,
    ...(action.deprecated ? { deprecated: true } : {}),
    params: action.params,
    ...(action.body ? { body: action.body } : {}),
    responses: action.responses,
  };
}

export interface MissingParams {
  path: string[];
  query: string[];
  body: boolean;
}

/**
 * Check a call against the action's declared parameters before it goes out.
 * A named missing parameter is a far better tool result than the registry's
 * 404 on a path with an unsubstituted `{ns}` in it.
 */
export function missingParams(
  action: Action,
  given: { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown },
): MissingParams {
  const has = (bag: Record<string, unknown> | undefined, p: ActionParam) =>
    bag !== undefined && bag[p.name] !== undefined && bag[p.name] !== null && bag[p.name] !== "";

  return {
    path: action.params.filter((p) => p.in === "path" && !has(given.path, p)).map((p) => p.name),
    query: action.params
      .filter((p) => p.in === "query" && p.required && !has(given.query, p))
      .map((p) => p.name),
    body: !!action.body?.required && given.body === undefined,
  };
}

/** All tags in the catalog, for the search tool's description. */
export const ALL_TAGS: readonly string[] = [...new Set(ACTIONS.flatMap((a) => a.tags))].sort();
