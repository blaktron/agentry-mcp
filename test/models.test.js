// Saved models: agentry_models_list reads them, agentry_run and
// agentry_session_start take `model` as `--model` on the plan and the run,
// the preview and the consent name the saved model, a run on a runhost or on
// a CLI without saved model runs is refused before anything is planned, and
// a saved model the computer does not have is the CLI's refusal.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALL_FEATURES, checkCli } from "../dist/cli.js";
import { FAKE, connect, receivedArgv } from "./helpers.js";

const runArgv = (path) => receivedArgv(path).filter((a) => a[0] === "run");

test("agentry_models_list: models list --json, the saved models and the default, never a key", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({ name: "agentry_models_list", arguments: {} });
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.result.default, "71903d13");
  assert.deepEqual(
    out.result.models.map((m) => m.name),
    ["anthropic", "Qwen"],
  );
  assert.deepEqual(receivedArgv(argvFile)[0], ["models", "list", "--json"]);
});

test("agentry_run's model: --model on the plan and on the run, and the preview and the consent name the saved model", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", model: "Qwen" },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const p = JSON.parse(r.content[0].text);
  assert.match(p.summary, /Model: the saved model Qwen \(custom\/qwen3\)/);
  assert.deepEqual(p.plan.plan.harness.savedModel, { id: "d3f17234", name: "Qwen" });
  const plan = runArgv(argvFile)[0];
  assert.equal(plan[plan.indexOf("--model") + 1], "Qwen");

  // Another model is another plan, so another digest: the consent names
  // the model it was given for.
  const other = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", model: "Llama" },
  });
  assert.notEqual(JSON.parse(other.content[0].text).digest, p.digest);
  const none = await client.callTool({ name: "agentry_run", arguments: { ref: "acme/widget" } });
  const def = JSON.parse(none.content[0].text);
  assert.notEqual(def.digest, p.digest);
  assert.match(def.summary, /^Model: as the runner policy sets it\./m);

  const ran = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", model: "Qwen", confirm: p.digest },
  });
  assert.equal(ran.isError, undefined, ran.content[0].text);
  const run = runArgv(argvFile).at(-1);
  assert.ok(!run.includes("--plan"));
  assert.equal(run[run.indexOf("--model") + 1], "Qwen");
});

test("agentry_session_start's model: --model on the session's plan", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({
    name: "agentry_session_start",
    arguments: { ref: "acme/widget", model: "Qwen" },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const plan = runArgv(argvFile)[0];
  assert.equal(plan[plan.indexOf("--model") + 1], "Qwen");
  assert.match(JSON.parse(r.content[0].text).summary, /the saved model Qwen/);
});

test("a saved model the computer does not have is the CLI's refusal, by its name", async () => {
  const { client } = await connect();
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", model: "Gone" },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no saved model "Gone"/);
});

test("model is refused on a runhost and on a CLI without saved model runs, before anything is planned", async () => {
  const { client, argvFile } = await connect();
  const on = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", model: "Qwen", on: "lab" },
  });
  assert.equal(on.isError, true);
  assert.match(on.content[0].text, /runhost keeps/);

  const old = await connect({}, {}, undefined, { ...ALL_FEATURES, savedModels: false });
  const r = await old.client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", model: "Qwen" },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /v0\.7\.39 or later/);
  const list = await old.client.callTool({ name: "agentry_models_list", arguments: {} });
  assert.equal(list.isError, true);
  assert.deepEqual(runArgv(argvFile), []);
  assert.deepEqual(runArgv(old.argvFile), []);
});

test("the probe reads run --model from the CLI's help", async () => {
  assert.equal((await checkCli(FAKE)).features.savedModels, true);
  process.env.FAKE_NO_SAVED_MODELS = "1";
  try {
    assert.equal((await checkCli(FAKE)).features.savedModels, false);
  } finally {
    delete process.env.FAKE_NO_SAVED_MODELS;
  }
});
