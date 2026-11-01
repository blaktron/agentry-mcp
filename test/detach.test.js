// Cancelling and detaching runs: a host's cancel stops the CLI run and
// keeps its envelope under a run id; a detached start returns the id at
// once; status reports a run before and after its end; cancel stops a
// detached run; a run an earlier server started is judged by its process
// and its files.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { connect, receivedArgv } from "./helpers.js";

const RUN = { ref: "acme/widget", input: "do the thing" };

async function consented(client, args = {}, name = "agentry_run") {
  const p = await client.callTool({ name, arguments: { ...RUN, ...args } });
  assert.equal(p.isError, undefined, p.content[0].text);
  return JSON.parse(p.content[0].text).digest;
}

function pidFile() {
  return join(mkdtempSync(join(tmpdir(), "agentry-mcp-pid-")), "pid");
}

function processGone(file) {
  const pid = Number(readFileSync(file, "utf8").trim());
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH";
  }
}

async function until(fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    assert.ok(Date.now() < end, "timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const status = async (client, id) =>
  client.callTool({ name: "agentry_run_status", arguments: id === undefined ? {} : { id } });

test("a host's cancel stops the blocking run with SIGINT, and the envelope the CLI wrote is kept under a run id", async () => {
  const pid = pidFile();
  const { client, stateDir } = await connect({ FAKE_RUN_SLEEP: "30", FAKE_RUN_PID: pid });
  const digest = await consented(client);
  const control = new AbortController();
  const call = client.callTool(
    { name: "agentry_run", arguments: { ...RUN, confirm: digest } },
    undefined,
    { signal: control.signal },
  );
  await until(() => existsSync(pid));
  const started = Date.now();
  control.abort();
  await assert.rejects(call);
  // The CLI got SIGINT, tore down and exited by itself: its process is gone.
  await until(() => processGone(pid));
  assert.ok(Date.now() - started < 10_000, "the run was interrupted at once");
  // The run is on record with the CLI's own envelope: class cli, error
  // interrupted, cancelled beside it. The record is written to the
  // scratch state directory, never the home's.
  const listed = await until(async () => {
    const r = await status(client);
    const { runs } = JSON.parse(r.content[0].text);
    return runs.length === 1 && runs[0].state === "cancelled" ? runs : undefined;
  });
  assert.equal(listed[0].tool, "agentry_run");
  assert.equal(listed[0].what, "acme/widget@1.0.0");
  assert.equal(listed[0].detached, false);
  assert.equal(listed[0].exitClass, "cli");
  assert.ok(existsSync(join(stateDir, "runs", `${listed[0].id}.json`)));
  const one = await status(client, listed[0].id);
  // A cancelled run ended in a failure class: a tool error carrying the envelope.
  assert.equal(one.isError, true);
  const out = JSON.parse(one.content[0].text);
  assert.equal(out.state, "cancelled");
  assert.equal(out.cancelRequested, true);
  assert.equal(out.exitClass, "cli");
  assert.equal(out.cancelled, true);
  assert.equal(out.result.error, "interrupted");
  assert.equal(out.receiptsDir, "/tmp/out/receipts");
  assert.match(out.progress.tail, /SIGINT: tearing down/);
});

test("a detached start needs the same digest as a waited one, returns the id at once, and status follows the run to its end", async () => {
  // The server's working folder is a scratch one: the run's default output
  // folder goes under it.
  const cwd = mkdtempSync(join(tmpdir(), "agentry-mcp-cwd-"));
  const { client, argvFile } = await connect(
    { FAKE_RUN_SLEEP: "2", FAKE_RUN_RESULT_FILE: "1" },
    { cwd },
  );
  // The preview is the same call without detach; its digest is what the detached start carries.
  const digest = await consented(client);
  const refused = await client.callTool({
    name: "agentry_run",
    arguments: { ...RUN, detach: true, confirm: "sha256:not-this" },
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /does not match/);
  const started = Date.now();
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ...RUN, detach: true, confirm: digest },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.ok(Date.now() - started < 1500, "the detached start returned before the run ended");
  const d = JSON.parse(r.content[0].text);
  assert.match(d.id, /^[0-9a-f]{12}$/);
  assert.equal(d.state, "running");
  assert.equal(d.detached, true);
  assert.ok(typeof d.pid === "number");
  assert.equal(d.outDir, join(cwd, "agentry-out", `acme-widget-${d.id}`));
  assert.match(d.next, /agentry_run_status/);
  // The run was given its output folder and the consented flag, and no
  // detach reached the CLI. The detached process writes its argv when it
  // starts, which is after the tool has returned.
  const argv = await until(() => receivedArgv(argvFile).find((a) => a.includes("--out")));
  assert.equal(argv[argv.indexOf("--out") + 1], d.outDir);
  assert.ok(argv.includes("--yes"));
  assert.ok(!argv.some((a) => /detach/.test(a)));
  // Before the end: running, with the narration so far.
  const running = JSON.parse((await status(client, d.id)).content[0].text);
  assert.equal(running.state, "running");
  assert.ok(running.progress.lines >= 1, "narration lines were counted");
  assert.match(running.progress.tail, /gateway up/);
  // After the end: the run tool's own result, the record's fields beside the envelope.
  const ended = await until(async () => {
    const s = await status(client, d.id);
    const o = JSON.parse(s.content[0].text);
    return o.state === "ended" ? { s, o } : undefined;
  });
  assert.equal(ended.s.isError, undefined, ended.s.content[0].text);
  assert.equal(ended.o.id, d.id);
  assert.equal(ended.o.exitClass, "ok");
  assert.equal(ended.o.result.result, "done");
  assert.equal(ended.o.receiptsDir, "/tmp/out/receipts");
  assert.ok(ended.o.endedAt);
  // The CLI wrote result.json where the server told it to, the folder agentry runs lists.
  assert.ok(existsSync(join(d.outDir, "result.json")));
  const listing = JSON.parse((await status(client)).content[0].text);
  assert.deepEqual(
    listing.runs.map((x) => [x.id, x.state, x.exitClass]),
    [[d.id, "ended", "ok"]],
  );
});

test("cancelling a detached run stops it and returns the envelope its teardown wrote", async () => {
  const pid = pidFile();
  const { client } = await connect({ FAKE_RUN_SLEEP: "30", FAKE_RUN_PID: pid });
  const digest = await consented(client);
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ...RUN, detach: true, confirm: digest },
  });
  const d = JSON.parse(r.content[0].text);
  await until(() => existsSync(pid));
  const started = Date.now();
  const c = await client.callTool({
    name: "agentry_run_cancel",
    arguments: { id: d.id, waitSeconds: 20 },
  });
  assert.ok(Date.now() - started < 10_000, "the cancel came back once the CLI had torn down");
  assert.ok(processGone(pid), "the CLI process is gone");
  assert.equal(c.isError, true, c.content[0].text);
  const o = JSON.parse(c.content[0].text);
  assert.equal(o.id, d.id);
  assert.equal(o.state, "cancelled");
  assert.equal(o.exitClass, "cli");
  assert.equal(o.cancelled, true);
  assert.equal(o.result.error, "interrupted");
  assert.match(o.progress.tail, /SIGINT: tearing down/);
  // A second cancel changes nothing and reports the same end.
  const again = await client.callTool({ name: "agentry_run_cancel", arguments: { id: d.id } });
  assert.equal(JSON.parse(again.content[0].text).state, "cancelled");
});

test("a detached draft takes the same path: an id at once, then the build's envelope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-mcp-draft-"));
  const file = join(dir, "desc.md");
  writeFileSync(file, "A QuickAgent that greets.");
  const { client } = await connect({ FAKE_SLEEP: "1" });
  const args = { descriptionFile: file, out: join(dir, "out") };
  const p = await client.callTool({ name: "agentry_draft", arguments: args });
  const digest = JSON.parse(p.content[0].text).digest;
  const r = await client.callTool({
    name: "agentry_draft",
    arguments: { ...args, detach: true, confirm: digest },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const d = JSON.parse(r.content[0].text);
  assert.equal(d.tool, "agentry_draft");
  assert.equal(d.outDir, join(dir, "out"));
  const ended = await until(async () => {
    const o = JSON.parse((await status(client, d.id)).content[0].text);
    return o.state === "ended" ? o : undefined;
  });
  assert.equal(ended.exitClass, "ok");
  assert.equal(ended.result.report, "report.json");
});

test("a run an earlier server started is judged by its process and its files: ended from its envelope, or lost", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agentry-mcp-state-"));
  const runs = join(stateDir, "runs");
  mkdirSync(runs, { recursive: true });
  // One record whose process is gone and whose stdout file holds the CLI's
  // envelope: ended, as a later server reads it.
  const endedOut = mkdtempSync(join(tmpdir(), "agentry-mcp-out-"));
  const envelope = {
    agentry: "fake",
    status: "error",
    exitCode: 14,
    exitClass: "harness",
    exitClassName: "harness",
    exitClassMeaning: "the agent's harness failed or could not reach its model",
    retryLikelyHelps: true,
    error: "agent exited 1",
    outDir: endedOut,
    resultFile: join(endedOut, "result.json"),
    receipts: { dir: join(endedOut, "receipts"), runPlanSha256: "abc" },
    result: "",
  };
  writeFileSync(join(runs, "aaaaaaaaaaaa.stdout"), JSON.stringify(envelope));
  writeFileSync(
    join(runs, "aaaaaaaaaaaa.log"),
    "narration: gateway up\nnarration: agent exited 1\n",
  );
  writeFileSync(
    join(runs, "aaaaaaaaaaaa.json"),
    JSON.stringify({
      id: "aaaaaaaaaaaa",
      tool: "agentry_run",
      what: "acme/widget@1.0.0",
      detached: true,
      pid: 2 ** 22 - 7,
      startedAt: "2026-10-31T10:00:00.000Z",
      state: "running",
      outDir: endedOut,
      stdoutFile: join(runs, "aaaaaaaaaaaa.stdout"),
      logFile: join(runs, "aaaaaaaaaaaa.log"),
    }),
  );
  // One whose stdout file is empty but whose output folder has result.json.
  const resultOut = mkdtempSync(join(tmpdir(), "agentry-mcp-out-"));
  writeFileSync(
    join(resultOut, "result.json"),
    JSON.stringify({
      ...envelope,
      status: "ok",
      exitCode: 0,
      exitClass: "ok",
      error: undefined,
      result: "done",
      outDir: resultOut,
    }),
  );
  writeFileSync(join(runs, "bbbbbbbbbbbb.stdout"), "");
  writeFileSync(
    join(runs, "bbbbbbbbbbbb.json"),
    JSON.stringify({
      id: "bbbbbbbbbbbb",
      tool: "agentry_run",
      what: "acme/widget@1.0.0",
      detached: true,
      pid: 2 ** 22 - 8,
      startedAt: "2026-10-31T10:01:00.000Z",
      state: "running",
      outDir: resultOut,
      stdoutFile: join(runs, "bbbbbbbbbbbb.stdout"),
    }),
  );
  // One whose process is gone and which wrote nothing: lost.
  writeFileSync(
    join(runs, "cccccccccccc.json"),
    JSON.stringify({
      id: "cccccccccccc",
      tool: "agentry_run",
      what: "acme/widget@1.0.0",
      detached: true,
      pid: 2 ** 22 - 9,
      startedAt: "2026-10-31T10:02:00.000Z",
      state: "running",
      outDir: join(stateDir, "nowhere"),
      stdoutFile: join(runs, "cccccccccccc.stdout"),
    }),
  );
  // One whose process is this test's own: still running, with a note.
  writeFileSync(
    join(runs, "dddddddddddd.json"),
    JSON.stringify({
      id: "dddddddddddd",
      tool: "agentry_draft",
      what: "Draft or revise a QuickAgent with the Drafter (agentry draft)",
      detached: true,
      pid: process.pid,
      startedAt: "2026-10-31T10:03:00.000Z",
      state: "running",
      outDir: join(stateDir, "draft-out"),
      stdoutFile: join(runs, "dddddddddddd.stdout"),
    }),
  );
  const { client } = await connect({ AGENTRY_MCP_STATE: stateDir });

  const a = await status(client, "aaaaaaaaaaaa");
  assert.equal(a.isError, true, a.content[0].text);
  const ao = JSON.parse(a.content[0].text);
  assert.equal(ao.state, "ended");
  assert.equal(ao.exitClass, "harness");
  assert.equal(ao.exitClassMeaning, envelope.exitClassMeaning);
  assert.equal(ao.retryLikelyHelps, true);
  assert.equal(ao.receiptsDir, join(endedOut, "receipts"));
  assert.match(ao.progress.tail, /agent exited 1/);
  assert.match(ao.log, /agent exited 1/);

  const b = await status(client, "bbbbbbbbbbbb");
  assert.equal(b.isError, undefined, b.content[0].text);
  const bo = JSON.parse(b.content[0].text);
  assert.equal(bo.state, "ended");
  assert.equal(bo.exitClass, "ok");
  assert.equal(bo.result.result, "done");

  const c = await status(client, "cccccccccccc");
  assert.equal(c.isError, true);
  assert.match(c.content[0].text, /"state":"lost"/);
  assert.match(c.content[0].text, /is lost: its process is gone and it wrote no result/);
  assert.match(c.content[0].text, /agentry runs/);

  const d = await status(client, "dddddddddddd");
  assert.equal(d.isError, undefined, d.content[0].text);
  const dd = JSON.parse(d.content[0].text);
  assert.equal(dd.state, "running");
  assert.match(dd.note, /earlier server process/);
  assert.equal(dd.pid, process.pid);

  // The records were rewritten with what was found, and the listing says the same.
  assert.equal(JSON.parse(readFileSync(join(runs, "aaaaaaaaaaaa.json"), "utf8")).state, "ended");
  assert.equal(JSON.parse(readFileSync(join(runs, "cccccccccccc.json"), "utf8")).state, "lost");
  const listing = JSON.parse((await status(client)).content[0].text);
  assert.deepEqual(
    listing.runs.map((x) => [x.id, x.state]),
    [
      ["dddddddddddd", "running"],
      ["cccccccccccc", "lost"],
      ["bbbbbbbbbbbb", "ended"],
      ["aaaaaaaaaaaa", "ended"],
    ],
  );

  // An id that is not on record is refused, naming the listing.
  const none = await status(client, "eeeeeeeeeeee");
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /no run "eeeeeeeeeeee" is on record/);
  const cancelNone = await client.callTool({ name: "agentry_run_cancel", arguments: { id: "zz" } });
  assert.equal(cancelNone.isError, true);
});

test("a detached run started by one server is found by the next through the shared state directory", async () => {
  const first = await connect({ FAKE_RUN_SLEEP: "1" });
  const digest = await consented(first.client);
  const r = await first.client.callTool({
    name: "agentry_run",
    arguments: { ...RUN, detach: true, confirm: digest },
  });
  const d = JSON.parse(r.content[0].text);
  await first.client.close();
  const second = await connect({ AGENTRY_MCP_STATE: first.stateDir });
  const ended = await until(async () => {
    const o = JSON.parse((await status(second.client, d.id)).content[0].text);
    return o.state === "ended" ? o : undefined;
  });
  assert.equal(ended.exitClass, "ok");
  assert.equal(ended.id, d.id);
});
