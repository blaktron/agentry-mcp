/**
 * The runs this server starts, each under an id a host can ask about and
 * cancel. A blocking run is the CLI process a tool call waits on; a
 * detached run is started in its own process group with its output in
 * files, so the tool call returns at once and the run outlives this
 * server. Every run leaves a record under the state directory
 * (AGENTRY_MCP_STATE, else ~/.agentry/mcp), so a server started later can
 * say what became of a run it did not start: still going (its process
 * answers), ended (the envelope the CLI wrote to its stdout file or to
 * result.json in its output folder), or lost (the process is gone and it
 * wrote no result). The CLI's own output folder is untouched: result.json
 * and the receipts are where `agentry run` puts them, and `agentry runs`
 * lists them.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { interrupt, runCli, type CliResult } from "./cli.js";
import type { Driver } from "./driver.js";
import { tail, toToolResult } from "./envelope.js";

/** How long an ended run's record and log are kept before the listing removes them. */
const KEEP_RECORDS_MS = 14 * 24 * 60 * 60 * 1000;
/** How many narration lines a blocking run keeps in memory for the status tool. */
const PROGRESS_LINES = 40;

export type RunState = "running" | "ended" | "cancelled" | "lost";

/** What the state directory holds for one run; the fields a later server reads. */
export interface RunRecord {
  id: string;
  /** The tool that started it. */
  tool: string;
  /** What runs, for the listing: the QuickAgent's ref, or the built-in's name. */
  what: string;
  detached: boolean;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  state: RunState;
  /** The run's output folder when known: given to a detached run, read from the envelope after a blocking one. */
  outDir?: string;
  /** Where the detached CLI's stdout (its envelope) and stderr (its narration) go. */
  stdoutFile?: string;
  logFile?: string;
  /** Set once a cancel was asked for, whichever way the run then ended. */
  cancelRequested?: boolean;
  /** Set when the server's timeout past the run's own budget ended it. */
  timedOut?: boolean;
  /** The CLI's result once the run ended, as toToolResult shaped it. */
  raw?: CallToolResult;
}

export interface StartOptions {
  id?: string;
  tool: string;
  what: string;
  argv: string[];
  detached: boolean;
  /** The output folder the argv names, when the caller chose it. */
  outDir?: string;
  timeoutMs: number;
  graceMs: number;
  /** A blocking run's narration, forwarded as it arrives. */
  onStderrLine?: (line: string) => void;
  /** Called once the run has ended, whatever the outcome (a temp input file is removed here). */
  onEnd?: () => Promise<void> | void;
}

/** A run this process holds: its record and, while it runs, the process. */
interface Held {
  record: RunRecord;
  progress: string[];
  lines: number;
  /** Cancels the blocking run (aborts its signal) or interrupts the detached process. */
  cancel?: () => void;
  /** Resolves with the CLI's result when the run ends. */
  done: Promise<CallToolResult>;
}

/** What the status tool reports: the record, and the narration so far. */
export interface RunStatus {
  record: RunRecord;
  progress: { lines: number; tail: string };
  /** Set when the record was found but its process and files say nothing more. */
  note?: string;
}

export class RunRegistry {
  private readonly held = new Map<string, Held>();
  /** One write of a record at a time, in order, so a start and an end that race land in order. */
  private readonly saving = new Map<string, Promise<void>>();
  private saves = 0;

  constructor(private readonly d: Driver) {}

  /** Where the records go: AGENTRY_MCP_STATE, else ~/.agentry/mcp. */
  get stateDir(): string {
    const env = this.d.env ?? {};
    return (
      env.AGENTRY_MCP_STATE ??
      process.env.AGENTRY_MCP_STATE ??
      join(env.HOME ?? process.env.HOME ?? homedir(), ".agentry", "mcp")
    );
  }

  private get recordsDir(): string {
    return join(this.stateDir, "runs");
  }

  newId(): string {
    return randomBytes(6).toString("hex");
  }

  /**
   * Starts a run. A blocking one is the CLI process with its streams piped,
   * as every tool runs the CLI; a detached one gets its own process group
   * and its streams in files under the state directory, and is left to run
   * when this process ends.
   */
  async start(o: StartOptions): Promise<Held> {
    const id = o.id ?? this.newId();
    if (!/^[0-9a-f]{12}$/.test(id))
      throw new Error(`run id ${JSON.stringify(id)} is not one this server makes`);
    await mkdir(this.recordsDir, { recursive: true, mode: 0o700 });
    const record: RunRecord = {
      id,
      tool: o.tool,
      what: o.what,
      detached: o.detached,
      startedAt: new Date().toISOString(),
      state: "running",
      ...(o.outDir ? { outDir: o.outDir } : {}),
    };
    const held: Held = { record, progress: [], lines: 0, done: Promise.resolve({ content: [] }) };
    this.held.set(id, held);
    const settle = async (r: CliResult) => {
      record.raw = toToolResult(o.tool, r);
      record.endedAt = new Date().toISOString();
      record.state = record.cancelRequested ? "cancelled" : "ended";
      if (r.timedOut) record.timedOut = true;
      if (!record.outDir) {
        const out = outDirOf(record.raw);
        if (out) record.outDir = out;
      }
      held.cancel = undefined;
      await this.save(record);
      await o.onEnd?.();
      return record.raw;
    };
    if (o.detached) {
      held.done = this.spawnDetached(o, record).then(settle);
    } else {
      const control = new AbortController();
      held.cancel = () => control.abort();
      held.done = runCli(this.d.bin, o.argv, {
        ...this.d.defaults,
        timeoutMs: o.timeoutMs,
        graceMs: o.graceMs,
        signal: control.signal,
        onSpawn: (pid) => {
          record.pid = pid;
        },
        onStderrLine: (line) => {
          held.lines += 1;
          held.progress.push(line);
          if (held.progress.length > PROGRESS_LINES) held.progress.shift();
          o.onStderrLine?.(line);
        },
      }).then(settle);
    }
    // The record is written once the process is started, pid included.
    await this.save(record);
    return held;
  }

  private spawnDetached(o: StartOptions, record: RunRecord): Promise<CliResult> {
    const stdoutFile = join(this.recordsDir, `${record.id}.stdout`);
    const logFile = join(this.recordsDir, `${record.id}.log`);
    record.stdoutFile = stdoutFile;
    record.logFile = logFile;
    const out = openSync(stdoutFile, "w", 0o600);
    const log = openSync(logFile, "w", 0o600);
    const defaults = this.d.defaults;
    let child;
    try {
      child = spawn(this.d.bin, o.argv, {
        cwd: defaults.cwd,
        env: { ...process.env, ...defaults.env },
        stdio: ["ignore", out, log],
        detached: true,
      });
    } finally {
      // The child holds its own copies of the two descriptors.
      closeSync(out);
      closeSync(log);
    }
    child.unref();
    record.pid = child.pid;
    return new Promise<CliResult>((resolveResult) => {
      let ended: "timeout" | "cancel" | undefined;
      let dropHardKill = () => {};
      const end = (why: "timeout" | "cancel") => {
        if (ended) return;
        ended = why;
        dropHardKill = interrupt(child, o.graceMs);
      };
      const timer =
        o.timeoutMs > 0
          ? setTimeout(() => {
              end("timeout");
            }, o.timeoutMs)
          : undefined;
      const heldRun = this.held.get(record.id);
      if (heldRun) heldRun.cancel = () => end("cancel");
      // The timer must not keep this process alive for a run meant to outlive it.
      timer?.unref();
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolveResult({ code: -1, stdout: "", stderr: "", spawnError: err.message });
      });
      child.on("close", async (code, signal) => {
        if (timer) clearTimeout(timer);
        dropHardKill();
        const stdout = await readFile(stdoutFile, "utf8").catch(() => "");
        const stderr = await readFile(logFile, "utf8").catch(() => "");
        if (ended && (signal || code === null)) {
          resolveResult({
            code: -1,
            stdout,
            stderr,
            spawnError:
              `${ended === "timeout" ? `timed out after ${o.timeoutMs}ms` : "was cancelled"} and was killed; ` +
              `SIGINT went unanswered for ${o.graceMs}ms, so the CLI's teardown may not have run — check for leftover agentry-* containers`,
          });
        } else if (ended) {
          resolveResult({
            code: code ?? -1,
            stdout,
            stderr,
            ...(ended === "timeout" ? { timedOut: true } : { cancelled: true }),
          });
        } else if (signal)
          resolveResult({ code: -1, stdout, stderr, spawnError: `killed by ${signal}` });
        else resolveResult({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  /**
   * Asks a run to stop: SIGINT to the CLI, so its teardown runs and it
   * writes its envelope; SIGKILL after the grace if it is still there. A run
   * an earlier server started gets the SIGINT by its process id, and what
   * became of it is read from its files.
   */
  async cancel(id: string): Promise<RunStatus | undefined> {
    const held = this.held.get(id);
    if (held) {
      if (held.record.state === "running") {
        held.record.cancelRequested = true;
        held.cancel?.();
        await this.save(held.record);
      }
      return this.status(id);
    }
    const record = await this.load(id);
    if (!record) return undefined;
    if (record.state === "running" && record.pid && alive(record.pid)) {
      record.cancelRequested = true;
      try {
        process.kill(record.pid, "SIGINT");
      } catch {
        // gone between the check and the signal
      }
      await this.save(record);
    }
    return this.status(id);
  }

  /** Waits up to waitMs for the run to leave the running state, then reports it. */
  async waitForEnd(
    id: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<RunStatus | undefined> {
    const until = Date.now() + waitMs;
    for (;;) {
      const s = await this.status(id);
      if (!s || s.record.state !== "running" || Date.now() >= until || signal?.aborted) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** The run as it stands, from this process when it holds it, else from its record and files. */
  async status(id: string): Promise<RunStatus | undefined> {
    const held = this.held.get(id);
    if (held) {
      return {
        record: held.record,
        progress: held.record.detached
          ? await this.logTail(held.record)
          : { lines: held.lines, tail: held.progress.join("\n") },
      };
    }
    const record = await this.load(id);
    if (!record) return undefined;
    return this.refresh(record);
  }

  /**
   * A record this process did not write: a run still marked running is
   * judged by its process and its files. The files win over a living
   * process id, since an id can be reused.
   */
  private async refresh(record: RunRecord): Promise<RunStatus> {
    if (record.state !== "running") return { record, progress: await this.logTail(record) };
    const envelope = await this.envelopeOnDisk(record);
    if (envelope) {
      record.raw = toToolResult(record.tool, {
        code: envelope.code,
        stdout: envelope.text,
        stderr: await this.logText(record),
        ...(record.cancelRequested ? { cancelled: true } : {}),
      });
      record.state = record.cancelRequested ? "cancelled" : "ended";
      record.endedAt = envelope.endedAt;
      if (!record.outDir) {
        const out = outDirOf(record.raw);
        if (out) record.outDir = out;
      }
      await this.save(record);
      return { record, progress: await this.logTail(record) };
    }
    if (record.pid && alive(record.pid)) {
      return {
        record,
        progress: await this.logTail(record),
        note: record.detached
          ? "started by an earlier server process; its process still answers"
          : "started by an earlier server process, which held its output; its process still answers, and when it ends result.json in its output folder is the record",
      };
    }
    record.state = "lost";
    record.endedAt = new Date().toISOString();
    await this.save(record);
    return {
      record,
      progress: await this.logTail(record),
      note:
        "its process is gone and it wrote no result" +
        (record.outDir ? ` (no result.json under ${record.outDir})` : "") +
        "; `agentry runs` lists the runs under the output directory",
    };
  }

  /** The envelope a run wrote, from its stdout file or its output folder's result.json. */
  private async envelopeOnDisk(
    record: RunRecord,
  ): Promise<{ text: string; code: number; endedAt: string } | undefined> {
    const candidates = [
      ...(record.stdoutFile ? [record.stdoutFile] : []),
      ...(record.outDir ? [join(record.outDir, "result.json")] : []),
    ];
    for (const file of candidates) {
      const text = await readFile(file, "utf8").catch(() => "");
      if (text.trim() === "") continue;
      let env: unknown;
      try {
        env = JSON.parse(text);
      } catch {
        continue;
      }
      if (!env || typeof env !== "object") continue;
      const e = env as { exitCode?: unknown; status?: unknown };
      const code = typeof e.exitCode === "number" ? e.exitCode : e.status === "ok" ? 0 : 1;
      const endedAt = await stat(file)
        .then((s) => s.mtime.toISOString())
        .catch(() => new Date().toISOString());
      return { text, code, endedAt };
    }
    return undefined;
  }

  private async logText(record: RunRecord): Promise<string> {
    return record.logFile ? readFile(record.logFile, "utf8").catch(() => "") : "";
  }

  private async logTail(record: RunRecord): Promise<{ lines: number; tail: string }> {
    const text = await this.logText(record);
    const lines = text === "" ? 0 : text.trimEnd().split("\n").length;
    return { lines, tail: tail(text) };
  }

  /** Every run on record, newest first; ended records past their keep time are removed. */
  async list(): Promise<RunStatus[]> {
    const names = await readdir(this.recordsDir).catch(() => [] as string[]);
    const out: RunStatus[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const m = /^([0-9a-f]{12})\.json$/.exec(name);
      if (!m || !m[1]) continue;
      const id = m[1];
      seen.add(id);
      const s = await this.status(id);
      if (!s) continue;
      const endedAt = s.record.endedAt ? Date.parse(s.record.endedAt) : NaN;
      if (
        s.record.state !== "running" &&
        !this.held.has(id) &&
        Date.now() - endedAt > KEEP_RECORDS_MS
      ) {
        await this.forget(s.record);
        continue;
      }
      out.push(s);
    }
    for (const [id, h] of this.held) if (!seen.has(id)) out.push(await this.statusOfHeld(h));
    return out.sort((a, b) => b.record.startedAt.localeCompare(a.record.startedAt));
  }

  private async statusOfHeld(h: Held): Promise<RunStatus> {
    return (
      (await this.status(h.record.id)) ?? { record: h.record, progress: { lines: 0, tail: "" } }
    );
  }

  private async forget(record: RunRecord): Promise<void> {
    for (const f of [join(this.recordsDir, `${record.id}.json`), record.stdoutFile, record.logFile])
      if (f) await rm(f, { force: true }).catch(() => {});
  }

  private async load(id: string): Promise<RunRecord | undefined> {
    if (!/^[0-9a-f]{12}$/.test(id)) return undefined;
    const text = await readFile(join(this.recordsDir, `${id}.json`), "utf8").catch(() => undefined);
    if (text === undefined) return undefined;
    try {
      const r = JSON.parse(text) as RunRecord;
      return r && typeof r === "object" && r.id === id ? r : undefined;
    } catch {
      return undefined;
    }
  }

  /** Writes the record whole, through a rename, so a reader sees one version or the other. */
  private save(record: RunRecord): Promise<void> {
    const text = JSON.stringify(record);
    const prev = this.saving.get(record.id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        await mkdir(this.recordsDir, { recursive: true, mode: 0o700 });
        const file = join(this.recordsDir, `${record.id}.json`);
        const tmp = `${file}.${process.pid}.${(this.saves += 1)}.tmp`;
        await writeFile(tmp, text, { mode: 0o600 });
        await rename(tmp, file);
      });
    this.saving.set(record.id, next);
    return next;
  }
}

/** Whether a process id answers; one that is another user's answers too. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The output folder the CLI's envelope names, when the result is one. */
function outDirOf(r: CallToolResult): string | undefined {
  const first = r.content[0];
  if (!first || first.type !== "text") return undefined;
  try {
    const env = JSON.parse(first.text) as { result?: { outDir?: unknown } };
    return typeof env.result?.outDir === "string" ? env.result.outDir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The output folder a detached run is given when the call names none: the
 * CLI's own layout, ./agentry-out/<ns>-<name>-<id> under the working
 * folder, with this server's run id where the CLI would put its own, so
 * the folder is known before the run ends and `agentry runs` lists it with
 * the rest.
 */
export function defaultOutDir(cwd: string | undefined, ref: string, id: string): string {
  const slug = ref
    .split("@")[0]!
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return join(resolve(cwd ?? process.cwd()), "agentry-out", `${slug || "run"}-${id}`);
}
