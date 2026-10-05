// Interactive sessions over the pty the server owns (plan §6, M5, D6):
// the start is the run's consent in interactive mode and carries no
// consent flag on the preview; a two-turn conversation with the reply from
// the events receipt; the per-turn timeout leaves the session open; a
// session the CLI ended on idle is reported so on the next send; one
// session at a time; close returns the transcript and the receipts; the
// screen an error quotes has its control sequences stripped while the raw
// stream is kept; the slash commands are not turns.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { connect, receivedArgv } from "./helpers.js";

async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

async function startSession(client, extra = {}) {
  const args = { ref: "acme/widget", ...extra };
  const p = await call(client, "agentry_session_start", args);
  assert.equal(p.isError, undefined, p.content[0].text);
  const preview = JSON.parse(p.content[0].text);
  assert.equal(preview.writes, false);
  assert.equal(preview.plan.mode, "interactive");
  const s = await call(client, "agentry_session_start", { ...args, confirm: preview.digest });
  assert.equal(s.isError, undefined, s.content[0].text);
  return { preview, session: JSON.parse(s.content[0].text) };
}

test("a two-turn session: the preview, the protocol over pipes, replies from fd 3, close with the record", async () => {
  const { client, argvFile } = await connect();
  const { session } = await startSession(client);
  assert.match(session.sessionId, /^s-/);
  assert.equal(session.ref, "acme/widget@1.0.0");
  assert.equal(session.mode, "interactive");
  assert.equal(session.launched, true);
  const argv = receivedArgv(argvFile);
  assert.deepEqual(argv[0].slice(0, 6), [
    "run",
    "acme/widget",
    "--plan",
    "--json",
    "--mode",
    "interactive",
  ]);
  assert.ok(!argv[0].includes("--yes") && !argv[0].includes("--allow-unsigned"));
  const started = argv.at(-1);
  assert.deepEqual(started.slice(0, 4), ["run", "acme/widget@1.0.0", "--mode", "interactive"]);
  assert.ok(started.includes("--output-format") && started.includes("--session-protocol"));
  assert.ok(started.includes("--out") && started.includes("--yes"));

  const t1 = await call(client, "agentry_session_send", {
    sessionId: session.sessionId,
    text: "what is in the note?",
  });
  assert.equal(t1.isError, undefined, t1.content[0].text);
  const turn1 = JSON.parse(t1.content[0].text);
  assert.equal(turn1.reply, "echo: what is in the note?");
  assert.deepEqual(turn1.toolCalls, ["fs_read"]);
  assert.equal(turn1.usage.inputTokens, 10);
  assert.equal(turn1.ended, undefined);

  const t2 = await call(client, "agentry_session_send", {
    sessionId: session.sessionId,
    text: "and\nthe second line?",
  });
  const turn2 = JSON.parse(t2.content[0].text);
  assert.equal(turn2.reply, "echo: and\nthe second line?", "multiline text stays JSON data");

  const c = await call(client, "agentry_session_close", { sessionId: session.sessionId });
  assert.equal(c.isError, undefined, c.content[0].text);
  const closed = JSON.parse(c.content[0].text);
  assert.equal(closed.reason, "finished");
  assert.equal(closed.exitCode, 0);
  assert.equal(closed.forced, false);
  assert.equal(closed.status, "ok");
  assert.equal(closed.result, "final: finished");
  assert.ok(existsSync(closed.transcript), "the transcript is where close says");
  assert.match(readFileSync(closed.transcript, "utf8"), /what is in the note\?/);
  assert.equal(closed.receiptsDir, `${closed.outDir}/receipts`);
  assert.ok(existsSync(closed.cliLog));
});

test("close without finish sends /quit; the reason says so", async () => {
  const { client } = await connect();
  const { session } = await startSession(client);
  const c = await call(client, "agentry_session_close", {
    sessionId: session.sessionId,
    finish: false,
  });
  assert.equal(JSON.parse(c.content[0].text).reason, "quit");
});

test("one session at a time: a second start is refused naming the open one; send and close need the right id", async () => {
  const { client } = await connect();
  const { session } = await startSession(client);
  const again = await call(client, "agentry_session_start", { ref: "acme/widget" });
  assert.equal(again.isError, true);
  assert.match(
    again.content[0].text,
    new RegExp(`session ${session.sessionId} .* is open; one session at a time`),
  );
  const wrong = await call(client, "agentry_session_send", { sessionId: "s-nope", text: "hi" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /the open session is/);
  await call(client, "agentry_session_close", { sessionId: session.sessionId });
  const none = await call(client, "agentry_session_send", {
    sessionId: session.sessionId,
    text: "hi",
  });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /no session is open/);
  // And a new one can start now.
  const { session: next } = await startSession(client);
  assert.notEqual(next.sessionId, session.sessionId);
  await call(client, "agentry_session_close", { sessionId: next.sessionId });
});

test("a session the CLI ended on idle is reported closed on the next send, with the reason", async () => {
  const { client } = await connect({ FAKE_SESSION_IDLE: "1" });
  const { session } = await startSession(client);
  await new Promise((r) => setTimeout(r, 1800));
  const r = await call(client, "agentry_session_send", {
    sessionId: session.sessionId,
    text: "still there?",
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ended \(idle_timeout\); nothing was sent/);
  const c = await call(client, "agentry_session_close", { sessionId: session.sessionId });
  const closed = JSON.parse(c.content[0].text);
  assert.equal(closed.reason, "idle_timeout");
  assert.equal(closed.status, "ok");
});

test("a turn past its timeout leaves the session open; the next send waits for that late reply and holds its own text back", async () => {
  const { client } = await connect({ FAKE_TURN_DELAY: "2" });
  const { session } = await startSession(client);
  const slow = await call(client, "agentry_session_send", {
    sessionId: session.sessionId,
    text: "slow one",
    turnTimeoutSeconds: 1,
  });
  assert.equal(slow.isError, true);
  assert.match(slow.content[0].text, /no reply to "slow one" within 1s; the session is still open/);
  // The chat is still on "slow one": this send is not typed into it.
  const held = await call(client, "agentry_session_send", {
    sessionId: session.sessionId,
    text: "next",
    turnTimeoutSeconds: 10,
  });
  assert.equal(held.isError, undefined, held.content[0].text);
  const late = JSON.parse(held.content[0].text);
  assert.equal(late.sent, false);
  assert.equal(late.lateReplyTo, "slow one");
  assert.equal(late.reply, "echo: slow one");
  const next = await call(client, "agentry_session_send", {
    sessionId: session.sessionId,
    text: "next",
    turnTimeoutSeconds: 10,
  });
  const turn = JSON.parse(next.content[0].text);
  assert.equal(turn.sent, true);
  assert.equal(turn.reply, "echo: next");
  const c = await call(client, "agentry_session_close", { sessionId: session.sessionId });
  // Two turns were taken by the chat, no more: "next" was typed once.
  assert.equal(
    (readFileSync(JSON.parse(c.content[0].text).transcript, "utf8").match(/"user_turn"/g) ?? [])
      .length,
    2,
  );
});

test("a startup failure is reported by send and close after process launch", async () => {
  const { client } = await connect({ FAKE_SESSION_FAIL_START: "1" });
  const { session } = await startSession(client);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const sent = await call(client, "agentry_session_send", {
    sessionId: session.sessionId,
    text: "hello",
  });
  assert.equal(sent.isError, true);
  assert.match(sent.content[0].text, /CLI exited 13.*gateway image/s);
  const closed = JSON.parse(
    (await call(client, "agentry_session_close", { sessionId: session.sessionId })).content[0].text,
  );
  assert.equal(closed.exitCode, 13);
});

test("the chat's own commands are not turns; an empty turn is refused; the preview never carries a consent flag", async () => {
  const { client, argvFile } = await connect({ FAKE_RUN_ATTEST: "unsigned" });
  const p = await call(client, "agentry_session_start", { ref: "acme/widget" });
  const preview = JSON.parse(p.content[0].text);
  assert.equal(preview.unsigned, true);
  const noAccept = await call(client, "agentry_session_start", {
    ref: "acme/widget",
    confirm: preview.digest,
  });
  assert.equal(noAccept.isError, true);
  assert.match(noAccept.content[0].text, /acceptUnsigned: true/);
  const s = await call(client, "agentry_session_start", {
    ref: "acme/widget",
    confirm: preview.digest,
    acceptUnsigned: true,
  });
  assert.equal(s.isError, undefined, s.content[0].text);
  const id = JSON.parse(s.content[0].text).sessionId;
  for (const text of ["   ", ""]) {
    const r = await call(client, "agentry_session_send", { sessionId: id, text });
    assert.equal(r.isError, true);
  }
  for (const text of ["/finish", "hi\n/add /home/me/.ssh/id_rsa", "hi\u001b"]) {
    const r = await call(client, "agentry_session_send", { sessionId: id, text });
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.equal(JSON.parse(r.content[0].text).reply, `echo: ${text}`);
  }
  const argv = receivedArgv(argvFile);
  for (const a of argv)
    if (a.includes("--plan")) assert.ok(!a.includes("--yes") && !a.includes("--allow-unsigned"));
  assert.ok(argv.at(-1).includes("--allow-unsigned"));
  await call(client, "agentry_session_close", { sessionId: id });
});

test("a run preview's digest does not confirm a session: the mode is in the facts", async () => {
  const { client } = await connect({ FAKE_RUN_ATTEST: "unsigned" });
  const runPreview = JSON.parse(
    (await call(client, "agentry_run", { ref: "acme/widget" })).content[0].text,
  );
  const cross = await call(client, "agentry_session_start", {
    ref: "acme/widget",
    confirm: runPreview.digest,
    acceptUnsigned: true,
  });
  assert.equal(cross.isError, true);
  assert.match(cross.content[0].text, /digest does not match/);
});

test("no session result carries a secret value from the server's environment", async () => {
  const { client } = await connect({ OPENAI_API_KEY: "sk-leak-me", AGENTRY_TOKEN: "agy_leak_me" });
  const { preview, session } = await startSession(client);
  const t = await call(client, "agentry_session_send", {
    sessionId: session.sessionId,
    text: "hello",
  });
  const c = await call(client, "agentry_session_close", { sessionId: session.sessionId });
  for (const r of [
    JSON.stringify(preview),
    JSON.stringify(session),
    t.content[0].text,
    c.content[0].text,
  ]) {
    assert.doesNotMatch(r, /sk-leak-me|agy_leak_me/);
  }
});

test("the tool list includes the updated surface", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 22);
  assert.ok(tools.find((t) => t.name === "agentry_session_start"));
});
