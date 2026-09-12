// The four read-only tools over the fake CLI: the tool list, the envelope,
// the argv each builds, and the refusals.
import assert from "node:assert/strict";
import { test } from "node:test";

import { connect, envelope, receivedArgv } from "./helpers.js";

test("lists exactly the four read-only tools", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "agentry_doctor",
    "agentry_info",
    "agentry_search",
    "agentry_verify",
  ]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is read-only`);
    assert.match(
      t.description,
      /agentry (search|info|verify|doctor) --json/,
      `${t.name} names its command`,
    );
  }
});

test("search: argv from typed arguments, the CLI's JSON in the envelope, stderr as log", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({
    name: "agentry_search",
    arguments: { query: "pull request", mode: "autonomous", limit: 5, verified: true },
  });
  assert.equal(r.isError, undefined);
  const { json } = envelope(r);
  assert.equal(json.exitClass, "ok");
  assert.equal(json.result.total, 1);
  assert.equal(json.result.results[0].name, "widget");
  assert.match(json.log, /narration: running search/);
  assert.deepEqual(receivedArgv(argvFile)[0], [
    "search",
    "pull request",
    "--json",
    "--mode",
    "autonomous",
    "--verified",
    "--limit",
    "5",
  ]);
});

test("info, verify, doctor: one command each, ref positional, doctor's ref optional", async () => {
  const { client, argvFile } = await connect();
  await client.callTool({
    name: "agentry_info",
    arguments: { ref: "acme/widget", registry: "https://r.example" },
  });
  await client.callTool({
    name: "agentry_verify",
    arguments: { ref: "acme/widget@1.0.0", strict: true },
  });
  await client.callTool({ name: "agentry_doctor", arguments: {} });
  await client.callTool({
    name: "agentry_doctor",
    arguments: { ref: "acme/widget", adapter: "claude" },
  });
  const got = receivedArgv(argvFile);
  assert.deepEqual(got[0], ["info", "acme/widget", "--json", "--registry", "https://r.example"]);
  assert.deepEqual(got[1], ["verify", "acme/widget@1.0.0", "--json", "--strict"]);
  assert.deepEqual(got[2], ["doctor", "--json"]);
  assert.deepEqual(got[3], ["doctor", "acme/widget", "--json", "--adapter", "claude"]);
});

test("a value that looks like a flag is refused before the CLI runs", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({ name: "agentry_info", arguments: { ref: "--yes" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /must not start with "-"/);
  assert.equal(receivedArgv(argvFile).length, 0, "the CLI was not invoked");
});

test("the CLI's JSON comes back whatever the exit class: doctor's failing checks are the answer", async () => {
  const { client } = await connect({ FAKE_EXIT: "1" });
  const r = await client.callTool({ name: "agentry_doctor", arguments: {} });
  assert.equal(r.isError, undefined, "a JSON report is not an error");
  const { json } = envelope(r);
  assert.equal(json.exitClass, "cli");
  assert.equal(json.result.checks[0].name, "docker");
});

test("every exit class without JSON is a tool error naming the class, with the CLI's stderr", async () => {
  const classes = {
    1: "cli",
    2: "usage",
    10: "verify",
    11: "policy",
    12: "compile",
    13: "gateway",
    14: "harness",
    15: "timeout",
    16: "budget",
    17: "outputSchema",
    42: "exit-42",
  };
  for (const [code, cls] of Object.entries(classes)) {
    const { client } = await connect({ FAKE_EXIT: code, FAKE_STDOUT: "" });
    const r = await client.callTool({ name: "agentry_doctor", arguments: {} });
    assert.equal(r.isError, true, `exit ${code}`);
    assert.match(r.content[0].text, new RegExp(`exited ${code} \\(${cls}\\)`));
    assert.match(r.content[0].text, /narration: running doctor/);
  }
});

test("exit 0 with non-JSON stdout is an error, never parsed as prose", async () => {
  const { client } = await connect({ FAKE_STDOUT: "acme/widget  1.0.0  scanned, 0 findings" });
  const r = await client.callTool({ name: "agentry_info", arguments: { ref: "acme/widget" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /stdout was not JSON/);
  assert.match(r.content[0].text, /never reads its prose/);
});

test("results carry no credential: nothing the fake did not print, and no token shape", async () => {
  const { client } = await connect({ AGENTRY_TOKEN: "agy_should_never_appear" });
  const r = await client.callTool({ name: "agentry_doctor", arguments: {} });
  assert.doesNotMatch(r.content[0].text, /agy_/);
});

test("a hung CLI is killed at the timeout and reported as such", async () => {
  const { client } = await connect({ FAKE_SLEEP: "5" }, { timeoutMs: 300 });
  const r = await client.callTool({ name: "agentry_doctor", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /timed out after 300ms/);
});
