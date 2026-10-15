/**
 * Driver: one found CLI and one way to run it. Tools register themselves on
 * the server with the SDK's own shape and wrap their handler in `guard`, so
 * an ArgumentError (a value that looks like a flag, an empty ref) becomes a
 * tool error rather than a crash.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ArgumentError } from "./argv.js";
import { runCli, type CliOptions } from "./cli.js";
import { toToolResult } from "./envelope.js";
import type { ProtocolSession } from "./session.js";

/**
 * The one interactive session a server holds at a time: the open one,
 * or a reservation while a start is between its consent and its spawn.
 */
export interface SessionSlot {
  current?: ProtocolSession;
  reserved: boolean;
}

export class Driver {
  constructor(
    readonly server: McpServer,
    readonly bin: string,
    private readonly defaults: CliOptions = {},
    /**
     * How long past a run's own --timeout the server waits before SIGINT:
     * the CLI's budget is what should end a run, the server's limit is the
     * backstop. Tests shorten it.
     */
    readonly runTimeoutSlackMs = 30_000,
  ) {}

  readonly sessions: SessionSlot = { reserved: false };

  /** The extra environment and working directory every CLI process gets (including the session protocol process). */
  get env(): Record<string, string> | undefined {
    return this.defaults.env;
  }
  get cwd(): string | undefined {
    return this.defaults.cwd;
  }

  /** Runs `agentry argv…` and returns the envelope or the error. */
  async run(what: string, argv: string[], opts: CliOptions = {}): Promise<CallToolResult> {
    const r = await runCli(this.bin, argv, { ...this.defaults, ...opts });
    return toToolResult(what, r);
  }
}

/** Runs a handler; an ArgumentError is the tool's answer, not the server's crash. */
export async function guard(
  name: string,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ArgumentError) {
      return { content: [{ type: "text", text: `${name}: ${err.message}` }], isError: true };
    }
    throw err;
  }
}
