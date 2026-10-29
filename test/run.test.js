// setup, run and validate over the fake CLI: argv for every
// argument; the preview is `run --plan --json` and lifts nothing; the temp
// input file 0600 and removed; --intake per entry; progress only with a
// progress token; the timeout's SIGINT and the envelope the CLI's teardown
// wrote; the consented flags only via the consent digest; no secret value in
// any result; an unanswered required intake question named by the run.
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { connect, receivedArgv, scratchArgv } from "./helpers.js";

const INPUT = scratchArgv() + "-input";
writeFileSync(INPUT, "sample");
const receivedRunArgv = (path) => receivedArgv(path).filter((a) => a[0] === "run");

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

test("setup: vultr and the other key-paid named providers pass through as --provider, with the key variable NAME", async () => {
  const { client, argvFile } = await connect({ VULTR_INFERENCE_API_KEY: "vultr-secret-value" });
  const r = await client.callTool({
    name: "agentry_setup",
    arguments: { provider: "vultr", apiKeyEnv: "VULTR_INFERENCE_API_KEY", skipImages: true },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.doesNotMatch(r.content[0].text, /vultr-secret-value/);
  assert.deepEqual(receivedArgv(argvFile)[0], [
    "setup",
    "--json",
    "--provider",
    "vultr",
    "--api-key-env",
    "VULTR_INFERENCE_API_KEY",
    "--skip-images",
  ]);
  for (const provider of ["openrouter", "poe", "huggingface"]) {
    const rr = await client.callTool({
      name: "agentry_setup",
      arguments: { provider, skipImages: true },
    });
    assert.equal(rr.isError, undefined, rr.content[0].text);
  }
  const argvs = receivedArgv(argvFile);
  assert.deepEqual(
    argvs.slice(1).map((a) => a[a.indexOf("--provider") + 1]),
    ["openrouter", "poe", "huggingface"],
  );
  const bad = await client.callTool({ name: "agentry_setup", arguments: { provider: "bedrock" } });
  assert.equal(
    bad.isError,
    true,
    "a provider the CLI does not name is refused before the CLI runs",
  );
});

test("setup: agentry pays with credits through the CLI's sign-in, so it passes no key variable, base URL or model", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({
    name: "agentry_setup",
    arguments: { provider: "agentry", skipImages: true },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(receivedArgv(argvFile)[0], [
    "setup",
    "--json",
    "--provider",
    "agentry",
    "--skip-images",
  ]);
  for (const extra of [
    { apiKeyEnv: "SOME_KEY" },
    { baseUrl: "https://x.example/v1" },
    { model: "m" },
  ]) {
    const bad = await client.callTool({
      name: "agentry_setup",
      arguments: { provider: "agentry", ...extra },
    });
    assert.equal(bad.isError, true, JSON.stringify(extra));
    assert.match(bad.content[0].text, /pays with your Agentry credits/);
  }
  assert.equal(receivedArgv(argvFile).length, 1, "a refused call never reached the CLI");
});

test("run preview: `run --plan --json`, the compiled plan and a digest, no run, nothing lifted", async () => {
  const writes = writesFile();
  const { client, argvFile } = await connect({ FAKE_WRITES: writes });
  const p = await previewRun(client, {
    ref: "acme/widget",
    intake: { audience: "ops" },
    files: [INPUT],
  });
  assert.equal(p.writes, false);
  assert.equal(p.unsigned, false);
  assert.equal(p.timeoutSeconds, 900, "the plan's own budget when the call names none");
  assert.equal(p.plan.ref, "acme/widget@1.0.0");
  assert.equal(p.plan.attestation, "verified");
  assert.equal(p.plan.planSha256, "abc");
  assert.deepEqual(p.plan.plan.capabilities, { egressMode: "none", fsReadMode: "workspace" });
  assert.equal(p.plan.plan.budgets.timeoutSeconds, 900);
  assert.match(p.digest, /^sha256:/);
  assert.deepEqual(receivedRunArgv(argvFile)[0], [
    "run",
    "acme/widget",
    "--plan",
    "--json",
    "--mode",
    "autonomous",
    "--file",
    INPUT,
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
    { ref: "acme/widget", files: [INPUT] },
    { ref: "acme/widget", inputFile: "/tmp/task.txt" },
    { ref: "acme/widget", out: "/tmp/elsewhere" },
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
  const { client, argvFile } = await connect({ FAKE_WRITES: writes });
  const p = await previewRun(client, {
    ref: "acme/widget",
    input: "summarise this",
    timeoutSeconds: 120,
  });
  assert.equal(p.timeoutSeconds, 120);
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
  const argv = receivedRunArgv(argvFile);
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
  const line = receivedRunArgv(argvFile)
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
  assert.deepEqual(p.refusals, p.plan.refusals);
  assert.equal(p.refusals[0].lift, "--allow-unsigned");
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
  const last = receivedRunArgv(argvFile).at(-1);
  assert.ok(last.includes("--yes") && last.includes("--allow-unsigned"));

  const local = await connect({ FAKE_WRITES: writesFile() });
  const lp = await previewRun(local.client, { local: "/home/me/work/agent" });
  assert.equal(lp.unsigned, true);
  assert.equal(lp.plan.attestation, "local");
  assert.deepEqual(receivedRunArgv(local.argvFile)[0], [
    "run",
    "--local",
    "/home/me/work/agent",
    "--plan",
    "--json",
    "--mode",
    "autonomous",
  ]);
  const lrun = await local.client.callTool({
    name: "agentry_run",
    arguments: { local: "/home/me/work/agent", confirm: lp.digest, acceptUnsigned: true },
  });
  assert.equal(lrun.isError, undefined, lrun.content[0].text);
  assert.deepEqual(receivedRunArgv(local.argvFile).at(-1).slice(0, 3), [
    "run",
    "--local",
    "/home/me/work/agent",
  ]);
  // Every plan the fake saw carried neither consented flag (the fake exits 99 on a lifted plan).
  for (const a of receivedRunArgv(argvFile).concat(receivedRunArgv(local.argvFile))) {
    if (a.includes("--plan"))
      assert.ok(
        !a.includes("--yes") && !a.includes("--allow-unsigned"),
        `a plan carried a consent flag: ${a}`,
      );
  }
});

test("an unscanned release: the preview reports it, acceptUnsigned does not lift it, acceptUnscanned runs with --allow-unscanned", async () => {
  const writes = writesFile();
  const { client, argvFile } = await connect({ FAKE_WRITES: writes, FAKE_RUN_ATTEST: "unscanned" });
  const p = await previewRun(client, { ref: "acme/widget" });
  assert.equal(p.unscanned, true);
  assert.equal(p.unsigned, false);
  assert.equal(p.plan.attestation, "unscanned");
  assert.match(p.plan.refusal, /--allow-unscanned/);
  for (const extra of [{}, { acceptUnsigned: true }]) {
    const r = await client.callTool({
      name: "agentry_run",
      arguments: { ref: "acme/widget", confirm: p.digest, ...extra },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /acceptUnscanned: true/);
  }
  assert.equal(existsSync(writes), false);
  const ok = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest, acceptUnscanned: true },
  });
  assert.equal(ok.isError, undefined, ok.content[0].text);
  const last = receivedRunArgv(argvFile).at(-1);
  assert.ok(last.includes("--yes") && last.includes("--allow-unscanned"), `argv: ${last}`);
  assert.ok(!last.includes("--allow-unsigned"), `argv: ${last}`);
  for (const a of receivedRunArgv(argvFile))
    if (a.includes("--plan"))
      assert.ok(!a.includes("--allow-unscanned"), `a plan was lifted: ${a}`);
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

test("every refusal is in the preview; with a vulnerable server beside the unsigned one, acceptUnsigned lifts nothing and the confirm stops", async () => {
  const writes = writesFile();
  const vuln =
    "declared MCP server npm:@acme/mcp-x@1.0.0 has a known critical advisory (GHSA-xxxx); re-run with --allow-vulnerable-mcp";
  const { client, argvFile } = await connect({
    FAKE_WRITES: writes,
    FAKE_RUN_ATTEST: "unsigned",
    FAKE_RUN_VULN: vuln,
  });
  const p = await previewRun(client, { ref: "acme/widget" });
  assert.equal(p.unsigned, true);
  assert.deepEqual(
    p.refusals.map((r) => [r.kind, r.lift]),
    [
      ["attestation", "--allow-unsigned"],
      ["vulnerable_server", "--allow-vulnerable-mcp"],
    ],
  );
  assert.equal(p.refusals[1].message, vuln);
  for (const extra of [
    {},
    { acceptUnsigned: true },
    { acceptUnsigned: true, acceptUnscanned: true },
  ]) {
    const r = await client.callTool({
      name: "agentry_run",
      arguments: { ref: "acme/widget", confirm: p.digest, ...extra },
    });
    assert.equal(r.isError, true);
    assert.match(
      r.content[0].text,
      /would refuse this: declared MCP server npm:@acme\/mcp-x@1\.0\.0/,
    );
    assert.doesNotMatch(
      r.content[0].text,
      /a run needs --allow-unsigned/,
      "the liftable one is not a reason to stop",
    );
  }
  assert.equal(existsSync(writes), false);
  for (const a of receivedRunArgv(argvFile))
    assert.ok(a.includes("--plan"), `only plans ran, never the run: ${a}`);
});

test("a CLI that prints only the deprecated single refusal: the unsigned one still lifts with acceptUnsigned, a mismatch still stops", async () => {
  const { client, argvFile } = await connect({ FAKE_RUN_ATTEST: "unsigned", FAKE_RUN_LEGACY: "1" });
  const p = await previewRun(client, { ref: "acme/widget" });
  assert.equal(p.plan.refusals, undefined);
  assert.deepEqual(p.refusals, [
    { kind: "attestation", message: p.plan.refusal, lift: "--allow-unsigned" },
  ]);
  const ok = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest, acceptUnsigned: true },
  });
  assert.equal(ok.isError, undefined, ok.content[0].text);
  assert.ok(receivedRunArgv(argvFile).at(-1).includes("--allow-unsigned"));

  const old = await connect({ FAKE_RUN_ATTEST: "mismatch", FAKE_RUN_LEGACY: "1" });
  const mp = await previewRun(old.client, { ref: "acme/widget" });
  assert.deepEqual(mp.refusals, [{ kind: "attestation", message: mp.plan.refusal }]);
  const r = await old.client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: mp.digest, acceptUnsigned: true },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /would refuse this: attestation mismatch/);
});

test("a lift that is not the verdict's own is not lifted: --allow-unsigned on an unscanned release stops even with both acceptances", async () => {
  const writes = writesFile();
  const { client } = await connect({
    FAKE_WRITES: writes,
    FAKE_RUN_ATTEST: "unscanned",
    FAKE_RUN_REFUSAL: "odd refusal naming the wrong flag",
    FAKE_RUN_LIFT: "--allow-unsigned",
  });
  const p = await previewRun(client, { ref: "acme/widget" });
  assert.equal(p.refusals[0].lift, "--allow-unsigned");
  const r = await client.callTool({
    name: "agentry_run",
    arguments: {
      ref: "acme/widget",
      confirm: p.digest,
      acceptUnsigned: true,
      acceptUnscanned: true,
    },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /would refuse this: odd refusal naming the wrong flag/);
  assert.equal(existsSync(writes), false);
});

test("an unscanned release beside a vulnerable server: acceptUnscanned lifts nothing", async () => {
  const writes = writesFile();
  const { client } = await connect({
    FAKE_WRITES: writes,
    FAKE_RUN_ATTEST: "unscanned",
    FAKE_RUN_VULN: "declared MCP server npm:@acme/mcp-x@1.0.0 has a known high advisory",
  });
  const p = await previewRun(client, { ref: "acme/widget" });
  assert.equal(p.refusals.length, 2);
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest, acceptUnscanned: true },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /would refuse this: declared MCP server/);
  assert.equal(existsSync(writes), false);
});

test("a refusal that appears between the preview and the confirm changes the digest", async () => {
  const writes = writesFile();
  const vulnFile = join(tmpdir(), `agentry-mcp-vuln-${process.pid}-${Date.now()}`);
  const { client } = await connect({
    FAKE_WRITES: writes,
    FAKE_RUN_ATTEST: "unsigned",
    FAKE_RUN_VULN_FILE: vulnFile,
  });
  const p = await previewRun(client, { ref: "acme/widget" });
  assert.equal(p.refusals.length, 1);
  writeFileSync(
    vulnFile,
    "declared MCP server npm:@acme/mcp-x@1.0.0 has a known critical advisory",
  );
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest, acceptUnsigned: true },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /confirm digest does not match/);
  assert.equal(existsSync(writes), false);
});

test("a refusals list the server cannot read, or an empty one beside a refusal, never reads as no refusal", async () => {
  for (const [raw, want] of [
    ['{"kind":"attestation"}', /cannot read/],
    ['[{"kind":"attestation"}]', /cannot read/],
    ["[]", /would refuse this: attestation mismatch/],
    ["null", /would refuse this: attestation mismatch/],
  ]) {
    const writes = writesFile();
    const { client } = await connect({
      FAKE_WRITES: writes,
      FAKE_RUN_ATTEST: "mismatch",
      FAKE_RUN_REFUSALS_RAW: raw,
    });
    const first = await client.callTool({ name: "agentry_run", arguments: { ref: "acme/widget" } });
    if (first.isError) {
      assert.match(first.content[0].text, want, `refusals ${raw}`);
    } else {
      const p = JSON.parse(first.content[0].text);
      const r = await client.callTool({
        name: "agentry_run",
        arguments: { ref: "acme/widget", confirm: p.digest, acceptUnsigned: true },
      });
      assert.equal(r.isError, true, `refusals ${raw}`);
      assert.match(r.content[0].text, want, `refusals ${raw}`);
    }
    assert.equal(existsSync(writes), false, `refusals ${raw}: something was written`);
  }
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

test("ref and local together, or neither, or input with inputFile, is a tool error before any plan or person", async () => {
  const { client, argvFile } = await connect();
  for (const [args, want] of [
    [{}, /exactly one of ref/],
    [{ ref: "acme/widget", local: "/x" }, /exactly one of ref/],
    [{ ref: "acme/widget", input: "x", inputFile: "/tmp/t" }, /not both/],
  ]) {
    const r = await client.callTool({ name: "agentry_run", arguments: args });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, want);
  }
  assert.deepEqual(receivedRunArgv(argvFile), [], "the CLI was never run");
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

test("a run refused for its inputs comes back as the envelope, each refused file named in refusedInputs", async () => {
  const refused = [
    { path: "eicar.com", by: "clamav", signature: "Eicar-Test-Signature" },
    {
      path: "bundle.zip/docs/report.pdf",
      by: "hybrid-analysis",
      verdict: "malicious",
      threatScore: 100,
    },
    { path: "notes.md", by: "ai-review", flagged: ["steers_agent"] },
  ];
  const { client } = await connect({ FAKE_RUN_REFUSED_INPUTS: JSON.stringify(refused) });
  const p = await previewRun(client, { ref: "acme/widget" });
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.exitClass, "policy");
  assert.deepEqual(out.result.reason, { code: "input-refused", detail: "malware" });
  assert.deepEqual(out.result.refusedInputs, refused);
  assert.equal(out.result.refusedInputsMore, 2);
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

test("no result or progress carries a secret value: the key and the registry token in the server's env never appear", async () => {
  const { client } = await connect({ OPENAI_API_KEY: "sk-leak-me", AGENTRY_TOKEN: "agy_leak_me" });
  const seen = [];
  client.setNotificationHandler(
    (await import("@modelcontextprotocol/sdk/types.js")).ProgressNotificationSchema,
    (n) => {
      seen.push(n.params.message);
    },
  );
  const p = await previewRun(client, { ref: "acme/widget", input: "the task" });
  for (const [name, args] of [
    ["agentry_setup", { provider: "openai", apiKeyEnv: "OPENAI_API_KEY", skipImages: true }],
    ["agentry_run", { ref: "acme/widget", input: "the task" }],
    ["agentry_run", { ref: "acme/widget", input: "the task", confirm: p.digest }],
    ["agentry_doctor", {}],
  ]) {
    const r = await client.callTool({ name, arguments: args }, undefined, { onprogress: () => {} });
    assert.doesNotMatch(r.content[0].text, /sk-leak-me|agy_leak_me/, name);
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    seen.some((m) => /gateway up/.test(m)),
    `the run streamed progress: ${JSON.stringify(seen)}`,
  );
  for (const m of seen) assert.doesNotMatch(m, /sk-leak-me|agy_leak_me/);
});

test("the run tool's description names the policy budget", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.ok(
    tools.find((t) => t.name === "agentry_run").description.includes("runner policy's own budget"),
  );
});
