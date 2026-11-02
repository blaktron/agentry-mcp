// The persistent-agent tools: the reads pass the CLI's JSON through; a
// start that needs agreement and every roster switch are two calls whose
// digest covers the consent sentences; a send is one attach process whose
// answer is the reply to its own turn, and busy is said as busy.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("the Coding agent is compacted the same way, and the preview names no memory of its own", async () => {
  const { client, argvFile } = await connect({ FAKE_AGENT_STATE: "running" });
  const p = envelope(await call(client, "agentry_agent_compact", { name: "coder" }));
  assert.equal(p.json.writes, true);
  assert.match(p.json.note, /writes a short handoff/);
  assert.match(p.json.note, /the Assistant first saves/);
  assert.deepEqual(receivedArgv(argvFile), [["agent", "show", "coder", "--json"]]);
  const r = envelope(
    await call(client, "agentry_agent_compact", { name: "coder", confirm: p.json.digest }),
  );
  assert.equal(r.json.exitClass, "ok");
  assert.deepEqual(receivedArgv(argvFile).at(-1), ["agent", "compact", "coder", "--json"]);
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

// A published persistent agent: acme/widget in the fake CLI, with a persona,
// a shipped pack and one subagent.
const AGENT_CONTRACT = JSON.stringify({
  persistent: { clock: true, memory: true, secrets: ["WIDGET_TOKEN"] },
  knowledge: ["handbook"],
  subagents: [{ ref: "acme/summarizer", version: "^1.0.0", why: "Summarises long documents." }],
});
const PERSISTENT = { FAKE_MODES: "persistent", FAKE_CONTRACT: AGENT_CONTRACT };

test("every agent tool takes a built-in's name or a published agent's ns/name, and nothing else", async () => {
  const { client, argvFile } = await connect();
  for (const name of ["assistant", "acme/widget", "acme.widget", "widget"])
    assert.equal((await call(client, "agentry_agent_show", { name })).isError, undefined, name);
  assert.deepEqual(
    receivedArgv(argvFile).map((a) => a[2]),
    ["assistant", "acme/widget", "acme.widget", "widget"],
  );
  const before = receivedArgv(argvFile).length;
  for (const name of [
    "--json",
    "acme/--yes",
    "acme/widget/extra",
    "Acme/Widget",
    "acme/../x",
    "acme/widget --yes",
    "acme.widget.more",
    "../widget",
    "/widget",
    "acme/",
    "a_b",
  ]) {
    for (const tool of ["agentry_agent_show", "agentry_agent_stop", "agentry_agent_start"]) {
      const r = await call(client, tool, { name });
      assert.equal(r.isError, true, `${tool} ${name}`);
    }
  }
  assert.equal(receivedArgv(argvFile).length, before);
});

test("show returns a published agent's release, persona, pack, subagent pins and their roster entries", async () => {
  const { client, argvFile } = await connect();
  const r = envelope(await call(client, "agentry_agent_show", { name: "acme/widget" }));
  const st = r.json.result;
  assert.equal(st.ref, "acme/widget");
  assert.equal(st.version, "1.0.0");
  assert.equal(st.persona.name, "Wally");
  assert.deepEqual(st.packs, ["handbook"]);
  assert.equal(st.subagents[0].ref, "acme/summarizer");
  assert.equal(st.subagents[0].version, "1.2.0");
  assert.deepEqual(
    st.roster.map((e) => e.id),
    ["subagent:acme/summarizer", "subagent:acme/summarizer:ask"],
  );
  assert.deepEqual(receivedArgv(argvFile), [["agent", "show", "acme/widget", "--json"]]);
});

test("a subagent's ask switch is a roster entry a grant previews and then switches", async () => {
  const { client, argvFile } = await connect();
  const entry = "subagent:acme/summarizer:ask";
  const p = envelope(
    await call(client, "agentry_agent_grant", { name: "acme/widget", entry, on: true }),
  );
  assert.equal(p.json.entry.id, entry);
  assert.equal(p.json.currentlyOn, false);
  const r = envelope(
    await call(client, "agentry_agent_grant", {
      name: "acme/widget",
      entry,
      on: true,
      confirm: p.json.digest,
    }),
  );
  assert.equal(r.json.exitClass, "ok");
  assert.deepEqual(receivedArgv(argvFile).at(-1), [
    "agent",
    "grant",
    "acme/widget",
    entry,
    "on",
    "--json",
    "--yes",
  ]);
});

test("an install previews the persistent keys, pack, subagents and persona, and the confirm installs the version it showed", async () => {
  const { client, argvFile } = await connect(PERSISTENT);
  const p = envelope(await call(client, "agentry_agent_install", { ref: "acme/widget" }));
  assert.equal(p.json.writes, false);
  assert.equal(p.json.ref, "acme/widget@1.0.0");
  assert.deepEqual(p.json.persistent, { clock: true, memory: true, secrets: ["WIDGET_TOKEN"] });
  assert.deepEqual(p.json.knowledge, ["handbook"]);
  assert.equal(p.json.subagents[0].why, "Summarises long documents.");
  assert.deepEqual(p.json.persona, { name: "Wally", editable: false });
  assert.equal(p.json.attestation, "verified");
  assert.match(p.json.note, /resolved by the CLI while it installs/);
  assert.match(p.json.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(receivedArgv(argvFile), [
    ["install", "acme/widget", "--plan", "--json"],
    ["info", "acme/widget", "--json"],
  ]);

  const r = envelope(
    await call(client, "agentry_agent_install", { ref: "acme/widget", confirm: p.json.digest }),
  );
  assert.equal(r.json.exitClass, "ok");
  assert.equal(r.json.result.subagents[0].version, "1.2.0");
  assert.equal(r.json.result.enabled, true);
  const argv = receivedArgv(argvFile);
  assert.deepEqual(argv.at(-1), ["agent", "install", "acme/widget@1.0.0", "--json", "--yes"]);
  assert.equal(argv.filter((a) => a.includes("--yes")).length, 1);
});

test("an install confirm that is not the preview's digest, or is for another call, writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-mcp-agent-"));
  const writes = join(dir, "writes");
  const { client, argvFile } = await connect({ ...PERSISTENT, FAKE_WRITES: writes });
  const p = envelope(await call(client, "agentry_agent_install", { ref: "acme/widget" }));
  for (const args of [
    { ref: "acme/widget", confirm: "sha256:" + "0".repeat(64) },
    { ref: "acme/widget", registry: "https://other.example", confirm: p.json.digest },
  ]) {
    const r = await call(client, "agentry_agent_install", args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /does not match this preview/);
  }
  assert.equal(existsSync(writes), false);
  for (const a of receivedArgv(argvFile)) assert.ok(!a.includes("--yes"), a.join(" "));
});

test("an install of a release that is not persistent, unsigned or unscanned is refused before anything is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-mcp-agent-"));
  const writes = join(dir, "writes");
  const plain = await connect({ FAKE_WRITES: writes });
  const r = await call(plain.client, "agentry_agent_install", { ref: "acme/widget" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not a persistent QuickAgent/);

  for (const attest of ["unsigned", "unscanned"]) {
    const { client, argvFile } = await connect({
      ...PERSISTENT,
      FAKE_ATTEST: attest,
      FAKE_WRITES: writes,
    });
    const p = envelope(await call(client, "agentry_agent_install", { ref: "acme/widget" }));
    assert.equal(p.json.refusals.length, 1);
    assert.equal(p.json.refusals[0].lift, undefined);
    const c = await call(client, "agentry_agent_install", {
      ref: "acme/widget",
      confirm: p.json.digest,
      acceptUnsigned: true,
      acceptUnscanned: true,
    });
    assert.equal(c.isError, true, attest);
    assert.match(c.content[0].text, /the CLI would refuse this/);
    for (const a of receivedArgv(argvFile)) assert.ok(!a.includes("--yes"), a.join(" "));
  }
  assert.equal(existsSync(writes), false);
});

test("an install of an agent already installed says the update stays at a terminal", async () => {
  const { client } = await connect({ ...PERSISTENT, FAKE_INSTALLED_AS_AGENT: "1" });
  const r = await call(client, "agentry_agent_install", { ref: "acme/widget" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /installed already/);
});

test("a persona of another version than the plan's is not shown, and the preview says so", async () => {
  const { client } = await connect({ ...PERSISTENT, FAKE_INFO_VERSION: "2.0.0" });
  const p = envelope(await call(client, "agentry_agent_install", { ref: "acme/widget@1.0.0" }));
  assert.equal(p.json.persona, null);
  assert.match(p.json.note, /persona could not be read/);
});

test("the person declining the host's question stops an install", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-mcp-agent-"));
  const writes = join(dir, "writes");
  const { client, elicitations } = await connect(
    { ...PERSISTENT, FAKE_WRITES: writes },
    {},
    "decline",
  );
  const p = envelope(await call(client, "agentry_agent_install", { ref: "acme/widget" }));
  const r = await call(client, "agentry_agent_install", {
    ref: "acme/widget",
    confirm: p.json.digest,
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /declined/);
  assert.match(elicitations[0], /persistent agent/);
  assert.match(elicitations[0], /WIDGET_TOKEN/);
  assert.match(elicitations[0], /acme\/summarizer/);
  assert.equal(existsSync(writes), false);
});

test("an install argument that is not an ns/name with an optional version never reaches the CLI", async () => {
  const { client, argvFile } = await connect(PERSISTENT);
  for (const ref of [
    "--local",
    "widget",
    "acme/widget@",
    "acme/widget@--yes",
    "acme/widget@1 --yes",
    "acme/widget/x",
    "Acme/widget",
  ]) {
    const r = await call(client, "agentry_agent_install", { ref });
    assert.equal(r.isError, true, ref);
  }
  assert.deepEqual(receivedArgv(argvFile), []);
  const ok = await call(client, "agentry_agent_install", { ref: "acme/widget@^1.0" });
  assert.equal(ok.isError, undefined);
});

test("a CLI without agent install is told to update, and nothing runs", async () => {
  const { client, argvFile } = await connect({}, {}, undefined, {
    deliverTo: true,
    destinations: true,
    buildSources: true,
    voiceURLs: true,
    agents: true,
    tasks: true,
    compact: true,
    publishedAgents: false,
  });
  for (const [tool, args] of [
    ["agentry_agent_install", { ref: "acme/widget" }],
    ["agentry_agent_uninstall", { name: "acme/widget" }],
  ]) {
    const r = await call(client, tool, args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Update the CLI/);
  }
  assert.deepEqual(receivedArgv(argvFile), []);
});

test("an uninstall says the data is kept, and the confirm uninstalls without --remove-data", async () => {
  const { client, argvFile } = await connect();
  const p = envelope(await call(client, "agentry_agent_uninstall", { name: "widget" }));
  assert.equal(p.json.writes, false);
  assert.equal(p.json.ref, "acme/widget");
  assert.equal(p.json.dataRemoved, false);
  assert.ok(p.json.keeps.includes("its conversation"));
  assert.ok(!p.json.removes.includes("its conversation"));
  assert.deepEqual(receivedArgv(argvFile), [["agent", "show", "widget", "--json"]]);
  const r = envelope(
    await call(client, "agentry_agent_uninstall", { name: "widget", confirm: p.json.digest }),
  );
  assert.equal(r.json.result.dataRemoved, false);
  assert.deepEqual(receivedArgv(argvFile).at(-1), ["agent", "uninstall", "acme/widget", "--json"]);
});

test("removing the data needs the reference as confirmRef, and passes it as --confirm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-mcp-agent-"));
  const writes = join(dir, "writes");
  const { client, argvFile } = await connect({ FAKE_WRITES: writes });
  const p = envelope(
    await call(client, "agentry_agent_uninstall", { name: "acme/widget", removeData: true }),
  );
  assert.equal(p.json.dataRemoved, true);
  assert.ok(p.json.removes.includes("its conversation"));
  assert.match(p.json.note, /confirmRef/);
  // A digest of the keep-the-data call is not the wipe's.
  const keep = envelope(await call(client, "agentry_agent_uninstall", { name: "acme/widget" }));
  const mismatched = await call(client, "agentry_agent_uninstall", {
    name: "acme/widget",
    removeData: true,
    confirmRef: "acme/widget",
    confirm: keep.json.digest,
  });
  assert.equal(mismatched.isError, true);
  assert.match(mismatched.content[0].text, /does not match this preview/);
  for (const confirmRef of [undefined, "widget", "acme/other"]) {
    const r = await call(client, "agentry_agent_uninstall", {
      name: "acme/widget",
      removeData: true,
      ...(confirmRef ? { confirmRef } : {}),
      confirm: p.json.digest,
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /needs `confirmRef`/);
  }
  assert.equal(existsSync(writes), false);
  const r = envelope(
    await call(client, "agentry_agent_uninstall", {
      name: "acme/widget",
      removeData: true,
      confirmRef: "acme/widget",
      confirm: p.json.digest,
    }),
  );
  assert.equal(r.json.result.dataRemoved, true);
  assert.deepEqual(receivedArgv(argvFile).at(-1), [
    "agent",
    "uninstall",
    "acme/widget",
    "--remove-data",
    "--confirm",
    "acme/widget",
    "--json",
  ]);
});

test("an uninstall refuses a built-in, a running agent, and a confirmRef without removeData", async () => {
  const { client, argvFile } = await connect();
  const builtin = await call(client, "agentry_agent_uninstall", { name: "assistant" });
  assert.equal(builtin.isError, true);
  assert.match(builtin.content[0].text, /built into Agentry/);
  const stray = await call(client, "agentry_agent_uninstall", {
    name: "acme/widget",
    confirmRef: "acme/widget",
  });
  assert.equal(stray.isError, true);
  assert.match(stray.content[0].text, /goes with removeData/);
  const running = await connect({ FAKE_AGENT_STATE: "running" });
  const r = await call(running.client, "agentry_agent_uninstall", { name: "acme/widget" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /stop it first/);
  for (const argv of [...receivedArgv(argvFile), ...receivedArgv(running.argvFile)])
    assert.notEqual(argv[1], "uninstall");
});

test("a question the agent asks during a send goes to the person through the host, and their answer goes back", async () => {
  for (const [elicit, answer] of [
    ["accept", "yes"],
    ["decline", "no"],
  ]) {
    const { client, elicitations } = await connect(
      { FAKE_AGENT_QUESTION: "Run acme/summarizer?\n\nIt reaches nothing." },
      {},
      elicit,
    );
    const r = envelope(
      await call(client, "agentry_agent_send", { name: "acme/widget", text: "summarise" }),
    );
    assert.equal(r.json.reply, `echo: summarise [answered ${answer}]`);
    assert.deepEqual(r.json.questions, [
      { id: "q-1", text: "Run acme/summarizer?\n\nIt reaches nothing.", answer },
    ]);
    assert.match(elicitations[0], /Run acme\/summarizer\?/);
  }
});

test("a question on a host that cannot ask the person is left unanswered, and the send says so", async () => {
  const { client } = await connect({ FAKE_AGENT_QUESTION: "Run acme/summarizer?" });
  const r = envelope(
    await call(client, "agentry_agent_send", { name: "acme/widget", text: "summarise" }),
  );
  assert.equal(r.json.awaitingPerson, true);
  assert.equal(r.json.reply, undefined);
  assert.deepEqual(r.json.questions, [{ id: "q-1", text: "Run acme/summarizer?" }]);
  assert.match(r.json.note, /never yours|cannot put to them/);
});
