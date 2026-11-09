/**
 * The run tools: setup, the autonomous run behind the two-call
 * consent, validate. Registered with the SDK's own shape so the handler
 * receives `extra` (the progress token, the notification sender).
 */

import { z } from "zod";

import { guard, type Driver } from "../driver.js";
import { ArgumentError } from "../argv.js";
import { runOutcome, toolJSON, toolText } from "../envelope.js";
import { DEFAULT_RUN_TIMEOUT_SECONDS, decorateRun, run, setup, validate } from "../run.js";
import type { RunStatus } from "../runs.js";
import { registerTool } from "../toolargs.js";
import { desktopArg } from "./desktop.js";

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
        "preview (`agentry run --plan --json`, then `agentry doctor <ref> --json`): `summary`, the contract in words " +
        "for the person (what runs and for how long, the model and how it is paid, what it may reach on the network, " +
        "what it reads and writes, where its result goes, every refusal, and whether it can start); `readiness`, " +
        "doctor's checks on this machine and the release (the model key's variable, the container engine, the images, " +
        "the registry sign-in, each declared secret) with `ready` and one line each; the compiled run plan under `plan` " +
        "(the release that resolved, its digest, the capabilities and enforcement a run would apply, the tools it would " +
        "be served, the gateway and proxy shape, the budgets, the attestation verdict) and every refusal a run would " +
        "meet (`refusals`); plus `digest`, which covers all of it. Nothing runs, nothing is recorded. Show the person the " +
        "summary (not the raw plan), and only when they agree call again with `confirm` set to that digest: the server " +
        "re-plans and re-checks, refuses if anything changed, then runs `agentry run --mode autonomous --output-format " +
        "json` and returns the CLI's result envelope (status, exitClass, result, usage, receipts) with `receiptsDir`, " +
        "`resultFile` and `outDir` beside it. A run whose exit class is not ok comes back as a tool error (`isError`) " +
        "carrying that envelope: read its exitClass and reason, and never report it as finished. " +
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
        "log when the host asks for it. Cancelling the call stops the CLI run (SIGINT, so its teardown runs and " +
        "its receipts are written); the envelope it wrote is kept under a run id that agentry_run_status lists. " +
        "With `detach: true` on the confirm, the run is started in its own process and its id comes back at " +
        "once: follow it with agentry_run_status and stop it with agentry_run_cancel. Use that when the host's " +
        "tool timeout is shorter than the run's budget. The digest is the same as for a waited run.",
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
        model: z
          .string()
          .optional()
          .describe(
            "The saved model to run on, by its name or id (see agentry_models_list; `--model`, CLI v0.7.39 or later). " +
              "Its provider's credential pays and the harness follows that credential unless adapter names one. " +
              "This computer's default saved model when omitted; a name it does not have is refused, never replaced by the default. " +
              "With `on` it is one of this computer's saved models, and its credential alone travels with the run (CLI v0.7.39 or later); " +
              "the runhost's own saved models are for agentry_agent_model's on, not a run's.",
          ),
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
            "The built-in report theme the run's PDFs take (`--report-theme`): plain, classic, modern, editorial, " +
              "technical, boardroom, studio, field, civic or lumen; the account's default report design, else " +
              "the config's, when omitted. Not with reportDesign.",
          ),
        reportDesign: z
          .string()
          .optional()
          .describe(
            "The report design the run's PDFs take (`--report-design`, CLI v0.7.22 or later): the name or id of a " +
              "design of the account's library (agentry_report_design_list), or the path of a file holding one. " +
              "Not with reportTheme.",
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
        desktop: desktopArg,
        on: z
          .string()
          .optional()
          .describe(
            "Run on this remote runhost (`--on`; a name agentry_runhost_list gives) instead of this computer: the " +
              "release is verified here and sent over SSH with the model key, the secrets and intake answers " +
              "gathered here and the run's files; it is verified again on the runhost and run there under gVisor, " +
              "and its output is sealed to this computer and opened into `out`. The preview's readiness is the " +
              "runhost's own doctor. Not taken on a runhost yet: target-host sign-ins, a destination on the " +
              "person's own network, a model sign-in or Agentry credits. Needs CLI v0.6.1017 or later, and " +
              "v0.6.1019 or later for files, intake and the rest.",
          ),
        detach: z
          .boolean()
          .optional()
          .describe(
            "With `confirm`: start the run and return its id at once instead of waiting for it. The run writes to " +
              "`out`, or to ./agentry-out/<ns>-<name>-<id> under the working folder, and goes on if this server stops. " +
              "Follow it with agentry_run_status; stop it with agentry_run_cancel.",
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
    "agentry_run_status",
    {
      description:
        "Report a run this server started (a QuickAgent run, a draft, a review or a build, waited or detached) by " +
        "its id, or list them all without an id. Nothing of the CLI runs: the server reads the run's record, its " +
        "narration so far and, once it ends, the envelope the CLI wrote (its stdout, or result.json in the output " +
        "folder, the one `agentry runs` lists). `state` is running, ended, cancelled or lost; `progress` is the " +
        "narration's line count and tail. An ended run comes back as the run tool would have returned it: the " +
        "envelope with exitClass, receiptsDir, resultFile and outDir, its deliverables after it, and a failure " +
        "class as a tool error. A run started by an earlier server process is judged by its process and its " +
        "files, and one whose process is gone with no result is reported lost, never finished. Running runs are " +
        "not cancelled or changed by this call.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe(
            "The run id a detached start or a listing returned. Omit to list every run on record.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => guard("agentry_run_status", () => runStatus(d, a.id)),
  );

  registerTool(
    d.server,
    "agentry_run_cancel",
    {
      description:
        "Stop a run this server started, by its id: the CLI gets SIGINT, as Ctrl-C would send it, so its teardown " +
        "runs and it writes its envelope and receipts; SIGKILL follows after a minute if it is still there. Waits up " +
        "to waitSeconds for the end and returns the run as agentry_run_status would: cancelled with the CLI's " +
        "envelope (the class it reports, `cancelled: true` beside it), or still running if the teardown is not " +
        "done yet, in which case call agentry_run_status again. A run started by an earlier server process is " +
        "signalled by its process id. Cancel only when the person asks.",
      inputSchema: {
        id: z.string().describe("The run id a detached start or agentry_run_status returned."),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .describe("How long to wait for the run to end before answering (default 30)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (a, extra) =>
      guard("agentry_run_cancel", async () => {
        const s = await d.runs.cancel(a.id);
        if (!s) throw new ArgumentError(noSuchRun(a.id));
        const waited = await d.runs.waitForEnd(a.id, (a.waitSeconds ?? 30) * 1000, extra.signal);
        return statusResult(d, waited ?? s);
      }),
  );

  registerTool(
    d.server,
    "agentry_validate",
    {
      description:
        "Validate a QuickAgent workspace offline with the installed agentry CLI (`agentry validate --json`): the " +
        "registry's manifest rules (the CLI names those it ran) and its S1/S3/S4 scanners, as data — issues, inventory and scan " +
        "findings with file and line, the bundle version, and the scaffold lines still to replace (`unfinished`: a TODO, " +
        "a placeholder namespace, author or licence, a template's README). `stages` names the registry stages it ran here " +
        "and those only the registry runs (secrets, AI Review, support scripts, declared servers, publisher signals, the diff " +
        "against the previous version), so a pass is not a publication verdict: the registry runs every stage at " +
        'submission and decides. The report comes back whatever the verdict; exitClass "cli" beside it means it failed. ' +
        "For authoring: fix what it names, then validate again; publishing itself is `agentry publish` in a terminal.",
      inputSchema: {
        dir: z.string().describe("The workspace directory holding agent.yaml."),
        strict: z.boolean().optional().describe("Also fail on warnings."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => guard("agentry_validate", () => validate(d, a)),
  );
}

function noSuchRun(id: string): string {
  return `no run ${JSON.stringify(id)} is on record here; agentry_run_status without an id lists the runs this server started`;
}

async function runStatus(d: Driver, id: string | undefined): Promise<ReturnType<typeof toolJSON>> {
  if (id === undefined) {
    const runs = await d.runs.list();
    return toolJSON({
      runs: runs.map((s) => ({
        id: s.record.id,
        tool: s.record.tool,
        what: s.record.what,
        state: s.record.state,
        detached: s.record.detached,
        startedAt: s.record.startedAt,
        endedAt: s.record.endedAt,
        outDir: s.record.outDir,
        exitClass: exitClassOf(s),
      })),
    });
  }
  const s = await d.runs.status(id);
  if (!s) throw new ArgumentError(noSuchRun(id));
  return statusResult(d, s);
}

/** The exit class an ended run's envelope names, when it has one. */
function exitClassOf(s: RunStatus): string | undefined {
  const first = s.record.raw?.content[0];
  if (!first || first.type !== "text") return undefined;
  try {
    const env = JSON.parse(first.text) as { exitClass?: unknown };
    return typeof env.exitClass === "string" ? env.exitClass : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One run as the status and cancel tools report it. A running run is its
 * record and progress. An ended one is the run tool's own result (the
 * envelope, the deliverables, a failure class as an error) with the
 * record's fields beside the envelope. A lost one is an error that says so.
 */
async function statusResult(d: Driver, s: RunStatus): Promise<ReturnType<typeof toolJSON>> {
  const r = s.record;
  const head = {
    id: r.id,
    state: r.state,
    tool: r.tool,
    what: r.what,
    detached: r.detached,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    outDir: r.outDir,
    pid: r.state === "running" ? r.pid : undefined,
    cancelRequested: r.cancelRequested,
    progress: s.progress,
    ...(s.note ? { note: s.note } : {}),
  };
  if (r.state === "running") {
    return toolJSON({
      ...head,
      elapsedSeconds: Math.round((Date.now() - Date.parse(r.startedAt)) / 1000),
      next: `${r.tool === "agentry_run" ? "agentry_run_status reports it again; " : ""}agentry_run_cancel stops it.`,
    });
  }
  if (r.state === "lost" || !r.raw) {
    return toolText(
      `${JSON.stringify(head)}\n\nrun ${r.id} is lost: ${s.note ?? "its process is gone and it wrote no result"}.`,
      true,
    );
  }
  const finished = r.tool === "agentry_run" ? await decorateRun(r.raw, d.cwd) : runOutcome(r.raw);
  const first = finished.content[0];
  if (!first || first.type !== "text") return finished;
  let envelope: unknown;
  try {
    envelope = JSON.parse(first.text);
  } catch {
    // The CLI left no JSON: the error names the class and quotes its last lines.
    return {
      ...finished,
      content: [
        { type: "text", text: `${JSON.stringify(head)}\n\n${first.text}` },
        ...finished.content.slice(1),
      ],
    };
  }
  const merged =
    envelope && typeof envelope === "object"
      ? { ...head, ...(envelope as object) }
      : { ...head, result: envelope };
  return {
    ...finished,
    content: [{ type: "text", text: JSON.stringify(merged) }, ...finished.content.slice(1)],
  };
}
