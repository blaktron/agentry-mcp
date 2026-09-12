/**
 * Interactive sessions (plan mcp-cli-driver M5, D6): the CLI's `run --mode
 * interactive` on a pseudo-terminal the server owns, driven the way its own
 * chat is driven — a line typed, Enter, the reply. The CLI insists on a
 * terminal for an interactive run (the chat is the input) and offers no
 * JSON form of one (the transcript and receipts are the record), so the
 * server gives it the terminal it wants: `pty-host.py` forks the CLI on a
 * pty and pumps bytes both ways, no shell in between.
 *
 * The reply to a turn is read from the run's own events receipt
 * (`receipts/events.ndjson`), which the engine appends to as the session
 * goes — `assistant_turn` closes a turn with the full text, `session_end`
 * says why it is over — rather than scraped off the screen: the chat is a
 * full-screen redraw, and the receipt is the record anyway. Everything the
 * pty said is kept raw in `pty.log` beside the run's output folder, and its
 * last lines, control sequences stripped, are what an error names when the
 * CLI stopped before the receipt existed.
 *
 * One session per server process at a time (M5); a second start is refused
 * naming the open one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ArgumentError } from "./argv.js";
import type { Driver } from "./driver.js";
import { isRunConsent, runArgv, runConsent, taskInput, type RunArgs } from "./run.js";

/** How long the sandbox gets to come up before a start is given up on. */
const START_TIMEOUT_MS = 180_000;
/** The reply a turn waits for when the call names no limit. */
export const DEFAULT_TURN_TIMEOUT_SECONDS = 300;
/** After close asks the CLI to finish, how long its teardown gets before SIGINT, then SIGKILL. */
const CLOSE_GRACE_MS = 120_000;
const KILL_GRACE_MS = 30_000;
/** The terminal the CLI's chat is given. */
const COLS = 200;
const ROWS = 50;

/** One line of the engine's events receipt (pkg/runner/session). */
interface SessionEvent {
  kind: string;
  time?: string;
  text?: string;
  reason?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

/** Control sequences the chat paints with; stripped from screen text an error quotes. */
const CONTROL = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][B0]|\x1b[=>]|\x1b\][^\x07]*\x07|\r/g;

export function stripControl(s: string): string {
  return s.replace(CONTROL, "");
}

/** The last non-blank lines of the pty stream, readable. */
function screenTail(raw: string, lines = 12): string {
  return stripControl(raw)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-lines)
    .join("\n");
}

function text(t: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: "text", text: t }], isError: true }
    : { content: [{ type: "text", text: t }] };
}

function json(v: unknown): CallToolResult {
  return text(JSON.stringify(v));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The pty host beside the built server. */
export const PTY_HOST = fileURLToPath(new URL("./pty-host.py", import.meta.url));

/** Reads the events receipt as it grows, one JSON line at a time. */
class EventTail {
  private offset = 0;
  private partial = "";
  constructor(readonly path: string) {}

  /** Every whole line appended since the last call. */
  async next(): Promise<SessionEvent[]> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return [];
    }
    if (size <= this.offset) return [];
    const fh = await open(this.path, "r");
    try {
      const buf = Buffer.alloc(size - this.offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
      this.offset += bytesRead;
      const chunk = this.partial + buf.subarray(0, bytesRead).toString("utf8");
      const lines = chunk.split("\n");
      this.partial = lines.pop() ?? "";
      const out: SessionEvent[] = [];
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          out.push(JSON.parse(l) as SessionEvent);
        } catch {
          // A line the engine is still writing arrives whole on the next read.
        }
      }
      return out;
    } finally {
      await fh.close();
    }
  }
}

/** What a turn produced: the reply, the tools called, the usage, or the end. */
export interface Turn {
  reply?: string;
  toolCalls: string[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
  ended?: string;
  errors: string[];
}

export class PtySession {
  readonly id: string;
  readonly startedAt = new Date();
  private raw = "";
  private log: WriteStream;
  private exit: Promise<number>;
  private exitCode: number | null = null;
  private tail: EventTail;
  private endedReason: string | undefined;
  private busy = false;

  constructor(
    readonly child: ChildProcess,
    readonly ref: string,
    readonly outDir: string,
    readonly ptyLog: string,
    private readonly cleanup: () => Promise<void>,
  ) {
    this.id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.log = createWriteStream(ptyLog, { mode: 0o600 });
    this.tail = new EventTail(join(outDir, "receipts", "events.ndjson"));
    child.stdout?.on("data", (d: Buffer) => {
      this.log.write(d);
      // Keep the last 64 KB for the error path; the file has all of it.
      this.raw = (this.raw + d.toString("utf8")).slice(-65536);
    });
    child.stderr?.on("data", (d: Buffer) => {
      this.log.write(d);
      this.raw = (this.raw + d.toString("utf8")).slice(-65536);
    });
    this.exit = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        this.exitCode = code ?? (signal ? 128 : -1);
        this.log.end();
        resolve(this.exitCode);
      });
    });
  }

  get receiptsDir(): string {
    return join(this.outDir, "receipts");
  }

  get exited(): boolean {
    return this.exitCode !== null;
  }

  /** Why the session is over, once the receipt or the process said so. */
  async ended(): Promise<string | undefined> {
    if (this.endedReason) return this.endedReason;
    for (const ev of await this.tail.next()) {
      if (ev.kind === "session_end") this.endedReason = ev.reason ?? "ended";
    }
    if (!this.endedReason && this.exited) this.endedReason = "harness_exit";
    return this.endedReason;
  }

  /** Waits for the receipt to appear (the sandbox is up) or the CLI to stop. */
  async awaitStart(timeoutMs: number): Promise<{ ok: true } | { ok: false; why: string }> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.exited) {
        return {
          ok: false,
          why: `the CLI exited (${this.exitCode}) before the session started:\n${screenTail(this.raw)}`,
        };
      }
      try {
        await stat(this.tail.path);
        return { ok: true };
      } catch {
        await sleep(250);
      }
    }
    return {
      ok: false,
      why: `the session did not start within ${timeoutMs / 1000}s:\n${screenTail(this.raw)}`,
    };
  }

  /** Types one line into the chat. */
  private type(line: string): void {
    this.child.stdin?.write(line + "\r");
  }

  /**
   * One user turn: typed into the chat, then the receipt is read until the
   * assistant's turn closes, the session ends, or the limit passes.
   */
  async send(line: string, timeoutMs: number): Promise<Turn | { timedOut: true; partial: Turn }> {
    if (this.busy) throw new ArgumentError("a turn is already in progress on this session");
    this.busy = true;
    try {
      // Anything the receipt gained since the last turn is not this turn's.
      await this.tail.next();
      this.type(line);
      const turn: Turn = {
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        errors: [],
      };
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        for (const ev of await this.tail.next()) {
          switch (ev.kind) {
            case "assistant_turn":
              turn.reply = ev.text ?? "";
              break;
            case "tool_call":
              turn.toolCalls.push(ev.text ?? "");
              break;
            case "usage":
              turn.usage.inputTokens += ev.inputTokens ?? 0;
              turn.usage.outputTokens += ev.outputTokens ?? 0;
              turn.usage.totalTokens += ev.totalTokens ?? 0;
              turn.usage.costUsd = Math.max(turn.usage.costUsd, ev.costUsd ?? 0);
              break;
            case "error":
              turn.errors.push(ev.text ?? "");
              break;
            case "session_end":
              this.endedReason = ev.reason ?? "ended";
              turn.ended = this.endedReason;
              break;
          }
        }
        if (turn.reply !== undefined || turn.ended !== undefined) return turn;
        if (this.exited) {
          this.endedReason ??= "harness_exit";
          turn.ended = this.endedReason;
          return turn;
        }
        await sleep(200);
      }
      return { timedOut: true, partial: turn };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Ends the session: the chat's own command (/finish asks the agent for
   * its final result first; /quit does not), then the CLI's teardown; a
   * CLI still there afterwards gets SIGINT, then SIGKILL. Returns the exit
   * code and whether force was needed.
   */
  async close(finish: boolean): Promise<{ exitCode: number; forced: boolean }> {
    let forced = false;
    if (!this.exited) {
      this.type(finish ? "/finish" : "/quit");
      if (!(await this.waitExit(CLOSE_GRACE_MS))) {
        forced = true;
        this.child.kill("SIGINT");
        if (!(await this.waitExit(KILL_GRACE_MS))) this.child.kill("SIGKILL");
        await this.waitExit(5000);
      }
    }
    await this.cleanup();
    return { exitCode: this.exitCode ?? -1, forced };
  }

  private async waitExit(ms: number): Promise<boolean> {
    const t = sleep(ms).then(() => false);
    return Promise.race([this.exit.then(() => true), t]);
  }
}

/** The one open session, if any. */
let current: PtySession | undefined;

// The server going away must not leave a chat running on its own: the CLI
// gets the interrupt it handles (teardown, envelope, receipts).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    if (current && !current.exited) {
      current.child.kill("SIGINT");
      current.child.on("close", () => process.exit(0));
      setTimeout(() => process.exit(0), KILL_GRACE_MS).unref();
    } else {
      process.exit(0);
    }
  });
}
process.on("exit", () => {
  if (current && !current.exited) current.child.kill("SIGKILL");
});

export type SessionStartArgs = Omit<RunArgs, "timeoutSeconds">;

/**
 * agentry_session_start: the run's two-call consent in interactive mode,
 * then the CLI on a pty; returns when the sandbox is up.
 */
export async function sessionStart(d: Driver, a: SessionStartArgs): Promise<CallToolResult> {
  if (current) {
    return text(
      `agentry_session_start: session ${current.id} (${current.ref}) is open; one session at a time — ` +
        "send to it, or close it first (agentry_session_close).",
      true,
    );
  }
  const c = await runConsent(d, a, "interactive", "agentry_session_start");
  if (!isRunConsent(c)) return c;
  // The person was asked meanwhile; a start that raced this one wins.
  const raced = current as PtySession | undefined;
  if (raced) {
    return text(
      `agentry_session_start: session ${raced.id} was started while this one was being confirmed.`,
      true,
    );
  }
  // The output folder is where the receipt the server reads lives, so the
  // server names one when the call did not.
  const base = a.out ?? join(await mkdtemp(join(tmpdir(), "agentry-mcp-session-")), "out");
  const task = await taskInput(a);
  const argv = runArgv({ ...a, out: base }, c, "interactive", task.path);
  const child = spawn("python3", [PTY_HOST, String(COLS), String(ROWS), "--", d.bin, ...argv], {
    env: { ...process.env, TERM: "xterm-256color", ...d.env },
    cwd: d.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const session = new PtySession(child, c.plan.ref, base, `${base}.pty.log`, task.done);
  current = session;
  const started = await session.awaitStart(START_TIMEOUT_MS);
  if (!started.ok) {
    await session.close(false);
    current = undefined;
    return text(`agentry_session_start: ${started.why}`, true);
  }
  return json({
    sessionId: session.id,
    ref: session.ref,
    version: c.plan.version,
    mode: "interactive",
    outDir: base,
    receiptsDir: session.receiptsDir,
    ptyLog: session.ptyLog,
    startedAt: session.startedAt.toISOString(),
  });
}

export interface SessionSendArgs {
  sessionId: string;
  text: string;
  turnTimeoutSeconds?: number;
}

function open_(id: string, tool: string): PtySession | CallToolResult {
  if (!current)
    return text(`${tool}: no session is open; start one with agentry_session_start.`, true);
  if (current.id !== id)
    return text(`${tool}: session ${id} is not open; the open session is ${current.id}.`, true);
  return current;
}

/** agentry_session_send: one user turn in, the agent's reply out. */
export async function sessionSend(a: SessionSendArgs): Promise<CallToolResult> {
  const s = open_(a.sessionId, "agentry_session_send");
  if (!(s instanceof PtySession)) return s;
  const line = a.text.replace(/\r?\n/g, " ").trim();
  if (line === "") throw new ArgumentError("text must not be empty");
  if (line.startsWith("/")) {
    throw new ArgumentError(
      'text must not start with "/": the chat\'s own commands (/finish, /quit, /add, /caps) are not turns; close the session with agentry_session_close',
    );
  }
  const already = await s.ended();
  if (already) {
    return text(
      `agentry_session_send: session ${s.id} ended (${already}); nothing was sent. Close it with agentry_session_close for the transcript and receipts.`,
      true,
    );
  }
  const timeoutMs = (a.turnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS) * 1000;
  const r = await s.send(line, timeoutMs);
  if ("timedOut" in r) {
    return text(
      `agentry_session_send: no reply within ${timeoutMs / 1000}s; the session is still open and the agent may still be working` +
        (r.partial.toolCalls.length ? ` (tools so far: ${r.partial.toolCalls.join(", ")})` : "") +
        ". Send again with a longer turnTimeoutSeconds, or close the session.",
      true,
    );
  }
  return json({ sessionId: s.id, ...r });
}

export interface SessionCloseArgs {
  sessionId: string;
  finish?: boolean;
}

/** agentry_session_close: end the chat, wait for the CLI's teardown, name the record. */
export async function sessionClose(a: SessionCloseArgs): Promise<CallToolResult> {
  const s = open_(a.sessionId, "agentry_session_close");
  if (!(s instanceof PtySession)) return s;
  const reasonBefore = await s.ended();
  const { exitCode, forced } = await s.close(a.finish ?? true);
  current = undefined;
  const reason = (await s.ended()) ?? reasonBefore;
  let envelope:
    { status?: string; result?: unknown; error?: string; exitClass?: string } | undefined;
  try {
    const fh = await open(join(s.outDir, "result.json"), "r");
    try {
      envelope = JSON.parse(await fh.readFile("utf8")) as typeof envelope;
    } finally {
      await fh.close();
    }
  } catch {
    // No envelope: the CLI stopped before writing one; the exit code and the pty log say what happened.
  }
  return json({
    sessionId: s.id,
    ref: s.ref,
    reason,
    exitCode,
    forced,
    status: envelope?.status,
    result: envelope?.result,
    error: envelope?.error,
    transcript: join(s.receiptsDir, "transcript.md"),
    receiptsDir: s.receiptsDir,
    outDir: s.outDir,
    resultFile: join(s.outDir, "result.json"),
    ptyLog: s.ptyLog,
  });
}
