/**
 * Assembles the server: the found CLI, the driver, the tools. The
 * instructions block is what the host's model reads before its first call,
 * so it says what this server is (a driver of the person's CLI), what the
 * registry says about BriefAgents (scanned, N findings, signed — never
 * safe), and what is deliberately not here (login, publish).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CliOptions } from "./cli.js";
import { Driver } from "./driver.js";
import { registerReadTools } from "./tools/read.js";

export const SERVER_NAME = "agentry-mcp";
export const SERVER_VERSION = "0.2.0";

export function instructions(bin: string, cliVersion: string): string {
  return [
    `This server drives the agentry CLI installed on this machine (${bin}, agentry ${cliVersion}) ` +
      "so you can search a registry, read a BriefAgent's capability contract, verify a release and " +
      "check the machine. Every tool is one CLI command; every result is the CLI's own JSON in an " +
      "envelope with the exit class and the CLI's log.",
    "",
    "A BriefAgent is a reviewable package of instructions published as an immutable, " +
      "content-addressed release. The registry reports each release as scanned, with a finding " +
      "count, and signed or unsigned — never as safe. Say what the registry says. The capability " +
      "contract on agentry_info is what a run enforces; read it before you propose an install or a run.",
    "",
    "Not here: signing in (the person runs `agentry login` in a terminal once; this server uses " +
      "that login) and publishing (`agentry publish` in a terminal, where the person sees the " +
      "pipeline's verdict). Installing, running and managing BriefAgents arrive in later versions " +
      "of this server, each behind the CLI's own consent.",
    "",
    "Start with agentry_doctor if a run or install is the goal: it says what this machine lacks.",
  ].join("\n");
}

export interface ServerOptions {
  /** The resolved CLI path. */
  bin: string;
  /** What `agentry --version` reported, for the instructions. */
  cliVersion: string;
  /** Per-invocation defaults (timeouts, cwd), mostly for tests. */
  cli?: CliOptions;
}

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(opts.bin, opts.cliVersion) },
  );
  const driver = new Driver(server, opts.bin, opts.cli ?? {});
  registerReadTools(driver);
  return server;
}
