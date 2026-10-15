/**
 * The session tools: start, send, close — an interactive run on a
 * CLI protocol process the server owns, one at a time.
 */

import { z } from "zod";

import { guard, type Driver } from "../driver.js";
import {
  DEFAULT_TURN_TIMEOUT_SECONDS,
  sessionClose,
  sessionAdd,
  sessionSend,
  sessionStart,
} from "../session.js";

export function registerSessionTools(d: Driver): void {
  d.server.registerTool(
    "agentry_session_start",
    {
      description:
        "Start an interactive session with a QuickAgent (`agentry run --mode interactive`), in the same two " +
        "calls as agentry_run: without `confirm`, a preview of the compiled plan for the interactive mode " +
        "with a `digest`; with `confirm` set to that digest (and `acceptUnsigned: true` only if the person " +
        "accepted an unsigned or local release, `acceptUnscanned: true` only if they accepted an unscanned one), the CLI process is launched over its JSON-line session protocol " +
        "and the call returns once the process launches; startup failures appear on send or close, with the session id, the output folder and the " +
        "receipts directory. Then agentry_session_send for each turn and agentry_session_close to end it. " +
        "One session at a time; a second start is refused naming the open one. The release's own idle " +
        "timeout and budgets end a session as they would in a terminal; a later send reports that.",
      inputSchema: {
        ref: z
          .string()
          .optional()
          .describe("A registry QuickAgent: namespace/name, optionally @version or @range."),
        local: z
          .string()
          .optional()
          .describe(
            "Instead of ref: an unpublished workspace directory (attestation `local`, always needs acceptUnsigned).",
          ),
        input: z
          .string()
          .optional()
          .describe(
            "An opening task as text, sent as the first turn; written to a temp file the server removes.",
          ),
        inputFile: z.string().optional().describe("The opening task as a path (instead of input)."),
        files: z
          .array(z.string())
          .optional()
          .describe("Files or directories provided read-only under /inputs."),
        knowledge: z
          .array(z.string())
          .max(5)
          .optional()
          .describe("Knowledge pack names or directories to attach read-only."),
        voice: z.boolean().optional().describe("Attach this computer's Writing Voice."),
        noVoice: z.boolean().optional().describe("Skip the Writing Voice for this run."),
        voiceFile: z
          .string()
          .optional()
          .describe("Attach this VOICE.md file instead of the stored voice."),
        maxTurns: z.number().int().min(0).optional().describe("Tool-call budget; 0 is unlimited."),
        maxCost: z.number().min(0).optional().describe("Cost budget in USD; 0 is unlimited."),
        intake: z
          .record(z.string(), z.string())
          .optional()
          .describe("Answers to the QuickAgent's intake questions, by id."),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(86400)
          .optional()
          .describe("Session wall-clock budget in seconds."),
        adapter: z.string().optional().describe("The harness adapter (default docker-agent)."),
        out: z
          .string()
          .optional()
          .describe(
            "The output folder for the transcript, reports and receipts; a folder the server makes when omitted.",
          ),
        policy: z
          .string()
          .optional()
          .describe("The operator policy file; the default when omitted."),
        registry: z
          .string()
          .optional()
          .describe("Registry base URL; the CLI's configured default when omitted."),
        confirm: z
          .string()
          .optional()
          .describe("The `digest` a preview of this exact call returned. Omit to preview."),
        acceptUnsigned: z
          .boolean()
          .optional()
          .describe(
            "Only with `confirm`, only when the preview said unsigned, and only if the person accepted that.",
          ),
        acceptUnscanned: z
          .boolean()
          .optional()
          .describe(
            "Only with `confirm`, only when the preview said unscanned (admitted without a scan), and only if the person accepted that nothing about its contents was checked.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (a) => guard("agentry_session_start", () => sessionStart(d, a)),
  );

  d.server.registerTool(
    "agentry_session_send",
    {
      description:
        "Send one user turn to the open session and get the agent's reply: `reply` is the assistant's turn as " +
        "the run's events receipt recorded it, with the tools it called and the usage beside it. A session the " +
        "release's idle timeout or a budget has ended is reported as such, with the reason, and nothing is " +
        `sent. The turn waits up to turnTimeoutSeconds (default ${DEFAULT_TURN_TIMEOUT_SECONDS}); past that the ` +
        "session is still open and the agent still on that turn: the next send waits for that reply and " +
        "returns it as `lateReplyTo` with `sent: false`, holding the new text back — send it again after. Set " +
        "the limit under your own tool-call limit if you have one. Text is sent as JSON data; multiline text and slash-prefixed text are literal. The terminal chat's " +
        "commands are never executed through this tool.",
      inputSchema: {
        sessionId: z.string().describe("The id agentry_session_start returned."),
        text: z.string().describe("The user's message; multiline text is preserved."),
        turnTimeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .optional()
          .describe(`How long to wait for the reply (default ${DEFAULT_TURN_TIMEOUT_SECONDS}).`),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (a) => guard("agentry_session_send", () => sessionSend(d, a)),
  );

  d.server.registerTool(
    "agentry_session_add",
    {
      description:
        "Give a new file to the open session through the CLI's add protocol command, in two calls. Preview its path, size and digest, then confirm after agreement. The server stages the file in a private session-inputs directory. Collect the agent's notice with agentry_session_send; input_refused is reported if the CLI rejects it.",
      inputSchema: { sessionId: z.string(), path: z.string(), confirm: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (a) => guard("agentry_session_add", () => sessionAdd(d, a)),
  );

  d.server.registerTool(
    "agentry_session_close",
    {
      description:
        "End the open session: with `finish` (the default) the agent is asked for its final result first, as " +
        "the chat's /finish does; without it the session just ends (/quit). Waits for the CLI's teardown and " +
        "returns why the session ended, the result envelope's status and result, and the record — the " +
        "transcript, the receipts directory (the mechanisms enforced: gateway, proxy, labels), the output " +
        "folder and the CLI log. Name the receipts when you report a session.",
      inputSchema: {
        sessionId: z.string().describe("The id agentry_session_start returned."),
        finish: z
          .boolean()
          .optional()
          .describe("Ask the agent for its final result before ending (default true)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (a) => guard("agentry_session_close", () => sessionClose(d, a)),
  );
}
