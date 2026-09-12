/**
 * Turning an API response into a tool result.
 *
 * Two jobs, both about what reaches the model's context. First, redaction: the
 * registry hands back a freshly minted PAT exactly once, and a token that lands
 * in a transcript is a token that leaks. Nothing secret is rendered unless a
 * caller asked for it in so many words. Second, budget: a version listing for a
 * busy agent can run to hundreds of kilobytes, and a tool that floods the
 * window is worse than one that truncates and says so.
 */

import type { ApiResponse } from "./client.js";

/**
 * Field names whose values are never rendered. Matched case-insensitively on
 * the whole key, so `token` and `sessionToken` are covered but `tokenId` — an
 * identifier that tools need in order to revoke — is not.
 */
const SECRET_KEYS =
  /^(?:token|secret|password|passphrase|private_?key|client_?secret|access_?token|refresh_?token|session_?token|api_?key|bearer)$/i;

/** Agentry's PAT shape, redacted wherever it appears inside a string. */
const PAT_PATTERN = /\bagy_[A-Za-z0-9_-]{8,}/g;

export const REDACTED = "[redacted]";

/** Replace secret-looking values with a marker, recursively. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") return value.replace(PAT_PATTERN, REDACTED) as T;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) && v !== null && v !== "" ? REDACTED : redactSecrets(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Clip a rendered payload to a character budget on a line boundary, so what
 * survives is still readable, and say plainly that it was clipped.
 */
export function clip(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (text.length <= maxChars) return { text, clipped: false };
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf("\n");
  const kept = lastNewline > maxChars * 0.5 ? cut.slice(0, lastNewline) : cut;
  return {
    text:
      `${kept}\n\n… truncated: ${text.length - kept.length} of ${text.length} characters not shown. ` +
      `Narrow the request (a filter, a smaller limit, or a specific id) to see the rest.`,
    clipped: true,
  };
}

export interface RenderOptions {
  maxChars: number;
  /** Skip redaction. Only ever set from an explicit caller opt-in. */
  reveal?: boolean;
  /** Prepended to the payload, e.g. a note about what was created. */
  note?: string;
}

/** Render an API response as the text body of a tool result. */
export function renderResponse(response: ApiResponse, options: RenderOptions): string {
  const parts: string[] = [];
  if (options.note) parts.push(options.note);

  if (response.data === undefined) {
    parts.push(`Done (HTTP ${response.status}, no content).`);
  } else {
    const shaped = options.reveal ? response.data : redactSecrets(response.data);
    parts.push(JSON.stringify(shaped, null, 2));
  }

  if (response.nextCursor) {
    parts.push(
      `More results available. Pass cursor="${response.nextCursor}" to this tool for the next page.`,
    );
  }
  if (response.rateLimit?.remaining !== undefined && response.rateLimit.remaining <= 5) {
    parts.push(
      `Rate limit nearly spent: ${response.rateLimit.remaining} of ` +
        `${response.rateLimit.limit ?? "?"} requests left in this window.`,
    );
  }

  return clip(parts.join("\n\n"), options.maxChars).text;
}
