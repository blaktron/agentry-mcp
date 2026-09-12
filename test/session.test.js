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

import { stripControl } from "../dist/session.js";
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

test("a two-turn session: the preview, the chat on a pty, replies from the receipt, close with the record", async () => {
  const { client, argvFile } = await connect();
  const { session } = await startSession(client);
  assert.match(session.sessionId, /^s-/);
  assert.equal(session.ref, "acme/widget@1.0.0");
  assert.equal(session.mode, "interactive");
  assert.ok(existsSync(`${session.receiptsDir}/events.ndjson`), "the receipt exists once started");
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
  assert.ok(!started.includes("--output-format"), "an interactive run has no JSON form");
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
  assert.equal(
    turn2.reply,
    "echo: and the second line?",
    "newlines become spaces; one line per turn",
  );

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
  const raw = readFileSync(closed.ptyLog, "utf8");
  assert.match(raw, /\x1b\[1;34m/, "the raw stream keeps the chat's colour codes");
  assert.match(raw, /what is in the note\?/);
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

test("a turn past its timeout leaves the session open; the next send gets the late reply's successor", async () => {
  const { client } = await connect({ FAKE_TURN_DELAY: "2" });
  const { session } = await startSession(client);
  const slow = await call(client, "agentry_session_send", {
    sessionId: session.sessionId,
    text: "slow one",
    turnTimeoutSeconds: 1,
  });
  assert.equal(slow.isError, true);
  assert.match(slow.content[0].text, /no reply within 1s; the session is still open/);
  await new Promise((r) => setTimeout(r, 2500));
  const next = await call(client, "agentry_session_send", {
    sessionId: session.sessionId,
    text: "next",
    turnTimeoutSeconds: 10,
  });
  assert.equal(next.isError, undefined, next.content[0].text);
  assert.equal(JSON.parse(next.content[0].text).reply, "echo: next");
  await call(client, "agentry_session_close", { sessionId: session.sessionId });
});

test("a CLI that stops before the session starts is an error quoting the screen with control sequences stripped", async () => {
  const { client } = await connect({ FAKE_SESSION_FAIL_START: "1" });
  const p = await call(client, "agentry_session_start", { ref: "acme/widget" });
  const r = await call(client, "agentry_session_start", {
    ref: "acme/widget",
    confirm: JSON.parse(p.content[0].text).digest,
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /exited \(13\) before the session started/);
  assert.match(r.content[0].text, /agentry: gateway image not present/);
  assert.doesNotMatch(r.content[0].text, /\x1b/);
  // The slot is free again.
  const fresh = await connect();
  const { session } = await startSession(fresh.client);
  assert.ok(session.sessionId);
  await call(fresh.client, "agentry_session_close", { sessionId: session.sessionId });
});

test("stripControl removes colour, cursor and title sequences and carriage returns", () => {
  assert.equal(
    stripControl("\x1b[1;34mhi\x1b[0m\r\n\x1b[2J\x1b[H\x1b]0;title\x07x\x1b(B\x1b[?1049h"),
    "hi\nx",
  );
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
  for (const text of ["/finish", "/quit", "   ", ""]) {
    const r = await call(client, "agentry_session_send", { sessionId: id, text });
    assert.equal(r.isError, true, text);
  }
  const argv = receivedArgv(argvFile);
  for (const a of argv)
    if (a.includes("--plan")) assert.ok(!a.includes("--yes") && !a.includes("--allow-unsigned"));
  assert.ok(argv.at(-1).includes("--allow-unsigned"));
  await call(client, "agentry_session_close", { sessionId: id });
});

test("the tool list is the thirteen", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13);
  assert.ok(tools.find((t) => t.name === "agentry_session_start"));
});
