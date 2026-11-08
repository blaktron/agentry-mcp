/**
 * Persistent agents: the Assistant, the Coding agent and the persistent
 * QuickAgents installed from a registry run in the background once started
 * and keep their conversation across segments. Installing or removing a
 * registry agent, starting one that would be given something the person
 * has not agreed to on this computer, and switching a roster entry, are the
 * two-call consent of src/consent.ts. A turn is one
 * `agentry agent attach --json` process: the send goes in on stdin, the
 * agent's events come back on descriptor 3, and the end detaches, leaving
 * the agent running.
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ArgumentError, flag, value } from "./argv.js";
import {
  askPerson,
  canonical,
  confirmed,
  consentedArgv,
  isConsent,
  planRefusals,
  previewText,
  runPlan,
  type InstallPlan,
} from "./consent.js";
import type { Driver } from "./driver.js";
import { tail, toolJSON as json, toolText as text } from "./envelope.js";

/** A start may build the runner's images first; the CLI's own limit is 20 minutes. */
const START_TIMEOUT_MS = 21 * 60_000;
/** A stop ends the segment and waits for its envelope; the CLI waits up to 3 minutes. */
const STOP_TIMEOUT_MS = 4 * 60_000;
/** After the end command, how long the attach process gets to detach. */
const DETACH_MS = 10_000;
export const DEFAULT_AGENT_TURN_SECONDS = 300;

/** The CLI result envelope a tool returns: the CLI's JSON, its exit class, its log. */
interface Envelope<R> {
  result: R;
  exitClass: string;
  log: string;
}

function envelopeOf<R>(r: CallToolResult): Envelope<R> | undefined {
  if (r.isError) return undefined;
  try {
    return JSON.parse((r.content[0] as { text: string }).text) as Envelope<R>;
  } catch {
    return undefined;
  }
}

/** The manifest's name rules: a namespace and a name. */
const NAMESPACE_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,63}[a-z0-9])?$/;
/** A version or range after `@` in a reference: no space, nothing a flag could start with. */
const VERSION_RE = /^[A-Za-z0-9^~<>=*][A-Za-z0-9.+\-^~*<>=|]{0,63}$/;

/**
 * The agent as the CLI takes it: a built-in's short name (`assistant`), a
 * published agent's `ns/name`, its key `ns.name`, or its bare name. Each
 * part follows the manifest's name rules, so nothing that could be read as
 * a flag, a path or a second argument gets through.
 */
export function agentName(name: string): string {
  const v = value("name", name);
  const bad = () =>
    new ArgumentError(
      `name must be a built-in agent's name (assistant, coder) or a published agent's ns/name, got ${JSON.stringify(v)}`,
    );
  const sep = v.includes("/") ? "/" : v.includes(".") ? "." : "";
  if (sep === "") {
    if (!NAME_RE.test(v)) throw bad();
    return v;
  }
  const parts = v.split(sep);
  const [ns, n] = parts;
  if (parts.length !== 2 || !NAMESPACE_RE.test(ns ?? "") || !NAME_RE.test(n ?? "")) throw bad();
  return v;
}

/** A runhost's name, as `agentry runhost list` names it. */
const RUNHOST_NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * argv with `--on <runhost>` when one is named: the agent command runs on
 * that remote runhost, where the agent runs.
 */
function onRunhost(d: Driver, argv: string[], on: string | undefined, arg = "on"): string[] {
  if (on === undefined) return argv;
  if (!RUNHOST_NAME.test(on))
    throw new ArgumentError(
      `${arg} ${JSON.stringify(on)} is not a runhost's name (see agentry_runhost_list)`,
    );
  if (!d.features.runhostAgents)
    throw new ArgumentError(
      "this agentry CLI runs no persistent agent on a runhost; update the CLI to v0.7.14 or later",
    );
  return [...argv, "--on", on];
}

/** A registry reference: `ns/name`, optionally `@version` or `@range`. */
function agentRelease(ref: string): { ns: string; name: string; version?: string } {
  const v = value("ref", ref);
  const at = v.indexOf("@");
  const base = at < 0 ? v : v.slice(0, at);
  const version = at < 0 ? undefined : v.slice(at + 1);
  const [ns, name] = base.split("/");
  if (
    base.split("/").length !== 2 ||
    !NAMESPACE_RE.test(ns ?? "") ||
    !NAME_RE.test(name ?? "") ||
    (version !== undefined && !VERSION_RE.test(version))
  )
    throw new ArgumentError(
      `ref must be a published agent's ns/name, optionally with @version, got ${JSON.stringify(v)}`,
    );
  return { ns: ns!, name: name!, ...(version !== undefined ? { version } : {}) };
}

/** Refuses the call when the found CLI has no persistent agents for a program. */
function needsAgents(d: Driver, tool: string): CallToolResult | undefined {
  if (d.features.agents) return undefined;
  return text(
    `${tool}: this agentry CLI cannot drive persistent agents from a program (no \`agentry agent attach\`). ` +
      "Update the CLI (https://secureagentry.net/download); the server never updates it for you.",
    true,
  );
}

export interface AgentListArgs {
  on?: string;
}

export async function agentList(d: Driver, a: AgentListArgs = {}): Promise<CallToolResult> {
  return (
    needsAgents(d, "agentry_agent_list") ??
    d.run("agentry_agent_list", onRunhost(d, ["agent", "list", "--json"], a.on))
  );
}

export interface AgentShowArgs {
  name: string;
  transcript?: number;
  on?: string;
}

export async function agentShow(d: Driver, a: AgentShowArgs): Promise<CallToolResult> {
  const refused = needsAgents(d, "agentry_agent_show");
  if (refused) return refused;
  const argv = ["agent", "show", agentName(a.name), "--json"];
  flag(argv, "transcript", a.transcript);
  return d.run("agentry_agent_show", onRunhost(d, argv, a.on));
}

export interface AgentStopArgs {
  name: string;
  on?: string;
}

export async function agentStop(d: Driver, a: AgentStopArgs): Promise<CallToolResult> {
  const refused = needsAgents(d, "agentry_agent_stop");
  if (refused) return refused;
  return d.run(
    "agentry_agent_stop",
    onRunhost(d, ["agent", "stop", agentName(a.name), "--json"], a.on),
    {
      timeoutMs: STOP_TIMEOUT_MS,
    },
  );
}

/** What `agent start --json` prints without consent when the person must agree first. */
interface AgreementNeeded {
  agent: string;
  needsAgreement: { id: string; line: string }[];
}

function isAgreementNeeded(v: unknown): v is AgreementNeeded {
  const o = v as Partial<AgreementNeeded> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.agent === "string" &&
    Array.isArray(o.needsAgreement) &&
    o.needsAgreement.every((e) => typeof e?.id === "string" && typeof e?.line === "string")
  );
}

export interface AgentStartArgs {
  name: string;
  policy?: string;
  confirm?: string;
  on?: string;
}

/**
 * agentry_agent_start. Unconsented, the CLI's start is its own preview:
 * it starts the agent when there is nothing new to agree to, and otherwise
 * prints what needs agreement and changes nothing. That list is what the
 * digest covers; the confirm asks again, and starts consented only when
 * the list is the one the person saw.
 */
export async function agentStart(d: Driver, a: AgentStartArgs): Promise<CallToolResult> {
  const refused = needsAgents(d, "agentry_agent_start");
  if (refused) return refused;
  if (a.on !== undefined && a.policy !== undefined)
    throw new ArgumentError(
      "policy names a file on this computer, which a runhost does not read: leave it out with on",
    );
  let argv = ["agent", "start", agentName(a.name), "--json"];
  flag(argv, "policy", a.policy);
  argv = onRunhost(d, argv, a.on);
  const opts = { timeoutMs: START_TIMEOUT_MS, graceMs: 30_000 };
  const first = await d.run("agentry_agent_start", argv, opts);
  const env = envelopeOf<unknown>(first);
  if (!env || env.exitClass !== "policy" || !isAgreementNeeded(env.result)) {
    // Started, or refused for a reason no agreement lifts.
    if (a.confirm !== undefined && env?.exitClass === "ok")
      return json({ ...env, note: "nothing needed agreement any more, so the agent started" });
    return first;
  }
  const facts = {
    tool: "agentry_agent_start",
    agent: env.result.agent,
    needsAgreement: env.result.needsAgreement,
    policy: a.policy ?? "",
  };
  if (a.confirm === undefined) {
    return previewText(
      {
        agent: env.result.agent,
        needsAgreement: env.result.needsAgreement,
        log: tail(env.log),
        writes: false,
        note:
          (a.on === undefined
            ? "The agent would be given these for the first time on this computer. "
            : `The agent would be given these for the first time on runhost ${a.on}. `) +
          "Show the person each line; " +
          "start it with `confirm` set to this digest only once they agree.",
      },
      facts,
    );
  }
  const ok = await confirmed(d.server, "agentry_agent_start", a.confirm, facts, {
    unsigned: false,
    ask:
      `Start the ${env.result.agent} agent? It would be given, for the first time on ${a.on === undefined ? "this computer" : `runhost ${a.on}`}: ` +
      env.result.needsAgreement.map((e) => e.line).join(" "),
  });
  if (!isConsent(ok)) return ok;
  return d.run("agentry_agent_start", consentedArgv(argv, ok), opts);
}

/** One roster entry as `agent show --json` prints it. */
interface RosterEntry {
  id: string;
  kind: string;
  name: string;
  grantedBy: string;
  state: string;
  on: boolean;
  line: string;
  fixed?: boolean;
}

/** A subagent a published agent's release declares, as pinned at its install. */
interface SubagentPin {
  ref: string;
  constraint: string;
  why: string;
  version?: string;
  unresolved?: string;
  reach?: string;
}

interface AgentState {
  agent: string;
  /** A published agent's `ns/name`; the built-ins carry none of this. */
  ref?: string;
  version?: string;
  source?: string;
  persona?: { name: string; editable: boolean };
  packs?: string[];
  subagents?: SubagentPin[];
  state: string;
  desktopOnly?: boolean;
  roster?: RosterEntry[];
  config?: { consented?: Record<string, string> };
}

export interface AgentGrantArgs {
  name: string;
  entry: string;
  on: boolean;
  confirm?: string;
  /** The runhost the agent runs on; `on` is the switch. */
  runhost?: string;
}

/**
 * desktopNote is what switching on an entry of the person's computer adds to
 * the preview's note: where it acts, and what an exec agreement waives.
 */
function desktopNote(kind: string): string {
  switch (kind) {
    case "desktop":
      return "It acts on the person's own computer through Agentry Desktop, which answers each call while it runs there; whether the application is running is read at each call. ";
    case "desktop-exec":
      return "With it on, code the agent runs inside that application runs without Agentry Desktop asking the person first. ";
  }
  return "";
}

/**
 * agentry_agent_grant: switching a roster entry is always two calls. The
 * preview reads the entry from `agent show --json`, and the digest covers
 * the entry, its consent sentence, what it was agreed to as, and the switch
 * asked for; the confirm reads them again and switches consented only
 * when nothing moved.
 */
export async function agentGrant(d: Driver, a: AgentGrantArgs): Promise<CallToolResult> {
  const refused = needsAgents(d, "agentry_agent_grant");
  if (refused) return refused;
  const name = agentName(a.name);
  const id = value("entry", a.entry);
  const shown = await d.run(
    "agentry_agent_grant (show)",
    onRunhost(d, ["agent", "show", name, "--json"], a.runhost, "runhost"),
  );
  const env = envelopeOf<AgentState>(shown);
  if (!env || env.exitClass !== "ok") return { ...shown, isError: true };
  const st = env.result;
  if (st.desktopOnly)
    return text(`agentry_agent_grant: the ${name} agent runs only in Agentry Desktop.`, true);
  const entry = st.roster?.find((e) => e.id === id);
  if (!entry) {
    const ids = (st.roster ?? []).map((e) => e.id).join(", ") || "none";
    return text(
      `agentry_agent_grant: the ${name} agent has no roster entry ${id}; its entries: ${ids}.`,
      true,
    );
  }
  if (entry.fixed)
    return text(
      `agentry_agent_grant: ${id} is always on for the ${name} agent; no switch changes it.`,
      true,
    );
  const facts = {
    tool: "agentry_agent_grant",
    agent: st.agent,
    entry: {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      grantedBy: entry.grantedBy,
      line: entry.line,
    },
    agreed: st.config?.consented?.[entry.id] ?? "",
    on: a.on,
  };
  const running = st.state === "running";
  if (a.confirm === undefined) {
    return previewText(
      {
        agent: st.agent,
        entry: facts.entry,
        currentlyOn: entry.on,
        on: a.on,
        running,
        writes: false,
        note:
          (a.on
            ? `Switching it on gives the agent: ${entry.line} ` + desktopNote(entry.kind)
            : "Switching it off takes it away. ") +
          (running
            ? "The running agent restarts with the change at its next turn and continues the conversation. "
            : "") +
          "Show the person this; confirm with this digest only once they agree.",
      },
      facts,
    );
  }
  const ok = await confirmed(d.server, "agentry_agent_grant", a.confirm, facts, {
    unsigned: false,
    ask: a.on
      ? `Give the ${st.agent} agent this? ${entry.line}`
      : `Take ${entry.name} (${entry.id}) away from the ${st.agent} agent?`,
  });
  if (!isConsent(ok)) return ok;
  return d.run(
    "agentry_agent_grant",
    consentedArgv(
      onRunhost(
        d,
        ["agent", "grant", name, id, a.on ? "on" : "off", "--json"],
        a.runhost,
        "runhost",
      ),
      ok,
    ),
  );
}

/** One event line from descriptor 3. */
interface AgentEvent {
  kind: string;
  refused?: string;
  /** A question event's id. */
  question?: string;
  text?: string;
  reason?: string;
  synthetic?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentSendArgs {
  name: string;
  text: string;
  turnTimeoutSeconds?: number;
  on?: string;
}

/**
 * agentry_agent_send: one turn over `agentry agent attach --json`. Other
 * chats (the terminal, the desktop) may be attached too, so the reply is
 * the assistant_turn after this turn's own user_turn; a send while another
 * chat's turn is in flight is refused busy. Past the limit the process
 * detaches and the agent finishes the turn on its own; its answer is in
 * the transcript.
 */
export async function agentSend(d: Driver, a: AgentSendArgs): Promise<CallToolResult> {
  const refused = needsAgents(d, "agentry_agent_send");
  if (refused) return refused;
  if (process.platform === "win32")
    return text(
      "agentry_agent_send: the CLI's pipe protocol is unavailable on Windows; use `agentry agent chat` in a terminal.",
      true,
    );
  const name = agentName(a.name);
  if (a.text.trim() === "") throw new ArgumentError("text must not be empty");
  const limitMs = (a.turnTimeoutSeconds ?? DEFAULT_AGENT_TURN_SECONDS) * 1000;
  const child = spawn(d.bin, onRunhost(d, ["agent", "attach", name, "--json"], a.on), {
    cwd: d.cwd,
    env: { ...process.env, ...d.env },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (s: string) => (stderr = (stderr + s).slice(-65536)));
  child.stdout?.resume();
  child.stdin?.on("error", () => {});
  const exited = new Promise<number>((resolve) => {
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : -1)));
    child.on("error", () => resolve(-1));
  });

  const toolCalls: string[] = [];
  const errors: string[] = [];
  // Questions the agent put to the person during the turn, and what became of each.
  const questions: { id: string; text: string; answer?: "yes" | "no" }[] = [];
  let unaskable = false;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let seen = false;
  let reply: string | undefined;
  let busy = false;
  let ended: string | undefined;
  let problem: string | undefined;
  // Set once the limit passed: what arrives while detaching is not taken.
  let stopped = false;
  let partial = "";
  const done = new Promise<void>((resolve) => {
    const events = child.stdio[3] as Readable;
    events.setEncoding("utf8");
    events.on("error", (err) => {
      problem = err.message;
      resolve();
    });
    events.on("end", () => resolve());
    events.on("data", (chunk: string) => {
      if (stopped) return;
      partial += chunk;
      if (partial.length > 16 << 20) {
        problem = "an agent event exceeded 16 MiB";
        resolve();
        return;
      }
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: AgentEvent;
        try {
          ev = JSON.parse(line) as AgentEvent;
        } catch {
          problem = "the CLI emitted an invalid protocol event";
          resolve();
          return;
        }
        if (ev.refused === "busy") {
          busy = true;
          resolve();
          return;
        }
        switch (ev.kind) {
          case "user_turn":
            // Notices the runner adds go before the person's text.
            if (!ev.synthetic && (ev.text ?? "").endsWith(a.text)) seen = true;
            break;
          case "tool_call":
            if (seen) toolCalls.push(ev.text ?? "");
            break;
          case "usage":
            if (seen) {
              usage.inputTokens += ev.inputTokens ?? 0;
              usage.outputTokens += ev.outputTokens ?? 0;
              usage.totalTokens += ev.totalTokens ?? 0;
            }
            break;
          case "question": {
            // The agent asks the person, never the model: the person is asked
            // through the host, and without that no answer is given.
            if (!seen || !ev.question) break;
            const q: { id: string; text: string; answer?: "yes" | "no" } = {
              id: ev.question,
              text: ev.text ?? "",
            };
            questions.push(q);
            if (!d.server.server.getClientCapabilities()?.elicitation) {
              unaskable = true;
              resolve();
              return;
            }
            void askPerson(d.server, `The ${name} agent asks: ${q.text}`).then(
              ({ yes }) => {
                q.answer = yes ? "yes" : "no";
                if (!stopped)
                  child.stdin?.write(JSON.stringify({ answer: { id: q.id, yes } }) + "\n");
              },
              () => {},
            );
            break;
          }
          case "assistant_turn":
            if (seen) {
              reply = ev.text ?? "";
              resolve();
              return;
            }
            break;
          case "error":
            // Another chat's failed turn is not this one's.
            if (!ev.refused && !seen) break;
            errors.push(`${ev.refused ? `${ev.refused}: ` : ""}${ev.text ?? ""}`);
            resolve();
            return;
          case "session_end":
            ended = ev.reason ?? "ended";
            resolve();
            return;
        }
      }
    });
  });

  child.stdin?.write(JSON.stringify({ send: { text: a.text } }) + "\n");
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    done.then(() => false),
    exited.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), limitMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  stopped = true;
  // Detach: the agent keeps running whatever this process does next.
  child.stdin?.end(JSON.stringify({ end: { finish: false } }) + "\n");
  let detachTimer: NodeJS.Timeout | undefined;
  const code = await Promise.race([
    exited,
    new Promise<number>((resolve) => {
      detachTimer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(-1);
      }, DETACH_MS);
    }),
  ]);
  if (detachTimer) clearTimeout(detachTimer);

  if (busy)
    return text(
      `agentry_agent_send: another chat with the ${name} agent has a turn in flight; nothing was sent. ` +
        "Send again once its answer has arrived.",
      true,
    );
  if (problem) return text(`agentry_agent_send: ${problem}`, true);
  if (unaskable)
    return json({
      agent: name,
      sent: true,
      awaitingPerson: true,
      questions,
      toolCalls,
      usage,
      errors,
      note:
        "The agent asked the person a question this host cannot put to them, so nothing was answered and this " +
        "call stopped waiting. The agent holds the question for ten minutes and then goes on as if the person " +
        "had not answered. Tell the person; they answer in Agentry Desktop or `agentry agent chat`, and you can " +
        "send the request again once they have it open.",
    });
  if (reply !== undefined)
    return json({
      agent: name,
      sent: true,
      reply,
      toolCalls,
      usage,
      errors,
      ...(questions.length > 0 ? { questions } : {}),
    });
  if (ended) return text(`agentry_agent_send: the ${name} agent's segment ended (${ended}).`, true);
  if (timedOut)
    return json({
      agent: name,
      sent: seen,
      timedOut: true,
      toolCalls,
      usage,
      errors,
      ...(questions.length > 0 ? { questions } : {}),
      note: seen
        ? "The agent is still on this turn and finishes it on its own; read its answer later with agentry_agent_show and `transcript`."
        : "The agent had not taken the turn within the limit.",
    });
  if (errors.length > 0) return text(`agentry_agent_send: ${errors.join("; ")}`, true);
  return text(
    `agentry_agent_send: \`agentry agent attach\` exited ${code} before the agent answered.` +
      (stderr.trim() ? `\n\n${tail(stderr)}` : ""),
    true,
  );
}

/** The task operations a program may ask for: pause and resume. Removing a
 *  task stays in a terminal and the desktop. */
export const TASK_OPS = ["pause", "resume"] as const;

export interface AgentTasksArgs {
  name: string;
  task?: string;
  op?: (typeof TASK_OPS)[number];
  on?: string;
}

/**
 * agentry_agent_tasks: an agent's tasks, each with its schedule, zone, state,
 * next and last fire and that answer's first line; or one paused or resumed
 * by its id. Pausing narrows what the agent does and resuming re-arms a task
 * the agent already has, which widens nothing it was given, so neither asks
 * first, as the CLI does not.
 */
export async function agentTasks(d: Driver, a: AgentTasksArgs): Promise<CallToolResult> {
  const refused = needsAgents(d, "agentry_agent_tasks");
  if (refused) return refused;
  if (!d.features.tasks)
    return text(
      "agentry_agent_tasks: this agentry CLI has no `agent tasks`. " +
        "Update the CLI (https://secureagentry.net/download); the server never updates it for you.",
      true,
    );
  const argv = ["agent", "tasks", agentName(a.name)];
  if ((a.task === undefined) !== (a.op === undefined))
    throw new ArgumentError(
      "agentry_agent_tasks: `task` and `op` go together: name the task and pause or resume it",
    );
  if (a.task !== undefined && a.op !== undefined) {
    if (!TASK_OPS.includes(a.op))
      throw new ArgumentError(`agentry_agent_tasks: op is pause or resume, not ${String(a.op)}`);
    argv.push(a.op, value("task", a.task));
  }
  argv.push("--json");
  return d.run("agentry_agent_tasks", onRunhost(d, argv, a.on));
}

/** How long a compaction may take: the CLI's own bound, and a margin. */
const COMPACT_TIMEOUT_MS = 11 * 60_000;

export interface AgentCompactArgs {
  name: string;
  confirm?: string;
}

/**
 * agentry_agent_compact, in two calls. The preview reads the agent's state
 * and says what a compaction does and spends: one upkeep turn on the
 * person's model plan, within the agent's daily cap. The confirm, with the
 * digest, runs `agent compact`, which asks nothing more on a terminal.
 */
export async function agentCompact(d: Driver, a: AgentCompactArgs): Promise<CallToolResult> {
  const refused = needsAgents(d, "agentry_agent_compact");
  if (refused) return refused;
  if (!d.features.compact)
    return text(
      "agentry_agent_compact: this agentry CLI has no `agent compact`. " +
        "Update the CLI (https://secureagentry.net/download); the server never updates it for you.",
      true,
    );
  const name = agentName(a.name);
  const shown = await d.run("agentry_agent_compact (show)", ["agent", "show", name, "--json"]);
  const env = envelopeOf<AgentState>(shown);
  if (!env || env.exitClass !== "ok") return { ...shown, isError: true };
  const st = env.result;
  if (st.desktopOnly)
    return text(`agentry_agent_compact: the ${name} agent runs only in Agentry Desktop.`, true);
  if (st.state !== "running")
    return text(
      `agentry_agent_compact: the ${name} agent is ${st.state}; a compaction needs it running (agentry_agent_start).`,
      true,
    );
  const facts = { tool: "agentry_agent_compact", agent: st.agent, spends: COMPACT_SPENDS };
  if (a.confirm === undefined) {
    return previewText(
      {
        agent: st.agent,
        running: true,
        writes: true,
        spends: COMPACT_SPENDS,
        note:
          "A compaction sends the agent one upkeep turn: it writes a short handoff (the Assistant first saves " +
          "what this conversation produced to its memory), and the agent goes on in a fresh conversation that " +
          "opens with it. " +
          "A message sent meanwhile waits for it. Show the person this; confirm with this digest only once they agree.",
      },
      facts,
    );
  }
  const ok = await confirmed(d.server, "agentry_agent_compact", a.confirm, facts, {
    unsigned: false,
    ask: `Compact the ${st.agent} agent's conversation now? ${COMPACT_SPENDS}`,
  });
  if (!isConsent(ok)) return ok;
  return d.run("agentry_agent_compact", ["agent", "compact", name, "--json"], {
    timeoutMs: COMPACT_TIMEOUT_MS,
  });
}

/** What a compaction spends, as the person is told it. */
const COMPACT_SPENDS =
  "It uses the person's model plan for one upkeep turn (the agent runs at most 12 upkeep turns a day), " +
  "which can take a few minutes on a long conversation.";

/** Refuses the call when the found CLI cannot install or remove a persistent agent from a registry. */
function needsPublishedAgents(d: Driver, tool: string): CallToolResult | undefined {
  if (d.features.publishedAgents) return undefined;
  return text(
    `${tool}: this agentry CLI has no \`agent install\` and \`agent uninstall\`. ` +
      "Update the CLI (https://secureagentry.net/download); the server never updates it for you.",
    true,
  );
}

/** The persona a release names, as its registry manifest declares it. */
interface ReleasePersona {
  name: string;
  /** The persona's file in the release, when the CLI's plan names it. */
  file?: string;
  editable: boolean;
}

/** What the capability contract of an install plan lists for a persistent agent. */
interface PersistentContract {
  persistent?: Record<string, unknown>;
  knowledge?: string[];
  subagents?: { ref: string; version?: string; why?: string }[];
}

/** A subagent as `agent install --plan` pins it: a version, or why none. */
interface SubagentPin {
  ref: string;
  constraint: string;
  why: string;
  version?: string;
  unresolved?: string;
  reach?: string;
  digest?: string;
}

/** The `agent` block `agent install --plan --json` adds to an install plan. */
interface AgentPlan {
  agent: string;
  persistent?: string[];
  persona?: { name: string; file: string; locked: boolean };
  packs?: string[];
  subagents?: SubagentPin[];
  runsSubagents: boolean;
  installed?: { version: string; source: string; digest: string; subagents?: SubagentPin[] };
}

/**
 * The persona of the release a plan resolved, read from `agentry info`:
 * the registry's manifest of the latest version. A persona is shown only
 * when that version is the plan's own; for any other the CLI offers no
 * read of its manifest, and the preview says so. A CLI with
 * `agent install --plan` names the planned version's own persona instead.
 */
async function releasePersona(
  d: Driver,
  ns: string,
  name: string,
  version: string,
  registry: string | undefined,
): Promise<ReleasePersona | null> {
  const argv = ["info", `${ns}/${name}`, "--json"];
  flag(argv, "registry", registry);
  const r = await d.run("agentry_agent_install (info)", argv);
  const env = envelopeOf<{
    latest?: { version?: string; manifest?: { persona?: { name?: string; editable?: boolean } } };
  }>(r);
  if (!env || env.exitClass !== "ok") return null;
  const latest = env.result.latest;
  const p = latest?.manifest?.persona;
  if (latest?.version !== version || !p || typeof p.name !== "string") return null;
  return { name: p.name, editable: p.editable !== false };
}

export interface AgentInstallArgs {
  ref: string;
  registry?: string;
  confirm?: string;
}

/**
 * agentry_agent_install, in two calls. The preview is
 * `agent install --plan --json`, which resolves the release, downloads it,
 * checks its digest and attestation and reports its capability contract,
 * with what installing it as a persistent agent adds: the persistent keys,
 * the persona of that version, the knowledge packs it ships, each subagent
 * pinned to the version, reach and digest the install would pin, and the
 * installed release when this is an update. A CLI without it is previewed
 * with `install --plan --json`, which has no pins and no update, and the
 * persona comes from `info`. The facts cover all of that and the confirm
 * plans again, so a release, a contract, a pin or a verdict that moved is
 * refused. The write names the resolved version the digest covered.
 */
export async function agentInstall(d: Driver, a: AgentInstallArgs): Promise<CallToolResult> {
  const refused =
    needsAgents(d, "agentry_agent_install") ?? needsPublishedAgents(d, "agentry_agent_install");
  if (refused) return refused;
  const rel = agentRelease(a.ref);
  const ref = `${rel.ns}/${rel.name}${rel.version !== undefined ? `@${rel.version}` : ""}`;
  const agentPlans = d.features.agentPlans;
  const planArgv = agentPlans
    ? ["agent", "install", ref, "--plan", "--json"]
    : ["install", ref, "--plan", "--json"];
  flag(planArgv, "registry", a.registry);
  const planned = await runPlan<InstallPlan & { agent?: AgentPlan }>(
    d,
    "agentry_agent_install (plan)",
    planArgv,
  );
  if (!planned.ok) {
    const first = planned.result.content[0] as { text?: string } | undefined;
    if (
      !agentPlans &&
      planned.result.isError &&
      /installed as a persistent agent/.test(first?.text ?? "")
    )
      return text(
        `${first?.text ?? ""}\n\nagentry_agent_install: ${rel.ns}/${rel.name} is installed already. This CLI previews ` +
          "an update only with `agentry agent install` at a terminal, so the update stays there; a newer CLI " +
          "previews it here.",
        true,
      );
    return planned.result;
  }
  const { plan, log } = planned;
  if (!(plan.modes ?? []).includes("persistent"))
    return text(
      `agentry_agent_install: ${plan.ref} is not a persistent QuickAgent (its modes: ${(plan.modes ?? []).join(", ") || "none"}); ` +
        "install it with agentry_install and run it with agentry_run.",
      true,
    );
  const ap = plan.agent;
  if (agentPlans && !ap)
    return text(
      "agentry_agent_install: the CLI's `agent install --plan` answered no agent block, so there is nothing " +
        "faithful to show; nothing was installed.",
      true,
    );
  // No acceptance lifts a refusal here: a persistent agent from a registry is a signed, scanned release.
  const refusals = planRefusals(plan, { unsigned: false });
  if (typeof refusals === "string") return text(`agentry_agent_install: ${refusals}`, true);
  const contract = (plan.contract ?? {}) as PersistentContract;
  const persona: ReleasePersona | null = ap
    ? ap.persona
      ? { name: ap.persona.name, file: ap.persona.file, editable: !ap.persona.locked }
      : null
    : await releasePersona(d, rel.ns, rel.name, plan.version, a.registry);
  const subagents = ap ? (ap.subagents ?? []) : (contract.subagents ?? []);
  const installed = ap?.installed ?? null;
  const declared = {
    persistent: contract.persistent ?? {},
    knowledge: contract.knowledge ?? [],
    subagents,
    persona,
  };
  const facts = {
    tool: "agentry_agent_install",
    refusals,
    ref: plan.ref,
    version: plan.version,
    archiveDigest: plan.digest,
    yanked: plan.yanked === true,
    attestation: plan.attestation,
    contract: plan.contract,
    contractDigest: plan.contractDigest,
    persona,
    registry: a.registry ?? "",
    ...(ap
      ? {
          pins: (ap.subagents ?? []).map((s) => ({
            ref: s.ref,
            version: s.version ?? null,
            digest: s.digest ?? null,
          })),
          installedVersion: installed?.version ?? null,
          installedDigest: installed?.digest ?? null,
        }
      : {}),
  };
  if (a.confirm === undefined) {
    const pinNote = ap
      ? "Each subagent shows the version it would be pinned to until the agent is updated, what that version's " +
        "contract reaches and its digest, or why it resolves to no version it can run. "
      : "The version each subagent is pinned to, and what its contract reaches, are resolved by the CLI while " +
        "it installs and come back in the result. ";
    const updateNote = installed
      ? `This updates the installed ${installed.version}: show what the update widens (diff) and the pins it ` +
        "replaces (installedAgent.subagents); " +
        (d.features.runningUpdates
          ? "if the agent runs, it takes the update at its next turn and its conversation continues. "
          : "stop the agent first if it runs. ")
      : "The agent is enabled and left stopped; start it with agentry_agent_start. ";
    return previewText(
      {
        ref: plan.ref,
        version: plan.version,
        releaseDigest: plan.digest,
        attestation: plan.attestation,
        signed: plan.signed,
        yanked: plan.yanked === true,
        ...declared,
        contract: plan.contract,
        installed: plan.installed ?? null,
        ...(ap ? { installedAgent: installed } : {}),
        diff: plan.diff ?? {},
        needsConfirmation: plan.needsConfirmation,
        ...(plan.reason ? { reason: plan.reason } : {}),
        refusals,
        log: tail(log),
        writes: false,
        note:
          "Show the person the persistent capabilities (what the agent may do beyond a run), the persona, the " +
          "knowledge it ships and each subagent with the reason it gives; a subagent runs as a QuickAgent of its " +
          "own under its own contract. " +
          (persona === null && !ap
            ? "The persona could not be read for this version; the CLI shows it only while installing. "
            : "") +
          pinNote +
          updateNote +
          "Confirm with this digest only once the person agrees.",
      },
      facts,
    );
  }
  const pinWords = subagents
    .map((s) =>
      ap ? `${s.ref}${s.version ? `@${s.version}` : " (resolves to no version)"}` : s.ref,
    )
    .join(", ");
  const ok = await confirmed(d.server, "agentry_agent_install", a.confirm, facts, {
    unsigned: false,
    refusals,
    ask:
      (installed
        ? `Update the persistent agent ${plan.ref} (installed: ${installed.version})? `
        : `Install ${plan.ref} as a persistent agent? `) +
      `It may: ${canonical(declared.persistent)}. ` +
      `Knowledge it ships: ${declared.knowledge.join(", ") || "none"}. ` +
      `Subagents: ${pinWords || "none"}. ` +
      `Persona: ${persona?.name ?? "not shown"}. Attestation: ${plan.attestation}.`,
  });
  if (!isConsent(ok)) return ok;
  const argv = ["agent", "install", plan.ref, "--json"];
  flag(argv, "registry", a.registry);
  return d.run("agentry_agent_install", consentedArgv(argv, ok), {
    timeoutMs: INSTALL_TIMEOUT_MS,
    graceMs: 30_000,
  });
}

/** An install downloads the release and resolves its subagents. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Removing the data removes the agent's volumes. */
const UNINSTALL_TIMEOUT_MS = 4 * 60_000;

export interface AgentUninstallArgs {
  name: string;
  removeData?: boolean;
  confirmRef?: string;
  confirm?: string;
}

/**
 * agentry_agent_uninstall, in two calls. The preview reads the agent from
 * `agent show --json` and says what goes and what stays: the release, its
 * installed servers and the person's agreement go; the conversation, the
 * files and the person's choices stay unless `removeData` asks to wipe them,
 * and then the confirm must also carry the agent's reference as `confirmRef`,
 * which is the CLI's own `--confirm`. The files in the agent's share folder
 * stay either way.
 */
export async function agentUninstall(d: Driver, a: AgentUninstallArgs): Promise<CallToolResult> {
  const refused =
    needsAgents(d, "agentry_agent_uninstall") ?? needsPublishedAgents(d, "agentry_agent_uninstall");
  if (refused) return refused;
  const name = agentName(a.name);
  const removeData = a.removeData === true;
  if (!removeData && a.confirmRef !== undefined)
    throw new ArgumentError("agentry_agent_uninstall: confirmRef goes with removeData");
  const shown = await d.run("agentry_agent_uninstall (show)", ["agent", "show", name, "--json"]);
  const env = envelopeOf<AgentState>(shown);
  if (!env || env.exitClass !== "ok") return { ...shown, isError: true };
  const st = env.result;
  if (!st.source || !st.ref)
    return text(
      `agentry_agent_uninstall: the ${name} agent is built into Agentry and is not uninstalled; ` +
        "disabling it stays with the person (`agentry agent disable`).",
      true,
    );
  const running = st.state === "running";
  if (running && !d.features.runningUpdates)
    return text(
      `agentry_agent_uninstall: ${st.ref} is running and this agentry CLI uninstalls only a stopped agent; ` +
        "stop it first (agentry_agent_stop), or update the CLI to v0.7.19 or later, which stops it itself.",
      true,
    );
  const ref = agentName(st.ref);
  const facts = {
    tool: "agentry_agent_uninstall",
    agent: st.agent,
    ref,
    version: st.version ?? "",
    source: st.source,
    removeData,
    running,
  };
  const removes = [
    "its release",
    "the servers installed for it",
    "the person's agreement to what it declares",
    ...(removeData
      ? ["its conversation", "its files and volumes", "everything the person chose for it"]
      : []),
  ];
  const keeps = removeData
    ? ["the files in its share folder"]
    : [
        "its conversation",
        "its files",
        "everything the person chose for it",
        "the files in its share folder",
      ];
  if (a.confirm === undefined) {
    return previewText(
      {
        agent: st.agent,
        ref,
        version: st.version ?? "",
        source: st.source,
        dataRemoved: removeData,
        removes,
        keeps,
        running,
        writes: false,
        note:
          (running ? "The agent is running: the uninstall stops it first. " : "") +
          (removeData
            ? `This also wipes the agent's conversation and files, which cannot be undone. Show the person ` +
              `this; confirm with this digest and \`confirmRef\` set to ${ref}, only once they agree and have typed or approved that reference.`
            : `The conversation and files are kept: installing ${ref} again takes them up. Show the person this; ` +
              "confirm with this digest only once they agree."),
      },
      facts,
    );
  }
  if (removeData && a.confirmRef !== ref) {
    return text(
      `agentry_agent_uninstall: removing the data needs \`confirmRef\` set to the agent's reference, ${ref}, ` +
        "as the person confirmed it; nothing was removed.",
      true,
    );
  }
  const ok = await confirmed(d.server, "agentry_agent_uninstall", a.confirm, facts, {
    unsigned: false,
    ask: removeData
      ? `${running ? "Stop and u" : "U"}ninstall ${ref} and wipe its conversation, its files and everything you chose for it? The files in its share folder are kept.`
      : `${running ? "Stop and u" : "U"}ninstall ${ref}? Its conversation and files are kept; installing it again takes them up.`,
  });
  if (!isConsent(ok)) return ok;
  // The CLI's uninstall asks nothing on a program's behalf; a matched digest and the
  // reference are what let this line run.
  const argv = ["agent", "uninstall", ref];
  if (removeData) argv.push("--remove-data", "--confirm", ref);
  argv.push("--json");
  return d.run("agentry_agent_uninstall", argv, { timeoutMs: UNINSTALL_TIMEOUT_MS });
}
