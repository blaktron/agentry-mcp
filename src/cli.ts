/**
 * The seam to the person's `agentry` binary: found through AGENTRY_BIN or
 * on PATH, checked once at start, and invoked with an argv assembled from
 * typed arguments — never a shell string. The server never downloads,
 * bundles or updates the CLI: it is the person's, with the person's login,
 * consent memory and runner policy.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

/** The current tool surface requires the CLI's Knowledge, Voice, built-ins and session protocol. */
export const MIN_CLI_VERSION = "0.6.63";

/**
 * What this CLI can do beyond the floor, probed from its help at start so a
 * call that needs a newer CLI says so instead of failing on an unknown flag.
 */
export interface CliFeatures {
  /** `run --deliver-to` and the run envelope's deliverables block. */
  deliverTo: boolean;
  /** `run --destination`, `agentry destinations` and `agentry deliver`. */
  destinations: boolean;
  /** `knowledge create|add --repo` and `--url`: a build from a repository or an address. */
  buildSources: boolean;
  /** `voice create|improve|edit --url`: samples from web addresses. */
  voiceURLs: boolean;
  /** `agent attach --json` and JSON from `agent start|stop`: persistent agents for a program. */
  agents: boolean;
  /** `agent tasks <name> [pause|resume|remove <task>] --json`: an agent's tasks. */
  tasks: boolean;
  /** `agent compact <name> --json`: an upkeep turn and a fresh conversation. */
  compact: boolean;
}

/** The features of a CLI that has them all (the tests' fake, a current CLI). */
export const ALL_FEATURES: CliFeatures = {
  deliverTo: true,
  destinations: true,
  buildSources: true,
  voiceURLs: true,
  agents: true,
  tasks: true,
  compact: true,
};

/** What `agentry --version` said, parsed. */
export interface CliVersion {
  /** The raw string after `agentry version `. */
  raw: string;
  /** The x.y.z part when raw is a release version, else undefined. */
  semver?: string;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started or was killed by a signal. */
  spawnError?: string;
  /** Set when the timeout's SIGINT ended the run and the CLI exited by itself. */
  timedOut?: boolean;
}

export interface CliOptions {
  timeoutMs?: number;
  cwd?: string;
  /** Extra environment on top of the server's own; never a credential. */
  env?: Record<string, string>;
  /** Called with each complete stderr line as it arrives (the CLI's narration). */
  onStderrLine?: (line: string) => void;
  /**
   * How a timeout ends the process: SIGINT first (the CLI's teardown runs
   * on every path), SIGKILL after graceMs if it is still there. Default
   * SIGKILL at once, for the short commands.
   */
  graceMs?: number;
}

/** Thrown at start when no usable CLI is found. */
export class CliUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUnavailableError";
  }
}

/** Resolves the binary: AGENTRY_BIN when set, else `agentry` on PATH. */
export async function findCli(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const explicit = env.AGENTRY_BIN;
  if (explicit) {
    await mustBeExecutable(explicit, `AGENTRY_BIN=${explicit} is not an executable file`);
    return explicit;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "agentry");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  throw new CliUnavailableError(
    "no `agentry` binary on PATH and AGENTRY_BIN is not set. Install the Agentry CLI " +
      "(https://secureagentry.net/download) or point AGENTRY_BIN at it; this server never " +
      "bundles or downloads one.",
  );
}

async function mustBeExecutable(path: string, message: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new CliUnavailableError(message);
  }
}

/** Runs the CLI with argv, capturing both streams. Never a shell. */
export function runCli(bin: string, argv: string[], opts: CliOptions = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (r: CliResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    // utf8 on the streams, so a multi-byte character split across chunks
    // does not corrupt the JSON.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    let pending = "";
    child.stderr.on("data", (d: string) => {
      stderr += d;
      if (!opts.onStderrLine) return;
      pending += d;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) opts.onStderrLine(line);
    });
    child.on("error", (err) => finish({ code: -1, stdout, stderr, spawnError: err.message }));
    child.on("close", (code, signal) => {
      if (timedOut && (signal || code === null)) {
        finish({
          code: -1,
          stdout,
          stderr,
          spawnError:
            `timed out after ${opts.timeoutMs}ms and was killed` +
            (opts.graceMs
              ? `; SIGINT went unanswered for ${opts.graceMs}ms, so the CLI's teardown may not have run — check for leftover agentry-* containers`
              : ""),
        });
      } else if (timedOut) {
        // SIGINT let the CLI finish its teardown and exit on its own: its
        // exit class is the answer, and the timeout is noted.
        finish({ code: code ?? -1, stdout, stderr, timedOut: true });
      } else if (signal) finish({ code: -1, stdout, stderr, spawnError: `killed by ${signal}` });
      else finish({ code: code ?? -1, stdout, stderr });
    });
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      let hard: NodeJS.Timeout | undefined;
      const t = setTimeout(() => {
        timedOut = true;
        if (opts.graceMs && opts.graceMs > 0) {
          child.kill("SIGINT");
          hard = setTimeout(() => child.kill("SIGKILL"), opts.graceMs);
        } else {
          child.kill("SIGKILL");
        }
      }, opts.timeoutMs);
      child.on("close", () => {
        clearTimeout(t);
        if (hard) clearTimeout(hard);
      });
    }
  });
}

/** Parses `agentry version <raw>`; anything else is not our CLI. */
export function parseVersion(output: string): CliVersion | undefined {
  const m = /^agentry version (\S+)/m.exec(output.trim());
  if (!m || !m[1]) return undefined;
  const raw = m[1].replace(/^v/, "");
  const sv = /^(\d+)\.(\d+)\.(\d+)(?:$|[+-])/.exec(raw);
  // "0.0.0-dev" is a dev build, not a release at 0.0.0.
  if (sv && !raw.endsWith("-dev")) return { raw, semver: `${sv[1]}.${sv[2]}.${sv[3]}` };
  return { raw };
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Runs `agentry --version` once and refuses a missing, foreign or too-old
 * CLI with a message that names the floor. Returns what it found so the
 * server can say it in its start-up line.
 */
export async function checkCli(
  bin: string,
  floor: string = MIN_CLI_VERSION,
): Promise<CliVersion & { floorChecked: boolean; features: CliFeatures }> {
  const r = await runCli(bin, ["--version"], { timeoutMs: 10_000 });
  if (r.spawnError) {
    throw new CliUnavailableError(`${bin} could not be run: ${r.spawnError}`);
  }
  const v = parseVersion(r.stdout);
  if (!v) {
    throw new CliUnavailableError(
      `${bin} did not answer \`--version\` like the Agentry CLI (got ${JSON.stringify(r.stdout.trim().slice(0, 80))}); ` +
        `this server drives the \`agentry\` CLI ${floor} or newer.`,
    );
  }
  if (v.semver !== undefined && compareSemver(v.semver, floor) < 0) {
    throw new CliUnavailableError(
      `${bin} is agentry ${v.raw}; this server needs ${floor} or newer. Update the CLI ` +
        `(https://secureagentry.net/download); the server never updates it for you.`,
    );
  }
  // A build from an untagged tree carries no version to compare, so the
  // output the writing tools need is probed directly as well:
  // `install --plan` and `run --plan` are what the consent previews run.
  for (const command of ["install", "run"]) {
    const help = await runCli(bin, [command, "--help"], { timeoutMs: 10_000 });
    if (help.spawnError || !/--plan\b/.test(help.stdout + help.stderr)) {
      throw new CliUnavailableError(
        `${bin} (agentry ${v.raw}) has no \`${command} --plan\`; this server needs the CLI ` +
          `${floor} or newer. Update the CLI; the server never updates it for you.`,
      );
    }
  }
  const protocol = await runCli(bin, ["run", "--help"], { timeoutMs: 10_000 });
  if (!/--session-protocol\b/.test(protocol.stdout + protocol.stderr))
    throw new CliUnavailableError(
      `${bin} has no run --session-protocol; update the CLI to ${floor} or newer.`,
    );
  for (const command of ["draft", "review", "knowledge", "voice", "builtins"]) {
    const help = await runCli(bin, [command, "--help"], { timeoutMs: 10_000 });
    if (help.spawnError || help.code !== 0)
      throw new CliUnavailableError(
        `${bin} has no ${command} command; update the CLI to ${floor} or newer.`,
      );
  }
  const runHelp = protocol.stdout + protocol.stderr;
  const knowledgeHelp = await runCli(bin, ["knowledge", "create", "--help"], { timeoutMs: 10_000 });
  const voiceHelp = await runCli(bin, ["voice", "create", "--help"], { timeoutMs: 10_000 });
  // A CLI without the subcommand prints the parent's help, so the probe
  // looks for attach's own usage line.
  const attachHelp = await runCli(bin, ["agent", "attach", "--help"], { timeoutMs: 10_000 });
  const tasksHelp = await runCli(bin, ["agent", "tasks", "--help"], { timeoutMs: 10_000 });
  const compactHelp = await runCli(bin, ["agent", "compact", "--help"], { timeoutMs: 10_000 });
  return {
    ...v,
    floorChecked: v.semver !== undefined,
    features: {
      deliverTo: /--deliver-to\b/.test(runHelp),
      destinations: /--destination\b/.test(runHelp),
      buildSources: /--repo\b/.test(knowledgeHelp.stdout + knowledgeHelp.stderr),
      voiceURLs: /--url\b/.test(voiceHelp.stdout + voiceHelp.stderr),
      agents: /attach <name> --json/.test(attachHelp.stdout + attachHelp.stderr),
      tasks: /tasks <name> \[pause\|resume/.test(tasksHelp.stdout + tasksHelp.stderr),
      compact: /compact <name>/.test(compactHelp.stdout + compactHelp.stderr),
    },
  };
}
