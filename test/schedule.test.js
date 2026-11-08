// The schedule and voice reads, and pausing a schedule: each runs the CLI
// command its row names, and a schedule id that is not one is refused
// before the CLI is run.
import assert from "node:assert/strict";
import { test } from "node:test";

import { connect, receivedArgv } from "./helpers.js";

test("agentry_schedule_show reads one schedule as JSON", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({
    name: "agentry_schedule_show",
    arguments: { id: "y34k0ku5us" },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(JSON.parse(r.content[0].text).result.schedule.id, "y34k0ku5us");
  assert.deepEqual(receivedArgv(argvFile).at(-1), ["schedule", "show", "y34k0ku5us", "--json"]);
});

test("agentry_schedule_pause pauses or resumes, then returns the schedule", async () => {
  const { client, argvFile } = await connect();
  for (const action of ["pause", "resume"]) {
    const r = await client.callTool({
      name: "agentry_schedule_pause",
      arguments: { id: "y34k0ku5us", action },
    });
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.equal(JSON.parse(r.content[0].text).result.schedule.name, "weekly");
    assert.deepEqual(receivedArgv(argvFile).slice(-2), [
      ["schedule", action, "y34k0ku5us"],
      ["schedule", "show", "y34k0ku5us", "--json"],
    ]);
  }
});

test("a schedule id that is not one is refused before the CLI runs", async () => {
  const { client, argvFile } = await connect();
  for (const name of ["agentry_schedule_show", "agentry_schedule_pause"]) {
    const r = await client.callTool({ name, arguments: { id: "--all", action: "pause" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not a schedule's id/);
  }
  assert.deepEqual(receivedArgv(argvFile), []);
});

test("agentry_voice_show reads the kept Writing Voice", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({ name: "agentry_voice_show", arguments: {} });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(JSON.parse(r.content[0].text).result.voice, /Short sentences/);
  assert.deepEqual(receivedArgv(argvFile).at(-1), ["voice", "show", "--json"]);
});
