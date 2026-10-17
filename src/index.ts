#!/usr/bin/env node
/**
 * stdio entry point. Nothing may reach stdout but MCP frames, so every
 * diagnostic goes to stderr; a missing or too-old CLI is reported and the
 * process exits non-zero rather than starting a server whose every tool
 * would fail the same way.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { checkCli, findCli, CliUnavailableError } from "./cli.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";
import { installShutdown } from "./session.js";
import { connectServer } from "./toolargs.js";

async function main(): Promise<void> {
  const bin = await findCli();
  const v = await checkCli(bin);
  const { server, driver } = createServer({ bin, cliVersion: v.raw });
  installShutdown(driver);
  await connectServer(server, new StdioServerTransport());
  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready: driving ${bin} (agentry ${v.raw}` +
      `${v.floorChecked ? "" : ", a dev build; the version floor is not checked"})\n`,
  );
}

main().catch((err: unknown) => {
  const message =
    err instanceof CliUnavailableError
      ? err.message
      : err instanceof Error
        ? (err.stack ?? err.message)
        : String(err);
  process.stderr.write(`${SERVER_NAME}: ${message}\n`);
  process.exit(1);
});
