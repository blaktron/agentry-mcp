/**
 * Account tools: who the credential belongs to, the profile, and the three
 * credential surfaces an operator actually automates — personal access tokens,
 * SSH keys for the git transport, and browser sessions.
 *
 * Several of these are session-only routes (the API refuses PATs on them
 * whatever their scopes). They are registered anyway, with that fact in the
 * description, because a tool that explains the constraint is more useful than
 * a missing tool the model works around by guessing.
 */

import { z } from "zod";

import { ACTIONS } from "../catalog.generated.js";
import { guard, render, textResult, uuidSchema, type ToolModule } from "./common.js";

const SESSION_NOTE =
  "Session-only: the API refuses personal access tokens here, so this needs AGENTRY_SESSION_COOKIE.";

export const accountTools: ToolModule = (server, ctx) => {
  server.registerTool(
    "agentry_whoami",
    {
      title: "Who am I on Agentry",
      description:
        "The account the configured credential belongs to, the registry it points at, and that " +
        "server's version and feature flags. Start here when a call fails with 401 or 403, or " +
        "when you need the caller's own handle to build a namespace.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const meta = await ctx.client.call("getMeta");
        const lines = [
          `Registry: ${ctx.config.registry}`,
          `Credential: ${ctx.config.credentialSource}${ctx.client.usesSession ? " (browser session)" : ""}`,
          ctx.config.readOnly ? "Mode: read-only (writes are refused)" : "Mode: read-write",
          `Catalog: ${ACTIONS.length} API operations, contract version ${meta.data && typeof meta.data === "object" && "version" in meta.data ? String((meta.data as { version?: unknown }).version) : "unknown"}`,
        ];

        if (ctx.config.credentialSource === "none") {
          return textResult(
            `${lines.join("\n")}\n\nNot authenticated — only public endpoints will answer. ` +
              `Set AGENTRY_TOKEN or run \`agentry login\`.`,
          );
        }

        const user = await ctx.client.call("getCurrentUser");
        return render(ctx, user, { note: lines.join("\n") });
      }),
  );

  server.registerTool(
    "agentry_update_profile",
    {
      title: "Update my Agentry profile",
      description: "Change the display name on the authenticated account.",
      inputSchema: {
        displayName: z.string().max(120).describe("New display name, at most 120 characters."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ displayName }) =>
      guard(async () =>
        render(ctx, await ctx.client.call("updateCurrentUser", { body: { displayName } })),
      ),
  );

  server.registerTool(
    "agentry_list_tokens",
    {
      title: "List my personal access tokens",
      description:
        "Metadata for every PAT on the account — id, name, scopes, expiry, last use. Secrets are " +
        "never returned by the registry after minting. Use the ids here with agentry_revoke_token.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => guard(async () => render(ctx, await ctx.client.call("listTokens"))),
  );

  server.registerTool(
    "agentry_create_token",
    {
      title: "Mint a personal access token",
      description:
        "Mint a PAT with the given scopes. The secret is returned by the registry exactly once and " +
        "is redacted from the tool result by default — pass revealSecret only when the operator has " +
        `asked for the value itself. ${SESSION_NOTE}`,
      inputSchema: {
        name: z.string().max(120).describe("Label for the token, shown in the token list."),
        scopes: z
          .array(
            z.enum([
              "repo:read",
              "repo:write",
              "agent:publish",
              "agent:read",
              "org:admin",
              "review:act",
              "audit:read",
              "user:profile",
            ]),
          )
          .min(1)
          .describe("Scopes to grant. Grant the narrowest set the job needs."),
        expiresAt: z
          .string()
          .optional()
          .describe(
            "RFC 3339 expiry. Defaults to, and is capped at, the registry's maximum lifetime.",
          ),
        orgHandle: z
          .string()
          .optional()
          .describe(
            "Bind the token to this org. Requires an SSO-fresh session; org-bound tokens are capped at 90 days.",
          ),
        revealSecret: z
          .boolean()
          .default(false)
          .describe(
            "Print the token secret in the result instead of redacting it. Off by default.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, scopes, expiresAt, orgHandle, revealSecret }) =>
      guard(async () => {
        const response = await ctx.client.call("createToken", {
          body: {
            name,
            scopes,
            ...(expiresAt ? { expiresAt } : {}),
            ...(orgHandle ? { orgHandle } : {}),
          },
        });
        return render(ctx, response, {
          reveal: revealSecret,
          note: revealSecret
            ? "Token minted. The secret below is shown once and is now in this transcript — treat the transcript as a credential."
            : "Token minted. The secret is redacted; the registry will not show it again. Re-run with revealSecret: true if the operator needs the value.",
        });
      }),
  );

  server.registerTool(
    "agentry_revoke_token",
    {
      title: "Revoke a personal access token",
      description: `Revoke a PAT immediately by id, from agentry_list_tokens. ${SESSION_NOTE}`,
      inputSchema: {
        tokenId: uuidSchema.describe("Token id from agentry_list_tokens."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ tokenId }) =>
      guard(async () =>
        render(ctx, await ctx.client.call("revokeToken", { path: { tokenId } }), {
          note: `Revoked token ${tokenId}.`,
        }),
      ),
  );

  server.registerTool(
    "agentry_list_ssh_keys",
    {
      title: "List my SSH keys",
      description:
        "SSH public keys registered for the git transport (ssh://git@…/ns/name.git), with their ids.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => guard(async () => render(ctx, await ctx.client.call("listSshKeys"))),
  );

  server.registerTool(
    "agentry_add_ssh_key",
    {
      title: "Register an SSH key",
      description: `Register an SSH public key for pushing to hosted agent repositories. ${SESSION_NOTE}`,
      inputSchema: {
        title: z.string().max(120).describe("Label for the key."),
        publicKey: z
          .string()
          .describe(
            'One authorized_keys line, e.g. "ssh-ed25519 AAAA… comment". Public half only.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, publicKey }) =>
      guard(async () =>
        render(ctx, await ctx.client.call("addSshKey", { body: { title, publicKey } })),
      ),
  );

  server.registerTool(
    "agentry_remove_ssh_key",
    {
      title: "Remove an SSH key",
      description: `Remove a registered SSH public key by id. ${SESSION_NOTE}`,
      inputSchema: { keyId: uuidSchema.describe("Key id from agentry_list_ssh_keys.") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ keyId }) =>
      guard(async () =>
        render(ctx, await ctx.client.call("removeSshKey", { path: { keyId } }), {
          note: `Removed SSH key ${keyId}.`,
        }),
      ),
  );

  server.registerTool(
    "agentry_list_sessions",
    {
      title: "List my browser sessions",
      description:
        "Active browser sessions on the account, with their ids, for review or revocation.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => guard(async () => render(ctx, await ctx.client.call("listUserSessions"))),
  );

  server.registerTool(
    "agentry_revoke_session",
    {
      title: "Revoke browser sessions",
      description:
        "Revoke one browser session by id, or every session except the calling one " +
        `("sign out everywhere else"). ${SESSION_NOTE}`,
      inputSchema: {
        sessionId: uuidSchema
          .optional()
          .describe("Session to revoke, from agentry_list_sessions. Omit to revoke all others."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ sessionId }) =>
      guard(async () =>
        sessionId
          ? render(ctx, await ctx.client.call("revokeUserSession", { path: { sessionId } }), {
              note: `Revoked session ${sessionId}.`,
            })
          : render(ctx, await ctx.client.call("revokeOtherUserSessions"), {
              note: "Revoked every session except this one.",
            }),
      ),
  );
};
