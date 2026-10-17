#!/usr/bin/env node
/**
 * stdio entry point.
 *
 * Nothing may be written to stdout but MCP frames, so every diagnostic goes to
 * stderr. A configuration failure is reported and exits non-zero rather than
 * starting a server whose every tool would fail the same way.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { AgentryMcpError } from "./errors.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";
import { connectServer } from "./toolargs.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);

  await connectServer(server, new StdioServerTransport());

  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready: ${config.registry} ` +
      `(credential: ${config.credentialSource}${config.readOnly ? ", read-only" : ""})\n`,
  );
}

main().catch((err: unknown) => {
  const message =
    err instanceof AgentryMcpError
      ? err.toToolMessage()
      : err instanceof Error
        ? (err.stack ?? err.message)
        : String(err);
  process.stderr.write(`${SERVER_NAME}: ${message}\n`);
  process.exit(1);
});
