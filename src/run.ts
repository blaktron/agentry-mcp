/**
 * Runs, setup and validate (plan mcp-cli-driver M4, §6). A run is one CLI
 * process the server waits on: `agentry run --mode autonomous
 * --output-format json`, its stderr forwarded as MCP progress when the host
 * sent a progress token and kept as `log`, its stdout the CLI's result
 * envelope passed through with `receiptsDir`, `resultFile` and `outDir`
 * beside it. The runner's isolation and receipts are untouched: the server
 * invokes `agentry run` exactly as a person would.
 *
 * Consent is the same two calls as install (src/consent.ts). The preview is
 * `run --plan --json` (agentry-cli#124): the compiled plan — exactly what a
 * run would enforce (the contract, the tools, the gateway, the proxy, the
 * budgets) — with the attestation verdict and the refusal a run would meet,
 * printed without asking or recording anything. The digest is over that
 * whole plan. The consented flags are spelled in consent.ts only; this file
 * hands it the argv to append to, and the preview carries neither.
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

import { ArgumentError, bool, flag, value } from "./argv.js";
import { canonical, confirmed, consentedArgv, isConsent, previewText, runPlan } from "./consent.js";
import type { Driver } from "./driver.js";
import { tail } from "./envelope.js";

/**
 * The budget the server assumes when neither the call nor the compiled plan
 * names one (the policy's own default); the plan's budget is what a run
 * without timeoutSeconds gets, and the server's backstop sits past it.
 */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 900;
/** After the timeout's SIGINT, how long the CLI's teardown gets before SIGKILL. */
const TEARDOWN_GRACE_MS = 60_000;
/** setup pulls and builds images; minutes, bounded. */
const SETUP_TIMEOUT_MS = 30 * 60 * 1000;

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Forwards stderr lines as progress notifications when the host asked for
 * them. A notification that cannot be delivered (the host went away
 * mid-run) is dropped: the run's own result still comes back.
 */
function progressSink(extra: Extra): ((line: string) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let n = 0;
  return (line) => {
    n += 1;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: n, message: line.slice(0, 500) },
      })
      .catch(() => {});
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

/**
 * agentry_setup: `setup --json`. The server gives the CLI no terminal, and
 * setup without one fills every gap from its provider table instead of
 * asking, so no consent flag is needed; the key NAME only ever crosses.
 */
export async function setup(d: Driver, a: SetupArgs, extra: Extra): Promise<CallToolResult> {
  const argv = ["setup", "--json"];
  flag(argv, "provider", a.provider);
  flag(argv, "model", a.model);
  flag(argv, "api-key-env", a.apiKeyEnv);
  flag(argv, "base-url", a.baseUrl);
  flag(argv, "policy", a.policy);
  bool(argv, "skip-images", a.skipImages);
  return d.run("agentry_setup", argv, {
    onStderrLine: progressSink(extra),
    timeoutMs: SETUP_TIMEOUT_MS,
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

/** The run plan the CLI prints (agentry-cli#124); the fields consent reads. */
export interface RunPlan {
  ref: string;
  version: string;
  digest: string;
  mode: string;
  modes: string[];
  summary?: string;
  /** The compiled plan, canonical: what the run enforces. */
  plan: { budgets?: { timeoutSeconds?: number }; [k: string]: unknown };
  /** The receipt's runPlanSha256 for that plan. */
  planSha256: string;
  contract: unknown;
  contractDigest: string;
  attestation: string;
  keyId?: string;
  signed: boolean;
  installed?: { version: string; dir: string };
  diff?: { widened?: string[]; narrowed?: string[] };
  needsConfirmation: boolean;
  reason?: string;
  refusal?: string;
}

/**
 * The target as argv: a workspace directory, or a registry ref — the
 * call's own for the preview, and for the run the one the preview resolved
 * (ns/name@version), never the floating ref the call carried.
 */
function target(a: RunArgs, resolvedRef?: string): string[] {
  if ((a.ref === undefined) === (a.local === undefined)) {
    throw new ArgumentError(
      "give exactly one of ref (a registry BriefAgent) or local (a workspace directory)",
    );
  }
  if (a.input !== undefined && a.inputFile !== undefined) {
    throw new ArgumentError("give input (text) or inputFile (a path), not both");
  }
  return a.local !== undefined
    ? ["--local", value("local", a.local)]
    : [value("ref", resolvedRef ?? (a.ref as string))];
}

/**
 * The flags both the preview and the run carry: they shape the plan.
 * --timeout only when the call named one; otherwise the compiled plan's own
 * budget (the policy's) is what the run gets.
 */
function commonFlags(argv: string[], a: RunArgs): void {
  argv.push("--mode", "autonomous");
  flag(argv, "timeout", a.timeoutSeconds);
  flag(argv, "adapter", a.adapter);
  flag(argv, "policy", a.policy);
  flag(argv, "registry", a.registry);
  for (const f of a.files ?? []) argv.push("--file", value("files", f));
  for (const [id, v] of Object.entries(a.intake ?? {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new ArgumentError(`intake id ${JSON.stringify(id)} is not an identifier`);
    argv.push("--intake", `${id}=${value(`intake.${id}`, v)}`);
  }
}

/**
 * The facts the run digest covers: the whole compiled plan (so a policy,
 * an image, a tool or a budget that changed between the calls changes the
 * digest), the release it came from and its attestation, the refusal, and
 * the call's own contribution to the run — the intake answers, the files
 * and the input file it hands the run, where the output lands, the budget.
 * The task input as text is not among them: it is the model's to compose,
 * and it changes nothing about what the run may reach.
 */
function runFacts(p: RunPlan, a: RunArgs, timeoutSeconds: number) {
  return {
    ref: p.ref,
    version: p.version,
    archiveDigest: p.digest,
    mode: p.mode,
    plan: p.plan,
    planSha256: p.planSha256,
    contract: p.contract,
    contractDigest: p.contractDigest,
    attestation: p.attestation,
    refusal: p.refusal ?? "",
    intake: a.intake ?? {},
    files: a.files ?? [],
    inputFile: a.inputFile ?? "",
    out: a.out ?? "",
    timeoutSeconds,
  };
}

/**
 * agentry_run: preview = the CLI's run plan, digest over it; confirm = the
 * run. The preview never lifts the unsigned gate: the CLI reports
 * `attestation: unsigned` (a release with no attestation) or `local` (a
 * workspace) with the refusal, and only a confirm carrying acceptUnsigned
 * — the person's word — lifts it.
 */
export async function run(d: Driver, a: RunArgs, extra: Extra): Promise<CallToolResult> {
  const planArgv = ["run", ...target(a), "--plan", "--json"];
  commonFlags(planArgv, a);
  const planned = await runPlan<RunPlan>(d, "agentry_run (plan)", planArgv);
  if (!planned.ok) return planned.result;
  const { plan, log } = planned;
  const unsigned = plan.attestation === "unsigned" || plan.attestation === "local";
  // The budget the run gets: the call's, else the compiled plan's (the
  // policy's), else the server's assumption.
  const timeoutSeconds =
    a.timeoutSeconds ?? plan.plan.budgets?.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS;
  const facts = runFacts(plan, a, timeoutSeconds);

  if (a.confirm === undefined) {
    return previewText({ plan, unsigned, timeoutSeconds, log: tail(log), writes: false }, facts);
  }
  const ok = await confirmed(d.server, "agentry_run", a.confirm, facts, {
    unsigned,
    acceptUnsigned: a.acceptUnsigned,
    refusal: plan.refusal,
    ask:
      `Run ${plan.ref} (${plan.mode}, up to ${timeoutSeconds}s)? Contract: ${canonical(plan.contract)}. ` +
      `Attestation: ${plan.attestation}.${plan.reason ? ` The CLI would ask because: ${plan.reason}.` : ""}`,
  });
  if (!isConsent(ok)) return ok;

  const argv = ["run", ...target(a, plan.ref), "--output-format", "json"];
  commonFlags(argv, a);
  flag(argv, "out", a.out);
  let tmp: string | undefined;
  try {
    if (a.input !== undefined) {
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

/** Adds receiptsDir, resultFile and outDir beside the CLI's envelope. */
function decorateRun(r: CallToolResult): CallToolResult {
  if (r.isError) return r;
  const env = JSON.parse(textOf(r)) as {
    result?: { receipts?: { dir?: string }; resultFile?: string; outDir?: string };
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

function textOf(r: CallToolResult): string {
  return (r.content[0] as { text: string }).text;
}
