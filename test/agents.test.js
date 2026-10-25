// The persistent-agent tools: the reads pass the CLI's JSON through; a
// start that needs agreement and every roster switch are two calls whose
// digest covers the consent sentences; a send is one attach process whose
// answer is the reply to its own turn, and busy is said as busy.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { connect, envelope, receivedArgv } from "./helpers.js";

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

test("list and show pass the CLI's JSON through", async () => {
  const { client, argvFile } = await connect();
  const list = envelope(await call(client, "agentry_agent_list"));
  assert.equal(list.json.exitClass, "ok");
  assert.deepEqual(
    list.json.result.map((a) => a.agent),
    ["main", "assistant"],
  );
  const show = envelope(
    await call(client, "agentry_agent_show", { name: "assistant", transcript: 20 }),
  );
  assert.equal(show.json.result.roster[1].id, "share");
  assert.deepEqual(receivedArgv(argvFile), [
    ["agent", "list", "--json"],
    ["agent", "show", "assistant", "--json", "--transcript", "20"],
  ]);
});

test("a start with nothing new to agree to starts at once, without --yes", async () => {
  const { client, argvFile } = await connect({ FAKE_AGENT_AGREED: "1" });
  const r = envelope(await call(client, "agentry_agent_start", { name: "assistant" }));
  assert.equal(r.json.exitClass, "ok");
  assert.equal(r.json.result.state, "running");
  assert.deepEqual(receivedArgv(argvFile), [["agent", "start", "assistant", "--json"]]);
});

test("a start that needs agreement previews the sentences, and the confirm starts with --yes", async () => {
  const { client, argvFile } = await connect();
  const p = envelope(await call(client, "agentry_agent_start", { name: "assistant" }));
  assert.equal(p.json.writes, false);
  assert.deepEqual(p.json.needsAgreement, [
    { id: "share", line: "the folder /home/me/agentry/assistantshare, read and write" },
  ]);
  assert.match(p.json.digest, /^sha256:[0-9a-f]{64}$/);
  const r = envelope(
    await call(client, "agentry_agent_start", { name: "assistant", confirm: p.json.digest }),
  );
  assert.equal(r.json.exitClass, "ok");
  const argv = receivedArgv(argvFile);
  assert.deepEqual(argv.at(-1), ["agent", "start", "assistant", "--json", "--yes"]);
  assert.equal(argv.filter((a) => a.includes("--yes")).length, 1);
});

test("a start whose sentences changed since the preview is refused, and --yes never reaches the CLI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-mcp-agent-"));
  const needs = join(dir, "needs");
  const { client, argvFile } = await connect({ FAKE_AGENT_NEEDS_FILE: needs });
  const p = envelope(await call(client, "agentry_agent_start", { name: "assistant" }));
  writeFileSync(needs, "the folder /etc, read and write");
  const r = await call(client, "agentry_agent_start", {
    name: "assistant",
    confirm: p.json.digest,
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /does not match this preview/);
  for (const a of receivedArgv(argvFile))
    assert.ok(!a.includes("--yes"), `--yes reached the CLI: ${a}`);
});

test("a grant previews the entry and its sentence, and the confirm switches it with --yes", async () => {
  const { client, argvFile } = await connect({ FAKE_AGENT_STATE: "running" });
  const p = envelope(
    await call(client, "agentry_agent_grant", { name: "assistant", entry: "share", on: true }),
  );
  assert.equal(p.json.writes, false);
  assert.equal(p.json.entry.line, "the folder /home/me/agentry/assistantshare, read and write");
  assert.equal(p.json.currentlyOn, false);
  assert.equal(p.json.running, true);
  assert.match(p.json.note, /restarts with the change/);
  const r = envelope(
    await call(client, "agentry_agent_grant", {
      name: "assistant",
      entry: "share",
      on: true,
      confirm: p.json.digest,
    }),
  );
  assert.equal(r.json.exitClass, "ok");
  assert.deepEqual(receivedArgv(argvFile).at(-1), [
    "agent",
    "grant",
    "assistant",
    "share",
    "on",
    "--json",
    "--yes",
  ]);
});

test("a grant confirm is refused when the sentence moved, when on differs from the preview, and for a fixed or unknown entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-mcp-agent-"));
  const line = join(dir, "line");
  const { client, argvFile } = await connect({ FAKE_AGENT_LINE_FILE: line });
  const p = envelope(
    await call(client, "agentry_agent_grant", { name: "assistant", entry: "share", on: true }),
  );
  const flipped = await call(client, "agentry_agent_grant", {
    name: "assistant",
    entry: "share",
    on: false,
    confirm: p.json.digest,
  });
  assert.equal(flipped.isError, true);
  writeFileSync(line, "the folder /, read and write");
  const moved = await call(client, "agentry_agent_grant", {
    name: "assistant",
    entry: "share",
    on: true,
    confirm: p.json.digest,
  });
  assert.equal(moved.isError, true);
  assert.match(moved.content[0].text, /does not match this preview/);
  const fixed = await call(client, "agentry_agent_grant", {
    name: "assistant",
    entry: "data",
    on: false,
  });
  assert.match(fixed.content[0].text, /always on/);
  const unknown = await call(client, "agentry_agent_grant", {
    name: "assistant",
    entry: "server:nope",
    on: true,
  });
  assert.match(unknown.content[0].text, /no roster entry server:nope; its entries: data, share/);
  const main = await call(client, "agentry_agent_grant", {
    name: "main",
    entry: "share",
    on: true,
  });
  assert.match(main.content[0].text, /only in Agentry Desktop/);
  for (const a of receivedArgv(argvFile))
    assert.ok(!a.includes("--yes"), `--yes reached the CLI: ${a}`);
});

test("a send is one attach: the reply to its own turn, past the end of another chat's", async () => {
  const { client, argvFile } = await connect({ FAKE_AGENT_STALE: "1" });
  const r = envelope(
    await call(client, "agentry_agent_send", {
      name: "assistant",
      text: "remember the lighthouse",
    }),
  );
  assert.equal(r.json.sent, true);
  assert.equal(r.json.reply, "echo: remember the lighthouse");
  assert.deepEqual(r.json.toolCalls, ["read_share"]);
  assert.equal(r.json.usage.totalTokens, 14);
  assert.deepEqual(receivedArgv(argvFile), [["agent", "attach", "assistant", "--json"]]);
});

test("a send while another chat's turn is in flight is refused busy", async () => {
  const { client } = await connect({ FAKE_AGENT_BUSY: "1" });
  const r = await call(client, "agentry_agent_send", { name: "assistant", text: "hello" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /turn in flight; nothing was sent/);
});

test("a send past its limit detaches and says where the answer will be", async () => {
  const { client } = await connect({ FAKE_TURN_DELAY: "3" });
  const r = envelope(
    await call(client, "agentry_agent_send", {
      name: "assistant",
      text: "slow one",
      turnTimeoutSeconds: 1,
    }),
  );
  assert.equal(r.json.timedOut, true);
  assert.equal(r.json.sent, true);
  assert.match(r.json.note, /transcript/);
});

test("a CLI without agent attach is told to update, and nothing runs", async () => {
  const { client, argvFile } = await connect({}, {}, undefined, {
    deliverTo: true,
    destinations: true,
    buildSources: true,
    voiceURLs: true,
    agents: false,
    tasks: false,
  });
  for (const [name, args] of [
    ["agentry_agent_list", {}],
    ["agentry_agent_send", { name: "assistant", text: "hi" }],
    ["agentry_agent_grant", { name: "assistant", entry: "share", on: true }],
  ]) {
    const r = await call(client, name, args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Update the CLI/);
  }
  assert.deepEqual(receivedArgv(argvFile), []);
});

test("a name that looks like a flag is refused before the CLI", async () => {
  const { client, argvFile } = await connect();
  const r = await call(client, "agentry_agent_stop", { name: "--yes" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /must not start with "-"/);
  assert.deepEqual(receivedArgv(argvFile), []);
});

test("tasks are listed through the CLI's JSON, and one is paused or resumed by its id", async () => {
  const { client, argvFile } = await connect();
  const list = envelope(await call(client, "agentry_agent_tasks", { name: "assistant" }));
  assert.equal(list.json.exitClass, "ok");
  assert.equal(list.json.result.tasks[0].name, "Morning summary");
  const paused = envelope(
    await call(client, "agentry_agent_tasks", { name: "assistant", task: "t1", op: "pause" }),
  );
  assert.equal(paused.json.result.tasks[0].state, "paused");
  assert.deepEqual(receivedArgv(argvFile), [
    ["agent", "tasks", "assistant", "--json"],
    ["agent", "tasks", "assistant", "pause", "t1", "--json"],
  ]);
});

test("a task op needs its task and is pause or resume alone; remove and add never reach the CLI", async () => {
  const { client, argvFile } = await connect();
  for (const args of [
    { name: "assistant", task: "t1" },
    { name: "assistant", op: "pause" },
    { name: "assistant", task: "t1", op: "remove" },
    { name: "assistant", task: "--yes", op: "pause" },
  ]) {
    const r = await call(client, "agentry_agent_tasks", args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.deepEqual(receivedArgv(argvFile), []);
});

test("a CLI without agent tasks is told to update, and nothing runs", async () => {
  const { client, argvFile } = await connect({}, {}, undefined, {
    deliverTo: true,
    destinations: true,
    buildSources: true,
    voiceURLs: true,
    agents: true,
    tasks: false,
  });
  const r = await call(client, "agentry_agent_tasks", { name: "assistant" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Update the CLI/);
  assert.deepEqual(receivedArgv(argvFile), []);
});

test("a compaction previews what it spends, and the confirm runs agent compact", async () => {
  const { client, argvFile } = await connect({ FAKE_AGENT_STATE: "running" });
  const p = envelope(await call(client, "agentry_agent_compact", { name: "assistant" }));
  assert.equal(p.json.writes, true);
  assert.match(p.json.spends, /model plan for one upkeep turn/);
  assert.match(p.json.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(receivedArgv(argvFile), [["agent", "show", "assistant", "--json"]]);
  const r = envelope(
    await call(client, "agentry_agent_compact", { name: "assistant", confirm: p.json.digest }),
  );
  assert.equal(r.json.exitClass, "ok");
  assert.equal(r.json.result.compacted.swapped, true);
  assert.deepEqual(receivedArgv(argvFile).at(-1), ["agent", "compact", "assistant", "--json"]);
});

test("a compaction with a digest it was not given, or of a stopped agent, runs nothing", async () => {
  const { client, argvFile } = await connect({ FAKE_AGENT_STATE: "running" });
  const bad = await call(client, "agentry_agent_compact", {
    name: "assistant",
    confirm: "sha256:" + "0".repeat(64),
  });
  assert.equal(bad.isError, true);
  const stopped = await connect();
  const r = await call(stopped.client, "agentry_agent_compact", { name: "assistant" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /needs it running/);
  for (const argv of [...receivedArgv(argvFile), ...receivedArgv(stopped.argvFile)])
    assert.notEqual(argv[1], "compact");
});

test("a CLI without agent compact is told to update, and nothing runs", async () => {
  const { client, argvFile } = await connect({}, {}, undefined, {
    deliverTo: true,
    destinations: true,
    buildSources: true,
    voiceURLs: true,
    agents: true,
    tasks: true,
    compact: false,
  });
  const r = await call(client, "agentry_agent_compact", { name: "assistant" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Update the CLI/);
  assert.deepEqual(receivedArgv(argvFile), []);
});
