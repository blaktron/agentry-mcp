/**
 * Organization tools: create an org, read one, and manage its membership.
 *
 * Teams, policy overlays, SSO connections, SCIM tokens, webhooks, domain claims
 * and audit exports are all part of the org surface too, but they are
 * occasional administrative work rather than automation, so they stay in the
 * catalog behind agentry_search_actions instead of costing a tool schema each.
 */

import { z } from "zod";

import { guard, handleSchema, render, type ToolModule } from "./common.js";
import { registerTool } from "../toolargs.js";

export const orgTools: ToolModule = (server, ctx) => {
  registerTool(
    server,
    "agentry_create_org",
    {
      title: "Create an organization",
      description:
        "Create an org; the calling account becomes its owner. Pass idempotencyKey when retrying " +
        "so a repeat does not create a second org.",
      inputSchema: {
        handle: handleSchema.describe("Org handle; becomes the namespace for its agents."),
        displayName: z.string().max(120).describe("Human-readable org name."),
        idempotencyKey: z
          .string()
          .max(255)
          .optional()
          .describe("Retry key. The registry replays the first response for 24 hours."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ handle, displayName, idempotencyKey }) =>
      guard(async () =>
        render(
          ctx,
          await ctx.client.call("createOrg", {
            body: { handle, displayName },
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }),
        ),
      ),
  );

  registerTool(
    server,
    "agentry_get_org",
    {
      title: "Get an organization",
      description:
        "Org profile. Public fields for anyone; settings as well when the caller is an admin of it.",
      inputSchema: { org: handleSchema.describe("Org handle.") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ org }) =>
      guard(async () => render(ctx, await ctx.client.call("getOrg", { path: { org } }))),
  );

  registerTool(
    server,
    "agentry_list_org_members",
    {
      title: "List organization members",
      description: "Members of an org with their roles. Any member of the org can read this.",
      inputSchema: { org: handleSchema.describe("Org handle.") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ org }) =>
      guard(async () => render(ctx, await ctx.client.call("listOrgMembers", { path: { org } }))),
  );

  registerTool(
    server,
    "agentry_set_org_member",
    {
      title: "Add an org member or change a role",
      description:
        "Add a user to an org, or change the role of an existing member. Admins may set member and " +
        "security_reviewer; only owners may grant owner or admin. Roles rank owner > admin > " +
        "security_reviewer | member.",
      inputSchema: {
        org: handleSchema.describe("Org handle."),
        handle: handleSchema.describe("Account handle of the member."),
        role: z
          .enum(["owner", "admin", "security_reviewer", "member"])
          .describe("Role to set. Setting a role the caller cannot grant is refused with 403."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org, handle, role }) =>
      guard(async () =>
        render(
          ctx,
          await ctx.client.call("setOrgMember", { path: { org, handle }, body: { role } }),
          {
            note: `${handle} is now ${role} of ${org}.`,
          },
        ),
      ),
  );

  registerTool(
    server,
    "agentry_remove_org_member",
    {
      title: "Remove an org member",
      description:
        "Remove a member from an org. Admins may remove members; only owners may remove owners. " +
        "This revokes the access the membership carried, including to the org's private agents.",
      inputSchema: {
        org: handleSchema.describe("Org handle."),
        handle: handleSchema.describe("Account handle to remove."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ org, handle }) =>
      guard(async () =>
        render(ctx, await ctx.client.call("removeOrgMember", { path: { org, handle } }), {
          note: `Removed ${handle} from ${org}.`,
        }),
      ),
  );
};
