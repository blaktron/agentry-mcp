// The managed settings an organization sets for the person: agentry_managed_show
// passes `managed show --json` through (and the CLI's reason when no run may
// start), agentry_managed_refresh reads them from the registry again and then
// shows them, the tools that write the person's settings pass the CLI's refusal
// of a locked value through unchanged, and the schedule reads carry `held`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkCli } from "../dist/cli.js";
import { FAKE, connect, envelope, receivedArgv } from "./helpers.js";

test("agentry_managed_show passes managed show --json through", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({ name: "agentry_managed_show", arguments: {} });
  assert.equal(r.isError, undefined, r.content[0].text);
  const { json } = envelope(r);
  assert.equal(json.exitClass, "ok");
  const doc = json.result.documents[0];
  assert.equal(doc.organization, "acme");
  assert.equal(doc.version, 3);
  assert.deepEqual(doc.settings[0], {
    id: "unsafeMode",
    value: false,
    locked: true,
    known: true,
    applied: true,
  });
  assert.deepEqual(json.result.problems, []);
  assert.deepEqual(receivedArgv(argvFile), [["managed", "show", "--json"]]);
});

test("agentry_managed_show takes a registry, and surfaces the CLI's reason when no run may start", async () => {
  const reason = "Error: a locked setting this version of Agentry does not know: newSetting";
  const { client, argvFile } = await connect({ FAKE_MANAGED_REFUSED: reason });
  const { json } = envelope(
    await client.callTool({
      name: "agentry_managed_show",
      arguments: { registry: "https://registry.example" },
    }),
  );
  assert.equal(json.exitClass, "policy");
  assert.equal(json.result.documents[0].organization, "acme");
  assert.ok(json.log.includes(reason), json.log);
  assert.deepEqual(receivedArgv(argvFile), [
    ["managed", "show", "--json", "--registry", "https://registry.example"],
  ]);
});

test("agentry_managed_refresh reads the registry again, then shows what is held", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({
    name: "agentry_managed_refresh",
    arguments: { registry: "https://registry.example" },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(envelope(r).json.result.documents[0].organization, "acme");
  assert.deepEqual(receivedArgv(argvFile), [
    ["managed", "refresh", "--registry", "https://registry.example"],
    ["managed", "show", "--json", "--registry", "https://registry.example"],
  ]);
});

test("a refresh the CLI refuses returns its words and shows nothing", async () => {
  const said = "not signed in to https://registry.example; run `agentry login`";
  const { client, argvFile } = await connect({ FAKE_MANAGED_REFRESH_FAIL: said });
  const r = await client.callTool({ name: "agentry_managed_refresh", arguments: {} });
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.includes(said), r.content[0].text);
  assert.deepEqual(receivedArgv(argvFile), [["managed", "refresh"]]);
});

test("a CLI without managed settings is told how to update, and no command is run", async () => {
  process.env.FAKE_NO_MANAGED = "1";
  let features;
  try {
    features = (await checkCli(FAKE)).features;
  } finally {
    delete process.env.FAKE_NO_MANAGED;
  }
  assert.equal(features.managedSettings, false);
  assert.equal((await checkCli(FAKE)).features.managedSettings, true);
  const { client, argvFile } = await connect({}, {}, undefined, {
    ...(await checkCli(FAKE)).features,
    managedSettings: false,
  });
  for (const name of ["agentry_managed_show", "agentry_managed_refresh"]) {
    const r = await client.callTool({ name, arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /no managed settings.*v0\.7\.35 or later/);
  }
  assert.deepEqual(receivedArgv(argvFile), []);
});

test("the setup tools pass the CLI's refusal of a locked value through unchanged", async () => {
  const locked = "model is locked by acme's managed settings (anthropic/claude-sonnet-5-5)";
  const { client } = await connect({ FAKE_LOCKED: locked, FAKE_AGENT_STATE: "running" });
  const setup = await client.callTool({
    name: "agentry_setup",
    arguments: { provider: "openai", skipImages: true },
  });
  assert.equal(setup.isError, true);
  assert.ok(setup.content[0].text.includes(locked), setup.content[0].text);
  assert.match(setup.content[0].text, /exited 11 \(policy\)/);

  const p = envelope(
    await client.callTool({
      name: "agentry_agent_model",
      arguments: { name: "assistant", model: "qwen" },
    }),
  );
  const moved = await client.callTool({
    name: "agentry_agent_model",
    arguments: { name: "assistant", model: "qwen", confirm: p.json.digest },
  });
  assert.ok(moved.content[0].text.includes(locked), moved.content[0].text);
  assert.ok(
    moved.isError === true || envelope(moved).json.exitClass === "policy",
    moved.content[0].text,
  );
});

test("the descriptions of the setup tools say the CLI's refusal comes through as it is", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const described = new Map(tools.map((t) => [t.name, t.description]));
  for (const name of ["agentry_setup", "agentry_agent_model"])
    assert.match(described.get(name), /managed settings.*lock.*unchanged/s, name);
});

test("the schedule reads carry held and run.unsafeMode, and their descriptions name them", async () => {
  const held = "managed settings forbid Unsafe Mode";
  const { client } = await connect({ FAKE_SCHEDULE_HELD: held });
  const list = envelope(await client.callTool({ name: "agentry_schedule_list", arguments: {} }));
  assert.equal(list.json.result[0].held, held);
  assert.equal(list.json.result[0].run.unsafeMode, true);
  const show = envelope(
    await client.callTool({ name: "agentry_schedule_show", arguments: { id: "y34k0ku5us" } }),
  );
  assert.equal(show.json.result.held, held);
  assert.equal(show.json.result.schedule.run.unsafeMode, true);
  const { tools } = await client.listTools();
  for (const t of tools.filter((t) => /^agentry_schedule_(list|show)$/.test(t.name)))
    assert.match(t.description, /`held`.*`run\.unsafeMode`/s, t.name);
});
