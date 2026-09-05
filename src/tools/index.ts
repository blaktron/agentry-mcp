import type { ToolModule } from "./common.js";
import { accountTools } from "./account.js";
import { agentTools } from "./agents.js";
import { catalogTools } from "./catalog.js";
import { orgTools } from "./orgs.js";

/**
 * Registration order is the order the tools are listed to the client, so the
 * identity tools come first: agentry_whoami is the right opening move when a
 * session does not yet know which account or registry it is working against.
 */
export const TOOL_MODULES: readonly ToolModule[] = [
  accountTools,
  orgTools,
  agentTools,
  catalogTools,
];

export type { ToolContext, ToolModule } from "./common.js";
