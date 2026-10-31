/**
 * Whether a run can start on this machine, read from `agentry doctor
 * --json` before the person is asked to confirm. The CLI's plan mode
 * compiles what a run would enforce, but it does not check what the run
 * would then need: the model key's variable set, the container engine
 * answering, the images present, the sign-in where the run needs one, and
 * each secret the release declares resolving. Doctor checks exactly those,
 * so the preview carries its report as `readiness`, and the digest covers
 * it: a readiness that changed between the two calls refuses the confirm.
 *
 * The report is the CLI's, passed through: this server reads only the
 * check names and statuses, and quotes each detail as written (the CLI
 * ends a failing detail with its remedy). Doctor exits in the `cli` class
 * when a check fails, with the report on stdout, so that class is the
 * answer here, not an error.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { flag, value } from "./argv.js";
import type { Driver } from "./driver.js";
import { toolText as text } from "./envelope.js";

/** One check as doctor reports it; `remedy` when the CLI prints one apart from the detail. */
export interface ReadinessCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  remedy?: string;
}

/** The readiness block a preview carries. */
export interface Readiness {
  /** No check failed: the run gets past the CLI's preflight, as far as doctor can tell. */
  ready: boolean;
  /** What doctor was asked about: this machine, or this machine and one release. */
  checked: string;
  /** Every check, as the CLI reported it. */
  checks: ReadinessCheck[];
  /**
   * One line each, in words: the model key, the engine, the images, the
   * registry sign-in, the release's secrets, and any other check that is
   * not ok, each with the CLI's own detail and remedy.
   */
  lines: string[];
}

/** What doctor is asked about beside the machine. */
export interface ReadinessTarget {
  /** The resolved release (ns/name@version) a run would use; doctor checks its install and declared secrets. */
  ref?: string;
  /** A workspace directory instead of a ref. */
  local?: string;
  policy?: string;
  registry?: string;
  adapter?: string;
}

/** Doctor's own timeout: it probes the engine, the registry and the advisories. */
const DOCTOR_TIMEOUT_MS = 120_000;

/**
 * The facets a person reads first, in this order, and the check names each
 * gathers (a name, or a prefix ending in ":" or "."). Every other failing or
 * warning check follows under its own name.
 */
const FACETS: { label: string; names: string[] }[] = [
  { label: "model key", names: ["model", "model:"] },
  { label: "container engine", names: ["docker", "docker:"] },
  { label: "images", names: ["image:"] },
  { label: "registry", names: ["registry"] },
  { label: "secrets", names: ["secrets", "profile"] },
];

function inFacet(check: ReadinessCheck, names: string[]): boolean {
  return names.some((n) =>
    n.endsWith(":") || n.endsWith(".") ? check.name.startsWith(n) : check.name === n,
  );
}

function isCheck(v: unknown): v is ReadinessCheck {
  const o = v as Partial<ReadinessCheck> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.name === "string" &&
    (o.status === "ok" || o.status === "warn" || o.status === "fail") &&
    (o.detail === undefined || typeof o.detail === "string") &&
    (o.remedy === undefined || typeof o.remedy === "string")
  );
}

/** A check in words: its status, the CLI's detail, and the remedy when it is a field of its own. */
function describe(c: ReadinessCheck): string {
  const state = c.status === "ok" ? "ok" : c.status === "warn" ? "warning" : "not ready";
  const words = [c.detail, c.remedy].filter((s): s is string => Boolean(s)).join(" — ");
  return words ? `${state}: ${words}` : state;
}

/** The readiness lines, one per facet, then every other check that is not ok. */
export function readinessLines(checks: ReadinessCheck[]): string[] {
  const lines: string[] = [];
  const taken = new Set<ReadinessCheck>();
  for (const facet of FACETS) {
    const own = checks.filter((c) => inFacet(c, facet.names));
    for (const c of own) taken.add(c);
    if (own.length === 0) {
      lines.push(`${facet.label}: not checked`);
      continue;
    }
    // One line: the facet's failing checks when any, else its warnings,
    // else the checks that passed (an image set is several checks).
    const worst = own.some((c) => c.status === "fail")
      ? own.filter((c) => c.status === "fail")
      : own.some((c) => c.status === "warn")
        ? own.filter((c) => c.status === "warn")
        : own;
    const said =
      worst.length === 1 && own.length === 1
        ? describe(worst[0]!)
        : worst.map((c) => `${c.name} ${describe(c)}`).join("; ");
    lines.push(`${facet.label}: ${said}`);
  }
  for (const c of checks) {
    if (taken.has(c) || c.status === "ok") continue;
    lines.push(`${c.name}: ${describe(c)}`);
  }
  return lines;
}

/**
 * Runs doctor for the target and reads its report into the readiness block,
 * or returns the tool error to hand back: the CLI could not run, exited in
 * a class other than ok or cli, or printed a report this server cannot
 * read. A report it cannot read is never taken as ready.
 */
export async function readiness(
  d: Driver,
  tool: string,
  target: ReadinessTarget = {},
): Promise<Readiness | CallToolResult> {
  const argv = ["doctor"];
  if (target.ref !== undefined) argv.push(value("ref", target.ref));
  argv.push("--json");
  flag(argv, "local", target.local);
  flag(argv, "policy", target.policy);
  flag(argv, "registry", target.registry);
  flag(argv, "adapter", target.adapter);
  const r = await d.run(`${tool} (readiness)`, argv, { timeoutMs: DOCTOR_TIMEOUT_MS });
  if (r.isError) return r;
  const env = JSON.parse((r.content[0] as { text: string }).text) as {
    result?: { ref?: string; checks?: unknown };
    exitClass: string;
  };
  if (env.exitClass !== "ok" && env.exitClass !== "cli") return { ...r, isError: true };
  const checks = env.result?.checks;
  if (!Array.isArray(checks) || !checks.every(isCheck)) {
    return text(
      `${tool}: the CLI's doctor report carries checks this server cannot read; nothing was done. ` +
        "Run `agentry doctor` in a terminal to see the machine's state.",
      true,
    );
  }
  const where =
    target.local !== undefined
      ? `this machine and the workspace ${target.local}`
      : target.ref !== undefined
        ? `this machine and ${target.ref}`
        : "this machine";
  return {
    ready: !checks.some((c) => c.status === "fail"),
    checked: where,
    checks: checks.map((c) => ({
      name: c.name,
      status: c.status,
      ...(c.detail !== undefined ? { detail: c.detail } : {}),
      ...(c.remedy !== undefined ? { remedy: c.remedy } : {}),
    })),
    lines: readinessLines(checks),
  };
}

export function isReadiness(v: Readiness | CallToolResult): v is Readiness {
  return !("content" in v);
}

/** The readiness in words, for the summary a person reads: whether it can start, then each line. */
export function readinessWords(r: Readiness): string[] {
  return [
    r.ready
      ? `Ready to start: yes (agentry doctor checked ${r.checked}).`
      : `Ready to start: no — a run would fail at the CLI's preflight (agentry doctor checked ${r.checked}).`,
    ...r.lines.map((l) => `  ${l}`),
  ];
}
