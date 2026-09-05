/**
 * Where the server points and what it authenticates with.
 *
 * Resolution deliberately mirrors the agentry CLI: the same
 * ~/.config/agentry/config.yaml the CLI writes at login is the default source
 * of both the registry URL and the token, relocated by the same
 * AGENTRY_CONFIG_DIR. An operator who can already use `agentry` gets a working
 * MCP server with no extra setup, and there is one place to rotate a
 * credential rather than two.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { ConfigError } from "./errors.js";
import { API_BASE_PATH } from "./catalog.generated.js";

export interface Config {
  /** Registry origin, no trailing slash, e.g. "https://dev.secureagentry.net". */
  registry: string;
  /** Full API base, e.g. "https://dev.secureagentry.net/api/v1". */
  apiBase: string;
  /** Bearer PAT (`agy_…`), when one was found. */
  token?: string;
  /** Value of the agentry_session cookie, for the routes that refuse PATs. */
  sessionCookie?: string;
  /** Where the credential came from, for whoami and for error messages. */
  credentialSource: "AGENTRY_TOKEN" | "AGENTRY_SESSION_COOKIE" | "config.yaml" | "none";
  /** Refuse every non-GET request. */
  readOnly: boolean;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Largest response body rendered into a tool result, in characters. */
  maxResponseChars: number;
}

interface CliConfigFile {
  defaultRegistry?: string;
  registries?: { url?: string; token?: string; tokenRef?: string }[];
}

/** The agentry client config directory, honouring the CLI's own override. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTRY_CONFIG_DIR || join(env.HOME || homedir(), ".config", "agentry");
}

function readCliConfig(dir: string): CliConfigFile | undefined {
  try {
    const parsed: unknown = parse(readFileSync(join(dir, "config.yaml"), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as CliConfigFile) : undefined;
  } catch {
    // Absent or unreadable is normal — the environment may carry everything.
    return undefined;
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive number, got "${raw}".`);
  }
  return Math.floor(n);
}

/**
 * True for the values people actually type when they mean yes. Anything else,
 * including the empty string, is off — so `AGENTRY_MCP_READ_ONLY=` does not
 * silently arm a mode the operator meant to clear.
 */
function truthy(raw: string | undefined): boolean {
  return raw !== undefined && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = readCliConfig(configDir(env));

  const registryRaw = env.AGENTRY_REGISTRY || file?.defaultRegistry;
  if (!registryRaw) {
    throw new ConfigError(
      "No Agentry registry configured.",
      `Set AGENTRY_REGISTRY (e.g. https://dev.secureagentry.net), or run \`agentry login\` ` +
        `so ${join(configDir(env), "config.yaml")} carries a defaultRegistry.`,
    );
  }

  let registry: string;
  try {
    registry = trimSlash(new URL(registryRaw).toString());
  } catch {
    throw new ConfigError(`AGENTRY_REGISTRY is not a valid URL: "${registryRaw}".`);
  }

  // The CLI keys tokens by registry URL, so a config with several registries
  // still yields the right one for wherever we are pointed.
  const entry = file?.registries?.find((r) => r.url && trimSlash(r.url) === registry);

  const sessionCookie = env.AGENTRY_SESSION_COOKIE?.trim() || undefined;
  const token = env.AGENTRY_TOKEN?.trim() || entry?.token?.trim() || undefined;

  const credentialSource: Config["credentialSource"] = env.AGENTRY_TOKEN?.trim()
    ? "AGENTRY_TOKEN"
    : token
      ? "config.yaml"
      : sessionCookie
        ? "AGENTRY_SESSION_COOKIE"
        : "none";

  return {
    registry,
    apiBase: registry + API_BASE_PATH,
    token,
    sessionCookie,
    credentialSource,
    readOnly: truthy(env.AGENTRY_MCP_READ_ONLY),
    timeoutMs: positiveInt(env.AGENTRY_MCP_TIMEOUT_MS, 30_000, "AGENTRY_MCP_TIMEOUT_MS"),
    maxResponseChars: positiveInt(env.AGENTRY_MCP_MAX_CHARS, 60_000, "AGENTRY_MCP_MAX_CHARS"),
  };
}
