/** Interactive sessions over the CLI JSON-line protocol; events arrive on fd 3. */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, open, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import type { Readable } from "node:stream";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createHash } from "node:crypto";
import { confirmed, isConsent, previewText } from "./consent.js";
import { fingerprint } from "./snapshot.js";
import { ArgumentError } from "./argv.js";
import type { Driver } from "./driver.js";
import { toolJSON as json, toolText as text } from "./envelope.js";
import { isRunConsent, runArgv, runConsent, taskInput, type RunArgs } from "./run.js";

/** The reply a turn waits for when the call names no limit. */
export const DEFAULT_TURN_TIMEOUT_SECONDS = 300;
/** After close asks the CLI to finish, how long its teardown gets before SIGINT, then SIGKILL. */
const CLOSE_GRACE_MS = 120_000;
const KILL_GRACE_MS = 30_000;
const POLL_MS = 20;
/** After SIGKILL, how long the process gets to be reaped before the close returns. */
const REAP_MS = 5_000;
/** How much of the CLI stream is kept in memory for the error path; the file has all of it. */
const SCREEN_KEEP = 65536;
/** One line of the engine's events receipt (pkg/runner/session). */
interface SessionEvent {
  kind: string;
  refused?: string;
  time?: string;
  text?: string;
  reason?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The fd-3 event stream, decoded across chunk boundaries. */
class EventStream {
  private queue: SessionEvent[] = [];
  private queuedBytes = 0;
  private partial = "";
  problem?: string;
  constructor(stream: Readable) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (this.problem) return;
      this.partial += chunk;
      const lines = this.partial.split("\n");
      this.partial = lines.pop() ?? "";
      if (this.partial.length > 16 << 20) {
        this.problem = "protocol event exceeded 16 MiB";
        this.partial = "";
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as SessionEvent;
          if (typeof event.kind !== "string") throw new Error("missing kind");
          // Streamed fragments have a full assistant_turn later and need no storage.
          if (event.kind === "assistant_text") continue;
          this.queuedBytes += Buffer.byteLength(line);
          if (this.queuedBytes > 16 << 20) {
            this.problem = "session events exceeded 16 MiB; close the session for its receipts";
            this.queue = [];
            break;
          }
          this.queue.push(event);
        } catch {
          this.problem = "the CLI emitted an invalid protocol event";
        }
      }
    });
    stream.on("error", (err) => {
      this.problem = err.message;
    });
  }
  async next(): Promise<SessionEvent[]> {
    this.queuedBytes = 0;
    return this.queue.splice(0);
  }
}

/** What a turn produced: the reply, the tools called, the usage, or the end. */
export interface Turn {
  /** The receipt recorded the user turn (the protocol took it). */
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

export class ProtocolSession {
  readonly id: string;
  readonly startedAt = new Date();
  private raw = "";
  private closing = false;
  private log: WriteStream;
  private exit: Promise<number>;
  private exitCode: number | null = null;
  private tail: EventStream;
  private endedReason: string | undefined;
  private busy = false;
  /** The text of a turn that went unanswered within its limit; the chat is still on it. */
  private awaiting: string | undefined;
  private pendingTurn: Turn | undefined;

  constructor(
    readonly child: ChildProcess,
    readonly ref: string,
    readonly outDir: string,
    readonly cliLog: string,
    private readonly cleanup: () => Promise<void>,
    readonly inputsDir: string,
    opening?: string,
  ) {
    if (opening?.trim()) this.awaiting = opening;
    this.id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.log = createWriteStream(cliLog, { mode: 0o600 });
    this.log.on("error", (err) => {
      this.endedReason = `CLI log failed: ${err.message}`;
      child.kill("SIGINT");
    });
    this.tail = new EventStream(child.stdio[3] as Readable);
    child.stdin?.on("error", () => {});
    child.on("error", (err) => {
      this.endedReason = `spawn failed: ${err.message}`;
    });
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
          if (turn) turn.errors.push(`${ev.refused ? `${ev.refused}: ` : ""}${ev.text ?? ""}`);
          break;
        case "session_end":
          this.endedReason = ev.reason ?? "ended";
          if (turn) turn.ended = this.endedReason;
          break;
      }
    }
  }

  /** There is no ready event: start reports a launched process, not sandbox readiness. */
  async awaitStart(): Promise<{ ok: true } | { ok: false; why: string }> {
    return new Promise((resolve) => {
      this.child.once("spawn", () => resolve({ ok: true }));
      this.child.once("error", (err) => resolve({ ok: false, why: err.message }));
    });
  }

  /** Send text as JSON data. */
  private type(line: string): void {
    this.child.stdin?.write(JSON.stringify({ send: { text: line } }) + "\n");
  }

  /** A timed-out turn remains pending; a later call collects it before sending more. */
  async send(line: string, timeoutMs: number): Promise<SendOutcome> {
    if (this.closing) throw new ArgumentError("the session is closing");
    if (this.busy) throw new ArgumentError("a turn is already in progress on this session");
    this.busy = true;
    try {
      const turn: Turn = this.pendingTurn ?? {
        taken: false,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        errors: [],
      };
      // What the receipt gained since the last turn: the end of the
      // session, or the answer to a turn that went past its limit.
      const late = this.awaiting;
      this.absorb(await this.tail.next(), late === undefined ? undefined : turn);
      if (this.endedReason || this.exited)
        return {
          kind: "ended",
          reason: this.endedReason ?? `CLI exited ${this.exitCode}: ${this.raw.slice(-4000)}`,
        };
      if (late !== undefined) {
        turn.taken = true;
        this.awaiting = undefined;
        if (turn.reply === undefined) {
          const got = await this.awaitTurn(turn, timeoutMs);
          if (got === "timeout") {
            this.awaiting = late;
            this.pendingTurn = turn;
            return { kind: "timeout", turn, text: late };
          }
        }
        this.pendingTurn = undefined;
        return { kind: "late", turn, text: late };
      }
      this.type(line);
      const got = await this.awaitTurn(turn, timeoutMs);
      if (got === "timeout") {
        this.awaiting = line;
        this.pendingTurn = turn;
        return { kind: "timeout", turn, text: line };
      }
      this.pendingTurn = undefined;
      return { kind: "reply", turn, text: line };
    } finally {
      this.busy = false;
    }
  }

  /** Reads the receipt until the turn has its reply or its end, or the limit passes. */
  private async awaitTurn(turn: Turn, timeoutMs: number): Promise<"done" | "timeout"> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      this.absorb(await this.tail.next(), turn);
      if (this.tail.problem) throw new ArgumentError(this.tail.problem);
      if (turn.reply !== undefined || turn.ended !== undefined || turn.errors.length > 0)
        return "done";
      if (this.exited) {
        this.endedReason ??= "harness_exit";
        turn.ended = this.endedReason;
        return "done";
      }
      await sleep(POLL_MS);
    }
    return "timeout";
  }

  /** A consented file add, never an arbitrary protocol command. */
  async add(path: string, content: Buffer): Promise<void> {
    if (this.busy || this.awaiting !== undefined || this.closing)
      throw new ArgumentError("a turn is in progress; collect its reply before adding a file");
    if (this.exited || this.endedReason) throw new ArgumentError("the session has ended");
    this.busy = true;
    try {
      const staged = join(this.inputsDir, basename(path));
      await writeFile(staged, content, { flag: "wx", mode: 0o600 });
      this.awaiting = `input added: ${basename(path)}`;
      this.child.stdin?.write(JSON.stringify({ add: { path: staged } }) + "\n");
    } catch (err) {
      throw new ArgumentError(`cannot stage input: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Ask the CLI to end, then interrupt and kill only when its teardown stalls. */
  async close(finish: boolean): Promise<{ exitCode: number; forced: boolean }> {
    this.closing = true;
    let forced = false;
    if (!this.exited) {
      this.child.stdin?.write(JSON.stringify({ end: { finish } }) + "\n");
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
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.exit.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
      const hard = setTimeout(() => s.child.kill("SIGKILL"), KILL_GRACE_MS);
      hard.unref();
      s.child.once("close", () => {
        clearTimeout(hard);
        void s.close(false).finally(then);
      });
    } else if (s) {
      void s.close(false).finally(then);
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

export type SessionStartArgs = RunArgs;

/** Preview/confirm, then launch the CLI with a dedicated event pipe. */
export async function sessionStart(d: Driver, a: SessionStartArgs): Promise<CallToolResult> {
  if (process.platform === "win32")
    return text(
      "agentry_session_start: the CLI session protocol is unavailable on Windows; use agentry run in a terminal.",
      true,
    );
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
  let session: ProtocolSession;
  let taskCleanup: (() => Promise<void>) | undefined;
  let inputsCleanup: (() => Promise<void>) | undefined;
  try {
    // The output folder is where the receipt the server reads lives, so
    // the server names one when the call did not.
    const base = resolve(
      d.cwd ?? process.cwd(),
      a.out ?? join(await mkdtemp(join(tmpdir(), "agentry-mcp-session-")), "out"),
    );
    const task = await taskInput(a);
    taskCleanup = task.done;
    const inputsDir = await mkdtemp(join(tmpdir(), "agentry-mcp-inputs-"));
    inputsCleanup = () => rm(inputsDir, { recursive: true, force: true });
    const argv = runArgv({ ...a, out: base }, c, "interactive", task.path);
    await mkdir(resolve(d.cwd ?? process.cwd(), base), { recursive: true });
    argv.push("--session-inputs", inputsDir);
    const opening = task.path
      ? await readFile(resolve(d.cwd ?? process.cwd(), task.path), "utf8")
      : undefined;
    argv.push("--session-protocol", "--output-format", "json");
    const child = spawn(d.bin, argv, {
      env: { ...process.env, ...d.env },
      cwd: d.cwd,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    session = new ProtocolSession(
      child,
      c.plan.ref,
      base,
      `${base}.cli.log`,
      async () => {
        await task.done();
        await inputsCleanup?.();
      },
      inputsDir,
      opening,
    );
    slot.current = session;
  } catch (err) {
    await taskCleanup?.();
    await inputsCleanup?.();
    throw new ArgumentError(`session could not launch: ${(err as Error).message}`);
  } finally {
    slot.reserved = false;
  }
  const started = await session.awaitStart();
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
    cliLog: session.cliLog,
    launched: true,
    startedAt: session.startedAt.toISOString(),
  });
}

export interface SessionSendArgs {
  sessionId: string;
  text: string;
  turnTimeoutSeconds?: number;
}

/** The open session under that id, or the tool error naming what is open. */
function openSession(d: Driver, id: string, tool: string): ProtocolSession | CallToolResult {
  const s = d.sessions.current;
  if (!s) return text(`${tool}: no session is open; start one with agentry_session_start.`, true);
  if (s.id !== id)
    return text(`${tool}: session ${id} is not open; the open session is ${s.id}.`, true);
  return s;
}

/** User text is JSON data; it cannot invoke a protocol command. */
export function turnLine(textIn: string): string {
  const line = textIn.trim();
  if (line === "") throw new ArgumentError("text must not be empty");
  if (Buffer.byteLength(JSON.stringify({ send: { text: line } })) > 1 << 20)
    throw new ArgumentError("text exceeds the session protocol's 1 MiB command limit");
  return line;
}

/** agentry_session_send: one user turn in, the agent's reply out. */
export async function sessionSend(d: Driver, a: SessionSendArgs): Promise<CallToolResult> {
  const s = openSession(d, a.sessionId, "agentry_session_send");
  if (!(s instanceof ProtocolSession)) return s;
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
      return json({ sessionId: s.id, sent: r.turn.taken, ...r.turn });
  }
}

/** A new host file is its own preview and confirmation, bound to its bytes. */
export async function sessionAdd(
  d: Driver,
  a: { sessionId: string; path: string; confirm?: string },
): Promise<CallToolResult> {
  const s = openSession(d, a.sessionId, "agentry_session_add");
  if (!(s instanceof ProtocolSession)) return s;
  const path = resolve(d.cwd ?? process.cwd(), a.path);
  // fingerprint rejects symlinks; this operation accepts only a file.
  const fileDigest = await fingerprint(path);
  const content = await readFile(path);
  const facts = {
    tool: "agentry_session_add",
    sessionId: s.id,
    path,
    fileDigest,
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  if (a.confirm === undefined) return previewText({ input: facts, writes: false }, facts);
  const consent = await confirmed(d.server, "agentry_session_add", a.confirm, facts, {
    unsigned: false,
    ask: `Give ${path} (${content.length} bytes) to session ${s.id}, read-only?`,
  });
  if (!isConsent(consent)) return consent;
  await s.add(path, content);
  return json({
    sessionId: s.id,
    submitted: true,
    path,
    note: "The protocol will report input_added or input_refused; collect its notice with agentry_session_send before sending another turn.",
  });
}

export interface SessionCloseArgs {
  sessionId: string;
  finish?: boolean;
}

/** agentry_session_close: end the chat, wait for the CLI's teardown, name the record. */
export async function sessionClose(d: Driver, a: SessionCloseArgs): Promise<CallToolResult> {
  const s = openSession(d, a.sessionId, "agentry_session_close");
  if (!(s instanceof ProtocolSession)) return s;
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
    // No envelope: the CLI stopped before writing one; the exit code and the CLI log say what happened.
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
    exitClass: envelope?.exitClass,
    reasonDetail: (envelope as { reason?: unknown } | undefined)?.reason,
    transcript: join(s.receiptsDir, "transcript.md"),
    receiptsDir: s.receiptsDir,
    outDir: s.outDir,
    resultFile: join(s.outDir, "result.json"),
    cliLog: s.cliLog,
  });
}
