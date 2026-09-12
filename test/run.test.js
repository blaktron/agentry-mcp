// setup, run and validate over the fake CLI (plan §6): argv for every
// argument; the preview is `run --plan --json` and lifts nothing; the temp
// input file 0600 and removed; --intake per entry; progress only with a
// progress token; the timeout's SIGINT and the envelope the CLI's teardown
// wrote; the consented flags only via the consent digest; no secret value in
// any result; an unanswered required intake question named by the run.
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { connect, receivedArgv, scratchArgv } from "./helpers.js";

function writesFile() {
  return join(scratchArgv() + "-writes");
}

async function previewRun(client, args) {
  const r = await client.callTool({ name: "agentry_run", arguments: args });
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
}

test("setup: argv from typed arguments (no consent flag: the CLI has no terminal), the policy back with the key NAME only, images ready or skipped", async () => {
  const { client, argvFile } = await connect({ OPENAI_API_KEY: "sk-secret-value" });
  const r = await client.callTool({
    name: "agentry_setup",
    arguments: {
      provider: "openai",
      model: "gpt-5.2",
      apiKeyEnv: "OPENAI_API_KEY",
      skipImages: true,
    },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const env = JSON.parse(r.content[0].text);
  assert.equal(env.result.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(env.result.images, "skipped");
  assert.doesNotMatch(r.content[0].text, /sk-secret-value/);
  assert.deepEqual(receivedArgv(argvFile)[0], [
    "setup",
    "--json",
    "--provider",
    "openai",
    "--model",
    "gpt-5.2",
    "--api-key-env",
    "OPENAI_API_KEY",
    "--skip-images",
  ]);
});

test("run preview: `run --plan --json`, the compiled plan and a digest, no run, nothing lifted", async () => {
  const writes = writesFile();
  const { client, argvFile } = await connect({ FAKE_WRITES: writes });
  const p = await previewRun(client, {
    ref: "acme/widget",
    intake: { audience: "ops" },
    files: ["/tmp/in"],
  });
  assert.equal(p.writes, false);
  assert.equal(p.unsigned, false);
  assert.equal(p.timeoutSeconds, 900);
  assert.equal(p.plan.ref, "acme/widget@1.0.0");
  assert.equal(p.plan.attestation, "verified");
  assert.equal(p.plan.planSha256, "abc");
  assert.deepEqual(p.plan.plan.capabilities, { egressMode: "none", fsReadMode: "workspace" });
  assert.equal(p.plan.plan.budgets.timeoutSeconds, 900);
  assert.match(p.digest, /^sha256:/);
  assert.deepEqual(receivedArgv(argvFile)[0], [
    "run",
    "acme/widget",
    "--plan",
    "--json",
    "--mode",
    "autonomous",
    "--timeout",
    "900",
    "--file",
    "/tmp/in",
    "--intake",
    "audience=ops",
  ]);
  assert.equal(existsSync(writes), false);
});

test("the digest covers the whole plan and the call's own contribution: a changed budget, intake or file is a new digest", async () => {
  const { client } = await connect();
  const base = await previewRun(client, { ref: "acme/widget" });
  const again = await previewRun(client, { ref: "acme/widget" });
  assert.equal(again.digest, base.digest, "the same preview digests the same");
  for (const args of [
    { ref: "acme/widget", timeoutSeconds: 120 },
    { ref: "acme/widget", intake: { audience: "ops" } },
    { ref: "acme/widget", files: ["/tmp/in"] },
  ]) {
    const p = await previewRun(client, args);
    assert.notEqual(p.digest, base.digest, JSON.stringify(args));
  }
  // The task input is not in the digest: it changes nothing about what the run may reach.
  const withInput = await previewRun(client, { ref: "acme/widget", input: "summarise this" });
  assert.equal(withInput.digest, base.digest);
});

test("run confirm: re-plans, then runs the resolved release with the consented flag, --timeout, the input written 0600 to a temp file and removed", async () => {
  const writes = writesFile();
  const { client, argvFile } = await connect({ FAKE_WRITES: writes, FAKE_ARGV_STAT: "1" });
  const p = await previewRun(client, {
    ref: "acme/widget",
    input: "summarise this",
    timeoutSeconds: 120,
  });
  const r = await client.callTool({
    name: "agentry_run",
    arguments: {
      ref: "acme/widget",
      input: "summarise this",
      confirm: p.digest,
      timeoutSeconds: 120,
    },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.exitClass, "ok");
  assert.equal(out.receiptsDir, "/tmp/out/receipts");
  assert.equal(out.resultFile, "/tmp/out/result.json");
  assert.equal(out.result.status, "ok");
  const argv = receivedArgv(argvFile);
  assert.ok(argv.at(-2).includes("--plan"), "the confirm re-plans first");
  const runArgv = argv.at(-1);
  // The run names the release the preview resolved, never the floating ref.
  assert.deepEqual(runArgv.slice(0, 8), [
    "run",
    "acme/widget@1.0.0",
    "--output-format",
    "json",
    "--mode",
    "autonomous",
    "--timeout",
    "120",
  ]);
  const i = runArgv.indexOf("--input");
  assert.ok(i > 0, "the input file was passed");
  const file = runArgv[i + 1];
  assert.ok(file.startsWith(join(tmpdir(), "agentry-mcp-run-")), file);
  assert.equal(existsSync(file), false, "the temp input is removed after the run");
  assert.ok(runArgv.includes("--yes"));
  assert.ok(!runArgv.includes("--allow-unsigned"));
});

test("the temp input file is created 0600", async () => {
  // The fake records the mode of --input at run time (FAKE_STAT_INPUT).
  const { client, argvFile } = await connect({ FAKE_STAT_INPUT: "1" });
  const p = await previewRun(client, { ref: "acme/widget", input: "x" });
  await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", input: "x", confirm: p.digest },
  });
  const line = receivedArgv(argvFile)
    .at(-1)
    .find((a) => a.startsWith("mode="));
  assert.equal(line, "mode=600");
});

test("a preview never lifts the gate; a wrong digest is refused; unsigned needs acceptUnsigned; local is attestation local", async () => {
  const writes = writesFile();
  const { client, argvFile } = await connect({ FAKE_WRITES: writes, FAKE_RUN_ATTEST: "unsigned" });
  const p = await previewRun(client, { ref: "acme/widget" });
  assert.equal(p.unsigned, true);
  assert.equal(p.plan.attestation, "unsigned");
  assert.match(p.plan.refusal, /a run needs/);
  const wrong = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: "sha256:nope" },
  });
  assert.equal(wrong.isError, true);
  const noAccept = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest },
  });
  assert.equal(noAccept.isError, true);
  assert.match(noAccept.content[0].text, /acceptUnsigned: true/);
  assert.equal(existsSync(writes), false);
  const ok = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest, acceptUnsigned: true },
  });
  assert.equal(ok.isError, undefined, ok.content[0].text);
  const last = receivedArgv(argvFile).at(-1);
  assert.ok(last.includes("--yes") && last.includes("--allow-unsigned"));

  const local = await connect({ FAKE_WRITES: writesFile() });
  const lp = await previewRun(local.client, { local: "/home/me/work/agent" });
  assert.equal(lp.unsigned, true);
  assert.equal(lp.plan.attestation, "local");
  assert.deepEqual(receivedArgv(local.argvFile)[0], [
    "run",
    "--local",
    "/home/me/work/agent",
    "--plan",
    "--json",
    "--mode",
    "autonomous",
    "--timeout",
    "900",
  ]);
  const lrun = await local.client.callTool({
    name: "agentry_run",
    arguments: { local: "/home/me/work/agent", confirm: lp.digest, acceptUnsigned: true },
  });
  assert.equal(lrun.isError, undefined, lrun.content[0].text);
  assert.deepEqual(receivedArgv(local.argvFile).at(-1).slice(0, 3), [
    "run",
    "--local",
    "/home/me/work/agent",
  ]);
  // Every plan the fake saw carried neither consented flag (the fake exits 99 on a lifted plan).
  for (const a of receivedArgv(argvFile).concat(receivedArgv(local.argvFile))) {
    if (a.includes("--plan"))
      assert.ok(
        !a.includes("--yes") && !a.includes("--allow-unsigned"),
        `a plan carried a consent flag: ${a}`,
      );
  }
});

test("a refusal the person cannot lift (attestation mismatch) stops the confirm", async () => {
  const writes = writesFile();
  const { client } = await connect({ FAKE_WRITES: writes, FAKE_RUN_ATTEST: "mismatch" });
  const p = await previewRun(client, { ref: "acme/widget" });
  assert.equal(p.unsigned, false);
  assert.match(p.plan.refusal, /mismatch/);
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest, acceptUnsigned: true },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /would refuse this: attestation mismatch/);
  assert.equal(existsSync(writes), false);
});

test("an unanswered required intake question is a tool error naming it, from the run, not a hang", async () => {
  const { client } = await connect({ FAKE_INTAKE_REQUIRED: "1" });
  const p = await previewRun(client, { ref: "acme/widget" });
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /intake question "audience" is required/);
  const answered = await previewRun(client, { ref: "acme/widget", intake: { audience: "ops" } });
  const ok = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", intake: { audience: "ops" }, confirm: answered.digest },
  });
  assert.equal(ok.isError, undefined, ok.content[0].text);
});

test("ref and local together, or neither, is a tool error, not a crash", async () => {
  const { client } = await connect();
  for (const args of [{}, { ref: "acme/widget", local: "/x" }]) {
    const r = await client.callTool({ name: "agentry_run", arguments: args });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /exactly one of ref/);
  }
});

test("progress: stderr lines become notifications only when the host sent a progress token", async () => {
  const { client } = await connect();
  const seen = [];
  client.setNotificationHandler(
    (await import("@modelcontextprotocol/sdk/types.js")).ProgressNotificationSchema,
    (n) => {
      seen.push(n.params.message);
    },
  );
  await client.callTool({ name: "agentry_setup", arguments: { skipImages: true } });
  assert.equal(seen.length, 0, "no token, no notifications");
  await client.callTool({ name: "agentry_setup", arguments: { skipImages: true } }, undefined, {
    onprogress: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    seen.some((m) => /policy written/.test(m)),
    `notifications: ${JSON.stringify(seen)}`,
  );
});

test("a run past its timeout gets SIGINT; the envelope the CLI's teardown wrote is the answer, timedOut beside it", async () => {
  const { client } = await connect({ FAKE_RUN_SLEEP: "30" }, {}, undefined);
  // The budget is in the digest: the preview names the same timeout.
  const p = await previewRun(client, { ref: "acme/widget", timeoutSeconds: 1 });
  const started = Date.now();
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest, timeoutSeconds: 1 },
  });
  assert.ok(Date.now() - started < 20_000, "the run was interrupted");
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.exitClass, "cli");
  assert.equal(out.result.error, "interrupted");
  assert.equal(out.timedOut, true);
  assert.equal(out.receiptsDir, "/tmp/out/receipts");
  assert.match(out.log, /SIGINT: tearing down/);
});

test("validate: the report comes back with exitClass cli when it failed", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({
    name: "agentry_validate",
    arguments: { dir: "/home/me/work/agent", strict: true },
  });
  assert.equal(r.isError, undefined);
  const env = JSON.parse(r.content[0].text);
  assert.equal(env.exitClass, "cli");
  assert.equal(env.result.passed, false);
  assert.deepEqual(receivedArgv(argvFile)[0], [
    "validate",
    "/home/me/work/agent",
    "--json",
    "--strict",
  ]);
});

test("no result carries a secret value: the key and the registry token in the server's env never appear", async () => {
  const { client } = await connect({ OPENAI_API_KEY: "sk-leak-me", AGENTRY_TOKEN: "agy_leak_me" });
  for (const [name, args] of [
    ["agentry_setup", { provider: "openai", apiKeyEnv: "OPENAI_API_KEY", skipImages: true }],
    ["agentry_run", { ref: "acme/widget" }],
    ["agentry_doctor", {}],
  ]) {
    const r = await client.callTool({ name, arguments: args });
    assert.doesNotMatch(r.content[0].text, /sk-leak-me|agy_leak_me/, name);
  }
});

test("the tool list is the ten", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  assert.ok(tools.find((t) => t.name === "agentry_run").description.includes("default 900"));
});
