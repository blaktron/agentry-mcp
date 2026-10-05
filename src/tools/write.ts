/**
 * The writing tools (M3): install and uninstall behind the two-call consent
 * of src/consent.ts, and the install list. The descriptions tell the model,
 * in the imperative, to show the person the contract before confirming;
 * the digest, not the description, is what stops a confirm the person did
 * not see.
 */

import { z } from "zod";

import { install, uninstall } from "../consent.js";
import { guard, type Driver } from "../driver.js";

const registry = z
  .string()
  .optional()
  .describe("Registry base URL; the CLI's configured default when omitted.");

export function registerWriteTools(d: Driver): void {
  d.server.registerTool(
    "agentry_install",
    {
      description:
        "Install a QuickAgent for an agent application with the installed agentry CLI, in two calls. " +
        "Without `confirm`: a preview (`agentry install --plan --json`) — the resolved version, the capability " +
        "contract, the diff against what this machine accepted before, the attestation verdict, the " +
        "refusal an install would meet, the target and directory — plus `digest`; nothing is written. Show the " +
        "person the contract and the directory, and only when they agree call again with `confirm` set to that " +
        "digest: the server re-runs the preview, refuses if anything changed, and then installs. An unsigned " +
        "release also needs `acceptUnsigned: true` on the confirm call, and an unscanned one (admitted without a scan) " +
        "`acceptUnscanned: true`; pass either only if the person said so. " +
        "The default install goes into the runner home; a requested embedded install is a Claude skill under ~/.claude/skills/<name>, or agents-md under " +
        "./agents/<name> with AGENTS.md updated.",
      inputSchema: {
        ref: z
          .string()
          .optional()
          .describe("namespace/name, optionally @version or @range; omit when local is given."),
        local: z
          .string()
          .optional()
          .describe(
            "Unpublished QuickAgent directory to install into the runner home; requires acceptUnsigned.",
          ),
        target: z
          .enum(["runner", "claude-skill", "agents-md"])
          .optional()
          .describe("The install target; runner when omitted."),
        provider: z
          .enum(["claude", "codex", "openclaw"])
          .optional()
          .describe("The agent application to install for (picks the target)."),
        dir: z
          .string()
          .optional()
          .describe(
            "Override the target directory; a directory the person named is merged into, never cleared.",
          ),
        registry,
        confirm: z
          .string()
          .optional()
          .describe("The `digest` a preview of this exact call returned. Omit to preview."),
        acceptUnsigned: z
          .boolean()
          .optional()
          .describe(
            "Only with `confirm`, only for a release the preview reported as unsigned, and only if the person accepted that.",
          ),
        acceptUnscanned: z
          .boolean()
          .optional()
          .describe(
            "Only with `confirm`, only for a release the preview reported as unscanned (admitted without a scan), and only if the person accepted that nothing about its contents was checked.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (a) => guard("agentry_install", () => install(d, a)),
  );

  d.server.registerTool(
    "agentry_uninstall",
    {
      description:
        "Remove a QuickAgent's runner install from this machine with the installed agentry CLI, in two calls: " +
        "without `confirm`, a preview (`agentry uninstall --plan --json`) of the install cache directories, the MCP " +
        "profiles (stored keys and installed servers) and the consent record that would go, plus `digest`; with " +
        "`confirm` set to that digest, the removal. Show the person what would be removed before confirming. " +
        "Embedded installs (Claude skills, AGENTS.md sections) are separate state and are not touched.",
      inputSchema: {
        ref: z.string().describe("namespace/name, optionally @version."),
        keepMcp: z
          .boolean()
          .optional()
          .describe(
            "Keep the MCP profile (keys, identities, installed servers) for a same-digest reinstall.",
          ),
        confirm: z
          .string()
          .optional()
          .describe("The `digest` a preview of this exact call returned. Omit to preview."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (a) => guard("agentry_uninstall", () => uninstall(d, a)),
  );

  d.server.registerTool(
    "agentry_list_installed",
    {
      description:
        "List this machine's install records with the installed agentry CLI (`agentry list --json`): every " +
        "record `install` and `run` wrote — registry, namespace, name, target, directory, version, the accepted " +
        "capabilities — each with `present`: whether its directory still exists. A record whose directory is gone " +
        "is still a record; nothing here prunes it. Records with target `runner` are run consents, not installs.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guard("agentry_list_installed", async () => {
        return d.run("agentry_list_installed", ["list", "--json"]);
      }),
  );
}
