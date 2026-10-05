import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connect, receivedArgv } from "./helpers.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentry-parity-"));
  const file = join(dir, "sample.md");
  writeFileSync(file, "A sample.");
  return { dir, file, out: join(dir, "out"), writes: join(dir, "writes") };
}
async function call(client, name, arguments_) {
  return client.callTool({ name, arguments: arguments_ });
}
async function preview(client, name, args) {
  const result = await call(client, name, args);
  assert.equal(result.isError, undefined, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

test("JSON inspection tools use typed CLI commands and preserve metadata", async () => {
  const { client, argvFile } = await connect();
  for (const name of [
    "agentry_whoami",
    "agentry_builtins",
    "agentry_voice_status",
    "agentry_knowledge_list",
  ]) {
    assert.equal((await call(client, name, {})).isError, undefined);
  }
  assert.deepEqual(receivedArgv(argvFile), [
    ["whoami", "--json"],
    ["builtins", "--json"],
    ["voice", "status", "--json"],
    ["knowledge", "list", "--json"],
  ]);
});

test("built-in operations require consent and refuse changed source bytes or another operation's digest", async () => {
  const f = fixture();
  const { client, argvFile } = await connect({ FAKE_WRITES: f.writes });
  const args = {
    descriptionFile: f.file,
    out: f.out,
    timeoutSeconds: 33,
    maxTurns: 4,
    maxCost: 0.5,
  };
  const p = await preview(client, "agentry_draft", args);
  assert.equal(p.writes, false);
  assert.equal(existsSync(f.writes), false);
  assert.match(p.note, /not a compiled/);
  writeFileSync(f.file, "A changed sample.");
  const changed = await call(client, "agentry_draft", { ...args, confirm: p.digest });
  assert.equal(changed.isError, true);
  assert.equal(existsSync(f.writes), false);
  const again = await preview(client, "agentry_draft", args);
  const cross = await call(client, "agentry_review", {
    dir: f.dir,
    out: f.out,
    confirm: again.digest,
  });
  assert.equal(cross.isError, true);
  const done = await call(client, "agentry_draft", { ...args, confirm: again.digest });
  assert.equal(done.isError, undefined, done.content[0].text);
  const last = receivedArgv(argvFile).at(-1);
  assert.ok(last.includes("--description-file") && last.includes("--output-format"));
  assert.equal(last[last.indexOf("--timeout") + 1], "33");
  assert.equal(last[last.indexOf("--max-cost") + 1], "0.5");
  assert.ok(!last.includes("--yes") && !last.includes("--allow-unsigned"));
});

test("Knowledge web choice and Voice edit samples reach the CLI only after confirmation", async () => {
  const f = fixture();
  const { client, argvFile } = await connect();
  const knowledge = { action: "create", name: "notes", briefFile: f.file, web: false, out: f.out };
  const p = await preview(client, "agentry_knowledge_build", knowledge);
  const changed = await call(client, "agentry_knowledge_build", {
    ...knowledge,
    web: true,
    confirm: p.digest,
  });
  assert.equal(changed.isError, true);
  const done = await call(client, "agentry_knowledge_build", { ...knowledge, confirm: p.digest });
  assert.equal(done.isError, undefined, done.content[0].text);
  assert.ok(receivedArgv(argvFile).at(-1).includes("--no-web"));
  const voice = {
    action: "edit",
    note: "Use shorter sentences",
    files: [f.file],
    write: join(f.dir, "VOICE.md"),
    out: f.out,
  };
  const v = await preview(client, "agentry_voice_build", voice);
  const built = await call(client, "agentry_voice_build", { ...voice, confirm: v.digest });
  assert.equal(built.isError, undefined, built.content[0].text);
  const last = receivedArgv(argvFile).at(-1);
  assert.deepEqual(last.slice(0, 4), ["voice", "edit", "--output-format", "json"]);
  assert.equal(last[last.indexOf("--file") + 1], f.file);
});

test("a declined authoring elicitation and symlink input never execute", async () => {
  const f = fixture();
  const { client } = await connect({ FAKE_WRITES: f.writes }, {}, "decline");
  const args = { dir: f.dir, out: f.out };
  const p = await preview(client, "agentry_review", args);
  const declined = await call(client, "agentry_review", { ...args, confirm: p.digest });
  assert.equal(declined.isError, true);
  assert.equal(existsSync(f.writes), false);
  const link = join(f.dir, "link");
  symlinkSync(f.file, link);
  const linked = await call(client, "agentry_draft", { descriptionFile: link, out: f.out });
  assert.equal(linked.isError, true);
  assert.match(linked.content[0].text, /without links/);
});

test("run attachments and budgets are bound to consent, and the archive digest is pinned", async () => {
  const f = fixture();
  const { client, argvFile } = await connect();
  const args = {
    ref: "acme/widget",
    knowledge: [f.dir],
    voiceFile: f.file,
    maxTurns: 4,
    maxCost: 1,
  };
  const p = await preview(client, "agentry_run", args);
  const changed = await call(client, "agentry_run", { ...args, maxCost: 2, confirm: p.digest });
  assert.equal(changed.isError, true);
  const done = await call(client, "agentry_run", { ...args, confirm: p.digest });
  assert.equal(done.isError, undefined, done.content[0].text);
  const last = receivedArgv(argvFile).at(-1);
  for (const [flag, val] of [
    ["--pin", "sha256:aaaa"],
    ["--knowledge", f.dir],
    ["--voice-file", f.file],
    ["--max-turns", "4"],
    ["--max-cost", "1"],
  ])
    assert.equal(last[last.indexOf(flag) + 1], val);
  writeFileSync(f.file, "new content");
  const modified = await call(client, "agentry_run", { ...args, confirm: p.digest });
  assert.equal(modified.isError, true);
});

test("local installs preserve the local target and require local unsigned acceptance", async () => {
  const { client, argvFile } = await connect({ FAKE_ATTEST: "local" });
  const args = { local: "/example/package" };
  const p = await preview(client, "agentry_install", args);
  assert.equal(p.unsigned, true);
  const refusal = await call(client, "agentry_install", { ...args, confirm: p.digest });
  assert.equal(refusal.isError, true);
  const installed = await call(client, "agentry_install", {
    ...args,
    confirm: p.digest,
    acceptUnsigned: true,
  });
  assert.equal(installed.isError, undefined, installed.content[0].text);
  assert.deepEqual(receivedArgv(argvFile).at(-1).slice(0, 3), [
    "install",
    "--local",
    "/example/package",
  ]);
  assert.ok(receivedArgv(argvFile).at(-1).includes("--allow-unsigned"));
});

test("opening turns, typed busy refusals and new-file consent use protocol events", async () => {
  const f = fixture();
  const { client } = await connect();
  const args = { ref: "acme/widget", input: "opening\ncontext" };
  const p = await preview(client, "agentry_session_start", args);
  const start = await preview(client, "agentry_session_start", { ...args, confirm: p.digest });
  const id = start.sessionId;
  const late = await preview(client, "agentry_session_send", { sessionId: id, text: "held" });
  assert.equal(late.sent, false);
  assert.equal(late.reply, "echo: opening\ncontext");
  const addArgs = { sessionId: id, path: f.file };
  const filePreview = await preview(client, "agentry_session_add", addArgs);
  writeFileSync(f.file, "changed");
  assert.equal(
    (await call(client, "agentry_session_add", { ...addArgs, confirm: filePreview.digest }))
      .isError,
    true,
  );
  const again = await preview(client, "agentry_session_add", addArgs);
  await preview(client, "agentry_session_add", { ...addArgs, confirm: again.digest });
  const notice = await preview(client, "agentry_session_send", { sessionId: id, text: "held" });
  assert.equal(notice.sent, false);
  assert.match(notice.reply, /input added: sample.md/);
  await call(client, "agentry_session_close", { sessionId: id, finish: false });
  const busy = await connect({ FAKE_PROTOCOL_BUSY: "1" });
  const bp = await preview(busy.client, "agentry_session_start", { ref: "acme/widget" });
  const bs = await preview(busy.client, "agentry_session_start", {
    ref: "acme/widget",
    confirm: bp.digest,
  });
  const refused = await preview(busy.client, "agentry_session_send", {
    sessionId: bs.sessionId,
    text: "hello",
  });
  assert.equal(refused.sent, false);
  assert.match(refused.errors[0], /busy:/);
  await call(busy.client, "agentry_session_close", { sessionId: bs.sessionId });
});

test("policy changes invalidate an authoring preview; failed JSON plans cannot authorize writes", async () => {
  const f = fixture();
  const policy = join(f.dir, "policy.yaml");
  writeFileSync(policy, "model: first");
  const { client } = await connect({ FAKE_WRITES: f.writes });
  const args = { descriptionFile: f.file, out: f.out, policy };
  const p = await preview(client, "agentry_draft", args);
  writeFileSync(policy, "model: second");
  const changed = await call(client, "agentry_draft", { ...args, confirm: p.digest });
  assert.equal(changed.isError, true);
  assert.equal(existsSync(f.writes), false);
  const failed = await connect({ FAKE_EXIT: "11", FAKE_WRITES: f.writes });
  const refused = await call(failed.client, "agentry_run", { ref: "acme/widget" });
  assert.equal(refused.isError, true);
  assert.equal(existsSync(f.writes), false);
});

test("voice selection and registry metadata are bound to the same run consent", async () => {
  const { client, argvFile } = await connect();
  const args = { ref: "acme/widget", voice: true, registry: "https://registry.example.test" };
  const p = await preview(client, "agentry_run", args);
  const changed = await call(client, "agentry_run", { ...args, voice: false, confirm: p.digest });
  assert.equal(changed.isError, true);
  const done = await call(client, "agentry_run", { ...args, confirm: p.digest });
  assert.equal(done.isError, undefined, done.content[0].text);
  const metadata = receivedArgv(argvFile).filter((a) => a[0] === "voice");
  assert.ok(metadata.length > 0);
  for (const argv of metadata) assert.equal(argv[argv.indexOf("--registry") + 1], args.registry);
});
