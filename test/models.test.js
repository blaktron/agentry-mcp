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

test("model is refused on a CLI without saved model runs, before anything is planned", async () => {
  const { argvFile } = await connect();
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

test("the probe reads agent configure --model from the CLI's help", async () => {
  assert.equal((await checkCli(FAKE)).features.agentModels, true);
  process.env.FAKE_NO_AGENT_MODELS = "1";
  try {
    assert.equal((await checkCli(FAKE)).features.agentModels, false);
  } finally {
    delete process.env.FAKE_NO_AGENT_MODELS;
  }
});

test("agentry_models_list with on: runhost model <on> --json, the runhost's saved models", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({ name: "agentry_models_list", arguments: { on: "lab" } });
  assert.notEqual(r.isError, true);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.result.runhost, "lab");
  assert.deepEqual(
    out.result.models.models.map((m) => [m.name, m.kind]),
    [
      ["Qwen", "no-key"],
      ["ChatGPT", "sign-in"],
    ],
  );
  assert.equal(out.result.models.models[1].refusal, "the runhost is not signed in to ChatGPT");
  assert.equal(out.result.models.default, "d3f17234");
  assert.deepEqual(receivedArgv(argvFile)[0], ["runhost", "model", "lab", "--json"]);
});

test("agentry_models_list with on refuses a bad name, a policy beside it, and a CLI that cannot list a runhost's models", async () => {
  const { client, argvFile } = await connect();
  const bad = await client.callTool({ name: "agentry_models_list", arguments: { on: "Lab;rm" } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /not a runhost's name/);
  const pol = await client.callTool({
    name: "agentry_models_list",
    arguments: { on: "lab", policy: "p.yaml" },
  });
  assert.equal(pol.isError, true);
  const old = await connect({}, {}, undefined, { ...ALL_FEATURES, runhostModels: false });
  const r = await old.client.callTool({ name: "agentry_models_list", arguments: { on: "lab" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /v0\.7\.39 or later/);
  assert.deepEqual(receivedArgv(argvFile), []);
  assert.deepEqual(receivedArgv(old.argvFile), []);
});

test("agentry_run's model with on: --model on the plan and the run, and the consent says its credential alone travels", async () => {
  const { client, argvFile } = await connect();
  const p = JSON.parse(
    (
      await client.callTool({
        name: "agentry_run",
        arguments: { ref: "acme/widget", model: "Qwen", on: "lab" },
      })
    ).content[0].text,
  );
  assert.match(
    p.summary,
    /saved model "Qwen": its credential alone travels with the run to the runhost lab/,
  );
  const plan = runArgv(argvFile)[0];
  assert.equal(plan[plan.indexOf("--model") + 1], "Qwen");
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", model: "Qwen", on: "lab", confirm: p.digest },
  });
  assert.notEqual(r.isError, true);
  const run = runArgv(argvFile).find((a) => !a.includes("--plan"));
  assert.equal(run[run.indexOf("--model") + 1], "Qwen");
  assert.equal(run[run.indexOf("--on") + 1], "lab");
});

test("agentry_session_start's model with on: --model on the session's plan, said in the summary", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({
    name: "agentry_session_start",
    arguments: { ref: "acme/widget", model: "Qwen", on: "lab" },
  });
  assert.notEqual(r.isError, true);
  const plan = runArgv(argvFile)[0];
  assert.equal(plan[plan.indexOf("--model") + 1], "Qwen");
  assert.match(JSON.parse(r.content[0].text).summary, /credential alone travels/);
});

test("model with on is refused with the version it needs on a CLI that takes no --model with --on", async () => {
  const old = await connect({}, {}, undefined, { ...ALL_FEATURES, runhostModels: false });
  for (const name of ["agentry_run", "agentry_session_start"]) {
    const r = await old.client.callTool({
      name,
      arguments: { ref: "acme/widget", model: "Qwen", on: "lab" },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /v0\.7\.39 or later/);
  }
  assert.deepEqual(runArgv(old.argvFile), []);
});

test("the probe reads --on --model from run's and agent configure's help", async () => {
  const f = await checkCli(FAKE);
  assert.equal(f.features.runhostModels, true);
  assert.equal(f.features.agentRunhostModels, true);
  process.env.FAKE_NO_RUNHOST_MODELS = "1";
  try {
    const old = await checkCli(FAKE);
    assert.equal(old.features.runhostModels, false);
    assert.equal(old.features.agentRunhostModels, false);
    assert.equal(old.features.savedModels, true);
    assert.equal(old.features.agentModels, true);
  } finally {
    delete process.env.FAKE_NO_RUNHOST_MODELS;
  }
});

test("agentry_providers_list: providers list --json, the providers and every kept sign-in, never a token", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({ name: "agentry_providers_list", arguments: {} });
  assert.equal(r.isError, undefined, r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  assert.deepEqual(
    out.result.providers.map((p) => [p.id, p.account]),
    [["copilot", "octo"]],
  );
  assert.deepEqual(
    out.result.signIns.map((s) => [s.vendor, s.provider, s.inUse]),
    [
      ["copilot", "copilot", true],
      ["chatgpt", "openai", false],
    ],
  );
  const withPolicy = await client.callTool({
    name: "agentry_providers_list",
    arguments: { policy: "/tmp/policy.yaml" },
  });
  assert.equal(withPolicy.isError, undefined, withPolicy.content[0].text);
  assert.deepEqual(receivedArgv(argvFile), [
    ["providers", "list", "--json"],
    ["providers", "list", "--json", "--policy", "/tmp/policy.yaml"],
  ]);
  const old = await connect({}, {}, undefined, { ...ALL_FEATURES, savedModels: false });
  const refused = await old.client.callTool({ name: "agentry_providers_list", arguments: {} });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /v0\.7\.39 or later/);
});
