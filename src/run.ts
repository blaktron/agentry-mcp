/**
 * Runs, setup and validate (plan mcp-cli-driver M4, §6). A run is one CLI
 * process the server waits on: `agentry run --mode autonomous
 * --output-format json`, its stderr forwarded as MCP progress when the host
 * sent a progress token and kept as `log`, its stdout the CLI's result
 * envelope passed through with `receiptsDir`, `resultFile` and `exitClass`
 * beside it. The runner's isolation and receipts are untouched: the server
 * invokes `agentry run` exactly as a person would.
 *
 * Consent is the same two calls as install (src/consent.ts): the preview
 * is `run --dry-run`, whose stdout is the compiled plan — exactly what a
 * run would enforce (the contract, the tools, the gateway, the proxy, the
 * budgets) — and the digest is over that plan. `--yes` is spelled in
 * consent.ts only; this file hands it the argv to append to.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { bool, flag, value } from "./argv.js";
import { confirmed, consentedArgv, previewText, type Consent } from "./consent.js";
import type { Driver } from "./driver.js";
import { exitClass, tail } from "./envelope.js";

/** The timeout a run gets when the call names none: the runner policy's own default budget. */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 900;
/** After the timeout's SIGINT, how long the CLI's teardown gets before SIGKILL. */
export const TEARDOWN_GRACE_MS = 60_000;

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Forwards stderr lines as progress notifications when the host asked for them. */
export function progressSink(extra: Extra): ((line: string) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let n = 0;
  return (line) => {
    n += 1;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: n, message: line.slice(0, 500) },
    });
  };
}

export interface SetupArgs {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  skipImages?: boolean;
  policy?: string;
}

/** agentry_setup: `setup --yes --json`; the key NAME only ever crosses. */
export async function setup(d: Driver, a: SetupArgs, extra: Extra): Promise<CallToolResult> {
  const argv = ["setup", "--yes", "--json"];
  flag(argv, "provider", a.provider);
  flag(argv, "model", a.model);
  flag(argv, "api-key-env", a.apiKeyEnv);
  flag(argv, "base-url", a.baseUrl);
  flag(argv, "policy", a.policy);
  bool(argv, "skip-images", a.skipImages);
  return d.run("agentry_setup", argv, {
    onStderrLine: progressSink(extra),
    timeoutMs: 30 * 60 * 1000,
    graceMs: TEARDOWN_GRACE_MS,
  });
}

export interface RunArgs {
  ref?: string;
  local?: string;
  input?: string;
  inputFile?: string;
  files?: string[];
  intake?: Record<string, string>;
  timeoutSeconds?: number;
  adapter?: string;
  out?: string;
  policy?: string;
  registry?: string;
  confirm?: string;
  acceptUnsigned?: boolean;
}

function target(a: RunArgs): string[] {
  if ((a.ref === undefined) === (a.local === undefined)) {
    throw new Error(
      "give exactly one of ref (a registry BriefAgent) or local (a workspace directory)",
    );
  }
  return a.local !== undefined
    ? ["--local", value("local", a.local)]
    : [value("ref", a.ref as string)];
}

function commonFlags(argv: string[], a: RunArgs): void {
  flag(argv, "adapter", a.adapter);
  flag(argv, "policy", a.policy);
  flag(argv, "registry", a.registry);
  for (const f of a.files ?? []) argv.push("--file", value("files", f));
  for (const [id, v] of Object.entries(a.intake ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new Error(`intake id ${JSON.stringify(id)} is not an identifier`);
    argv.push("--intake", `${id}=${value(`intake.${id}`, v)}`);
  }
}

/** The compiled plan a dry run prints; the fields the digest and the preview name. */
interface CompiledPlan {
  ref: string;
  digest: string;
  mode: string;
  capabilities?: unknown;
  enforcement?: unknown;
  tools?: unknown;
  gateway?: unknown;
  proxy?: unknown;
  budgets?: unknown;
  [k: string]: unknown;
}

/**
 * agentry_run: preview = the compiled plan (`run --dry-run`), digest over
 * it; confirm = the run. An unsigned release (and every --local workspace,
 * which the CLI treats as unsigned) needs acceptUnsigned on the confirm; the
 * preview tries without --allow-unsigned first and says `unsigned: true`
 * when that is why the dry run refused.
 */
export async function run(d: Driver, a: RunArgs, extra: Extra): Promise<CallToolResult> {
  const tgt = target(a);
  const dry = ["run", ...tgt, "--dry-run", "--mode", "autonomous"];
  commonFlags(dry, a);
  let unsigned = a.local !== undefined;
  let planRes = await d.run("agentry_run (plan)", unsigned ? [...dry, "--allow-unsigned"] : dry);
  if (planRes.isError && !unsigned && /unsigned|--allow-unsigned/.test(textOf(planRes))) {
    unsigned = true;
    planRes = await d.run("agentry_run (plan)", [...dry, "--allow-unsigned"]);
  }
  if (planRes.isError) return planRes;
  const env = JSON.parse(textOf(planRes)) as { result: CompiledPlan; log: string };
  const plan = env.result;
  const facts = {
    ref: plan.ref,
    digest: plan.digest,
    mode: plan.mode,
    unsigned,
    capabilities: plan.capabilities,
    enforcement: plan.enforcement,
    tools: plan.tools,
    gateway: plan.gateway,
    proxy: plan.proxy,
    budgets: plan.budgets,
    intake: a.intake ?? {},
    files: a.files ?? [],
  };
  if (a.confirm === undefined) {
    return previewText(
      {
        plan: {
          ref: plan.ref,
          digest: plan.digest,
          mode: plan.mode,
          capabilities: plan.capabilities,
          enforcement: plan.enforcement,
          tools: plan.tools,
          gateway: plan.gateway,
          proxy: plan.proxy,
          budgets: plan.budgets,
        },
        unsigned,
        log: tail(env.log),
        writes: false,
      },
      facts,
    );
  }
  const ok = await confirmed(d, "agentry_run", a.confirm, facts, {
    unsigned,
    acceptUnsigned: a.acceptUnsigned,
    ask:
      `Run ${plan.ref} (${plan.mode})? It may reach: ${JSON.stringify(plan.capabilities)}; tools: ${JSON.stringify(plan.tools)}.` +
      (unsigned ? " The release is unsigned." : ""),
  });
  if (!isConsent(ok)) return ok;

  const timeoutSeconds = a.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS;
  const argv = [
    "run",
    ...tgt,
    "--mode",
    "autonomous",
    "--output-format",
    "json",
    "--timeout",
    String(timeoutSeconds),
  ];
  commonFlags(argv, a);
  flag(argv, "out", a.out);
  let tmp: string | undefined;
  try {
    if (a.input !== undefined) {
      if (a.inputFile !== undefined)
        throw new Error("give input (text) or inputFile (a path), not both");
      tmp = await mkdtemp(join(tmpdir(), "agentry-mcp-run-"));
      const file = join(tmp, "input.txt");
      await writeFile(file, a.input, { mode: 0o600 });
      argv.push("--input", file);
    } else if (a.inputFile !== undefined) {
      argv.push("--input", value("inputFile", a.inputFile));
    }
    const r = await d.run("agentry_run", consentedArgv(argv, ok), {
      onStderrLine: progressSink(extra),
      // The CLI enforces --timeout itself; the server's own limit sits
      // past it so the CLI's teardown is what ends the run.
      timeoutMs: timeoutSeconds * 1000 + d.runTimeoutSlackMs,
      graceMs: TEARDOWN_GRACE_MS,
    });
    return decorateRun(r);
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

/** Adds receiptsDir and resultFile beside the CLI's envelope; a timeout is named. */
function decorateRun(r: CallToolResult): CallToolResult {
  if (r.isError) return r;
  const env = JSON.parse(textOf(r)) as {
    result: { receipts?: { dir?: string }; resultFile?: string; outDir?: string };
    exitClass: string;
    log: string;
    timedOut?: boolean;
  };
  const out = {
    ...env,
    receiptsDir: env.result?.receipts?.dir,
    resultFile: env.result?.resultFile,
    outDir: env.result?.outDir,
  };
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

export interface ValidateArgs {
  dir: string;
  strict?: boolean;
}

/** agentry_validate: `validate DIR --json`; the report comes back whatever the exit. */
export async function validate(d: Driver, a: ValidateArgs): Promise<CallToolResult> {
  const argv = ["validate", value("dir", a.dir), "--json"];
  bool(argv, "strict", a.strict);
  return d.run("agentry_validate", argv);
}

function isConsent(v: Consent | CallToolResult): v is Consent {
  return !("content" in v);
}

function textOf(r: CallToolResult): string {
  return (r.content[0] as { text: string }).text;
}

export { exitClass };
