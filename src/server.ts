/**
 * Assembles the MCP server: configuration, one HTTP client, and the four tool
 * modules registered against it.
 *
 * The instructions block is worth its weight — it is the only place the model
 * learns the shape of the product (agents are repositories, versions are
 * immutable, publishing happens through the pipeline) before it starts calling
 * tools, which is what stops it from inventing a publish flow.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AgentryClient } from "./client.js";
import { ACTIONS, API_VERSION } from "./catalog.generated.js";
import { loadConfig, type Config } from "./config.js";
import { TOOL_MODULES } from "./tools/index.js";

export const SERVER_NAME = "agentry-mcp";
export const SERVER_VERSION = "0.1.0";

function instructions(config: Config): string {
  return [
    `Automation for an Agentry registry at ${config.registry}.`,
    "",
    "Agentry is a registry and git host for BriefAgents: reviewable packages of instructions " +
      "published as immutable, content-addressed, scanned and signed releases. An agent IS its " +
      "repository — creating one creates its hosted git repo, and its versions are the releases " +
      "cut from that repo.",
    "",
    "Things worth knowing before you call anything:",
    "- Versions are history. A published version is never deleted, only yanked; an agent with any " +
      "version cannot be deleted at all.",
    "- Publishing is not exposed here. Versions reach the registry by pushing a tag or by the CLI " +
      "uploading an archive it built, so that what is scanned is what was published. Do not try to " +
      "publish through the catalog tools.",
    "- Say what the registry says. It reports agents as scanned, with a finding count, and signed — " +
      "never as safe. Static scanning reduces risk; the manifest's capability contract is what the " +
      "runner enforces at run time.",
    "- Token minting and revocation, SSH keys, sessions and 2FA refuse personal access tokens " +
      "outright. Those tools will tell you when they need a browser session instead.",
    "- A 404 on an agent means either no such agent or one this credential cannot read. Do not " +
      "report it as proof the agent does not exist.",
    "",
    `Start with agentry_whoami if you do not yet know the account or its permissions. The dedicated ` +
      `tools cover account and repository work; agentry_search_actions reaches the rest of the ` +
      `${ACTIONS.length}-operation API (contract version ${API_VERSION}).`,
    config.readOnly ? "\nThis server is running read-only: every write will be refused." : "",
  ]
    .join("\n")
    .trim();
}

/**
 * @param fetchImpl injected only by tests, so the tool surface can be exercised
 * end to end without a registry to talk to.
 */
export function createServer(config: Config = loadConfig(), fetchImpl?: typeof fetch): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(config) },
  );

  const ctx = { client: new AgentryClient(config, fetchImpl), config };
  for (const register of TOOL_MODULES) register(server, ctx);

  return server;
}
