/**
 * The result envelope every tool returns (plan D3): the CLI's own JSON
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
}

/** The tail of a stream, bounded so a long run's log does not swamp the host. */
export function tail(text: string, lines = 40, chars = 4000): string {
  const t = text.trimEnd().split("\n").slice(-lines).join("\n");
  return t.length > chars ? t.slice(-chars) : t;
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolResult = CallToolResult;

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
