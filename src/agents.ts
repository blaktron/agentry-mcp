/**
 * Persistent agents: the Assistant and the Coding agent run in the
 * background once started and keep their conversation across segments.
 * Starting one that would be given something the person has not agreed to
 * on this computer, and switching a roster entry, are the two-call consent
 * of src/consent.ts. A turn is one `agentry agent attach --json` process:
 * the send goes in on stdin, the agent's events come back on descriptor 3,
 * and the end detaches, leaving the agent running.
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ArgumentError, flag, value } from "./argv.js";
import { confirmed, consentedArgv, isConsent, previewText } from "./consent.js";
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

/** The agent's name as the CLI takes it. */
function agentName(name: string): string {
  return value("name", name);
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

export async function agentList(d: Driver): Promise<CallToolResult> {
  return (
    needsAgents(d, "agentry_agent_list") ?? d.run("agentry_agent_list", ["agent", "list", "--json"])
  );
}

export interface AgentShowArgs {
  name: string;
  transcript?: number;
}

export async function agentShow(d: Driver, a: AgentShowArgs): Promise<CallToolResult> {
  const refused = needsAgents(d, "agentry_agent_show");
  if (refused) return refused;
  const argv = ["agent", "show", agentName(a.name), "--json"];
  flag(argv, "transcript", a.transcript);
  return d.run("agentry_agent_show", argv);
}

export interface AgentStopArgs {
  name: string;
}

export async function agentStop(d: Driver, a: AgentStopArgs): Promise<CallToolResult> {
  const refused = needsAgents(d, "agentry_agent_stop");
  if (refused) return refused;
  return d.run("agentry_agent_stop", ["agent", "stop", agentName(a.name), "--json"], {
    timeoutMs: STOP_TIMEOUT_MS,
  });
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
  const argv = ["agent", "start", agentName(a.name), "--json"];
  flag(argv, "policy", a.policy);
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
          "The agent would be given these for the first time on this computer. Show the person each line; " +
          "start it with `confirm` set to this digest only once they agree.",
      },
      facts,
    );
  }
  const ok = await confirmed(d.server, "agentry_agent_start", a.confirm, facts, {
    unsigned: false,
    ask:
      `Start the ${env.result.agent} agent? It would be given, for the first time on this computer: ` +
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

interface AgentState {
  agent: string;
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
  const shown = await d.run("agentry_agent_grant (show)", ["agent", "show", name, "--json"]);
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
            ? `Switching it on gives the agent: ${entry.line} `
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
    consentedArgv(["agent", "grant", name, id, a.on ? "on" : "off", "--json"], ok),
  );
}

/** One event line from descriptor 3. */
interface AgentEvent {
  kind: string;
  refused?: string;
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
  const child = spawn(d.bin, ["agent", "attach", name, "--json"], {
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
  if (reply !== undefined)
    return json({ agent: name, sent: true, reply, toolCalls, usage, errors });
  if (ended) return text(`agentry_agent_send: the ${name} agent's segment ended (${ended}).`, true);
  if (timedOut)
    return json({
      agent: name,
      sent: seen,
      timedOut: true,
      toolCalls,
      usage,
      errors,
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
}

/**
 * agentry_agent_tasks: an agent's tasks, each with its schedule, zone, state,
 * next and last fire and that answer's first line; or one paused or resumed
 * by its id. Pausing narrows what the agent does and resuming re-arms a task
 * the agent registered, which widens nothing it was given, so neither asks
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
  return d.run("agentry_agent_tasks", argv);
}
