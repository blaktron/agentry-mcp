// The README's tool tables and the registered tools agree: every
// `agentry_*` row in a README table is a registered tool, every registered
// tool has a row, and the descriptions name the same CLI command the row
// says the tool runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { connect } from "./helpers.js";

const README = new URL("../README.md", import.meta.url);

/** The tool rows of every table: name → the "Runs" cell. */
function readmeTools() {
  const rows = new Map();
  for (const line of readFileSync(README, "utf8").split("\n")) {
    const m = /^\| `(agentry_[a-z_]+)`\s*\| (.*?)\s*\|/.exec(line);
    if (m) rows.set(m[1], m[2]);
  }
  return rows;
}

test("the README's tables name exactly the registered tools", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const registered = new Map(tools.map((t) => [t.name, t.description]));
  const rows = readmeTools();
  assert.deepEqual([...rows.keys()].sort(), [...registered.keys()].sort());
});

test("each README row's CLI command appears in the tool's description", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const described = new Map(tools.map((t) => [t.name, t.description]));
  for (const [name, runs] of readmeTools()) {
    // The row's first backticked `agentry …` span is the command the tool
    // runs; the description spells the same subcommand. A session's send
    // and close run no command — they type into the open chat — and their
    // descriptions say so.
    const cmd = /`agentry ([a-z]+)/.exec(runs);
    if (!cmd) {
      assert.match(runs, /chat/, `${name}: the README row names neither a command nor the chat`);
      assert.match(described.get(name), /session/, `${name}: the description does not say session`);
      continue;
    }
    const want = name.startsWith("agentry_session") ? "--mode interactive" : `agentry ${cmd[1]}`;
    assert.ok(described.get(name).includes(want), `${name}: description does not name ${want}`);
  }
});
