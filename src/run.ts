/**
 * Runs, setup and validate. A run is one CLI process the server waits on: `agentry run --mode autonomous
 * --output-format json`, its stderr forwarded as MCP progress when the host
 * sent a progress token and kept as `log`, its stdout the CLI's result
 * envelope passed through with `receiptsDir`, `resultFile` and `outDir`
 * beside it. The runner's isolation and receipts are untouched: the server
 * invokes `agentry run` exactly as a person would.
 *
 * Consent is the same two calls as install (src/consent.ts). The preview is
 * `run --plan --json`: the compiled plan — exactly what a
 * run would enforce (the contract, the tools, the gateway, the proxy, the
 * budgets) — with the attestation verdict and every refusal a run would
 * meet, printed without asking or recording anything.
 * The digest is over that whole plan. The consented flags are spelled in
 * consent.ts only; this file hands it the argv to append to, and the
 * preview carries neither.
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

import { deliverablesBack } from "./deliverables.js";
import { fingerprint, localPackPaths } from "./snapshot.js";
import { ArgumentError, bool, flag, value } from "./argv.js";
import {
  canonical,
  confirmed,
  consentedArgv,
  isConsent,
  planRefusals,
  previewText,
  runPlan,
  type Consent,
  type PlanRefusal,
} from "./consent.js";
import type { Driver } from "./driver.js";
import { tail, toolText as text } from "./envelope.js";

/**
 * The budget the server assumes when neither the call nor the compiled plan
 * names one (the policy's own default); the plan's budget is what a run
 * without timeoutSeconds gets, and the server's backstop sits past it.
 */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 900;
/** After the timeout's SIGINT, how long the CLI's teardown gets before SIGKILL. */
export const TEARDOWN_GRACE_MS = 60_000;
/** setup pulls and builds images; minutes, bounded. */
const SETUP_TIMEOUT_MS = 30 * 60 * 1000;

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Forwards stderr lines as progress notifications when the host asked for
 * them. A notification that cannot be delivered (the host went away
 * mid-run) is dropped: the run's own result still comes back.
 */
export function progressSink(extra: Extra): ((line: string) => void) | undefined {
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
  if (a.provider === "agentry" && (a.apiKeyEnv || a.baseUrl || a.model)) {
    throw new ArgumentError(
      "provider agentry pays with your Agentry credits through the registry the CLI is signed in to: give no apiKeyEnv, baseUrl or model",
    );
  }
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

/** The run modes the CLI compiles a plan for. */
export type RunMode = "autonomous" | "interactive";

export interface RunArgs {
  ref?: string;
  local?: string;
  input?: string;
  inputFile?: string;
  files?: string[];
  knowledge?: string[];
  voice?: boolean;
  noVoice?: boolean;
  voiceFile?: string;
  maxTurns?: number;
  maxCost?: number;
  intake?: Record<string, string>;
  timeoutSeconds?: number;
  adapter?: string;
  out?: string;
  deliverTo?: string;
  destinations?: string[];
  noDestination?: boolean;
  reportTheme?: string;
  intakeTokens?: Record<string, string>;
  hostKeys?: Record<string, string>;
  hostPasswords?: Record<string, string>;
  hostPassphrases?: Record<string, string>;
  hostSudoPasswords?: Record<string, string>;
  policy?: string;
  registry?: string;
  confirm?: string;
  acceptUnsigned?: boolean;
  acceptUnscanned?: boolean;
}

/** The run plan the CLI prints; the fields consent reads. */
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
  /** Every refusal a run would meet; read through planRefusals. */
  refusals?: PlanRefusal[];
  /** Deprecated by the CLI: refusals[0].message, read when refusals is absent. */
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
      "give exactly one of ref (a registry QuickAgent) or local (a workspace directory)",
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
function commonFlags(argv: string[], a: RunArgs, mode: RunMode): void {
  argv.push("--mode", mode);
  flag(argv, "timeout", a.timeoutSeconds);
  flag(argv, "max-turns", a.maxTurns);
  flag(argv, "max-cost", a.maxCost);
  for (const pack of a.knowledge ?? []) flag(argv, "knowledge", pack);
  if ([a.voice, a.noVoice, a.voiceFile !== undefined].filter(Boolean).length > 1)
    throw new ArgumentError("choose only one of voice, noVoice or voiceFile");
  bool(argv, "voice", a.voice);
  bool(argv, "no-voice", a.noVoice);
  flag(argv, "voice-file", a.voiceFile);
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
 * digest), the release it came from and its attestation, the refusals, and
 * the call's own contribution to the run — the intake answers, the files
 * and the input file it hands the run, where the output lands, the budget.
 * The task input as text is not among them: it is the model's to compose,
 * and it changes nothing about what the run may reach.
 */
function runFacts(p: RunPlan, a: RunArgs, timeoutSeconds: number, refusals: PlanRefusal[]) {
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
    refusals,
    intake: a.intake ?? {},
    files: a.files ?? [],
    knowledge: a.knowledge ?? [],
    voice: a.voice ?? false,
    noVoice: a.noVoice ?? false,
    voiceFile: a.voiceFile ?? "",
    maxTurns: a.maxTurns ?? null,
    maxCost: a.maxCost ?? null,
    registry: a.registry ?? "",
    inputFile: a.inputFile ?? "",
    out: a.out ?? "",
    deliverTo: a.deliverTo ?? "",
    destinations: a.destinations ?? [],
    noDestination: a.noDestination ?? false,
    reportTheme: a.reportTheme ?? "",
    intakeTokens: a.intakeTokens ?? {},
    hostKeys: a.hostKeys ?? {},
    hostPasswords: a.hostPasswords ?? {},
    hostPassphrases: a.hostPassphrases ?? {},
    hostSudoPasswords: a.hostSudoPasswords ?? {},
    timeoutSeconds,
  };
}

/**
 * What a matched, accepted confirm hands the run: the consent to append
 * the flags for, the plan the digest covered, the budget it named.
 */
export interface RunConsent {
  consent: Consent;
  plan: RunPlan;
  timeoutSeconds: number;
}

/**
 * The two-call consent for a run in either mode: preview = the CLI's run
 * plan, digest over it; confirm = a Consent for the caller to run with.
 * The preview never lifts the unsigned gate: the CLI reports `attestation:
 * unsigned` (a release with no attestation) or `local` (a workspace) with
 * its refusal, and only a confirm carrying acceptUnsigned — the person's
 * word — lifts it. `unscanned` (admitted without a scan) is the same shape
 * with its own word, acceptUnscanned. Any other refusal the plan lists (a
 * declared server with a known vulnerability, a signature no key verifies)
 * stops the confirm. Returns the preview or the tool error to hand back,
 * or the consent.
 */
export async function runConsent(
  d: Driver,
  a: RunArgs,
  mode: RunMode,
  tool: string,
): Promise<RunConsent | CallToolResult> {
  if (a.deliverTo !== undefined && !d.features.deliverTo)
    throw new ArgumentError(
      "this agentry CLI has no run --deliver-to; update the CLI to deliver a run's files to a folder",
    );
  if ((a.destinations?.length || a.noDestination) && !d.features.destinations)
    throw new ArgumentError(
      "this agentry CLI has no run --destination; update the CLI to send a run's result to a destination",
    );
  if (a.destinations?.length && a.noDestination)
    throw new ArgumentError("give destinations or noDestination, not both");
  // The flags only the run carries are checked before anything is planned.
  deliveryFlags([], a);
  const planArgv = ["run", ...target(a), "--plan", "--json"];
  commonFlags(planArgv, a, mode);
  const planned = await runPlan<RunPlan>(d, `${tool} (plan)`, planArgv);
  if (!planned.ok) return planned.result;
  const { plan, log } = planned;
  const unsigned = plan.attestation === "unsigned" || plan.attestation === "local";
  const unscanned = plan.attestation === "unscanned";
  // The budget the run gets: the call's, else the compiled plan's (the
  // policy's), else the server's assumption.
  const timeoutSeconds =
    a.timeoutSeconds ?? plan.plan.budgets?.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS;
  // Every refusal the run would meet, shown before the person consents,
  // not only the first.
  const refusals = planRefusals(plan, { unsigned, unscanned });
  if (typeof refusals === "string") return text(`${tool}: ${refusals}`, true);
  const attachmentInputs = [];
  for (const path of [
    ...(a.files ?? []),
    ...(a.voiceFile ? [a.voiceFile] : []),
    ...(await localPackPaths(a.knowledge ?? [], d.cwd)),
  ])
    attachmentInputs.push({ path, digest: await fingerprint(path, d.cwd) });
  let knowledgeState: unknown = null;
  if (a.knowledge?.length) {
    const argv = ["knowledge", "list", "--json"];
    flag(argv, "registry", a.registry);
    const state = await runPlan<unknown>(d, tool, argv);
    if (!state.ok) return state.result;
    knowledgeState = state.plan;
  }
  const voiceArgv = ["voice", "status", "--json"];
  flag(voiceArgv, "registry", a.registry);
  const voice = await runPlan<unknown>(d, tool, voiceArgv);
  if (!voice.ok) return voice.result;
  // Where the run (or the session, at its end) sends its result: the
  // call's destinations, else the QuickAgent's default set, which the
  // person saved and may change between the preview and the confirm.
  let destinationsState: unknown = null;
  if (
    d.features.destinations &&
    !a.noDestination &&
    (a.destinations?.length || a.local === undefined)
  ) {
    const state = await runPlan<unknown>(d, tool, ["destinations", "list", "--json"]);
    if (!state.ok) return state.result;
    destinationsState = state.plan;
  }
  const sends = delivery(a, plan, destinationsState);
  const secrets = signIns(a);
  const facts = {
    ...runFacts(plan, a, timeoutSeconds, refusals),
    attachmentInputs,
    knowledgeState,
    voiceState: voice.plan,
    delivery: sends,
    signIns: secrets,
  };

  if (a.confirm === undefined) {
    return previewText(
      {
        plan,
        unsigned,
        unscanned,
        refusals,
        timeoutSeconds,
        delivery: sends,
        ...(secrets.length ? { signIns: secrets } : {}),
        log: tail(log),
        writes: false,
      },
      facts,
    );
  }
  const ok = await confirmed(d.server, tool, a.confirm, facts, {
    unsigned,
    acceptUnsigned: a.acceptUnsigned,
    unscanned,
    acceptUnscanned: a.acceptUnscanned,
    refusals,
    ask:
      `${mode === "interactive" ? "Start a session with" : "Run"} ${plan.ref} (${plan.mode}` +
      `${mode === "interactive" ? "" : `, up to ${timeoutSeconds}s`})? Contract: ${canonical(plan.contract)}. ` +
      `${a.deliverTo !== undefined ? `Copies its deliverables to ${a.deliverTo}. ` : ""}` +
      `${sends.destinations.length ? `Sends its result and deliverables to ${sends.destinations.join(", ")}. ` : ""}` +
      `${secrets.length ? `Signs in with: ${secrets.map(describeSignIn).join("; ")}. ` : ""}` +
      `Attestation: ${plan.attestation}.${plan.reason ? ` The CLI would ask because: ${plan.reason}.` : ""}`,
  });
  if (!isConsent(ok)) return ok;
  return { consent: ok, plan, timeoutSeconds };
}

/** agentry_run: the consent above, then one CLI process the server waits on. */
export async function run(d: Driver, a: RunArgs, extra: Extra): Promise<CallToolResult> {
  const c = await runConsent(d, a, "autonomous", "agentry_run");
  if (!isRunConsent(c)) return c;
  const task = await taskInput(a);
  try {
    const r = await d.run("agentry_run", runArgv(a, c, "autonomous", task.path), {
      onStderrLine: progressSink(extra),
      // The CLI enforces --timeout itself; the server's own limit sits
      // past it so the CLI's teardown is what ends the run.
      timeoutMs: c.timeoutSeconds * 1000 + d.runTimeoutSlackMs,
      graceMs: TEARDOWN_GRACE_MS,
    });
    return await decorateRun(r, d.cwd);
  } finally {
    await task.done();
  }
}

/**
 * The task input as a `--input` path: the call's own file, or its text
 * written 0600 to a temp file that `done` removes whatever happened.
 */
export async function taskInput(a: RunArgs): Promise<{ path?: string; done(): Promise<void> }> {
  if (a.input === undefined) {
    return { path: a.inputFile, done: async () => {} };
  }
  const tmp = await mkdtemp(join(tmpdir(), "agentry-mcp-run-"));
  const path = join(tmp, "input.txt");
  await writeFile(path, a.input, { mode: 0o600 });
  return { path, done: () => rm(tmp, { recursive: true, force: true }) };
}

/**
 * The argv for a consented run in either mode: the target the digest
 * covered, the mode and the flags that shaped the plan, the output folder,
 * the task input, and the consented flags last. An autonomous run's
 * stdout is its result envelope; the interactive driver adds its protocol
 * flags and collects the event stream separately.
 */
export function runArgv(a: RunArgs, c: RunConsent, mode: RunMode, inputPath?: string): string[] {
  const argv = ["run", ...target(a, c.plan.ref)];
  if (mode === "autonomous") argv.push("--output-format", "json");
  commonFlags(argv, a, mode);
  flag(argv, "pin", a.local === undefined ? c.plan.digest : undefined);
  flag(argv, "out", a.out);
  deliveryFlags(argv, a);
  if (inputPath !== undefined) argv.push("--input", value("inputFile", inputPath));
  return consentedArgv(argv, c.consent);
}

/** An environment variable's name, never its value. */
function envName(name: string, v: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))
    throw new ArgumentError(
      `${name} takes the NAME of an environment variable holding the secret, never the secret itself`,
    );
  return v;
}

/** Appends `--flag id=value` for each entry, the id an identifier. */
function idFlags(
  argv: string[],
  name: string,
  arg: string,
  m: Record<string, string> | undefined,
  check: (name: string, v: string) => string,
): void {
  for (const [id, v] of Object.entries(m ?? {})) {
    if (!/^[A-Za-z0-9_.-]+$/.test(id))
      throw new ArgumentError(`${arg} id ${JSON.stringify(id)} is not an identifier`);
    argv.push(`--${name}`, `${id}=${check(`${arg}.${id}`, v)}`);
  }
}

/**
 * The flags only the run carries, never the plan: where it delivers, the
 * report theme, and the sign-ins for its input sources and target hosts,
 * each by the name of an environment variable or a key file's path.
 */
function deliveryFlags(argv: string[], a: RunArgs): void {
  flag(argv, "deliver-to", a.deliverTo);
  for (const name of a.destinations ?? []) argv.push("--destination", value("destinations", name));
  bool(argv, "no-destination", a.noDestination);
  flag(argv, "report-theme", a.reportTheme);
  idFlags(argv, "intake-token", "intakeTokens", a.intakeTokens, envName);
  idFlags(argv, "host-key", "hostKeys", a.hostKeys, value);
  idFlags(argv, "host-password", "hostPasswords", a.hostPasswords, envName);
  idFlags(argv, "host-passphrase", "hostPassphrases", a.hostPassphrases, envName);
  idFlags(argv, "host-sudo-password", "hostSudoPasswords", a.hostSudoPasswords, envName);
}

/** A saved destination as `destinations list --json` shows it. */
interface SavedDestination {
  name?: string;
  kind?: string;
  where?: string;
  onMyNetwork?: boolean;
  defaultFor?: string[];
}

/**
 * Where a run would deliver, for the preview and the digest: the folder
 * (the call's, else the CLI's deliver.folder setting) and the destinations,
 * the call's or else the default set saved for this QuickAgent, each as
 * saved (name, kind, host). The list shows a destination's host, never its
 * path or secret, so a destination saved again under the same name and
 * host is the same destination here.
 */
function delivery(a: RunArgs, p: RunPlan, state: unknown) {
  const folder = a.deliverTo ?? "the CLI's deliver.folder setting, if any";
  const rows = (state as { destinations?: SavedDestination[] } | null)?.destinations ?? [];
  const saved = (names: string[]) =>
    names.map((n) => {
      const r = rows.find((row) => row.name === n);
      return r
        ? { name: n, kind: r.kind, where: r.where, onMyNetwork: r.onMyNetwork }
        : { name: n, saved: false };
    });
  if (a.noDestination) return { folder, destinations: [] as string[] };
  if (a.destinations?.length)
    return { folder, destinations: a.destinations, saved: saved(a.destinations) };
  if (a.local !== undefined) return { folder, destinations: [] as string[] };
  const agent = p.ref.split("@")[0] ?? p.ref;
  const names = rows.filter((r) => r.defaultFor?.includes(agent)).map((r) => r.name ?? "");
  return names.length
    ? { folder, destinations: names, defaultSetFor: agent, saved: saved(names) }
    : { folder, destinations: [] as string[] };
}

/** One secret a run would read, named for the person: what it signs in to and where it comes from. */
interface SignIn {
  kind: string;
  id: string;
  env?: string;
  path?: string;
  source?: string;
}

/**
 * The secrets the call has the run read, for the preview and the person's
 * question: a variable's value goes to the input source or target host its
 * id names, so the person sees which variable goes where before agreeing.
 */
function signIns(a: RunArgs): SignIn[] {
  const out: SignIn[] = [];
  for (const [id, env] of Object.entries(a.intakeTokens ?? {}))
    out.push({
      kind: "input source token",
      id,
      env,
      source: a.intake?.[id] ?? "the source's saved answer",
    });
  for (const [id, path] of Object.entries(a.hostKeys ?? {}))
    out.push({ kind: "target host key file", id, path });
  for (const [kind, m] of [
    ["target host password", a.hostPasswords],
    ["target host key passphrase", a.hostPassphrases],
    ["target host sudo password", a.hostSudoPasswords],
  ] as const)
    for (const [id, env] of Object.entries(m ?? {})) out.push({ kind, id, env });
  return out;
}

function describeSignIn(s: SignIn): string {
  const from = s.env !== undefined ? `$${s.env}` : `the key file ${s.path}`;
  return s.source !== undefined
    ? `${from} as the ${s.kind} for ${s.id} (${s.source})`
    : `${from} as the ${s.kind} for host ${s.id}`;
}

/**
 * Adds receiptsDir, resultFile and outDir beside the CLI's envelope, and
 * hands back the run's deliverables: what came of each in the envelope, and
 * after it the files themselves, text inline and the rest as links.
 */
async function decorateRun(r: CallToolResult, cwd?: string): Promise<CallToolResult> {
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
  // The run's outcome is the CLI's: a deliverable that cannot be handed
  // back never turns a finished run into a tool error.
  const back = await deliverablesBack(env.result, cwd).catch(() => undefined);
  if (!back) return { content: [{ type: "text", text: JSON.stringify(out) }] };
  const withBack = {
    ...out,
    deliverables: back.deliverables,
    ...(back.truncated ? { deliverablesTruncated: true } : {}),
  };
  return { content: [{ type: "text", text: JSON.stringify(withBack) }, ...back.content] };
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

export function isRunConsent(v: RunConsent | CallToolResult): v is RunConsent {
  return !("content" in v);
}

function textOf(r: CallToolResult): string {
  return (r.content[0] as { text: string }).text;
}
