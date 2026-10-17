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

async function execute(
  d: Driver,
  tool: string,
  a: Common,
  argv: string[],
  paths: string[],
  extra: Extra,
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
    ask: `Execute ${tool}? Inputs: ${paths.join(", ") || "text in the operation"}. Output: ${a.out}. Budget: ${a.timeoutSeconds}s. Model and review/search charges may apply.`,
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
        "Create or extend a Knowledge pack with agentry knowledge create/add --output-format json (the Creator). Two calls: operation preview and confirm. Sources are files, a brief file, or both; the explicit web choice is shown before the model runs. Returns the build report and receipts. Account upload/export/delete stay in a terminal.",
      inputSchema: {
        ...common,
        timeoutSeconds: common.timeoutSeconds.default(3600),
        action: z.enum(["create", "add"]),
        name: z.string(),
        files: z.array(z.string()).optional(),
        briefFile: z.string().optional(),
        web: z.boolean(),
        dir: z.string().optional(),
        maxPackMB: z.number().int().min(1).max(1024).optional(),
      },
      annotations: writes,
    },
    (a, extra) =>
      guard("agentry_knowledge_build", async () => {
        if (!(a.files?.length || a.briefFile))
          throw new ArgumentError("give files, briefFile or both");
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
        flag(argv, "brief-file", a.briefFile);
        flag(argv, "dir", a.dir);
        flag(argv, "max-pack-mb", a.maxPackMB);
        const paths = [...(a.files ?? []), ...(a.briefFile ? [a.briefFile] : [])];
        if (a.action === "add") paths.push(...(await localPackPaths([a.name], d.cwd)));
        return execute(d, "agentry_knowledge_build", a, argv, paths, extra);
      }),
  );
  registerTool(
    d.server,
    "agentry_voice_build",
    {
      description:
        "Create, improve or AI-edit a Writing Voice with agentry voice create/improve/edit --output-format json (the Voice Writer). Two calls: operation preview and confirm. Reads writing samples and an optional brief (edit uses note); returns the build and receipts. This changes this computer's voice unless write names a VOICE.md output file.",
      inputSchema: {
        ...common,
        action: z.enum(["create", "improve", "edit"]),
        files: z.array(z.string()).optional(),
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
        if (a.action === "edit" ? !a.note : !a.files?.length)
          throw new ArgumentError(
            a.action === "edit" ? "edit needs note" : "create/improve need writing samples",
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
        );
      }),
  );
}
