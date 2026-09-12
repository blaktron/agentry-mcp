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
 * pty said is kept raw in `<out>.pty.log` beside the run's output folder,
 * and its last lines, control sequences stripped, are what an error names
 * when the CLI stopped before the chat was up.
 *
 * One session per server at a time (M5), held on the Driver; a second
 * start is refused naming the open one.
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
import { toolJSON as json, toolText as text } from "./envelope.js";
import { isRunConsent, runArgv, runConsent, taskInput, type RunArgs } from "./run.js";

/** How long the sandbox gets to come up before a start is given up on. */
const START_TIMEOUT_MS = 180_000;
/** The reply a turn waits for when the call names no limit. */
export const DEFAULT_TURN_TIMEOUT_SECONDS = 300;
/** After close asks the CLI to finish, how long its teardown gets before SIGINT, then SIGKILL. */
const CLOSE_GRACE_MS = 120_000;
const KILL_GRACE_MS = 30_000;
/** How long a typed turn may go unrecorded before Enter is pressed again. */
const ENTER_RETRY_MS = 5_000;
/** After the chat's status line shows, a moment for its input reader to be up too. */
const SETTLE_MS = 300;
/** How often the receipt is read for new lines. */
const POLL_MS = 200;
/** After SIGKILL, how long the process gets to be reaped before the close returns. */
const REAP_MS = 5_000;
/** How much of the pty stream is kept in memory for the error path; the file has all of it. */
const SCREEN_KEEP = 65536;
/** The terminal the CLI's chat is given. */
const COLS = 200;
const ROWS = 50;
/** A C0 control byte or DEL: a key the chat would act on, not text. */
const CONTROL_BYTE = /[\x00-\x1f\x7f]/;

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

/** The chat's status line (`… · interactive · turns N/M · …`): on the screen, the chat is up. */
const STATUS_LINE = /· interactive · turns \d+/;

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
          // Not the engine's JSON: kept out of the turn, left in the file.
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
  /** The receipt recorded the user turn (Enter was taken). */
  taken: boolean;
  reply?: string;
  toolCalls: string[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
  ended?: string;
  errors: string[];
}

/** How a send came out: the reply to this text, the late reply to an earlier one, a timeout, or the end. */
export type SendOutcome =
  | { kind: "reply"; turn: Turn; text: string }
  | { kind: "late"; turn: Turn; text: string }
  | { kind: "timeout"; turn: Turn; text: string }
  | { kind: "ended"; reason: string };

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
  /** The text of a turn that went unanswered within its limit; the chat is still on it. */
  private awaiting: string | undefined;

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
      this.raw = (this.raw + d.toString("utf8")).slice(-SCREEN_KEEP);
    });
    child.stderr?.on("data", (d: Buffer) => {
      this.log.write(d);
      this.raw = (this.raw + d.toString("utf8")).slice(-SCREEN_KEEP);
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
    this.absorb(await this.tail.next(), undefined);
    if (!this.endedReason && this.exited) this.endedReason = "harness_exit";
    return this.endedReason;
  }

  /** Folds receipt lines into a turn (when one is open) and notes the end. */
  private absorb(events: SessionEvent[], turn: Turn | undefined): void {
    for (const ev of events) {
      switch (ev.kind) {
        case "user_turn":
          if (turn) turn.taken = true;
          break;
        case "assistant_turn":
          if (turn) turn.reply = ev.text ?? "";
          break;
        case "tool_call":
          if (turn) turn.toolCalls.push(ev.text ?? "");
          break;
        case "usage":
          if (turn) {
            turn.usage.inputTokens += ev.inputTokens ?? 0;
            turn.usage.outputTokens += ev.outputTokens ?? 0;
            turn.usage.totalTokens += ev.totalTokens ?? 0;
            // The engine reports cost as a running total, not a delta.
            turn.usage.costUsd = Math.max(turn.usage.costUsd, ev.costUsd ?? 0);
          }
          break;
        case "error":
          if (turn) turn.errors.push(ev.text ?? "");
          break;
        case "session_end":
          this.endedReason = ev.reason ?? "ended";
          if (turn) turn.ended = this.endedReason;
          break;
      }
    }
  }

  /**
   * Waits for the chat to be up — its status line on the screen, which the
   * CLI paints only once the sandbox is up and its chat is reading the
   * terminal in raw mode — or for the CLI to stop. The receipt alone is
   * too early: it exists while the harness is still shaking hands, and a
   * line typed before the chat owns the terminal is cooked by the line
   * discipline (Enter arrives as a newline the chat does not submit on).
   */
  async awaitStart(timeoutMs: number): Promise<{ ok: true } | { ok: false; why: string }> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.exited) {
        return {
          ok: false,
          why: `the CLI exited (${this.exitCode}) before the session started:\n${screenTail(this.raw)}`,
        };
      }
      if (STATUS_LINE.test(stripControl(this.raw))) {
        await sleep(SETTLE_MS);
        return { ok: true };
      }
      await sleep(POLL_MS);
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
   * One user turn. Typed into the chat, then the receipt is read until the
   * assistant's turn closes, the session ends, or the limit passes — in
   * which case the chat is still answering, and the next send waits for
   * that answer instead of typing (a busy chat drops the line): it comes
   * back as the late reply to the earlier text, and `sent` says the new
   * text was not sent.
   */
  async send(line: string, timeoutMs: number): Promise<SendOutcome> {
    if (this.busy) throw new ArgumentError("a turn is already in progress on this session");
    this.busy = true;
    try {
      const turn: Turn = {
        taken: false,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        errors: [],
      };
      // What the receipt gained since the last turn: the end of the
      // session, or the answer to a turn that went past its limit.
      const late = this.awaiting;
      this.absorb(await this.tail.next(), late === undefined ? undefined : turn);
      if (this.endedReason) return { kind: "ended", reason: this.endedReason };
      if (late !== undefined) {
        turn.taken = true;
        this.awaiting = undefined;
        if (turn.reply === undefined) {
          const got = await this.awaitTurn(turn, timeoutMs, false);
          if (got === "timeout") {
            this.awaiting = late;
            return { kind: "timeout", turn, text: late };
          }
        }
        return { kind: "late", turn, text: late };
      }
      this.type(line);
      const got = await this.awaitTurn(turn, timeoutMs, true);
      if (got === "timeout") {
        this.awaiting = line;
        return { kind: "timeout", turn, text: line };
      }
      return { kind: "reply", turn, text: line };
    } finally {
      this.busy = false;
    }
  }

  /** Reads the receipt until the turn has its reply or its end, or the limit passes. */
  private async awaitTurn(
    turn: Turn,
    timeoutMs: number,
    retryEnter: boolean,
  ): Promise<"done" | "timeout"> {
    const until = Date.now() + timeoutMs;
    // An Enter the chat missed is pressed once more (on an empty input it does nothing).
    let retryAt = retryEnter ? Date.now() + ENTER_RETRY_MS : Number.POSITIVE_INFINITY;
    while (Date.now() < until) {
      if (!turn.taken && Date.now() > retryAt) {
        this.child.stdin?.write("\r");
        retryAt = Number.POSITIVE_INFINITY;
      }
      this.absorb(await this.tail.next(), turn);
      if (turn.reply !== undefined || turn.ended !== undefined) return "done";
      if (this.exited) {
        this.endedReason ??= "harness_exit";
        turn.ended = this.endedReason;
        return "done";
      }
      await sleep(POLL_MS);
    }
    return "timeout";
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
        await this.waitExit(REAP_MS);
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

/**
 * The server going away must not leave a chat running on its own: on the
 * server's own interrupt, and when the host closes the transport, the CLI
 * gets the interrupt it handles (teardown, envelope, receipts). Installed
 * by the entry point, not at import.
 */
export function installShutdown(d: Driver): void {
  const stop = (then: () => void) => {
    const s = d.sessions.current;
    if (s && !s.exited) {
      s.child.kill("SIGINT");
      s.child.once("close", then);
      setTimeout(then, KILL_GRACE_MS).unref();
    } else {
      then();
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => stop(() => process.exit(0)));
  }
  process.on("exit", () => {
    const s = d.sessions.current;
    if (s && !s.exited) s.child.kill("SIGKILL");
  });
  d.server.server.onclose = () => stop(() => {});
}

export type SessionStartArgs = Omit<RunArgs, "timeoutSeconds">;

/**
 * agentry_session_start: the run's two-call consent in interactive mode,
 * then the CLI on a pty; returns when the sandbox is up.
 */
export async function sessionStart(d: Driver, a: SessionStartArgs): Promise<CallToolResult> {
  const slot = d.sessions;
  const open = slot.current;
  if (open) {
    return text(
      `agentry_session_start: session ${open.id} (${open.ref}) is open; one session at a time — ` +
        "send to it, or close it first (agentry_session_close).",
      true,
    );
  }
  const c = await runConsent(d, a, "interactive", "agentry_session_start");
  if (!isRunConsent(c)) return c;
  // The person was asked meanwhile; a start that raced this one holds the
  // slot, from here (no await between the check and the claim) until it
  // has spawned or failed.
  if (slot.current || slot.reserved) {
    return text(
      "agentry_session_start: another session was started while this one was being confirmed.",
      true,
    );
  }
  slot.reserved = true;
  let session: PtySession;
  try {
    // The output folder is where the receipt the server reads lives, so
    // the server names one when the call did not.
    const base = a.out ?? join(await mkdtemp(join(tmpdir(), "agentry-mcp-session-")), "out");
    const task = await taskInput(a);
    const argv = runArgv({ ...a, out: base }, c, "interactive", task.path);
    const child = spawn("python3", [PTY_HOST, String(COLS), String(ROWS), "--", d.bin, ...argv], {
      env: { ...process.env, TERM: "xterm-256color", ...d.env },
      cwd: d.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    session = new PtySession(child, c.plan.ref, base, `${base}.pty.log`, task.done);
    slot.current = session;
  } finally {
    slot.reserved = false;
  }
  const started = await session.awaitStart(START_TIMEOUT_MS);
  if (!started.ok) {
    await session.close(false);
    slot.current = undefined;
    return text(`agentry_session_start: ${started.why}`, true);
  }
  return json({
    sessionId: session.id,
    ref: session.ref,
    version: c.plan.version,
    mode: "interactive",
    outDir: session.outDir,
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

/** The open session under that id, or the tool error naming what is open. */
function openSession(d: Driver, id: string, tool: string): PtySession | CallToolResult {
  const s = d.sessions.current;
  if (!s) return text(`${tool}: no session is open; start one with agentry_session_start.`, true);
  if (s.id !== id)
    return text(`${tool}: session ${id} is not open; the open session is ${s.id}.`, true);
  return s;
}

/**
 * The text as one line the chat takes as a turn: newlines fold to spaces,
 * and anything the chat would act on rather than read — a control byte
 * (a carriage return submits, an escape quits) or a leading slash (the
 * chat's own commands: /add would hand the run a host file consent never
 * covered) — is refused.
 */
export function turnLine(textIn: string): string {
  const line = textIn.replace(/\r?\n/g, " ").trim();
  if (line === "") throw new ArgumentError("text must not be empty");
  if (CONTROL_BYTE.test(line)) {
    throw new ArgumentError(
      "text must be plain text: a control character is a key the chat would act on, not a turn",
    );
  }
  if (line.startsWith("/")) {
    throw new ArgumentError(
      'text must not start with "/": the chat\'s own commands (/finish, /quit, /add, /caps) are not turns; close the session with agentry_session_close',
    );
  }
  return line;
}

/** agentry_session_send: one user turn in, the agent's reply out. */
export async function sessionSend(d: Driver, a: SessionSendArgs): Promise<CallToolResult> {
  const s = openSession(d, a.sessionId, "agentry_session_send");
  if (!(s instanceof PtySession)) return s;
  const line = turnLine(a.text);
  const timeoutMs = (a.turnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS) * 1000;
  const r = await s.send(line, timeoutMs);
  switch (r.kind) {
    case "ended":
      return text(
        `agentry_session_send: session ${s.id} ended (${r.reason}); nothing was sent. Close it with agentry_session_close for the transcript and receipts.`,
        true,
      );
    case "timeout":
      return text(
        `agentry_session_send: no reply to ${JSON.stringify(r.text)} within ${timeoutMs / 1000}s; the session is still open and the agent is still on it` +
          (r.turn.toolCalls.length ? ` (tools so far: ${r.turn.toolCalls.join(", ")})` : "") +
          ". Send again to wait for that reply (the new text is held back until it arrives), or close the session.",
        true,
      );
    case "late":
      return json({
        sessionId: s.id,
        sent: false,
        lateReplyTo: r.text,
        ...r.turn,
        note: `the reply to the earlier turn ${JSON.stringify(r.text)}; ${JSON.stringify(line)} was not sent — send it again`,
      });
    case "reply":
      return json({ sessionId: s.id, sent: true, ...r.turn });
  }
}

export interface SessionCloseArgs {
  sessionId: string;
  finish?: boolean;
}

/** agentry_session_close: end the chat, wait for the CLI's teardown, name the record. */
export async function sessionClose(d: Driver, a: SessionCloseArgs): Promise<CallToolResult> {
  const s = openSession(d, a.sessionId, "agentry_session_close");
  if (!(s instanceof PtySession)) return s;
  const reasonBefore = await s.ended();
  const { exitCode, forced } = await s.close(a.finish ?? true);
  d.sessions.current = undefined;
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
