// A run on a remote runhost: agentry_run's `on` plans on this computer, takes
// the runhost's doctor as its readiness, covers `on` in the digest and runs
// with --on; what a run on a runhost does not carry yet is refused before any
// plan; an older CLI is told what to update to. agentry_runhost_list passes
// the CLI's list through.
import assert from "node:assert/strict";
import { test } from "node:test";

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
    { ref: "acme/widget", on: "lab", files: ["/tmp/x"] },
    { ref: "acme/widget", on: "lab", intake: { repo: "https://example.com/r" } },
    { ref: "acme/widget", on: "lab", destinations: ["hook"] },
    { ref: "acme/widget", on: "lab", knowledge: ["notes"] },
    { local: "/tmp/ws", on: "lab" },
    { ref: "acme/widget", on: "Lab Server" },
    { ref: "acme/widget", on: "lab; id" },
  ]) {
    const r = await client.callTool({ name: "agentry_run", arguments: args });
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(runArgv(argvFile).length, 0, "nothing was planned");
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
