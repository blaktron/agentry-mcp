/** Built-in authoring runs have no CLI --plan: preview the operation explicitly. */
import { z } from "zod";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { access } from "node:fs/promises";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { ArgumentError, flag, value } from "../argv.js";
import { confirmed, isConsent, previewText, runPlan } from "../consent.js";
import { guard, type Driver } from "../driver.js";
import { fingerprint, localPackPaths } from "../snapshot.js";
import { progressSink, TEARDOWN_GRACE_MS } from "../run.js";
import { registerTool } from "../toolargs.js";

const common = {
  out: z.string().describe("Output directory for this operation's report and receipts."),
  policy: z.string().optional(),
  registry: z.string().optional(),
  timeoutSeconds: z.number().int().min(1).max(86400).default(1800),
  maxTurns: z.number().int().min(0).optional(),
  maxCost: z.number().min(0).optional(),
  confirm: z
    .string()
    .optional()
    .describe("Omit to preview the operation; after agreement, repeat with its digest."),
};
const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type Common = z.infer<z.ZodObject<typeof common>>;

/** What a build fetches before the run: each repository or address, and the one host it reaches. */
interface Fetch {
  kind: "repository" | "url";
  /** The address as given, its query shown as "?…" (it can carry a signed download's credential). */
  address: string;
  /** The host the fetch reaches, with its port when one is named. */
  host: string;
}

/**
 * The fetches a build makes, for its consent facts. Each is held to what the
 * CLI takes before anything runs: https, a host, and no user information,
 * which would be a credential in the address. A repository's ref after @
 * is cut from its path alone; an address has none.
 */
function fetches(repos?: string[], urls?: string[]): Fetch[] {
  const parse = (kind: Fetch["kind"], raw: string): Fetch => {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      throw new ArgumentError(
        `${kind === "repository" ? "repos" : "urls"}: ${JSON.stringify(raw)} is not an address`,
      );
    }
    if (u.protocol !== "https:" || !u.hostname)
      throw new ArgumentError(
        `${kind === "repository" ? "repos" : "urls"}: an address must be https with a host`,
      );
    if (u.username || u.password)
      throw new ArgumentError(
        `${kind === "repository" ? "repos" : "urls"}: an address must not carry a user or a password; a private repository uses the token saved for its host in a terminal`,
      );
    const shown = u.search ? raw.trim().slice(0, raw.trim().indexOf("?")) + "?…" : raw.trim();
    return { kind, address: shown, host: u.host.toLowerCase() };
  };
  return [
    ...(repos ?? []).map((r) => parse("repository", r)),
    ...(urls ?? []).map((u) => parse("url", u)),
  ];
}

/** The consent facts of what a build fetches, and the review a voice's pages get. */
interface SourceFacts {
  fetches?: Fetch[];
  review?: string;
}

/** The review a voice's pages get before the Voice Writer reads them. */
const VOICE_PAGE_REVIEW =
  "every page is read by AI Review with the person's own TypeSafe key before the Voice Writer reads it; without the key the CLI refuses the addresses";

async function execute(
  d: Driver,
  tool: string,
  a: Common,
  argv: string[],
  paths: string[],
  extra: Extra,
  sourceFacts: SourceFacts = {},
) {
  flag(argv, "out", a.out);
  flag(argv, "policy", a.policy);
  flag(argv, "registry", a.registry);
  flag(argv, "timeout", a.timeoutSeconds);
  flag(argv, "max-turns", a.maxTurns);
  flag(argv, "max-cost", a.maxCost);
  // Built-in identity and mutable account/local store metadata are re-read at confirm.
  const metadataArgv = (command: string[]) => {
    const argv = [...command, "--json"];
    flag(argv, "registry", a.registry);
    return argv;
  };
  const builtins = await runPlan<unknown>(d, tool, metadataArgv(["builtins"]));
  if (!builtins.ok) return builtins.result;
  const packs = await runPlan<unknown>(d, tool, metadataArgv(["knowledge", "list"]));
  if (!packs.ok) return packs.result;
  const voice = await runPlan<unknown>(d, tool, metadataArgv(["voice", "status"]));
  if (!voice.ok) return voice.result;
  const policy =
    a.policy ??
    join(
      d.env?.AGENTRY_RUNNER_HOME ??
        process.env.AGENTRY_RUNNER_HOME ??
        join(d.env?.HOME ?? process.env.HOME ?? homedir(), ".agentry", "runner"),
      "policy.yaml",
    );
  let policyDigest: string | null = null;
  try {
    await access(resolve(d.cwd ?? process.cwd(), policy));
    policyDigest = await fingerprint(policy, d.cwd);
  } catch (err) {
    if (a.policy || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const inputs = [];
  for (const path of paths) inputs.push({ path, digest: await fingerprint(path, d.cwd) });
  const facts = {
    tool,
    argv,
    inputs,
    policyDigest,
    builtins: builtins.plan,
    packs: packs.plan,
    voice: voice.plan,
    ...(sourceFacts.fetches?.length ? { fetches: sourceFacts.fetches } : {}),
    ...(sourceFacts.review ? { review: sourceFacts.review } : {}),
  };
  if (a.confirm === undefined)
    return previewText(
      {
        operation: facts,
        writes: false,
        note: "Operation preview, not a compiled CLI run plan. The CLI's embedded built-in runs with the named inputs and policy, uses the person's model and review keys, and can incur model/search charges. Review the input paths, web choice, output and budgets before confirming.",
      },
      facts,
    );
  const consent = await confirmed(d.server, tool, a.confirm, facts, {
    unsigned: false,
    ask: `Execute ${tool}? Inputs: ${paths.join(", ") || "text in the operation"}.${sourceFacts.fetches?.length ? ` Fetched first: ${sourceFacts.fetches.map((f) => f.address).join(", ")}.` : ""} Output: ${a.out}. Budget: ${a.timeoutSeconds}s. Model and review/search charges may apply.`,
  });
  if (!isConsent(consent)) return consent;
  // These commands have no terminal capability gate and take no bypass flags.
  return d.run(tool, argv, {
    timeoutMs: a.timeoutSeconds * 1000 + d.runTimeoutSlackMs,
    graceMs: TEARDOWN_GRACE_MS,
    onStderrLine: progressSink(extra),
  });
}

export function registerAuthorTools(d: Driver): void {
  registerTool(
    d.server,
    "agentry_draft",
    {
      description:
        "Draft or revise a QuickAgent with agentry draft --output-format json (the Drafter). Two calls: an operation preview, then confirm with its digest after agreement. Reads the description and optional Knowledge; uses AI Review and may search the web. Returns the draft and receipts; inspect the package before publishing in a terminal.",
      inputSchema: {
        ...common,
        descriptionFile: z.string().optional(),
        revise: z.string().optional(),
        reviseRef: z.string().optional(),
        instructionsFile: z.string().optional(),
        problemsFile: z.string().optional(),
        hints: z.array(z.string()).optional(),
        knowledge: z.array(z.string()).max(5).optional(),
      },
      annotations: writes,
    },
    (a, extra) =>
      guard("agentry_draft", async () => {
        if ([a.descriptionFile, a.revise, a.reviseRef].filter((v) => v !== undefined).length !== 1)
          throw new ArgumentError("give exactly one of descriptionFile, revise or reviseRef");
        const argv = ["draft", "--output-format", "json"];
        const paths = [a.descriptionFile, a.revise, a.instructionsFile, a.problemsFile].filter(
          (v): v is string => v !== undefined,
        );
        for (const [key, v] of [
          ["description-file", a.descriptionFile],
          ["revise", a.revise],
          ["revise-ref", a.reviseRef],
          ["instructions-file", a.instructionsFile],
          ["problems-file", a.problemsFile],
        ] as const)
          flag(argv, key, v);
        if (a.reviseRef) {
          if (!/^[^@]+@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(a.reviseRef))
            throw new ArgumentError("reviseRef must name an exact published version");
          const inspect = ["verify", value("reviseRef", a.reviseRef), "--strict", "--json"];
          flag(inspect, "registry", a.registry);
          const verified = await runPlan<unknown>(d, "agentry_draft revision", inspect);
          if (!verified.ok) return verified.result;
        }
        for (const hint of a.hints ?? []) flag(argv, "hint", hint);
        for (const pack of a.knowledge ?? []) {
          flag(argv, "knowledge", pack);
          paths.push(...(await localPackPaths([pack], d.cwd)));
        }
        return execute(d, "agentry_draft", a, argv, paths, extra);
      }),
  );
  registerTool(
    d.server,
    "agentry_review",
    {
      description:
        "Review a local QuickAgent with agentry review DIR --json (the Examiner). Two calls: operation preview and confirm. Runs registry rules and AI Review using the person's keys; returns report.json findings and an expected gate outcome, which may be undetermined. Publication still runs the registry's pipeline.",
      inputSchema: { ...common, dir: z.string() },
      annotations: writes,
    },
    (a, extra) =>
      guard("agentry_review", () =>
        execute(d, "agentry_review", a, ["review", value("dir", a.dir), "--json"], [a.dir], extra),
      ),
  );
  registerTool(
    d.server,
    "agentry_knowledge_build",
    {
      description:
        "Create or extend a Knowledge pack with agentry knowledge create/add --output-format json (the Creator). Two calls: operation preview and confirm. Sources are files, git repositories (repos, https with @ref), file addresses (urls), a brief file, or any mix; the CLI fetches each repository or address before the run, through a proxy to its host alone, and the preview lists them. The explicit web choice is shown before the model runs. Returns the build report, the sources it fetched, and receipts. A private repository's token is the one a terminal build saved for its host in the system keychain; the server never takes one. Account upload/export/delete stay in a terminal.",
      inputSchema: {
        ...common,
        timeoutSeconds: common.timeoutSeconds.default(3600),
        action: z.enum(["create", "add"]),
        name: z.string(),
        files: z.array(z.string()).optional(),
        repos: z.array(z.string()).max(10).optional(),
        urls: z.array(z.string()).max(20).optional(),
        briefFile: z.string().optional(),
        web: z.boolean(),
        dir: z.string().optional(),
        maxPackMB: z.number().int().min(1).max(1024).optional(),
      },
      annotations: writes,
    },
    (a, extra) =>
      guard("agentry_knowledge_build", async () => {
        if (!(a.files?.length || a.briefFile || a.repos?.length || a.urls?.length))
          throw new ArgumentError("give files, repos, urls, briefFile, or a mix");
        if ((a.repos?.length || a.urls?.length) && !d.features.buildSources)
          throw new ArgumentError(
            "this agentry CLI has no knowledge --repo or --url; update the CLI to build a pack from a repository or an address",
          );
        if (a.action === "add" && a.dir)
          throw new ArgumentError(
            "dir is only for create; for add name the existing pack directory in name",
          );
        const argv = [
          "knowledge",
          a.action,
          value("name", a.name),
          "--output-format",
          "json",
          a.web ? "--web" : "--no-web",
        ];
        for (const file of a.files ?? []) flag(argv, "file", file);
        for (const repo of a.repos ?? []) flag(argv, "repo", repo);
        for (const url of a.urls ?? []) flag(argv, "url", url);
        flag(argv, "brief-file", a.briefFile);
        flag(argv, "dir", a.dir);
        flag(argv, "max-pack-mb", a.maxPackMB);
        const paths = [...(a.files ?? []), ...(a.briefFile ? [a.briefFile] : [])];
        if (a.action === "add") paths.push(...(await localPackPaths([a.name], d.cwd)));
        return execute(d, "agentry_knowledge_build", a, argv, paths, extra, {
          fetches: fetches(a.repos, a.urls),
        });
      }),
  );
  registerTool(
    d.server,
    "agentry_voice_build",
    {
      description:
        "Create, improve or AI-edit a Writing Voice with agentry voice create/improve/edit --output-format json (the Voice Writer). Two calls: operation preview and confirm. Reads writing samples (files) and pages of the person's writing (urls, https), and an optional brief (edit uses note); each page is fetched first and read by AI Review with the person's own TypeSafe key, which a build with urls needs. Returns the build, what became of each page, and receipts. This changes this computer's voice unless write names a VOICE.md output file.",
      inputSchema: {
        ...common,
        action: z.enum(["create", "improve", "edit"]),
        files: z.array(z.string()).optional(),
        urls: z.array(z.string()).max(20).optional(),
        brief: z.string().optional(),
        note: z.string().optional(),
        current: z.string().optional(),
        write: z.string().optional(),
        maxTextBytes: z.number().int().min(0).optional(),
      },
      annotations: writes,
    },
    (a, extra) =>
      guard("agentry_voice_build", async () => {
        if (a.action === "edit" ? !a.note : !(a.files?.length || a.urls?.length))
          throw new ArgumentError(
            a.action === "edit"
              ? "edit needs note"
              : "create/improve need writing samples (files or urls)",
          );
        if (a.urls?.length && !d.features.voiceURLs)
          throw new ArgumentError(
            "this agentry CLI has no voice --url; update the CLI to take samples from web addresses",
          );
        if (
          (a.action === "edit" && a.brief) ||
          (a.action !== "edit" && a.note) ||
          (a.action === "create" && a.current)
        )
          throw new ArgumentError(
            "brief applies to create/improve, note to edit, and current to improve/edit",
          );
        const argv = ["voice", a.action, "--output-format", "json"];
        for (const file of a.files ?? []) flag(argv, "file", file);
        for (const url of a.urls ?? []) flag(argv, "url", url);
        flag(argv, "brief", a.brief);
        flag(argv, "note", a.note);
        flag(argv, "current", a.current);
        flag(argv, "write", a.write);
        flag(argv, "max-text-bytes", a.maxTextBytes);
        return execute(
          d,
          "agentry_voice_build",
          a,
          argv,
          [...(a.files ?? []), ...(a.current ? [a.current] : [])],
          extra,
          a.urls?.length
            ? {
                fetches: fetches(undefined, a.urls),
                review: VOICE_PAGE_REVIEW,
              }
            : {},
        );
      }),
  );
}
