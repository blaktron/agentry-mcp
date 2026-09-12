/**
 * The one place an HTTP request to Agentry is made.
 *
 * Everything the API's own conventions demand lives here rather than in the
 * tools: RFC 9457 problem bodies become readable errors, the `Link: …
 * rel="next"` cursor and the `RateLimit-*` headers are lifted out of the
 * response, `Idempotency-Key` is passed through, and the session-only routes
 * are refused before the request goes out. A tool then reads as the call it
 * is, and there is a single seam to test.
 */

import { findAction, type Action } from "./catalog.generated.js";
import type { Config } from "./config.js";
import {
  ApiError,
  ConfigError,
  ReadOnlyError,
  SessionRequiredError,
  TransportError,
  remedyFor,
  type Problem,
} from "./errors.js";

export interface RequestOptions {
  /** Path parameters, substituted into the action's path template. */
  path?: Record<string, string | number>;
  /** Query parameters; undefined and null values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON request body. */
  body?: unknown;
  /** Replayed verbatim by the API when a retry carries the same key. */
  idempotencyKey?: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  /** Parsed JSON, or undefined for 204 and empty bodies. */
  data: T | undefined;
  /** Opaque cursor for the next page, from `nextCursor` or the Link header. */
  nextCursor?: string;
  rateLimit?: { limit?: number; remaining?: number; reset?: number };
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Fill `{ns}`, `{name}` … from `path`, refusing to leave a hole behind. */
export function expandPath(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined || value === "") {
      throw new ConfigError(`path parameter "${key}" is required by ${template} but was not given`);
    }
    return encodeURIComponent(String(value));
  });
}

/** `Link: <…?cursor=abc>; rel="next"` — the API's forward pagination pointer. */
export function cursorFromLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part);
    if (!match?.[1]) continue;
    try {
      return (
        new URL(match[1], "https://placeholder.invalid").searchParams.get("cursor") ?? undefined
      );
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function intHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export class AgentryClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly config: Config,
    fetchImpl?: typeof fetch,
  ) {
    // Bound to globalThis: an unbound `fetch` throws "Illegal invocation".
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** True when calls go out as a browser session rather than a PAT. */
  get usesSession(): boolean {
    return !this.config.token && !!this.config.sessionCookie;
  }

  /**
   * Run a catalog action. The action carries the method, path template and
   * whether a PAT is accepted, so callers pass only the values.
   */
  async call<T = unknown>(
    operationId: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const action = findAction(operationId);
    if (!action) {
      throw new ConfigError(
        `Unknown operation "${operationId}".`,
        `Use agentry_search_actions to find the operation id for what you want to do.`,
      );
    }
    return this.callAction<T>(action, options);
  }

  async callAction<T = unknown>(
    action: Action,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    // A PAT is structurally refused on these routes; say so here rather than
    // letting the model read a 403 and retry with different scopes.
    if (action.sessionOnly && !this.config.sessionCookie) {
      throw new SessionRequiredError(action.id);
    }
    if (this.config.readOnly && WRITE_METHODS.has(action.method)) {
      throw new ReadOnlyError(action.method, action.path);
    }
    if (!action.public && this.config.credentialSource === "none") {
      throw new ConfigError(
        `${action.method} ${action.path} needs authentication but no credential is configured.`,
        `Set AGENTRY_TOKEN to an agy_… personal access token, or run \`agentry login\` so the ` +
          `CLI config carries one for ${this.config.registry}.`,
      );
    }

    const url = new URL(this.config.apiBase + expandPath(action.path, options.path));
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = new Headers({ Accept: "application/json" });
    if (this.config.token) headers.set("Authorization", `Bearer ${this.config.token}`);
    if (this.config.sessionCookie) {
      headers.set("Cookie", `agentry_session=${this.config.sessionCookie}`);
    }
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);

    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      headers.set("Content-Type", "application/json");
    }

    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: action.method,
        headers,
        body: payload,
        signal: timeout,
        redirect: "follow",
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new TransportError(
        `${action.method} ${action.path} could not reach ${this.config.registry}: ${reason}`,
        `Check that the registry is up and reachable from this machine, and that ` +
          `AGENTRY_REGISTRY names it correctly.`,
      );
    }

    const rateLimit = {
      limit: intHeader(response.headers, "RateLimit-Limit"),
      remaining: intHeader(response.headers, "RateLimit-Remaining"),
      reset: intHeader(response.headers, "RateLimit-Reset"),
    };

    const text = await response.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const problem: Problem =
        parsed && typeof parsed === "object"
          ? (parsed as Problem)
          : { title: text.slice(0, 400) || response.statusText };
      throw new ApiError(
        response.status,
        action.method,
        action.path,
        problem,
        intHeader(response.headers, "Retry-After"),
        remedyFor(response.status, this.usesSession),
      );
    }

    const body = parsed as (T & { nextCursor?: string }) | undefined;
    const nextCursor =
      (body && typeof body === "object" && typeof body.nextCursor === "string"
        ? body.nextCursor
        : undefined) ?? cursorFromLink(response.headers.get("Link"));

    return {
      status: response.status,
      data: body,
      ...(nextCursor ? { nextCursor } : {}),
      ...(rateLimit.limit !== undefined || rateLimit.remaining !== undefined ? { rateLimit } : {}),
    };
  }
}
