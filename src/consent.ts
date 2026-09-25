/**
 * The two-call consent (plan mcp-cli-driver §5, D4). The CLI asks on a
 * terminal; the server has none and the model is not the person. So every
 * writing tool is two calls: a preview that runs the CLI's plan mode and
 * writes nothing, returning what consent would cover plus `digest`; and a
 * confirm carrying that digest, which recomputes the preview, refuses on
 * any difference, and only then runs the writing command. The digest is
 * the control, not the tool description: a model cannot confirm what the
 * server did not show it.
 *
 * `--yes`, `--allow-unsigned` and `--allow-unscanned` are spelled in this
 * file and nowhere else (CI greps for them): `--yes` only after a digest
 * matched, `--allow-unsigned` only when the preview said the release is
 * unsigned AND the confirm call said `acceptUnsigned: true`, and
 * `--allow-unscanned` only when the preview said it is unscanned AND the
 * confirm said `acceptUnscanned: true`. Unscanned is its own consent, not a
 * kind of unsigned (DR-27): the registry admitted the release without a
 * scan, so no findings, report or attestation stand behind it, and
 * `acceptUnsigned` does not lift it.
 */

import { createHmac, randomBytes } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { flag, value } from "./argv.js";
import type { Driver } from "./driver.js";
import { tail, toolText as text } from "./envelope.js";

/** Canonical JSON: keys sorted at every level, compact. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(o[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

/**
 * The key under which this process digests consent facts: random, never
 * exported, gone when the process ends. So a digest can only have come from
 * a preview this server produced — not from a model that assembled the
 * same facts out of the read tools — and a restart invalidates every
 * outstanding preview (the confirm says to preview again).
 */
const sessionKey = randomBytes(32);

/**
 * The digest a preview returns and a confirm must carry: an HMAC-SHA-256,
 * under the process key, over the canonical JSON of the facts consent
 * covers. Everything that would change what the person is agreeing to is in
 * it — the release that resolved, its archive digest, the attestation
 * verdict, whether it is yanked, the contract, where it lands — so a release
 * that moved, a contract that changed or a signature that appeared or
 * vanished between the two calls changes the digest.
 */
export function consentDigest(facts: unknown): string {
  return "sha256:" + createHmac("sha256", sessionKey).update(canonical(facts)).digest("hex");
}

/** The install plan the CLI prints (agentry-cli#102); the fields consent reads. */
export interface InstallPlan {
  ref: string;
  version: string;
  digest: string;
  yanked?: boolean;
  contract: unknown;
  contractDigest: string;
  attestation: string;
  signed: boolean;
  needsConfirmation: boolean;
  reason?: string;
  target: string;
  dir: string;
  managed: boolean;
  refusal?: string;
  installed?: { version: string; dir: string };
  diff?: { widened?: string[]; narrowed?: string[] };
}

export interface InstallArgs {
  ref: string;
  target?: string;
  provider?: string;
  dir?: string;
  registry?: string;
  confirm?: string;
  acceptUnsigned?: boolean;
  acceptUnscanned?: boolean;
}

export type ToolText = CallToolResult;

/** Runs the CLI's plan mode and parses the plan; a refusal or non-JSON is the error. */
export async function runPlan<P>(
  d: Driver,
  what: string,
  argv: string[],
): Promise<{ ok: true; plan: P; log: string } | { ok: false; result: ToolText }> {
  const r = await d.run(what, argv);
  if (r.isError) return { ok: false, result: r };
  const env = JSON.parse((r.content[0] as { text: string }).text) as { result: P; log: string };
  return { ok: true, plan: env.result, log: env.log };
}

function installPlanArgv(a: InstallArgs): string[] {
  const argv = ["install", value("ref", a.ref), "--plan", "--json"];
  flag(argv, "target", a.target);
  flag(argv, "provider", a.provider);
  flag(argv, "dir", a.dir);
  flag(argv, "registry", a.registry);
  return argv;
}

/** The facts the install digest covers. */
function installFacts(p: InstallPlan) {
  return {
    ref: p.ref,
    version: p.version,
    archiveDigest: p.digest,
    yanked: p.yanked === true,
    attestation: p.attestation,
    contract: p.contract,
    contractDigest: p.contractDigest,
    target: p.target,
    dir: p.dir,
  };
}

/**
 * Asks the person through MCP elicitation when the host advertises it; a
 * host without it gets the two-call shape alone. "accept" with the box
 * ticked is yes; decline, cancel or an unticked box is no.
 */
async function askPerson(
  server: McpServer,
  message: string,
): Promise<{ asked: boolean; yes: boolean }> {
  const caps = server.server.getClientCapabilities();
  if (!caps?.elicitation) return { asked: false, yes: true };
  const res = await server.server.elicitInput(
    {
      message,
      requestedSchema: {
        type: "object",
        properties: {
          proceed: { type: "boolean", title: "Proceed", description: "Tick to proceed." },
        },
        required: ["proceed"],
      },
    },
    // A person reading a contract takes longer than the SDK's minute; a
    // timeout is still a no (the SDK throws, nothing is written).
    { timeout: 10 * 60 * 1000 },
  );
  const yes =
    res.action === "accept" && (res.content as { proceed?: boolean } | undefined)?.proceed === true;
  return { asked: true, yes };
}

/** A preview result: the plan the CLI printed, the digest over `facts`, writes: false. */
export function previewText(preview: Record<string, unknown>, facts: unknown): ToolText {
  return text(JSON.stringify({ ...preview, digest: consentDigest(facts) }));
}

/**
 * What a matched confirm hands back: the only value the consented flags
 * are appended for. Opaque on purpose — a tool cannot make one.
 */
export interface Consent {
  readonly allowUnsigned: boolean;
  readonly allowUnscanned: boolean;
}

/**
 * One refusal a plan reports (agentry-cli#126): the gate it comes from,
 * what it says, and the flag that lifts it — absent when none does.
 */
export interface PlanRefusal {
  kind: string;
  message: string;
  lift?: string;
}

/**
 * Every refusal a plan reports, in the order a run meets them: the CLI's
 * `refusals` when it prints them, else its one deprecated `refusal`, whose
 * lift is what it always was here — the verdict's own flag for an unsigned
 * or unscanned release, none for anything else.
 */
export function planRefusals(
  p: { refusals?: PlanRefusal[]; refusal?: string },
  verdict: { unsigned: boolean; unscanned?: boolean },
): PlanRefusal[] {
  if (p.refusals !== undefined) return p.refusals;
  if (!p.refusal) return [];
  const lift = verdict.unsigned
    ? "--allow-unsigned"
    : verdict.unscanned
      ? "--allow-unscanned"
      : undefined;
  return [{ kind: "attestation", message: p.refusal, ...(lift ? { lift } : {}) }];
}

export interface ConfirmOptions {
  unsigned: boolean;
  acceptUnsigned?: boolean;
  /** The preview's verdict was `unscanned`: admitted without a scan. */
  unscanned?: boolean;
  acceptUnscanned?: boolean;
  /**
   * Every refusal the CLI's plan reported (planRefusals). One lifted by
   * --allow-unsigned on an unsigned release, or by --allow-unscanned on an
   * unscanned one, waits for that acceptance; any other stops the confirm,
   * since this server passes no other lift (--allow-vulnerable-mcp among
   * them) and the run would meet it.
   */
  refusals?: PlanRefusal[];
  /** What the person is asked through elicitation. */
  ask: string;
}

/**
 * The confirm half, shared by every writing tool: the digest must match
 * the re-run preview's facts, a refusal the person cannot lift stops it,
 * an unsigned release needs acceptUnsigned, an unscanned one
 * acceptUnscanned, and the person is asked when the host can ask. Returns the Consent, or the tool error to return.
 */
export async function confirmed(
  server: McpServer,
  tool: string,
  confirm: string,
  facts: unknown,
  o: ConfirmOptions,
): Promise<Consent | ToolText> {
  const digest = consentDigest(facts);
  if (confirm !== digest) {
    return text(
      `${tool}: the confirm digest does not match this preview (${confirm} vs ${digest}). ` +
        "Something changed since the preview was shown (the resolved version, the contract, the signature, the " +
        "plan, where it lands), or this call differs from the one previewed, or the digest was not taken from a " +
        "preview of this server. Preview again with exactly this call, show the person what it says, and confirm " +
        "with the digest that preview returned.",
      true,
    );
  }
  const liftedBy = (r: PlanRefusal): "unsigned" | "unscanned" | undefined =>
    r.lift === "--allow-unsigned" && o.unsigned
      ? "unsigned"
      : r.lift === "--allow-unscanned" && o.unscanned
        ? "unscanned"
        : undefined;
  const refusals = o.refusals ?? [];
  const standing = refusals.filter((r) => liftedBy(r) === undefined);
  if (standing.length > 0) {
    return text(
      `${tool}: the CLI would refuse this: ${standing.map((r) => r.message).join("; ")}`,
      true,
    );
  }
  const said = (by: "unsigned" | "unscanned") =>
    refusals
      .filter((r) => liftedBy(r) === by)
      .map((r) => r.message)
      .join("; ");
  if (o.unsigned && !o.acceptUnsigned) {
    return text(
      `${tool}: the release is unsigned${said("unsigned") ? ` (${said("unsigned")})` : ""}. Going ahead needs the person's explicit ` +
        "acceptance: confirm again with acceptUnsigned: true only if they said so.",
      true,
    );
  }
  if (o.unscanned && !o.acceptUnscanned) {
    return text(
      `${tool}: the release is unscanned: ${said("unscanned") || "the registry admitted it without a scan"}. ` +
        "Going ahead needs the person's explicit acceptance that nothing about its contents was checked: " +
        "confirm again with acceptUnscanned: true only if they said so. acceptUnsigned does not cover it.",
      true,
    );
  }
  const asked = await askPerson(server, o.ask);
  if (!asked.yes) return text(`${tool}: the person declined; nothing was done.`, true);
  return {
    allowUnsigned: o.unsigned && o.acceptUnsigned === true,
    allowUnscanned: o.unscanned === true && o.acceptUnscanned === true,
  };
}

/**
 * Appends the consented flags — the only place in the server that spells
 * them (CI greps): --yes for a matched confirm, --allow-unsigned only when
 * the preview said unsigned and the person accepted that, --allow-unscanned
 * only when the preview said unscanned and the person accepted that.
 */
export function consentedArgv(argv: string[], c: Consent): string[] {
  const out = [...argv, "--yes"];
  if (c.allowUnsigned) out.push("--allow-unsigned");
  if (c.allowUnscanned) out.push("--allow-unscanned");
  return out;
}

/** agentry_install: preview without `confirm`, write with it. */
export async function install(d: Driver, a: InstallArgs): Promise<ToolText> {
  const planned = await runPlan<InstallPlan>(d, "agentry_install (plan)", installPlanArgv(a));
  if (!planned.ok) return planned.result;
  const { plan, log } = planned;
  const facts = installFacts(plan);
  const unsigned = plan.attestation === "unsigned";
  const unscanned = plan.attestation === "unscanned";

  if (a.confirm === undefined) {
    return previewText({ plan, log: tail(log), unsigned, unscanned, writes: false }, facts);
  }
  const ok = await confirmed(d.server, "agentry_install", a.confirm, facts, {
    unsigned,
    acceptUnsigned: a.acceptUnsigned,
    unscanned,
    acceptUnscanned: a.acceptUnscanned,
    refusals: planRefusals(plan, { unsigned, unscanned }),
    ask:
      `Install ${plan.ref} to ${plan.dir} (${plan.target})? Contract: ${canonical(plan.contract)}. ` +
      `Attestation: ${plan.attestation}.${plan.reason ? ` The CLI would ask because: ${plan.reason}.` : ""}`,
  });
  if (!isConsent(ok)) return ok;

  // The write names the release the digest covered — plan.ref is resolved
  // (ns/name@version) — never the floating ref the call carried, so a
  // range that moves between the re-plan and the write cannot install a
  // release the person did not see.
  const argv = ["install", value("ref", plan.ref), "--json"];
  flag(argv, "target", a.target);
  flag(argv, "provider", a.provider);
  flag(argv, "dir", a.dir);
  flag(argv, "registry", a.registry);
  return d.run("agentry_install", consentedArgv(argv, ok));
}

/** A Consent, as against the tool error `confirmed` returns instead. */
export function isConsent(v: Consent | ToolText): v is Consent {
  return !("content" in v);
}

/** The uninstall plan the CLI prints. */
export interface UninstallPlan {
  ref: string;
  plan: boolean;
  installs: string[];
  profiles: string[];
  keptProfiles?: string[];
  consentRecord: boolean;
}

export interface UninstallArgs {
  ref: string;
  keepMcp?: boolean;
  confirm?: string;
}

/** agentry_uninstall: the same two calls; uninstall has no CLI gate, but a removal is a write. */
export async function uninstall(d: Driver, a: UninstallArgs): Promise<ToolText> {
  const planArgv = ["uninstall", value("ref", a.ref), "--plan", "--json"];
  if (a.keepMcp) planArgv.push("--keep-mcp");
  const planned = await runPlan<UninstallPlan>(d, "agentry_uninstall (plan)", planArgv);
  if (!planned.ok) return planned.result;
  const { plan, log } = planned;
  const facts = {
    ref: plan.ref,
    installs: plan.installs,
    profiles: plan.profiles,
    keptProfiles: plan.keptProfiles ?? [],
    consentRecord: plan.consentRecord,
  };
  if (a.confirm === undefined) {
    return previewText({ plan, log: tail(log), writes: false }, facts);
  }
  const ok = await confirmed(d.server, "agentry_uninstall", a.confirm, facts, {
    unsigned: false,
    ask: `Remove ${plan.ref} from this machine? Installs: ${plan.installs.join(", ") || "none"}. Profiles (keys, servers): ${plan.profiles.join(", ") || "none"}.`,
  });
  if (!isConsent(ok)) return ok;
  // Removal has no CLI gate, so no consented flag is needed; the Consent is
  // still what let this line run.
  const argv = ["uninstall", value("ref", a.ref), "--json"];
  if (a.keepMcp) argv.push("--keep-mcp");
  return d.run("agentry_uninstall", argv);
}
