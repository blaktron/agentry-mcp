/**
 * Errors this server raises, and the shape it turns Agentry's RFC 9457
 * `application/problem+json` bodies into.
 *
 * Every tool failure the model sees should say three things: what was asked,
 * what the registry answered, and what would make it work. A bare "403" makes
 * the model retry blindly; "403 — the PAT lacks scope org:admin" does not.
 */

/** An RFC 9457 problem document, as Agentry returns it. */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

/** Base class so tool handlers can catch everything this server throws. */
export class AgentryMcpError extends Error {
  constructor(
    message: string,
    /** What the caller could change to make the call succeed, if anything. */
    readonly remedy?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }

  /** The message a tool result should carry. */
  toToolMessage(): string {
    return this.remedy ? `${this.message}\n\n${this.remedy}` : this.message;
  }
}

/** The server is missing a registry URL, a credential, or both. */
export class ConfigError extends AgentryMcpError {}

/**
 * The route refuses personal access tokens whatever their scopes. Raised
 * before the request goes out, because the API's 403 does not explain itself
 * and the model would otherwise retry with different scopes forever.
 */
export class SessionRequiredError extends AgentryMcpError {
  constructor(operationId: string) {
    super(
      `The Agentry API refuses personal access tokens on "${operationId}" whatever ` +
        `their scopes: token minting and revocation, SSH keys, sessions, 2FA and ` +
        `account erasure are browser-session routes only.`,
      `Set AGENTRY_SESSION_COOKIE to the value of the agentry_session cookie from a ` +
        `signed-in browser, or perform this one in the web UI.`,
    );
  }
}

/** A write was attempted while the server is running read-only. */
export class ReadOnlyError extends AgentryMcpError {
  constructor(method: string, path: string) {
    super(
      `Refusing ${method} ${path}: this server is running in read-only mode.`,
      `Unset AGENTRY_MCP_READ_ONLY to allow writes.`,
    );
  }
}

/** The registry answered with a non-2xx status. */
export class ApiError extends AgentryMcpError {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly problem: Problem,
    /** Seconds to wait, from Retry-After, when the registry rate-limited us. */
    readonly retryAfter?: number,
    remedy?: string,
  ) {
    const title = problem.title ?? problem.detail ?? "no detail";
    super(`${method} ${path} failed: ${status} ${title}`, remedy);
  }

  override toToolMessage(): string {
    const lines = [this.message];
    if (this.problem.detail && this.problem.detail !== this.problem.title) {
      lines.push(this.problem.detail);
    }
    if (this.problem.type && this.problem.type !== "about:blank") {
      lines.push(`type: ${this.problem.type}`);
    }
    if (this.retryAfter !== undefined) {
      lines.push(`Retry after ${this.retryAfter}s.`);
    }
    if (this.remedy) lines.push("", this.remedy);
    return lines.join("\n");
  }
}

/** The request never got an answer: DNS, TLS, connection refused, timeout. */
export class TransportError extends AgentryMcpError {}

/**
 * Suggests what to change for the statuses the registry actually returns,
 * so the message the model reads names a next step rather than a number.
 */
export function remedyFor(status: number, sessionAuth: boolean): string | undefined {
  switch (status) {
    case 401:
      return sessionAuth
        ? "The session cookie is expired or invalid. Sign in again and refresh AGENTRY_SESSION_COOKIE."
        : "The token is missing, expired or revoked. Check AGENTRY_TOKEN, or the token for this registry in ~/.config/agentry/config.yaml.";
    case 403:
      return "Authenticated but not permitted: the token may lack the scope this route needs (repo:read, repo:write, agent:publish, agent:read, org:admin, review:act, audit:read, user:profile), or the account may lack the role.";
    case 404:
      return "Check the namespace, name and version — a private agent you cannot read is indistinguishable from one that does not exist.";
    case 409:
      return "The resource is in a state that forbids this change; read it back before retrying.";
    case 422:
      return "The request validated against the schema but the registry rejected its contents; the detail above names the field.";
    case 429:
      return "Rate-limited. Wait for the interval above rather than retrying immediately.";
    default:
      return status >= 500
        ? "The registry failed on its side. Retry once; if it persists, check the server's health."
        : undefined;
  }
}
