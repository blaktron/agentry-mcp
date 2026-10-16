/**
 * Assembles the server: the found CLI, the driver, the tools. The
 * instructions block is what the host's model reads before its first call,
 * so it says what this server is (a driver of the person's CLI), what the
 * registry says about QuickAgents (scanned, N findings, signed — never
 * safe), and what is deliberately not here (login, publish).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CliOptions } from "./cli.js";
import { Driver } from "./driver.js";
import { registerAuthorTools } from "./tools/author.js";
import { registerReadTools } from "./tools/read.js";
import { registerRunTools } from "./tools/run.js";
import { registerSessionTools } from "./tools/session.js";
import { registerWriteTools } from "./tools/write.js";

export const SERVER_NAME = "agentry-mcp";
export const SERVER_VERSION = "0.6.13";

export function instructions(bin: string, cliVersion: string): string {
  return [
    `This server drives the agentry CLI installed on this machine (${bin}, agentry ${cliVersion}) ` +
      "so you can search a registry, read a QuickAgent's capability contract, verify a release and " +
      "check the machine. Every tool is one CLI command; every result is the CLI's own JSON in an " +
      "envelope with the exit class and the CLI's log.",
    "",
    "A QuickAgent is a reviewable package of instructions published as an immutable, " +
      "content-addressed release. The registry reports each release as scanned, with a finding " +
      "count, and signed or unsigned — never as safe. Say what the registry says. The capability " +
      "contract on agentry_info is what a run enforces; read it before you propose an install or a run.",
    "",
    "Installing and removing are two calls each: a preview that shows the person the contract (or " +
      "what would be removed) and returns a digest, then a confirm that carries that digest. The " +
      "digest is what makes the confirm valid — it is of exactly what the preview showed — so show " +
      "the person the contract before you confirm, and never confirm on their behalf. An unsigned " +
      "release needs the person's explicit acceptance as well.",
    "",
    "Running is the same two calls: the preview is the compiled run plan — what the run may reach " +
      "and which tools it is served — and the confirm runs it; the result names the receipts, which are " +
      "the record of what was enforced. A run that needs the machine prepared fails at agentry_doctor's " +
      "checks first; agentry_setup writes the provider (key NAME only) and pulls the images.",
    "",
    "An interactive session is the same consent, then agentry_session_start opens the QuickAgent's " +
      "session through the CLI's JSON-line protocol; agentry_session_send is one turn in and the reply out, as the " +
      "run's own events receipt recorded it; agentry_session_close ends it and names the transcript and " +
      "receipts. One session at a time.",
    "",
    "Authoring: agentry_draft, agentry_review, agentry_knowledge_build and agentry_voice_build use " +
      "two-call operation previews (not compiled plans). They fingerprint inputs, policy and built-in identities " +
      "before confirmation, then run the CLI built-ins with model/review/search charges as described. " +
      "Use agentry_builtins, agentry_knowledge_list and agentry_voice_status to inspect their state.",
    "",
    "Not here: signing in (the person runs `agentry login` in a terminal once; this server uses " +
      "that login) and publishing (`agentry publish` in a terminal, where the person sees the " +
      "pipeline's verdict).",
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
  /** The server's backstop past a run's own --timeout; tests shorten it. */
  runTimeoutSlackMs?: number;
}

export function createServer(opts: ServerOptions): { server: McpServer; driver: Driver } {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(opts.bin, opts.cliVersion) },
  );
  const driver = new Driver(server, opts.bin, opts.cli ?? {}, opts.runTimeoutSlackMs);
  registerAuthorTools(driver);
  registerReadTools(driver);
  registerWriteTools(driver);
  registerRunTools(driver);
  registerSessionTools(driver);
  return { server, driver };
}
