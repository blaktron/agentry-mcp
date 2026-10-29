/**
 * The run tools: setup, the autonomous run behind the two-call
 * consent, validate. Registered with the SDK's own shape so the handler
 * receives `extra` (the progress token, the notification sender).
 */

import { z } from "zod";

import { guard, type Driver } from "../driver.js";
import { DEFAULT_RUN_TIMEOUT_SECONDS, run, setup, validate } from "../run.js";
import { registerTool } from "../toolargs.js";

export function registerRunTools(d: Driver): void {
  registerTool(
    d.server,
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
          .enum([
            "anthropic",
            "openai",
            "google",
            "vultr",
            "openrouter",
            "poe",
            "huggingface",
            "agentry",
            "custom",
          ])
          .optional()
          .describe(
            "The model provider; the policy's current one when omitted. vultr is Vultr Serverless Inference " +
              "(key variable VULTR_INFERENCE_API_KEY by default; needs CLI v0.6.1000 or later); openrouter, poe " +
              "and huggingface default to OPENROUTER_API_KEY, POE_API_KEY and HF_TOKEN. Each is paid by a key " +
              "variable here; signing in with the provider's own account (Connect your account) is done in a " +
              "terminal (`agentry setup`) or the desktop, never through this tool. agentry pays with the Agentry " +
              "credits of the account the CLI is signed in to (`agentry login`, in a terminal) and takes no apiKeyEnv, " +
              "baseUrl or model: each run opens a credits session with that sign-in, and the registry picks the model " +
              "(needs CLI v0.6.1005 or later).",
          ),
        model: z
          .string()
          .optional()
          .describe(
            "The model name; the provider's default when omitted. vultr, openrouter, poe and huggingface have no " +
              "default: name one. agentry takes none.",
          ),
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

  registerTool(
    d.server,
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
        "The run's deliverables, the files it was for, come back after the envelope: text ones inline (up to 256 KiB " +
        "each and 1 MiB in all), the rest as links to the delivered copy or the file in the run folder, each only " +
        "after its bytes match the SHA-256 the runner listed; `deliverables` in the envelope says what came of each. " +
        "The preview's `delivery` says where the run sends its result: the folder, and the destinations (the " +
        "call's, else the QuickAgent's default set). Secrets for input sources and target hosts are passed as " +
        "environment variable NAMES, never values. " +
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
        deliverTo: z
          .string()
          .optional()
          .describe(
            "Copy the run's deliverables, once it succeeds, to FOLDER/<QuickAgent>/<date time> <title>/ " +
              "(`--deliver-to`); the CLI's deliver.folder setting, if any, when omitted. The run folder is left as it is.",
          ),
        destinations: z
          .array(z.string())
          .optional()
          .describe(
            "Send the run's result and deliverables, once it succeeds, to these saved destinations " +
              "(`--destination`; see agentry_destinations_list). Without it, the QuickAgent's default set, which the preview names.",
          ),
        noDestination: z
          .boolean()
          .optional()
          .describe(
            "Send to no destination, not even the QuickAgent's default set (`--no-destination`).",
          ),
        reportTheme: z
          .string()
          .optional()
          .describe(
            "The built-in report theme the run's PDFs take (`--report-theme`): plain, classic, modern, editorial " +
              "or technical; the account's report design, else the config's, when omitted.",
          ),
        intakeTokens: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "For an input source that needs a token, by intake question id: the NAME of the environment variable " +
              "holding it (`--intake-token id=ENV_NAME`), never the token. Otherwise the key saved for the source's host.",
          ),
        hostKeys: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Sign in to a target host with a private key FILE, by host id (`--host-key id=PATH`); otherwise the " +
              "sign-in saved in the system keychain.",
          ),
        hostPasswords: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Sign in to a target host with a password, by host id: the NAME of the environment variable holding it " +
              "(`--host-password id=ENV_NAME`), never the password.",
          ),
        hostPassphrases: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "The passphrase of a target host's key, by host id: an environment variable's NAME (`--host-passphrase`).",
          ),
        hostSudoPasswords: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "The sudo password of a target host's account, by host id: an environment variable's NAME " +
              "(`--host-sudo-password`); without one, sudo works only where it asks for none.",
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

  registerTool(
    d.server,
    "agentry_validate",
    {
      description:
        "Validate a QuickAgent workspace offline with the installed agentry CLI (`agentry validate --json`): the " +
        "registry's manifest rules (the CLI names those it ran) and its S1/S3/S4 scanners, as data — issues, inventory and scan " +
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
