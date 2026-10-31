// A preview says whether the run can start: the readiness block read from
// `agentry doctor --json` (the resolved release named), the summary in
// words beside the plan, both in the digest; a run that ends in a failure
// class is a tool error carrying the envelope, the CLI's exit-class words
// lifted beside exitClass when it printed them.
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readinessLines } from "../dist/readiness.js";
import { connect, receivedArgv } from "./helpers.js";

async function preview(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
}

test("a run preview carries readiness from `doctor <resolved ref> --json` and a summary in words, the plan under its field", async () => {
  const { client, argvFile } = await connect();
  const p = await preview(client, "agentry_run", { ref: "acme/widget", maxCost: 2 });
  assert.equal(p.readiness.ready, true);
  assert.equal(p.readiness.checked, "this machine and acme/widget@1.0.0");
  assert.ok(p.readiness.checks.some((c) => c.name === "model" && c.status === "ok"));
  assert.ok(p.readiness.checks.some((c) => c.name === "secrets"));
  // The summary reads as sentences: what runs, the model and its cost class,
  // the network, reads and writes, delivery, then the readiness lines.
  assert.match(
    p.summary,
    /^Run acme\/widget@1\.0\.0 \(autonomous; attestation verified, signed\), up to 900 s, at most \$2\./m,
  );
  assert.match(p.summary, /^Model: the runner policy's model, paid with your own provider key\./m);
  assert.match(p.summary, /^Network: no network\./m);
  assert.match(
    p.summary,
    /^Reads: the workspace\. Writes: only its report under the output folder\./m,
  );
  assert.match(p.summary, /^Tools served: write_report\./m);
  assert.match(p.summary, /^Delivers to: .*no destination\./m);
  assert.match(p.summary, /^Ready to start: yes/m);
  assert.match(
    p.summary,
    /^ {2}model key: ok: anthropic\/claude-sonnet-5-5 \(key from \$ANTHROPIC_API_KEY\)/m,
  );
  assert.match(p.summary, /^ {2}container engine: ok: Docker Engine/m);
  assert.match(p.summary, /^ {2}images: /m);
  assert.match(p.summary, /^ {2}registry: ok: .*credential stored/m);
  assert.match(p.summary, /^ {2}secrets: ok: all 1 declared secret\(s\) resolve/m);
  assert.match(p.summary, /^ {2}install: warning: not installed yet/m);
  assert.doesNotMatch(p.summary, /planSha256|"capabilities"/, "the summary is words, not the plan");
  // The plan is still there, under its field, whole.
  assert.equal(p.plan.planSha256, "abc");
  assert.deepEqual(p.plan.plan.capabilities, { egressMode: "none", fsReadMode: "workspace" });
  assert.equal(Object.keys(p)[0], "summary", "the summary comes first");
  // Doctor was asked about the release the plan resolved, after the plan.
  const argv = receivedArgv(argvFile);
  const doctor = argv.find((a) => a[0] === "doctor");
  assert.deepEqual(doctor, ["doctor", "acme/widget@1.0.0", "--json"]);
  assert.ok(argv.findIndex((a) => a[0] === "run") < argv.indexOf(doctor));
});

test("with the model key's variable unset, the preview says the run cannot start and quotes the CLI's remedy; the person is told", async () => {
  const { client, elicitations } = await connect({ FAKE_DOCTOR_KEY_UNSET: "1" }, {}, "decline");
  const p = await preview(client, "agentry_run", { ref: "acme/widget" });
  assert.equal(p.readiness.ready, false);
  const model = p.readiness.checks.find((c) => c.name === "model");
  assert.equal(model.status, "fail");
  assert.match(model.detail, /\$ANTHROPIC_API_KEY is not set/);
  assert.match(model.remedy, /export ANTHROPIC_API_KEY, or run `agentry setup`/);
  assert.match(p.summary, /^Ready to start: no — a run would fail at the CLI's preflight/m);
  assert.match(
    p.summary,
    /^ {2}model key: not ready: anthropic\/claude-sonnet-5-5: \$ANTHROPIC_API_KEY is not set in this environment — export ANTHROPIC_API_KEY, or run `agentry setup` to store the key$/m,
  );
  // The confirm is the person's call: the question they are asked carries the same words.
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /declined/);
  assert.match(elicitations[0], /Ready to start: no/);
  assert.match(elicitations[0], /\$ANTHROPIC_API_KEY is not set/);
});

test("the digest covers readiness and the summary: a readiness changed between the calls refuses the confirm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-readiness-"));
  const file = join(dir, "doctor.json");
  const { client } = await connect({ FAKE_DOCTOR_FILE: file });
  const ready = await preview(client, "agentry_run", { ref: "acme/widget" });
  assert.equal(ready.readiness.ready, true);
  // The key vanished (the file now holds a failing model check).
  writeFileSync(
    file,
    JSON.stringify([
      { name: "model", status: "fail", detail: "anthropic/claude: $ANTHROPIC_API_KEY is not set" },
      { name: "docker", status: "ok", detail: "engine available" },
    ]),
  );
  const stale = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: ready.digest },
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /digest does not match this preview/);
  // Previewed again, the new state digests differently and reads as not ready.
  const again = await preview(client, "agentry_run", { ref: "acme/widget" });
  assert.notEqual(again.digest, ready.digest);
  assert.equal(again.readiness.ready, false);
  assert.match(again.summary, /images: not checked/);
  // Back as it was, the first digest is good again: the same facts digest the same.
  unlinkSync(file);
  const back = await preview(client, "agentry_run", { ref: "acme/widget" });
  assert.equal(back.digest, ready.digest);
});

test("a run that ends in a failure class is a tool error carrying the envelope; the CLI's exit-class words are lifted when present, absent otherwise", async () => {
  for (const words of [false, true]) {
    const { client } = await connect({
      FAKE_RUN_FAIL: "1",
      ...(words ? { FAKE_RUN_CLASS_WORDS: "1" } : {}),
    });
    const p = await preview(client, "agentry_run", { ref: "acme/widget" });
    const r = await client.callTool({
      name: "agentry_run",
      arguments: { ref: "acme/widget", confirm: p.digest },
    });
    assert.equal(r.isError, true, "a failed run is an error");
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.exitClass, "policy");
    assert.equal(out.result.status, "error");
    assert.match(out.result.error, /\$ANTHROPIC_API_KEY is not set/);
    assert.equal(out.receiptsDir, "/tmp/out/receipts", "the receipts are still named");
    if (words) {
      assert.equal(out.exitClassName, "policy");
      assert.match(out.exitClassMeaning, /refused the run/);
      assert.equal(out.retryLikelyHelps, false);
    } else {
      assert.equal("exitClassName" in out, false);
      assert.equal("exitClassMeaning" in out, false);
      assert.equal("retryLikelyHelps" in out, false);
    }
  }
  // A run that ends ok is not an error.
  const { client } = await connect();
  const p = await preview(client, "agentry_run", { ref: "acme/widget" });
  const ok = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest },
  });
  assert.equal(ok.isError, undefined, ok.content[0].text);
  assert.equal(JSON.parse(ok.content[0].text).exitClass, "ok");
});

test("a session preview carries the same readiness and summary; a local workspace is checked as --local", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-readiness-local-"));
  const { client, argvFile } = await connect({ FAKE_DOCTOR_KEY_UNSET: "1" });
  const p = await preview(client, "agentry_session_start", { local: dir });
  assert.equal(p.readiness.ready, false);
  assert.equal(p.readiness.checked, `this machine and the workspace ${dir}`);
  assert.match(
    p.summary,
    /^Start an interactive session with fixtures\/hello-report@1\.0\.0 \(interactive; attestation local\)\./m,
  );
  assert.match(p.summary, /^The CLI would refuse: the release is local/m);
  assert.deepEqual(
    receivedArgv(argvFile).find((a) => a[0] === "doctor"),
    ["doctor", "--json", "--local", dir],
  );
});

test("an authoring preview carries readiness from `doctor --json` and a summary; a build that fails is a tool error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-readiness-build-"));
  const file = join(dir, "sample.md");
  writeFileSync(file, "A sample.");
  const args = {
    action: "create",
    name: "notes",
    files: [file],
    web: false,
    out: join(dir, "out"),
  };
  const { client, argvFile } = await connect({ FAKE_DOCTOR_KEY_UNSET: "1" });
  const p = await preview(client, "agentry_knowledge_build", args);
  assert.equal(p.readiness.ready, false);
  assert.equal(p.readiness.checked, "this machine");
  assert.match(
    p.summary,
    /^Build a Knowledge pack with the Creator \(agentry knowledge\), up to 3600 s\./m,
  );
  assert.match(
    p.summary,
    new RegExp(`^Reads: ${file.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\.`, "m"),
  );
  assert.match(p.summary, /^Writes: its report and receipts under /m);
  assert.match(p.summary, /^Ready to start: no/m);
  assert.match(p.summary, /secrets: not checked/);
  assert.deepEqual(
    receivedArgv(argvFile).find((a) => a[0] === "doctor"),
    ["doctor", "--json"],
  );
  assert.equal(Object.keys(p)[0], "summary");
  assert.equal(p.operation.tool, "agentry_knowledge_build", "the operation facts are still there");

  const failing = await connect({ FAKE_RUN_FAIL: "1" });
  const draft = { descriptionFile: file, out: join(dir, "out2") };
  const dp = await preview(failing.client, "agentry_draft", draft);
  assert.equal(dp.readiness.ready, true);
  const r = await failing.client.callTool({
    name: "agentry_draft",
    arguments: { ...draft, confirm: dp.digest },
  });
  assert.equal(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.exitClass, "gateway");
  assert.equal(out.result.error, "the gateway did not start");
});

test("a doctor report the server cannot read is never taken as ready", async () => {
  const { client } = await connect({ FAKE_DOCTOR: '[{"name":"model","status":"fine"}]' });
  const r = await client.callTool({ name: "agentry_run", arguments: { ref: "acme/widget" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /doctor report carries checks this server cannot read/);
});

test("readiness lines: one per facet, the failing checks first, then every other check that is not ok", () => {
  const lines = readinessLines([
    { name: "policy", status: "ok", detail: "/p" },
    { name: "model", status: "fail", detail: "x: $K is not set" },
    { name: "model:kind", status: "warn", detail: "a subscription token" },
    { name: "docker", status: "ok", detail: "engine" },
    { name: "docker:socket", status: "warn", detail: "slow socket" },
    { name: "image:gateway", status: "ok", detail: "g" },
    {
      name: "image:harness",
      status: "fail",
      detail: "h is not present locally — `agentry setup` pulls it",
    },
    { name: "registry", status: "ok", detail: "r reachable" },
    { name: "exec", status: "warn", detail: "no packages catalogued" },
  ]);
  assert.deepEqual(lines, [
    "model key: model not ready: x: $K is not set",
    "container engine: docker:socket warning: slow socket",
    "images: image:harness not ready: h is not present locally — `agentry setup` pulls it",
    "registry: ok: r reachable",
    "secrets: not checked",
    "exec: warning: no packages catalogued",
  ]);
});
