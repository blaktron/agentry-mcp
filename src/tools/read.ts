/**
 * The four read-only tools: each one `agentry <cmd> --json`, the
 * result the CLI's own JSON in the envelope. Their descriptions are what the
 * host's model reads before calling, so they say what the registry says —
 * scanned, N findings, signed or unsigned — and never more.
 */

import { z } from "zod";

import { bool, flag, value } from "../argv.js";
import { guard, type Driver } from "../driver.js";

const registry = z
  .string()
  .optional()
  .describe(
    "Registry base URL; the CLI's configured default when omitted (the one the person logged in to).",
  );

const readOnly = { readOnlyHint: true, openWorldHint: true };

export function registerReadTools(d: Driver): void {
  for (const [name, command, description] of [
    [
      "agentry_whoami",
      ["whoami"],
      "Read the signed-in account and tier with agentry whoami --json; signing in stays in a terminal.",
    ],
    [
      "agentry_builtins",
      ["builtins"],
      "List the CLI's embedded packages and archive digests with agentry builtins --json.",
    ],
    [
      "agentry_voice_status",
      ["voice", "status"],
      "Read the local and account Writing Voice metadata and review with agentry voice status --json.",
    ],
  ] as const) {
    d.server.registerTool(
      name,
      { description, inputSchema: { registry }, annotations: readOnly },
      (a) =>
        guard(name, async () => {
          const argv = [...command, "--json"];
          flag(argv, "registry", a.registry);
          return d.run(name, argv);
        }),
    );
  }
  d.server.registerTool(
    "agentry_knowledge_list",
    {
      description:
        "List local knowledge packs, or an organization's shared packs, with agentry knowledge list --json. Returns metadata, not decrypted pages.",
      inputSchema: { org: z.string().optional(), registry },
      annotations: readOnly,
    },
    (a) =>
      guard("agentry_knowledge_list", async () => {
        const argv = ["knowledge", "list", "--json"];
        flag(argv, "org", a.org);
        flag(argv, "registry", a.registry);
        return d.run("agentry_knowledge_list", argv);
      }),
  );

  d.server.registerTool(
    "agentry_search",
    {
      description:
        "Search a registry's public QuickAgents with the installed agentry CLI (`agentry search --json`). " +
        "Returns the CLI's JSON: results (namespace, name, modes, summary, installs30d, quarantineState), " +
        "facets and total. Every result is a published, scanned release; the report card is on agentry_info.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Free text over names, summaries and READMEs; a namespace handle also matches.",
          ),
        mode: z
          .enum(["autonomous", "interactive"])
          .optional()
          .describe("Only QuickAgents supporting this run mode."),
        capability: z
          .enum(["network", "filesystem", "exec", "secrets", "dataAccess"])
          .optional()
          .describe("Only QuickAgents whose latest version asks for this capability."),
        license: z
          .string()
          .optional()
          .describe("SPDX identifier of the latest published manifest."),
        verified: z.boolean().optional().describe("Only org namespaces with a verified domain."),
        sort: z.enum(["relevance", "installs", "newest"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        registry,
      },
      annotations: readOnly,
    },
    (a) =>
      guard("agentry_search", async () => {
        const argv = ["search", value("query", a.query), "--json"];
        flag(argv, "mode", a.mode);
        flag(argv, "capability", a.capability);
        flag(argv, "license", a.license);
        bool(argv, "verified", a.verified);
        flag(argv, "sort", a.sort);
        flag(argv, "limit", a.limit);
        flag(argv, "registry", a.registry);
        return d.run("agentry_search", argv);
      }),
  );

  d.server.registerTool(
    "agentry_info",
    {
      description:
        "Read one QuickAgent with the installed agentry CLI (`agentry info --json`): the agent, its latest " +
        "published version and that version's capability contract — what it declares it needs (network hosts, " +
        "filesystem, exec, secrets, declared MCP servers) — and whether that version carries an attestation " +
        "(signed or unsigned). The finding count is on the registry's report card, not here. Read this before " +
        "installing or running; the contract is what a run enforces.",
      inputSchema: {
        ref: z
          .string()
          .describe(
            "namespace/name, optionally @version (for example agentry/pr-review-brief or agentry/pr-review-brief@1.2.1).",
          ),
        registry,
      },
      annotations: readOnly,
    },
    (a) =>
      guard("agentry_info", async () => {
        const argv = ["info", value("ref", a.ref), "--json"];
        flag(argv, "registry", a.registry);
        return d.run("agentry_info", argv);
      }),
  );

  d.server.registerTool(
    "agentry_verify",
    {
      description:
        "Verify a published version with the installed agentry CLI (`agentry verify --json`): the archive digest " +
        "the registry recorded against the one computed from the download, and the attestation's verdict " +
        "(verified, unverifiable, or failed, with the reason). A verdict says who signed what; it does not " +
        "judge the contents.",
      inputSchema: {
        ref: z.string().describe("namespace/name@version."),
        strict: z
          .boolean()
          .optional()
          .describe(
            "Also fail when the attestation could not be checked (key fetch failure, key rotation).",
          ),
        registry,
      },
      annotations: readOnly,
    },
    (a) =>
      guard("agentry_verify", async () => {
        const argv = ["verify", value("ref", a.ref), "--json"];
        bool(argv, "strict", a.strict);
        flag(argv, "registry", a.registry);
        return d.run("agentry_verify", argv);
      }),
  );

  d.server.registerTool(
    "agentry_doctor",
    {
      description:
        "Check this machine for QuickAgent runs with the installed agentry CLI (`agentry doctor --json`): the " +
        "runner policy, the model provider and whether its key NAME is set (values are never printed), the " +
        "docker engine, the gateway and runner images, the exec catalog, and optionally one QuickAgent's " +
        "requirements or one harness adapter's installation. Call this first; it says what a run would fail on. " +
        'When a check fails the report still comes back, with exitClass "cli" beside it.',
      inputSchema: {
        ref: z
          .string()
          .optional()
          .describe(
            "Also check one QuickAgent's requirements against this machine (namespace/name[@version]).",
          ),
        local: z
          .string()
          .optional()
          .describe("Check a local QuickAgent directory instead of a registry ref."),
        adapter: z
          .string()
          .optional()
          .describe("Also check this harness adapter's installation (for example claude)."),
        policy: z
          .string()
          .optional()
          .describe("Operator policy file; the default is ~/.agentry/runner/policy.yaml."),
        registry,
      },
      annotations: readOnly,
    },
    (a) =>
      guard("agentry_doctor", async () => {
        const argv = ["doctor"];
        if (a.ref !== undefined) argv.push(value("ref", a.ref));
        argv.push("--json");
        flag(argv, "local", a.local);
        flag(argv, "adapter", a.adapter);
        flag(argv, "policy", a.policy);
        flag(argv, "registry", a.registry);
        return d.run("agentry_doctor", argv);
      }),
  );
}
