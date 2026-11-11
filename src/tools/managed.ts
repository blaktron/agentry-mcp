/**
 * The managed settings an organization's admins set for the person, as this
 * computer holds them: one read, and a refresh that reads them from the
 * registry again and then shows them. Changing them is an admin's act in
 * the organization's console and has no tool here.
 */

import { z } from "zod";

import { ArgumentError, flag } from "../argv.js";
import { runCli } from "../cli.js";
import { guard, type Driver } from "../driver.js";
import { toToolResult } from "../envelope.js";
import { registerTool } from "../toolargs.js";

const registry = z
  .string()
  .optional()
  .describe(
    "Registry base URL: one registry's managed settings alone (show), or the registry to ask (refresh; the CLI's default registry when omitted).",
  );

const NEEDS_CLI =
  "this agentry CLI has no managed settings; update the CLI to v0.7.35 or later " +
  "(https://secureagentry.net/download); the server never updates it for you";

const READ =
  "The CLI's JSON is passed through: `documents`, one per organization, each with its `registry`, " +
  "`organization`, `version`, `issuedAt` and `fetchedAt`, and its `settings`, each with its `id`, its `value`, " +
  "`locked` (true: the person cannot change it; false: the organization's default, which applies until the " +
  "person chooses otherwise), `known` (this version of Agentry knows the setting) and `applied` (this " +
  "computer's Agentry applies it); and `problems`, the copies that could not be verified. With CLI v0.7.55 or " +
  "later, `machine` names this computer's machine settings (where they were read, the `registry` they pin and the " +
  "organization `requireOrg` requires), their settings are the document whose `organization` is \"this computer's " +
  "administrator\" and whose `registry` is empty, and a problem with them has `machine` true; only this computer's " +
  "administrator changes them. When no run can " +
  "start (a copy that cannot be verified, or a locked setting this version does not know) the CLI exits 11: " +
  "the result then has exitClass `policy` and the CLI's reason in `log`, unchanged. Say who set a value and " +
  "whether it is locked or a default; do not guess a reason for it. ";

const ADMIN =
  "Changing managed settings is an admin's act in the organization's console; this server has no tool for it.";

export function registerManagedTools(d: Driver): void {
  registerTool(
    d.server,
    "agentry_managed_show",
    {
      description:
        "Read the managed settings the person's organization sets for them, as this computer holds them, with " +
        "agentry managed show --json (no registry is asked; agentry_managed_refresh asks). " +
        READ +
        ADMIN,
      inputSchema: { registry },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) =>
      guard("agentry_managed_show", async () => {
        if (!d.features.managedSettings) throw new ArgumentError(NEEDS_CLI);
        const argv = ["managed", "show", "--json"];
        flag(argv, "registry", a.registry);
        return d.run("agentry_managed_show", argv);
      }),
  );

  registerTool(
    d.server,
    "agentry_managed_refresh",
    {
      description:
        "Read the person's managed settings from the registry again (`agentry managed refresh`, which uses " +
        "the CLI's sign-in and keeps the verified answer in place of the copy this computer held), then " +
        "return them as agentry_managed_show does. A refresh the CLI refuses (not signed in, say) returns " +
        "the CLI's words and shows nothing. Refresh only when the person asked, or when a result suggests " +
        "the copy is stale. " +
        READ +
        ADMIN,
      inputSchema: { registry },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (a) =>
      guard("agentry_managed_refresh", async () => {
        if (!d.features.managedSettings) throw new ArgumentError(NEEDS_CLI);
        const refresh = ["managed", "refresh"];
        flag(refresh, "registry", a.registry);
        // refresh prints a line, not JSON: the exit code is the answer, and
        // what is held is read back as JSON.
        const changed = await runCli(d.bin, refresh, d.defaults);
        if (changed.spawnError || changed.code !== 0)
          return toToolResult("agentry_managed_refresh", changed);
        const show = ["managed", "show", "--json"];
        flag(show, "registry", a.registry);
        return d.run("agentry_managed_refresh", show);
      }),
  );
}
