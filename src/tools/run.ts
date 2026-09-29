/**
 * The run tools (M4): setup, the autonomous run behind the two-call
 * consent, validate. Registered with the SDK's own shape so the handler
 * receives `extra` (the progress token, the notification sender).
 */

import { z } from "zod";

import { guard, type Driver } from "../driver.js";
import { DEFAULT_RUN_TIMEOUT_SECONDS, run, setup, validate } from "../run.js";

export function registerRunTools(d: Driver): void {
  d.server.registerTool(
    "agentry_setup",
    {
      description:
        "Prepare this machine for QuickAgent runs with the installed agentry CLI (`agentry setup --json`): " +
        "write the model provider into the runner policy (~/.agentry/runner/policy.yaml) — provider, model, the " +
        "NAME of the environment variable holding the key, never the key — and, unless skipImages, pull and build " +
        "the gateway, harness and runner images (minutes; progress is streamed when the host asks for it). " +
        "Returns the policy as configured and whether the images are ready. Call agentry_doctor first to see " +
        "what is missing.",
      inputSchema: {
        provider: z
          .enum(["anthropic", "openai", "google", "custom"])
          .optional()
          .describe("The model provider; the policy's current one when omitted."),
        model: z
          .string()
          .optional()
          .describe("The model name; the provider's default when omitted."),
        apiKeyEnv: z
          .string()
          .optional()
          .describe(
            "The NAME of the environment variable the runner reads the key from (e.g. ANTHROPIC_API_KEY). Never a key.",
          ),
        baseUrl: z
          .string()
          .optional()
          .describe(
            "For a custom provider: the endpoint's base URL, which sets the agent container's only egress.",
          ),
        skipImages: z
          .boolean()
          .optional()
          .describe("Write the policy only; skip the image pulls and build."),
        policy: z
          .string()
          .optional()
          .describe("The operator policy file; the default when omitted."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (a, extra) => guard("agentry_setup", () => setup(d, a, extra)),
  );

  d.server.registerTool(
    "agentry_run",
    {
      description:
        "Run a QuickAgent autonomously with the installed agentry CLI, in two calls. Without `confirm`: a " +
        "preview (`agentry run --plan --json`) — the compiled run plan: the release that resolved, its digest, " +
        "the capabilities and enforcement a run would apply, the tools it would be served, the gateway and proxy " +
        "shape, the budgets, the attestation verdict and every refusal a run would meet (`refusals`) — plus `digest`; nothing " +
        "runs, nothing is recorded. Show the person what the run may reach and do, and only when they agree " +
        "call again with `confirm` set to that digest: the server re-plans, refuses if anything changed, then " +
        "runs `agentry run --mode autonomous --output-format json` and returns the CLI's result envelope " +
        "(status, exitClass, result, usage, receipts) with `receiptsDir`, `resultFile` and `outDir` beside it. " +
        "The receipts are the record of what was enforced; name them when you report a run. An unsigned " +
        "release, and every local workspace, needs `acceptUnsigned: true` on the confirm; an unscanned release " +
        "(admitted without a scan) needs `acceptUnscanned: true`; pass either only if the person said so. A run stops at timeoutSeconds, or the runner policy's own budget when omitted " +
        "(the preview shows which); the CLI's teardown runs on every path. Progress streams from the CLI's " +
        "log when the host asks for it.",
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
            "The task input as text; written to a temp file the server removes after the run.",
          ),
        inputFile: z
          .string()
          .optional()
          .describe("The task input as a path the host already has (instead of input)."),
        files: z
          .array(z.string())
          .optional()
          .describe("Files or directories provided read-only under /inputs."),
        intake: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Answers to the QuickAgent's intake questions, by id. A required question left unanswered is an error naming it.",
          ),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(86400)
          .optional()
          .describe(
            `Stop the run after this many seconds; the runner policy's budget when omitted (${DEFAULT_RUN_TIMEOUT_SECONDS} by default).`,
          ),
        adapter: z.string().optional().describe("The harness adapter (default docker-agent)."),
        out: z
          .string()
          .optional()
          .describe(
            "The output folder for reports and receipts; the CLI's default under ./agentry-out when omitted.",
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
    (a, extra) => guard("agentry_run", () => run(d, a, extra)),
  );

  d.server.registerTool(
    "agentry_validate",
    {
      description:
        "Validate a QuickAgent workspace offline with the installed agentry CLI (`agentry validate --json`): the " +
        "registry's manifest rules (V1–V9) and its S1/S3/S4 scanners, as data — issues, inventory and scan " +
        "findings with file and line, the bundle version, and whether publish would pass. The report comes back " +
        'whatever the verdict; exitClass "cli" beside it means it failed. For authoring: fix what it names, ' +
        "then validate again; publishing itself is `agentry publish` in a terminal.",
      inputSchema: {
        dir: z.string().describe("The workspace directory holding agent.yaml."),
        strict: z.boolean().optional().describe("Also fail on warnings."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => guard("agentry_validate", () => validate(d, a)),
  );
}
