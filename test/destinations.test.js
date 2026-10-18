// The read tools for schedules, connections, model
// sign-ins, the report design and destinations; agentry_run's destination,
// report theme and sign-in arguments, on the run alone and in the digest,
// secrets only by name; the default destination set in the preview and the
// digest; agentry_deliver behind two calls; an older CLI told to update.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { checkCli } from "../dist/cli.js";
import { FAKE, connect, receivedArgv, scratchArgv } from "./helpers.js";

const runs = (file) => receivedArgv(file).filter((a) => a[0] === "run");

async function preview(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
}

test("the read tools run their CLI command with --json and pass its JSON through", async () => {
  const { client, argvFile } = await connect();
  for (const name of [
    "agentry_schedule_list",
    "agentry_connections_list",
    "agentry_model_signins_list",
    "agentry_report_design_show",
    "agentry_destinations_list",
  ]) {
    const env = await preview(client, name, {});
    assert.equal(env.exitClass, "ok", name);
  }
  assert.deepEqual(receivedArgv(argvFile), [
    ["schedule", "list", "--json"],
    ["connections", "list", "--json"],
    ["model-signins", "list", "--json"],
    ["report-design", "show", "--json"],
    ["destinations", "list", "--json"],
  ]);
});

test("run: destinations, report theme and sign-ins by name ride on the run, never the plan", async () => {
  const { client, argvFile } = await connect({ HOST_PW: "hunter2-value" });
  const call = {
    ref: "acme/widget",
    destinations: ["n8n", "archive"],
    reportTheme: "modern",
    intakeTokens: { repo: "GITHUB_TOKEN" },
    hostKeys: { web: "/home/me/.ssh/id_ed25519" },
    hostPasswords: { db: "HOST_PW" },
    hostPassphrases: { web: "KEY_PASSPHRASE" },
    hostSudoPasswords: { web: "SUDO_PW" },
  };
  const p = await preview(client, "agentry_run", call);
  assert.deepEqual(p.delivery.destinations, ["n8n", "archive"]);
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ...call, confirm: p.digest },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const [plan, run] = runs(argvFile).slice(-2);
  for (const f of [
    "--destination",
    "--report-theme",
    "--intake-token",
    "--host-key",
    "--host-password",
  ])
    assert.ok(!plan.includes(f), `${f} on the plan`);
  const pairs = [];
  for (let i = 0; i < run.length; i++)
    if (
      /^--(destination|report-theme|intake-token|host-key|host-password|host-passphrase|host-sudo-password)$/.test(
        run[i],
      )
    )
      pairs.push([run[i], run[i + 1]]);
  assert.deepEqual(pairs, [
    ["--destination", "n8n"],
    ["--destination", "archive"],
    ["--report-theme", "modern"],
    ["--intake-token", "repo=GITHUB_TOKEN"],
    ["--host-key", "web=/home/me/.ssh/id_ed25519"],
    ["--host-password", "db=HOST_PW"],
    ["--host-passphrase", "web=KEY_PASSPHRASE"],
    ["--host-sudo-password", "web=SUDO_PW"],
  ]);
  assert.doesNotMatch(JSON.stringify(r), /hunter2-value/);
});

test("run: a secret where a variable's name belongs, a flag-like value or a bad id is refused before any CLI call", async () => {
  const { client, argvFile } = await connect();
  for (const [args, re] of [
    [{ hostPasswords: { db: "hunter2!" } }, /NAME of an environment variable/],
    [{ intakeTokens: { repo: "ghp abc" } }, /NAME of an environment variable/],
    [{ hostKeys: { web: "--yes" } }, /must not start with "-"/],
    [{ destinations: ["--allow-unsigned"] }, /must not start with "-"/],
    [{ hostKeys: { "a b": "/k" } }, /is not an identifier/],
    [{ destinations: ["n8n"], noDestination: true }, /not both/],
  ]) {
    const r = await client.callTool({
      name: "agentry_run",
      arguments: { ref: "acme/widget", ...args },
    });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, re);
  }
  assert.deepEqual(receivedArgv(argvFile), []);
});

test("run: each new argument changes the digest", async () => {
  const { client } = await connect();
  const base = (await preview(client, "agentry_run", { ref: "acme/widget" })).digest;
  for (const extra of [
    { destinations: ["n8n"] },
    { noDestination: true },
    { reportTheme: "classic" },
    { intakeTokens: { repo: "TOKEN" } },
    { hostKeys: { web: "/k" } },
    { hostPasswords: { web: "PW" } },
    { hostPassphrases: { web: "PP" } },
    { hostSudoPasswords: { web: "SP" } },
  ]) {
    const d = (await preview(client, "agentry_run", { ref: "acme/widget", ...extra })).digest;
    assert.notEqual(d, base, JSON.stringify(extra));
  }
});

test("run: the preview names the QuickAgent's default destinations, and a default set changed before the confirm refuses it", async () => {
  const file = scratchArgv() + "-dests";
  writeFileSync(
    file,
    JSON.stringify({
      destinations: [
        { name: "n8n", kind: "webhook", where: "n8n.example:443", defaultFor: ["acme/widget"] },
        { name: "other", kind: "webhook", where: "x.example:443", defaultFor: ["acme/else"] },
      ],
    }),
  );
  const { client, argvFile } = await connect({ FAKE_DESTINATIONS_FILE: file });
  const p = await preview(client, "agentry_run", { ref: "acme/widget" });
  assert.deepEqual(p.delivery.destinations, ["n8n"]);
  assert.equal(p.delivery.defaultSetFor, "acme/widget");
  writeFileSync(
    file,
    JSON.stringify({
      destinations: [{ name: "n8n", kind: "webhook", where: "n8n.example:443", defaultFor: [] }],
    }),
  );
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", confirm: p.digest },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /digest does not match/);
  assert.ok(!runs(argvFile).some((a) => !a.includes("--plan")), "nothing ran");

  const none = await preview(client, "agentry_run", { ref: "acme/widget", noDestination: true });
  assert.deepEqual(none.delivery.destinations, []);
});

test("an older CLI: destinations are refused naming the update, and a run without them reads no destinations", async () => {
  const { client, argvFile } = await connect({}, {}, undefined, {
    deliverTo: true,
    destinations: false,
  });
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", destinations: ["n8n"] },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no run --destination; update the CLI/);
  await preview(client, "agentry_run", { ref: "acme/widget" });
  assert.ok(!receivedArgv(argvFile).some((a) => a[0] === "destinations"));
  const dl = await client.callTool({
    name: "agentry_deliver",
    arguments: { runFolder: "/nowhere", destinations: ["n8n"] },
  });
  assert.match(dl.content[0].text, /cannot send to a destination; update the CLI/);
});

test("checkCli reports whether the CLI has run --destination", async () => {
  assert.equal((await checkCli(FAKE)).features.destinations, true);
  process.env.FAKE_NO_DESTINATION = "1";
  try {
    assert.equal((await checkCli(FAKE)).features.destinations, false);
  } finally {
    delete process.env.FAKE_NO_DESTINATION;
  }
});

function runFolderWithResult() {
  const dir = mkdtempSync(join(tmpdir(), "agentry-mcp-run-"));
  const result = {
    status: "ok",
    deliverables: {
      files: [{ path: "reports/a.md", title: "A", sha256: "0".repeat(64), bytes: 1 }],
    },
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  return { dir, result };
}

test("deliver: the preview lists the run's deliverables and sends nothing; the confirm runs agentry deliver", async () => {
  const writes = scratchArgv() + "-writes";
  const { dir } = runFolderWithResult();
  const { client, argvFile } = await connect({ FAKE_WRITES: writes });
  const call = { runFolder: dir, to: "/home/me/Documents/Agentry", destinations: ["n8n"] };
  const p = await preview(client, "agentry_deliver", call);
  assert.equal(p.operation.deliverables.files[0].path, "reports/a.md");
  assert.equal(p.writes, false);
  assert.deepEqual(receivedArgv(argvFile), [["destinations", "list", "--json"]]);
  const r = await client.callTool({
    name: "agentry_deliver",
    arguments: { ...call, confirm: p.digest },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(receivedArgv(argvFile).at(-1), [
    "deliver",
    dir,
    "--json",
    "--to",
    "/home/me/Documents/Agentry",
    "--destination",
    "n8n",
  ]);
  assert.equal(JSON.parse(r.content[0].text).result.deliveries[0].status, "delivered");
});

test("deliver: a result.json changed since the preview refuses the confirm; no folder and no destination, or no run folder, is refused", async () => {
  const { dir, result } = runFolderWithResult();
  const { client, argvFile } = await connect();
  const p = await preview(client, "agentry_deliver", { runFolder: dir, to: "/x" });
  result.deliverables.files.push({
    path: "reports/b.md",
    title: "B",
    sha256: "1".repeat(64),
    bytes: 1,
  });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  const r = await client.callTool({
    name: "agentry_deliver",
    arguments: { runFolder: dir, to: "/x", confirm: p.digest },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /digest does not match/);
  for (const [args, re] of [
    [{ runFolder: dir }, /give a folder/],
    [{ runFolder: join(dir, "nope"), to: "/x" }, /no result.json/],
    [{ runFolder: "--yes", to: "/x" }, /must not start with "-"/],
  ]) {
    const e = await client.callTool({ name: "agentry_deliver", arguments: args });
    assert.equal(e.isError, true);
    assert.match(e.content[0].text, re);
  }
  assert.ok(!receivedArgv(argvFile).some((a) => a[0] === "deliver"));
});

test("the preview and the person's question say which variable goes to which source or host", async () => {
  const { client, elicitations } = await connect({}, {}, "accept");
  const call = {
    ref: "acme/widget",
    intake: { repo: "https://git.example/acme/app" },
    intakeTokens: { repo: "GITHUB_TOKEN" },
    hostPasswords: { db: "DB_PW" },
    hostKeys: { web: "/home/me/.ssh/id_ed25519" },
  };
  const p = await preview(client, "agentry_run", call);
  assert.deepEqual(p.signIns, [
    {
      kind: "input source token",
      id: "repo",
      env: "GITHUB_TOKEN",
      source: "https://git.example/acme/app",
    },
    { kind: "target host key file", id: "web", path: "/home/me/.ssh/id_ed25519" },
    { kind: "target host password", id: "db", env: "DB_PW" },
  ]);
  await client.callTool({ name: "agentry_run", arguments: { ...call, confirm: p.digest } });
  assert.match(
    elicitations[0],
    /\$GITHUB_TOKEN as the input source token for repo \(https:\/\/git\.example\/acme\/app\)/,
  );
  assert.match(elicitations[0], /\$DB_PW as the target host password for host db/);
});

test("a session's preview names the default destinations it delivers to at its end", async () => {
  const file = scratchArgv() + "-dests";
  writeFileSync(
    file,
    JSON.stringify({
      destinations: [
        { name: "n8n", kind: "webhook", where: "n8n.example:443", defaultFor: ["acme/widget"] },
      ],
    }),
  );
  const { client } = await connect({ FAKE_DESTINATIONS_FILE: file });
  const p = await preview(client, "agentry_session_start", { ref: "acme/widget" });
  assert.deepEqual(p.delivery.destinations, ["n8n"]);
  assert.equal(p.delivery.saved[0].where, "n8n.example:443");
});

test("deliver: the preview shows only the named destinations and the start of the result; a result.json changed while the person was asked delivers nothing", async () => {
  const file = scratchArgv() + "-dests";
  writeFileSync(
    file,
    JSON.stringify({
      destinations: [
        { name: "n8n", kind: "webhook", where: "n8n.example:443", defaultFor: [] },
        { name: "unrelated", kind: "webhook", where: "u.example:443", defaultFor: [] },
      ],
    }),
  );
  const { dir, result } = runFolderWithResult();
  const { client, argvFile } = await connect({ FAKE_DESTINATIONS_FILE: file }, {}, "accept");
  const call = { runFolder: dir, destinations: ["n8n"] };
  const p = await preview(client, "agentry_deliver", call);
  assert.deepEqual(
    p.operation.savedDestinations.map((r) => r.name),
    ["n8n"],
  );
  assert.equal(p.operation.result, "null");
  client.setRequestHandler(ElicitRequestSchema, async () => {
    result.status = "tampered";
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    return { action: "accept", content: { proceed: true } };
  });
  const r = await client.callTool({
    name: "agentry_deliver",
    arguments: { ...call, confirm: p.digest },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /changed while the person was asked/);
  assert.ok(!receivedArgv(argvFile).some((a) => a[0] === "deliver"));
});
