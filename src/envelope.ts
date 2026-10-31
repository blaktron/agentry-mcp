/**
 * The result envelope every tool returns: the CLI's own JSON
 * passed through, the exit class named, and the stderr tail as `log` — the
 * server parses no prose. An exit class other than ok is an MCP tool error
 * whose text names the class and quotes the CLI's last lines, so the host
 * can act on what the CLI said rather than on a guess.
 */

import type { CliResult } from "./cli.js";

/** The §R8 exit-code taxonomy of the CLI (pkg/runner/engine). */
export const EXIT_CLASSES: Record<number, string> = {
  0: "ok",
  1: "cli",
  2: "usage",
  10: "verify",
  11: "policy",
  12: "compile",
  13: "gateway",
  14: "harness",
  15: "timeout",
  16: "budget",
  17: "outputSchema",
  // The agent could not do its task with what the run had, by its own
  // end_blocked or the runner's evidence.
  18: "blocked",
};

export function exitClass(code: number): string {
  return EXIT_CLASSES[code] ?? `exit-${code}`;
}

/**
 * What the tool returns when the CLI answered with JSON: the parsed stdout
 * and the exit class. A non-zero class beside a JSON result is the CLI
 * reporting through its own shape — `doctor` writes its report and exits
 * `cli` when a check fails, `verify --strict` writes its verdict and exits
 * `verify` — so the report is the answer, not an error.
 */
export interface Envelope {
  /** The CLI's parsed stdout. */
  result: unknown;
  exitClass: string;
  /** The last lines of the CLI's stderr: its narration, never its result. */
  log: string;
  /** Set when the server's timeout interrupted the process and the CLI then exited by itself. */
  timedOut?: boolean;
}

/** The tail of a stream, bounded so a long run's log does not swamp the host. */
export function tail(text: string, lines = 40, chars = 4000): string {
  const t = text.trimEnd().split("\n").slice(-lines).join("\n");
  return t.length > chars ? t.slice(-chars) : t;
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolResult = CallToolResult;

/** A text result; isError marks the tool's own refusal or failure. */
export function toolText(t: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: "text", text: t }], isError: true }
    : { content: [{ type: "text", text: t }] };
}

/** A JSON result. */
export function toolJSON(v: unknown): ToolResult {
  return toolText(JSON.stringify(v));
}

/**
 * Turns a finished CLI process into the tool result: the envelope whenever
 * stdout is JSON, whatever the exit class (the class is in the envelope);
 * an error naming the exit class when there is no JSON to pass through;
 * and an error when the CLI exits 0 with something that is not JSON (a
 * bug, never parsed as prose).
 */
export function toToolResult(what: string, r: CliResult): ToolResult {
  if (r.spawnError) {
    return errorResult(`${what}: the CLI could not run (${r.spawnError}).`, r.stderr);
  }
  const cls = exitClass(r.code);
  const parsed = parseJSON(r.stdout);
  if (parsed !== undefined) {
    const env: Envelope = { result: parsed.value, exitClass: cls, log: tail(r.stderr) };
    if (r.timedOut) env.timedOut = true;
    return { content: [{ type: "text", text: JSON.stringify(env) }] };
  }
  if (r.code !== 0) {
    return errorResult(`${what}: the CLI exited ${r.code} (${cls}).`, r.stderr);
  }
  return errorResult(
    `${what}: the CLI exited 0 but its stdout was not JSON (starts ${JSON.stringify(r.stdout.trim().slice(0, 120))}); ` +
      `this server passes the CLI's JSON through and never reads its prose.`,
    r.stderr,
  );
}

/**
 * The exit-class words the CLI prints beside `exitClass` when it has them:
 * the class's name, its meaning in a phrase, and whether retrying the same
 * run is likely to help. Carried beside the server's own `exitClass` when
 * the CLI's envelope has them, absent otherwise.
 */
export interface ExitClassWords {
  exitClassName?: string;
  exitClassMeaning?: string;
  retryLikelyHelps?: boolean;
}

export function exitClassWords(result: unknown): ExitClassWords {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return {};
  const out: ExitClassWords = {};
  if (typeof r.exitClassName === "string") out.exitClassName = r.exitClassName;
  if (typeof r.exitClassMeaning === "string") out.exitClassMeaning = r.exitClassMeaning;
  if (typeof r.retryLikelyHelps === "boolean") out.retryLikelyHelps = r.retryLikelyHelps;
  return out;
}

/**
 * The result of a tool that started a run (a QuickAgent run, a draft, a
 * review, a build): the envelope as the CLI wrote it, and `isError` set
 * when its exit class is not ok, so a host reads a classed failure as the
 * failure it is and never as a finished run. The envelope stays the
 * content: the class, the CLI's reason and the receipts are what the host
 * acts on. A result that is already an error, or not JSON, is returned as
 * it is.
 */
export function runOutcome(r: ToolResult): ToolResult {
  if (r.isError) return r;
  const first = r.content[0];
  if (!first || first.type !== "text") return r;
  const parsed = parseJSON(first.text);
  if (parsed === undefined) return r;
  const env = parsed.value as (Envelope & ExitClassWords & { result?: unknown }) | null;
  if (!env || typeof env !== "object" || typeof env.exitClass !== "string") return r;
  const withWords = { ...env, ...exitClassWords(env.result) };
  const content = [
    { type: "text" as const, text: JSON.stringify(withWords) },
    ...r.content.slice(1),
  ];
  return env.exitClass === "ok" ? { ...r, content } : { ...r, content, isError: true };
}

function parseJSON(text: string): { value: unknown } | undefined {
  if (text.trim() === "") return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function errorResult(message: string, stderr: string): ToolResult {
  const log = tail(stderr);
  return {
    content: [{ type: "text", text: log ? `${message}\n\n${log}` : message }],
    isError: true,
  };
}
