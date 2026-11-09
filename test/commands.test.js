// The tool table against the CLI's command tree: every command the CLI
// lists (spec/cli-commands.txt, read from its help by
// scripts/cli-commands.mjs) is run by a tool or named as terminal-only with
// its reason, nothing either list names is missing from the CLI, every
// registered tool says which commands it runs, and the README's
// terminal-only table is the list in src/commands.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { TERMINAL_ONLY, TOOL_COMMANDS } from "../dist/commands.js";
import { subcommands } from "../scripts/cli-commands.mjs";
import { connect } from "./helpers.js";

const TREE = readFileSync(new URL("../spec/cli-commands.txt", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l && !l.startsWith("#"));
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** The commands that take no subcommand: the ones a person runs. */
function leaves(tree) {
  return tree.filter((p) => !tree.some((q) => q.startsWith(p + " ")));
}

test("every CLI command is a tool's or terminal-only", () => {
  const byTool = new Set(Object.values(TOOL_COMMANDS).flat());
  const missing = leaves(TREE).filter((p) => !byTool.has(p) && !(p in TERMINAL_ONLY));
  assert.deepEqual(
    missing,
    [],
    "these CLI commands are neither run by a tool nor listed in TERMINAL_ONLY (src/commands.ts)",
  );
  const both = Object.keys(TERMINAL_ONLY).filter((p) => byTool.has(p));
  assert.deepEqual(both, [], "a command is both a tool's and terminal-only");
});

test("nothing names a command the CLI does not have", () => {
  const known = new Set(TREE);
  for (const [tool, commands] of Object.entries(TOOL_COMMANDS))
    for (const c of commands)
      assert.ok(known.has(c), `${tool} runs \`agentry ${c}\`, which the CLI does not list`);
  for (const c of Object.keys(TERMINAL_ONLY))
    assert.ok(known.has(c), `TERMINAL_ONLY names \`agentry ${c}\`, which the CLI does not list`);
});

test("every registered tool says which commands it runs", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOL_COMMANDS).sort());
});

test("the README's terminal-only table is TERMINAL_ONLY", () => {
  const start = README.indexOf("## Terminal-only commands");
  assert.ok(start >= 0, "the README has no Terminal-only commands section");
  const section = README.slice(start, README.indexOf("\n## ", start + 1));
  const rows = [...section.matchAll(/^\| `agentry ([a-z][a-z -]*)` *\|/gm)].map((m) => m[1]);
  assert.deepEqual(rows.sort(), Object.keys(TERMINAL_ONLY).sort());
});

test("the tree reader takes the command lists and nothing above the usage", () => {
  const help = [
    "Run things. Its states:",
    "  running   the agent is up",
    "",
    "Usage:",
    "  agentry agent [command]",
    "",
    "Start here:",
    "  doctor         Check this machine",
    "  check-signed-out Say whether",
    "",
    "Available Commands:",
    "  help           Help about any command",
    "  show           Show one",
    "",
    "Flags:",
    "  -h, --help   help",
  ].join("\n");
  assert.deepEqual(subcommands(help), ["doctor", "check-signed-out", "show"]);
});

test("a CLI that lacks a feature is told which tools refuse and how to update", async () => {
  const { ALL_FEATURES, FEATURE_TOOLS, missingFeaturesNote } = await import("../dist/cli.js");
  assert.equal(missingFeaturesNote("0.7.40", ALL_FEATURES), "");
  assert.deepEqual(Object.keys(FEATURE_TOOLS).sort(), Object.keys(ALL_FEATURES).sort());
  const note = missingFeaturesNote("0.7.1", { ...ALL_FEATURES, runhosts: false, compact: false });
  assert.match(note, /^agentry 0\.7\.1 is older than these tools need/);
  assert.match(note, /agentry_agent_compact; agentry_run's on \(a remote runhost\)\./);
  assert.match(note, /secureagentry\.net\/download/);
});
