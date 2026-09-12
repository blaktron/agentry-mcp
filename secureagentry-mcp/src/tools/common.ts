/**
 * Shared plumbing for tool modules: the context handlers receive, the uniform
 * error boundary, and the zod pieces that repeat across the account and
 * repository tools.
 *
 * The patterns here come straight from the API contract — a namespace and an
 * agent name have fixed shapes, and rejecting a bad one locally costs a round
 * trip less than letting the registry do it.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AgentryClient } from "../client.js";
import type { Config } from "../config.js";
import { AgentryMcpError } from "../errors.js";
import { renderResponse, type RenderOptions } from "../shaping.js";
import type { ApiResponse } from "../client.js";

export interface ToolContext {
  client: AgentryClient;
  config: Config;
}

export type ToolModule = (server: McpServer, ctx: ToolContext) => void;

/** Handle shapes, from schemas/openapi.yaml components.parameters. */
export const handleSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/,
    "lowercase letters, digits and hyphens, ≤39 chars",
  );

export const agentNameSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,63}[a-z0-9])?$/,
    "lowercase letters, digits and hyphens, ≤65 chars",
  );

export const semverSchema = z
  .string()
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+].*)?$/, "a semantic version such as 1.2.3 or 1.2.3-rc.1");

export const uuidSchema = z.string().uuid();

/** The namespace/name pair almost every repository tool takes. */
export const agentRef = {
  namespace: handleSchema.describe("Owning user or org handle, the `ns` in ns/name."),
  name: agentNameSchema.describe("Agent name within the namespace."),
};

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Run a handler, turning anything it throws into a tool error the model can
 * act on. Errors this server raises already explain themselves; anything else
 * is a bug here, and says so rather than posing as an API failure.
 */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AgentryMcpError) return errorResult(err.toToolMessage());
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`agentry-mcp failed before reaching the registry: ${message}`);
  }
}

/** Render an API response with this server's configured budget. */
export function render(
  ctx: ToolContext,
  response: ApiResponse,
  options: Partial<RenderOptions> = {},
): CallToolResult {
  return textResult(
    renderResponse(response, { maxChars: ctx.config.maxResponseChars, ...options }),
  );
}
