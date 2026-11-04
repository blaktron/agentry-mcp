/**
 * The persistent-agent tools: list, show, install, uninstall, start, stop,
 * send, grant, tasks and compact. The Assistant, the Coding agent and the
 * persistent QuickAgents installed from a registry run in the background
 * once started; Main runs only in Agentry Desktop. Enabling, configuring
 * and resetting an agent stay with the person, in a terminal or the
 * desktop.
 */

import { z } from "zod";

import {
  agentCompact,
  agentGrant,
  agentInstall,
  agentList,
  agentSend,
  agentShow,
  agentStart,
  agentStop,
  agentTasks,
  agentUninstall,
  DEFAULT_AGENT_TURN_SECONDS,
  TASK_OPS,
} from "../agents.js";
import { guard, type Driver } from "../driver.js";
import { registerTool } from "../toolargs.js";

const name = z
  .string()
  .describe(
    "The agent: `assistant` or `coder`, or a published agent's `ns/name` (agentry_agent_list names them; a name no other agent has also works alone).",
  );

const on = z
  .string()
  .optional()
  .describe(
    "A remote runhost's name (agentry_runhost_list names them): the agent there, which runs on that server under its service. Needs CLI v0.7.14 or later.",
  );

export function registerAgentTools(d: Driver): void {
  registerTool(
    d.server,
    "agentry_agent_list",
    {
      description:
        "List the persistent agents on this computer with the installed agentry CLI (`agentry agent list --json`): " +
        "each agent's name, the name it goes by, and whether it is running, stopped, disabled or runs only in " +
        "Agentry Desktop, with who runs it and since when.",
      inputSchema: { on },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => guard("agentry_agent_list", () => agentList(d, a)),
  );

  registerTool(
    d.server,
    "agentry_agent_show",
    {
      description:
        "Show one persistent agent (`agentry agent show <name> --json`): its state and, for one installed from a " +
        "registry, its `ref`, `version`, `source`, persona (name, whether the person may replace its text), the " +
        "knowledge packs its release ships and its `subagents` as pinned at install (ref, constraint, why, the " +
        "version it resolved to or why it resolved to none, what its contract reaches, its digest). " +
        "`subagentRuns` lists the runs it started of its subagents, newest first, at most 50: the subagent's " +
        "exact version, who granted it, when it started and ended, its outcome or error and the run's own id " +
        "(CLI v0.7.8 or later). A subagent's roster entries, `subagent:<ns>/<name>` and its `:ask` switch, say " +
        "whether it is on. It also returns its running segment, its " +
        "roster (each entry's id, kind, what it gives the agent, whether it is on, and what it waits for: its " +
        "folders, memory, heartbeat, skills, stored secrets by name (never a value), git host accounts, the " +
        "servers it is offered and the person's own), the servers it suggests, its share folder, its usage and, " +
        "with `transcript`, the end of its transcript, where the answer to a turn that outlasted " +
        "agentry_agent_send's limit is found. `lastCompaction` is its newest compaction's record: when, why, " +
        "whether a fresh conversation started and, for the Assistant, the memory's fact lines before and after " +
        "(-1 when not counted); the Assistant's `lastConsolidation` is its memory's newest daily tidy.",
      inputSchema: {
        name,
        on,
        transcript: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Also return the last N lines of the agent's transcript."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => guard("agentry_agent_show", () => agentShow(d, a)),
  );

  registerTool(
    d.server,
    "agentry_agent_install",
    {
      description:
        "Install or update a persistent QuickAgent from a registry as a persistent agent (`agentry agent " +
        "install <ns/name> --json`), in two calls. Without `confirm`: a preview from `agentry agent install " +
        "--plan --json` of the resolved version and its archive digest, the attestation verdict and the " +
        "capability contract: `persistent` (what the agent may do beyond a run: its clock, memory, skills, " +
        "stored secrets, mail, coding toolchain, web, helper tools and the rest), the `knowledge` packs it " +
        "ships, that version's persona (name, file, whether the person may replace its text), and each of its " +
        "`subagents` with the reason it gives, pinned to the version the install would pin, with what that " +
        "version reaches and its digest, or why it resolves to none. For an agent already installed, " +
        "`installedAgent` is its installed release with its pins and `diff` what the update widens. Any " +
        "refusal (a running agent's among them) comes with a `digest`; nothing is written. Show the person all " +
        "of it and only when they agree call again with `confirm` set to that digest: the server plans again, " +
        "refuses if anything changed (a pin included), and installs the version the preview named. The agent " +
        "is enabled and left stopped; agentry_agent_start starts it. A release that is unsigned or unscanned, " +
        "declares files or a target host, or is not persistent is refused. A running agent takes an update at " +
        "its next turn, its conversation continuing (CLI v0.7.19 or later; an older CLI refuses it while it runs). " +
        "A CLI older than v0.7.8 is previewed from `agentry install --plan` and `agentry info`, without the " +
        "pins, and an update stays at its terminal.",
      inputSchema: {
        ref: z
          .string()
          .describe("The persistent QuickAgent: namespace/name, optionally @version or @range."),
        registry: z
          .string()
          .optional()
          .describe("Registry base URL; the CLI's configured default when omitted."),
        confirm: z
          .string()
          .optional()
          .describe("The `digest` a preview of this exact call returned. Omit to preview."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (a) => guard("agentry_agent_install", () => agentInstall(d, a)),
  );

  registerTool(
    d.server,
    "agentry_agent_uninstall",
    {
      description:
        "Uninstall a persistent agent that was installed from a registry (`agentry agent uninstall <name> " +
        "--json`), in two calls. Without `confirm`: what goes (its release, the servers installed for it, the " +
        "person's agreement) and what stays (its conversation, its files and everything the person chose for it, " +
        "which installing it again takes up; the files in its share folder always stay), plus a `digest`; " +
        "nothing is removed. With `removeData: true` it also wipes its conversation, files and volumes, which " +
        "cannot be undone: the confirm then needs `confirmRef` set to the agent's reference (`ns/name`, as the " +
        "preview names it), the CLI's own `--confirm`. Show the person which of the two it is and confirm only " +
        "once they agree. The result says whether the data was removed. The built-in agents are disabled, not " +
        "uninstalled, and a running agent is stopped first (CLI v0.7.19 or later; an older CLI refuses it).",
      inputSchema: {
        name,
        removeData: z
          .boolean()
          .optional()
          .describe("Also remove its conversation, files and volumes. Default: keep them."),
        confirmRef: z
          .string()
          .optional()
          .describe(
            "With removeData and `confirm`: the agent's reference, as the preview names it.",
          ),
        confirm: z
          .string()
          .optional()
          .describe("The `digest` a preview of this exact call returned. Omit to preview."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (a) => guard("agentry_agent_uninstall", () => agentUninstall(d, a)),
  );

  registerTool(
    d.server,
    "agentry_agent_start",
    {
      description:
        "Start an enabled persistent agent in the background (`agentry agent start <name> --json`); its " +
        "conversation continues from where it stopped, and it keeps running after this server goes. When it " +
        "would be given something the person has not agreed to on this computer, nothing starts: the call " +
        "returns `needsAgreement`, each entry with the sentence to agree to, and a `digest`. Show the person " +
        "every line, and only when they agree call again with `confirm` set to that digest. A first start " +
        "can take minutes while the runner builds its images. An agent that is not enabled is enabled by the " +
        "person, in a terminal (`agentry agent enable`) or the desktop.",
      inputSchema: {
        name,
        on,
        policy: z
          .string()
          .optional()
          .describe("The operator policy file; the default when omitted."),
        confirm: z
          .string()
          .optional()
          .describe("The `digest` a preview of this exact call returned. Omit to preview."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (a) => guard("agentry_agent_start", () => agentStart(d, a)),
  );

  registerTool(
    d.server,
    "agentry_agent_stop",
    {
      description:
        "Stop a running persistent agent (`agentry agent stop <name> --json`): its segment ends and its " +
        "conversation, its files and its share folder are kept for the next start. Returns the segment's " +
        "result file. Stop only when the person asked: other chats (a terminal, the desktop) may be using it.",
      inputSchema: { name, on },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (a) => guard("agentry_agent_stop", () => agentStop(d, a)),
  );

  registerTool(
    d.server,
    "agentry_agent_send",
    {
      description:
        "Send one turn to a running persistent agent and get its answer (`agentry agent attach <name> --json`): " +
        "`reply` is its assistant turn, with the tools it called and the usage. Other chats may be attached to " +
        "the same agent; while one of theirs has a turn in flight the send is refused as busy and nothing is " +
        `sent. The turn waits up to turnTimeoutSeconds (default ${DEFAULT_AGENT_TURN_SECONDS}); past that the ` +
        "agent finishes the turn on its own, and its answer is in agentry_agent_show's `transcript`. Leaving " +
        "never stops the agent. A persistent agent takes no files through its chat: the person puts them in its " +
        "share folder. Text is sent as JSON data; slash-prefixed text is literal.",
      inputSchema: {
        name,
        on,
        text: z.string().describe("The person's message; multiline text is preserved."),
        turnTimeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .optional()
          .describe(`How long to wait for the answer (default ${DEFAULT_AGENT_TURN_SECONDS}).`),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (a) => guard("agentry_agent_send", () => agentSend(d, a)),
  );

  registerTool(
    d.server,
    "agentry_agent_grant",
    {
      description:
        "Switch an entry of a persistent agent's roster on or off (`agentry agent grant <name> <entry> on|off " +
        "--json`), in two calls. Without `confirm`: a preview of the entry (its id, what it is, the sentence that " +
        "says what it gives the agent), whether it is on now, and a `digest`; nothing changes. Show the person " +
        "the sentence and only when they agree call again with `confirm` set to that digest. A running agent " +
        "takes the change at its next turn and continues the conversation. agentry_agent_show lists the " +
        "entries. Adding a server, a knowledge pack or a skill, storing a secret, giving an account, the " +
        "Google sign-in, giving or removing a calendar feed, exporting the memory and moving the share folder " +
        "stay in a terminal or the desktop.",
      inputSchema: {
        name,
        runhost: on,
        entry: z
          .string()
          .describe(
            "The roster entry's id, as agentry_agent_show lists it: `share`, `knowledge:<pack>`, `server:<id>` (the person's or an offered one) and an offered server's `server:<id>:writes`, `skill:<name>`, `secret:<NAME>`, a registry agent's subagent `subagent:<ns>/<name>` and its `subagent:<ns>/<name>:ask` switch (which asks the person before each run), the Assistant's `heartbeat`, `meetings` (which needs `heartbeat` on first) and `calendar:<name>` (a calendar feed), and the Coding agent's `account:<host>`, `commands`, `egress`, `browser`, `dependency-scan`, `devhost` and `port:<name>`.",
          ),
        on: z.boolean().describe("true switches it on, false off."),
        confirm: z
          .string()
          .optional()
          .describe("The `digest` a preview of this exact call returned. Omit to preview."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (a) => guard("agentry_agent_grant", () => agentGrant(d, a)),
  );

  registerTool(
    d.server,
    "agentry_agent_tasks",
    {
      description:
        "A persistent agent's tasks (`agentry agent tasks <name> --json`): each task's id, name, cron and zone, " +
        "what it asks, whether it is on or paused, who made it, its next fire, and its last fire with the first " +
        "line of that answer. With `task` and `op`, pause or resume that task and return the tasks as they now " +
        "are. A task is added or changed by asking the agent with agentry_agent_send; removing one stays in a " +
        "terminal or the desktop. Its heartbeat (the `heartbeat` entry, agentry_agent_grant) runs them while it runs.",
      inputSchema: {
        name,
        on,
        task: z.string().optional().describe("The task's id, as the list gives it; with `op`."),
        op: z.enum(TASK_OPS).optional().describe("pause or resume the task; with `task`."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (a) => guard("agentry_agent_tasks", () => agentTasks(d, a)),
  );

  registerTool(
    d.server,
    "agentry_agent_compact",
    {
      description:
        "Compact a running persistent agent's conversation now (`agentry agent compact <name> --json`), in two " +
        "calls: the agent writes a short handoff, then goes on in a fresh conversation that opens with it; the " +
        "Assistant first saves what the conversation produced to its memory. Every agent also does this on its " +
        "own when its conversation grows large. Without `confirm`: what it does and spends (one upkeep turn on the person's model plan, " +
        "within its 12 a day) and a `digest`; nothing runs. Show the person, and only when they agree call again " +
        "with `confirm` set to that digest. It can take a few minutes; the result says whether a fresh " +
        "conversation started and, for the Assistant, the memory's fact lines before and after, and " +
        "agentry_agent_show's `lastCompaction` keeps it.",
      inputSchema: {
        name,
        confirm: z
          .string()
          .optional()
          .describe("The `digest` a preview of this exact call returned. Omit to preview."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (a) => guard("agentry_agent_compact", () => agentCompact(d, a)),
  );
}
