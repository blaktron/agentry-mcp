/**
 * Agent (repository) tools.
 *
 * An Agentry agent *is* the repository: creating one creates its hosted git
 * repo, and its versions are the published releases cut from that repo. So the
 * repository automation surface is agent CRUD, the version history, the
 * per-agent grants that decide who may push or publish, and resolution of a
 * ns/name@range reference to a concrete version.
 *
 * Publishing itself is deliberately absent. A version is submitted by pushing a
 * tag or by uploading an archive through the CLI, which computes the digest and
 * carries the archive; wrapping `submitVersion` here would invite the model to
 * publish something it had not built.
 */

import { z } from "zod";

import {
  agentNameSchema,
  agentRef,
  guard,
  handleSchema,
  render,
  semverSchema,
  type ToolModule,
} from "./common.js";

export const agentTools: ToolModule = (server, ctx) => {
  server.registerTool(
    "agentry_search_agents",
    {
      title: "Search public agents",
      description:
        "Full-text search across public agents on the registry, with facets. Use this to discover " +
        "agents; use agentry_list_agents when you already know the namespace and want everything in it.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Free-text query over name, summary and description."),
        mode: z
          .enum(["autonomous", "interactive"])
          .optional()
          .describe("Only agents that support this run mode."),
        capability: z
          .string()
          .max(64)
          .optional()
          .describe("Restrict to agents declaring this capability, e.g. network or exec."),
        license: z.string().max(64).optional().describe("Restrict to an SPDX licence id."),
        verified: z.boolean().optional().describe("Restrict to agents from verified publishers."),
        sort: z
          .enum(["relevance", "installs", "newest"])
          .optional()
          .describe("Result ordering; relevance by default."),
        limit: z.number().int().min(1).max(100).optional().describe("Results per page, 1–100."),
        offset: z.number().int().min(0).optional().describe("Offset for paging through results."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, mode, capability, license, verified, sort, limit, offset }) =>
      guard(async () =>
        render(
          ctx,
          await ctx.client.call("searchAgents", {
            query: { q: query, mode, capability, license, verified, sort, limit, offset },
          }),
        ),
      ),
  );

  server.registerTool(
    "agentry_list_agents",
    {
      title: "List agents in a namespace",
      description:
        "Every agent in one namespace. Anyone sees the public ones; the private ones appear when " +
        "the credential can read them.",
      inputSchema: {
        namespace: handleSchema.describe("User or org handle whose agents to list."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ namespace }) =>
      guard(async () => render(ctx, await ctx.client.call("listAgents", { query: { namespace } }))),
  );

  server.registerTool(
    "agentry_get_agent",
    {
      title: "Get an agent",
      description:
        "Metadata for one agent: run modes, visibility, repository, latest version and quarantine state. " +
        "Set includeStats for star and install counts. A 404 means either no such agent or one you " +
        "cannot read — the registry does not distinguish them.",
      inputSchema: {
        ...agentRef,
        includeStats: z.boolean().default(false).describe("Also fetch star and install counts."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ namespace, name, includeStats }) =>
      guard(async () => {
        const path = { ns: namespace, name };
        const agent = await ctx.client.call("getAgent", { path });
        if (!includeStats) return render(ctx, agent);
        const stats = await ctx.client.call("getAgentStats", { path });
        return render(ctx, { ...agent, data: { agent: agent.data, stats: stats.data } });
      }),
  );

  server.registerTool(
    "agentry_create_agent",
    {
      title: "Create an agent and its repository",
      description:
        "Create an agent in a namespace, which also creates its hosted git repository. The " +
        "namespace must be the caller's own handle or an org they may publish in. Agents are " +
        "private unless visibility says otherwise.",
      inputSchema: {
        namespace: handleSchema.describe("Owning user or org handle."),
        name: agentNameSchema.describe("Agent name, unique within the namespace."),
        modes: z
          .array(z.enum(["autonomous", "interactive"]))
          .min(1)
          .describe(
            "Run modes the agent supports: autonomous (runs from its files and ends), interactive (a conversation with the same controls), or both. A publish later sets them from the manifest.",
          ),
        visibility: z
          .enum(["public", "private"])
          .optional()
          .describe("Private by default. Public agents are readable by anyone."),
        summary: z
          .string()
          .max(140)
          .optional()
          .describe("One-line description, at most 140 characters."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ namespace, name, modes, visibility, summary }) =>
      guard(async () =>
        render(
          ctx,
          await ctx.client.call("createAgent", {
            body: {
              namespace,
              name,
              modes,
              ...(visibility ? { visibility } : {}),
              ...(summary ? { summary } : {}),
            },
          }),
          { note: `Created ${namespace}/${name} and its git repository.` },
        ),
      ),
  );

  server.registerTool(
    "agentry_update_agent",
    {
      title: "Update agent settings",
      description:
        "Change an agent's summary, visibility, run modes, tag auto-publishing or force-push policy. Needs " +
        "maintain on the agent. Turning visibility from private to public exposes the repository " +
        "and every published version to anyone.",
      inputSchema: {
        ...agentRef,
        summary: z.string().max(140).optional().describe("New one-line description."),
        visibility: z.enum(["public", "private"]).optional().describe("New visibility."),
        autoPublishTags: z
          .boolean()
          .optional()
          .describe("Whether pushing a version tag submits that version to the pipeline."),
        allowForcePush: z
          .boolean()
          .optional()
          .describe("Allow non-fast-forward pushes to the default branch. Off by default."),
        modes: z
          .array(z.enum(["autonomous", "interactive"]))
          .min(1)
          .optional()
          .describe(
            "Replace the run modes the agent advertises (maintain only). Published versions keep the modes their own manifests declare.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ namespace, name, summary, visibility, autoPublishTags, allowForcePush, modes }) =>
      guard(async () => {
        const body: Record<string, unknown> = {};
        if (summary !== undefined) body.summary = summary;
        if (visibility !== undefined) body.visibility = visibility;
        if (autoPublishTags !== undefined) body.autoPublishTags = autoPublishTags;
        if (allowForcePush !== undefined) body.allowForcePush = allowForcePush;
        if (modes !== undefined) body.modes = modes;
        if (Object.keys(body).length === 0) {
          return render(ctx, await ctx.client.call("getAgent", { path: { ns: namespace, name } }), {
            note: "Nothing to change — no settings were given. Current state below.",
          });
        }
        return render(
          ctx,
          await ctx.client.call("updateAgent", { path: { ns: namespace, name }, body }),
        );
      }),
  );

  server.registerTool(
    "agentry_delete_agent",
    {
      title: "Delete an unpublished agent",
      description:
        "Delete an agent and its hosted repository. The registry refuses with 409 once the agent " +
        "has any version, published or still in the pipeline: published history is not deletable, " +
        "it is yanked. Needs maintain on the agent.",
      inputSchema: agentRef,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ namespace, name }) =>
      guard(async () =>
        render(ctx, await ctx.client.call("deleteAgent", { path: { ns: namespace, name } }), {
          note: `Deleted ${namespace}/${name} and its repository.`,
        }),
      ),
  );

  server.registerTool(
    "agentry_list_versions",
    {
      title: "List an agent's versions",
      description:
        "Version history newest first, with each version's pipeline state (submitted, scanning, " +
        "published, yanked, blocked) and archive identity.",
      inputSchema: agentRef,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ namespace, name }) =>
      guard(async () =>
        render(ctx, await ctx.client.call("listVersions", { path: { ns: namespace, name } })),
      ),
  );

  server.registerTool(
    "agentry_get_version",
    {
      title: "Get one version",
      description:
        "One version's state and archive identity. Set includeManifest for the agent manifest as " +
        "published — the capability contract the runner enforces.",
      inputSchema: {
        ...agentRef,
        version: semverSchema.describe("Exact version, e.g. 1.4.0."),
        includeManifest: z.boolean().default(false).describe("Also fetch the published manifest."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ namespace, name, version, includeManifest }) =>
      guard(async () => {
        const path = { ns: namespace, name, version };
        const info = await ctx.client.call("getVersionInfo", { path });
        if (!includeManifest) return render(ctx, info);
        const manifest = await ctx.client.call("getVersionManifest", { path });
        return render(ctx, { ...info, data: { version: info.data, manifest: manifest.data } });
      }),
  );

  server.registerTool(
    "agentry_yank_version",
    {
      title: "Yank a published version",
      description:
        "Yank a published version: it stays resolvable for anyone who already pinned it, and stops " +
        "being selected for new installs. This is the published-history counterpart of deletion and " +
        "cannot be undone through this server. Needs publish permission.",
      inputSchema: {
        ...agentRef,
        version: semverSchema.describe("Version to yank."),
        reason: z
          .string()
          .max(500)
          .describe("Why it is being yanked. Recorded and shown to consumers."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ namespace, name, version, reason }) =>
      guard(async () =>
        render(
          ctx,
          await ctx.client.call("yankVersion", {
            path: { ns: namespace, name, version },
            body: { reason },
          }),
          { note: `Yanked ${namespace}/${name}@${version}.` },
        ),
      ),
  );

  server.registerTool(
    "agentry_list_grants",
    {
      title: "List per-agent grants",
      description:
        "Explicit user and team grants on an agent, over and above what org membership gives. " +
        "Needs maintain on the agent.",
      inputSchema: agentRef,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ namespace, name }) =>
      guard(async () =>
        render(ctx, await ctx.client.call("listAgentGrants", { path: { ns: namespace, name } })),
      ),
  );

  server.registerTool(
    "agentry_set_grant",
    {
      title: "Grant or revoke per-agent access",
      description:
        "Give a user or an org team a role on one agent, or revoke it by passing role: none. Roles " +
        "rank read < write < maintain < publish. Team grants only apply to agents in an org " +
        "namespace. Needs maintain on the agent.",
      inputSchema: {
        ...agentRef,
        subjectType: z
          .enum(["user", "team"])
          .describe("Whether subject names an account or an org team."),
        subject: handleSchema.describe("Account handle, or team slug within the agent's org."),
        role: z
          .enum(["read", "write", "maintain", "publish", "none"])
          .describe("Role to set; none removes the grant."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ namespace, name, subjectType, subject, role }) =>
      guard(async () => {
        const base = { ns: namespace, name };
        const isUser = subjectType === "user";
        if (role === "none") {
          const op = isUser ? "removeAgentUserGrant" : "removeAgentTeamGrant";
          const path = isUser ? { ...base, handle: subject } : { ...base, team: subject };
          return render(ctx, await ctx.client.call(op, { path }), {
            note: `Removed the ${subjectType} grant for ${subject} on ${namespace}/${name}.`,
          });
        }
        const op = isUser ? "setAgentUserGrant" : "setAgentTeamGrant";
        const path = isUser ? { ...base, handle: subject } : { ...base, team: subject };
        return render(ctx, await ctx.client.call(op, { path, body: { role } }), {
          note: `${subjectType} ${subject} now has ${role} on ${namespace}/${name}.`,
        });
      }),
  );

  server.registerTool(
    "agentry_resolve",
    {
      title: "Resolve an agent reference",
      description:
        'Resolve a reference such as "acme/linter@^1.2" to the concrete version the registry would ' +
        "install, honouring yanks and the release channel. Use this before pinning a version in a " +
        "manifest or a deployment.",
      inputSchema: {
        ref: z.string().describe('Reference to resolve, e.g. "acme/linter@^1.2" or "acme/linter".'),
        channel: z
          .enum(["stable", "beta"])
          .optional()
          .describe("Release channel; stable when omitted."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ ref, channel }) =>
      guard(async () =>
        render(ctx, await ctx.client.call("resolveRef", { query: { ref, channel } })),
      ),
  );
};
