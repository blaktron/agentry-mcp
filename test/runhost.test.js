// A run on a remote runhost: agentry_run's `on` plans on this computer, takes
// the runhost's doctor as its readiness, covers `on` in the digest and runs
// with --on and the run's files, intake and destinations; what a run on a
// runhost does not carry yet is refused before any plan; an older CLI is told
// what to update to. agentry_runhost_list passes
// the CLI's list through.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ALL_FEATURES } from "../dist/cli.js";

import { connect, receivedArgv } from "./helpers.js";

const runArgv = (path) => receivedArgv(path).filter((a) => a[0] === "run");

async function preview(client, args) {
  const r = await client.callTool({ name: "agentry_run", arguments: args });
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
}

test("run on a runhost: the plan is this computer's, the readiness the runhost's, and the run carries --on", async () => {
  const { client, argvFile } = await connect();
  const p = await preview(client, { ref: "acme/widget", on: "lab" });
  assert.equal(p.readiness.checked, "the remote runhost lab");
  assert.equal(p.readiness.ready, true);
  assert.match(p.summary, /Where: the remote runhost lab, over SSH/);
  const planned = receivedArgv(argvFile);
  assert.ok(
    planned.some((a) => a[0] === "runhost" && a[1] === "doctor" && a[2] === "lab"),
    "the runhost's doctor was asked",
  );
  assert.ok(!planned.some((a) => a[0] === "doctor"), "this computer's doctor was not asked");

  // The digest covers `on`: the same call for another runhost, or for this
  // computer, is another digest.
  const here = await preview(client, { ref: "acme/widget" });
  const other = await preview(client, { ref: "acme/widget", on: "lab2" });
  assert.notEqual(p.digest, here.digest);
  assert.notEqual(p.digest, other.digest);

  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", on: "lab", confirm: p.digest },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const run = runArgv(argvFile).at(-1);
  const i = run.indexOf("--on");
  assert.ok(i > 0 && run[i + 1] === "lab", run.join(" "));
  assert.ok(run.includes("--pin"));

  const wrong = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", on: "lab2", confirm: p.digest },
  });
  assert.equal(wrong.isError, true, "a digest for one runhost does not run on another");
});

test("a runhost whose doctor fails is not ready, and the summary says so", async () => {
  const { client } = await connect({ FAKE_RUNHOST_DOWN: "1" });
  const p = await preview(client, { ref: "acme/widget", on: "lab" });
  assert.equal(p.readiness.ready, false);
  assert.match(p.summary, /Ready to start: no/);
  assert.match(p.summary, /runhost:gvisor/);
});

test("what a run on a runhost does not carry yet, and a name that is not a runhost's, are refused before any plan", async () => {
  const { client, argvFile } = await connect();
  for (const args of [
    { local: "/tmp/ws", on: "lab" },
    { ref: "acme/widget", on: "Lab Server" },
    { ref: "acme/widget", on: "lab; id" },
  ]) {
    const r = await client.callTool({ name: "agentry_run", arguments: args });
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(runArgv(argvFile).length, 0, "nothing was planned");
});

test("a run on a runhost carries its files, intake, knowledge, voice, theme and destinations to the CLI", async () => {
  const { client, argvFile } = await connect();
  const dir = mkdtempSync(join(tmpdir(), "agentry-mcp-runhost-"));
  const notes = join(dir, "notes.txt");
  writeFileSync(notes, "notes");
  const args = {
    ref: "acme/widget",
    on: "lab",
    files: [notes],
    knowledge: ["notes"],
    intake: { topic: "birds" },
    destinations: ["hook"],
    reportTheme: "plain",
    deliverTo: dir,
  };
  const p = await preview(client, args);
  assert.match(p.summary, /the secrets and intake answers it gathers here, and the run's files/);
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ...args, confirm: p.digest },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const run = runArgv(argvFile).at(-1).join(" ");
  for (const want of [
    "--on lab",
    `--file ${notes}`,
    "--knowledge notes",
    "--intake topic=birds",
    "--destination hook",
    "--report-theme plain",
    `--deliver-to ${dir}`,
  ])
    assert.ok(run.includes(want), `${want} in ${run}`);
});

test("a CLI whose run --on carries a release alone is told to update before it is handed files", async () => {
  const { client, argvFile } = await connect({ FAKE_OLD_RUNHOST: "1" }, {}, undefined, {
    ...ALL_FEATURES,
    runhostJobs: false,
  });
  for (const args of [
    { ref: "acme/widget", on: "lab", files: ["/tmp/x"] },
    { ref: "acme/widget", on: "lab", intake: { repo: "https://example.com/r" } },
    { ref: "acme/widget", on: "lab", destinations: ["hook"] },
    { ref: "acme/widget", on: "lab", knowledge: ["notes"] },
    { ref: "acme/widget", on: "lab", hostKeys: { box: "/tmp/k" } },
  ]) {
    const r = await client.callTool({ name: "agentry_run", arguments: args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, /update the CLI to v0\.6\.1019/);
  }
  assert.equal(runArgv(argvFile).length, 0, "nothing was planned");
  const ok = await preview(client, { ref: "acme/widget", on: "lab" });
  assert.match(ok.summary, /Where: the remote runhost lab/);
});

test("a CLI without run --on is told what to update to", async () => {
  const { client } = await connect({ FAKE_NO_RUNHOST: "1" }, {}, undefined, { runhosts: false });
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", on: "lab" },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no run --on; update the CLI to v0\.6\.1017/);
});

test("agentry_runhost_list passes the CLI's list through, and says when the CLI has no runhost command", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({ name: "agentry_runhost_list", arguments: {} });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /"name":\s*"lab"/);
  assert.ok(receivedArgv(argvFile).some((a) => a.join(" ") === "runhost list --json"));

  const old = await connect({ FAKE_NO_RUNHOST: "1" });
  const r2 = await old.client.callTool({ name: "agentry_runhost_list", arguments: {} });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /no runhost command; update the CLI to v0\.6\.1014/);
});

test("a run on a runhost passes its adapter, and says claude runs as its image there", async () => {
  const { client, argvFile } = await connect();
  const p = await preview(client, { ref: "acme/widget", on: "lab", adapter: "claude" });
  assert.match(p.summary, /claude runs as its image, claude-image, in a container under gVisor/);
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", on: "lab", adapter: "claude", confirm: p.digest },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const run = runArgv(argvFile).at(-1).join(" ");
  assert.ok(run.includes("--on lab") && run.includes("--adapter claude"), run);
});

test("a CLI whose run --on takes no adapter is told to update before anything is planned", async () => {
  const { client, argvFile } = await connect({}, {}, undefined, {
    ...ALL_FEATURES,
    runhostSignIns: false,
  });
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", on: "lab", adapter: "codex" },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /update the CLI to v0\.7\.6/);
  assert.equal(runArgv(argvFile).length, 0, "nothing was planned");
  const here = await preview(client, { ref: "acme/widget", adapter: "codex" });
  assert.doesNotMatch(here.summary, /Where: the remote runhost/);
});

test("agentry_schedule_list takes on and lists that runhost's schedules", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({ name: "agentry_schedule_list", arguments: { on: "lab" } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /"kind":\s*"model-key"/);
  assert.ok(receivedArgv(argvFile).some((a) => a.join(" ") === "runhost schedules lab --json"));
  const bad = await client.callTool({
    name: "agentry_schedule_list",
    arguments: { on: "Lab Server" },
  });
  assert.equal(bad.isError, true);

  const old = await connect({}, {}, undefined, { ...ALL_FEATURES, runhostSchedules: false });
  const r2 = await old.client.callTool({ name: "agentry_schedule_list", arguments: { on: "lab" } });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /update the CLI to v0\.7\.11/);
  const here = await old.client.callTool({ name: "agentry_schedule_list", arguments: {} });
  assert.equal(here.isError, undefined, here.content[0].text);
});

test("the agent tools take on and drive the agent on that runhost", async () => {
  const { client, argvFile } = await connect();
  for (const [name, args] of [
    ["agentry_agent_list", { on: "lab" }],
    ["agentry_agent_show", { name: "assistant", on: "lab" }],
    ["agentry_agent_stop", { name: "assistant", on: "lab" }],
    ["agentry_agent_tasks", { name: "assistant", on: "lab" }],
  ]) {
    await client.callTool({ name, arguments: args });
  }
  const sent = receivedArgv(argvFile).filter((a) => a[0] === "agent");
  for (const sub of ["list", "show", "stop", "tasks"]) {
    const a = sent.find((x) => x[1] === sub);
    assert.ok(a, `agent ${sub} was not run`);
    const i = a.indexOf("--on");
    assert.ok(i > 0 && a[i + 1] === "lab", a.join(" "));
  }
  const bad = await client.callTool({
    name: "agentry_agent_show",
    arguments: { name: "assistant", on: "Lab Server" },
  });
  assert.equal(bad.isError, true);
  const withPolicy = await client.callTool({
    name: "agentry_agent_start",
    arguments: { name: "assistant", on: "lab", policy: "/etc/x.yaml" },
  });
  assert.equal(withPolicy.isError, true);
  assert.match(withPolicy.content[0].text, /policy names a file on this computer/);

  const old = await connect({}, {}, undefined, { ...ALL_FEATURES, runhostAgents: false });
  const r = await old.client.callTool({
    name: "agentry_agent_show",
    arguments: { name: "assistant", on: "lab" },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /update the CLI to v0\.7\.14/);
  const here = await old.client.callTool({ name: "agentry_agent_list", arguments: {} });
  assert.equal(here.isError, undefined, here.content[0].text);
});
