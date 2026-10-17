// Tool arguments sent in a JSON type other than the one the schema names are
// taken as the value meant, in both directions, and a value that encodes
// nothing the schema takes is still refused naming the parameter.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { coerce, connectServer, registerTool } from "../dist/toolargs.js";
import { connect, receivedArgv } from "./helpers.js";

test("a JSON string sent for a non-string parameter is the value it encodes", () => {
  assert.equal(coerce(z.boolean(), "true"), true);
  assert.equal(coerce(z.boolean().default(false), "false"), false);
  assert.equal(coerce(z.number().int().optional(), "30"), 30);
  assert.deepEqual(coerce(z.array(z.string()), '["enter"]'), ["enter"]);
  assert.deepEqual(coerce(z.array(z.enum(["read", "write"])), '["read","write"]'), [
    "read",
    "write",
  ]);
  assert.deepEqual(coerce(z.record(z.string(), z.string()).optional(), '{"region":"eu"}'), {
    region: "eu",
  });
  assert.deepEqual(
    coerce(z.record(z.string(), z.union([z.string(), z.number()])), '{"org":"acme","n":2}'),
    { org: "acme", n: 2 },
  );
});

test("a value sent for a string parameter is its compact JSON text", () => {
  assert.equal(coerce(z.string(), 5), "5");
  assert.equal(coerce(z.string().optional(), true), "true");
  assert.equal(coerce(z.string(), { name: "a", tags: [1, 2] }), '{"name":"a","tags":[1,2]}');
  assert.equal(coerce(z.string(), [1, 2]), "[1,2]");
});

test("non-string elements of a list or map of strings are their JSON text", () => {
  assert.deepEqual(coerce(z.array(z.string()), ["-n", 5, true]), ["-n", "5", "true"]);
  assert.deepEqual(coerce(z.array(z.string()), '["-n",5]'), ["-n", "5"]);
  assert.deepEqual(
    coerce(z.record(z.string(), z.string()), { count: 5, accept: "text/html", obj: { a: 1 } }),
    { count: "5", accept: "text/html", obj: '{"a":1}' },
  );
});

test("a string sent for a parameter that takes strings is taken as written", () => {
  assert.equal(coerce(z.string(), "true"), "true");
  assert.equal(coerce(z.string(), '{"a":1}'), '{"a":1}');
  assert.equal(coerce(z.enum(["GET", "POST"]), "GET"), "GET");
  assert.equal(coerce(z.union([z.string(), z.number()]), "30"), "30");
  assert.deepEqual(coerce(z.array(z.string()), ["[1]", "true"]), ["[1]", "true"]);
});

test("values already in the schema's type, and absent ones, are left alone", () => {
  assert.equal(coerce(z.boolean(), true), true);
  assert.equal(coerce(z.number(), 3), 3);
  assert.deepEqual(coerce(z.array(z.string()), ["a"]), ["a"]);
  assert.equal(coerce(z.string().optional(), undefined), undefined);
  assert.equal(coerce(z.boolean().nullable(), null), null);
  assert.equal(coerce(z.union([z.string(), z.number(), z.boolean()]), false), false);
});

test("a string that does not encode the wanted type is left for validation to refuse", () => {
  assert.equal(coerce(z.boolean(), "yes"), "yes");
  assert.equal(coerce(z.boolean(), "30"), "30");
  assert.equal(coerce(z.number().max(10), "30"), "30");
  assert.equal(coerce(z.array(z.string()), "enter"), "enter");
  assert.equal(coerce(z.array(z.string()), "[1"), "[1");
});

test("a JSON string sent for a parameter that takes any JSON is the object or array it holds", () => {
  assert.deepEqual(coerce(z.unknown().optional(), '{"name":"x"}'), { name: "x" });
  assert.deepEqual(coerce(z.unknown(), "[1,2]"), [1, 2]);
  assert.equal(coerce(z.unknown(), "42"), "42");
  assert.equal(coerce(z.unknown(), "plain text"), "plain text");
  assert.deepEqual(coerce(z.unknown(), { name: "x" }), { name: "x" });
});

async function probe() {
  const shape = {
    command: z.string(),
    sudo: z.boolean().default(false),
    timeout: z.number().int().optional(),
    keys: z.array(z.string()).optional(),
  };
  const plain = new McpServer({ name: "plain", version: "0" });
  plain.registerTool("probe", { description: "probe", inputSchema: shape }, async () => ({
    content: [],
  }));
  const server = new McpServer({ name: "probe", version: "0" });
  registerTool(server, "probe", { description: "probe", inputSchema: shape }, async (args) => ({
    content: [{ type: "text", text: JSON.stringify(args) }],
  }));
  const clients = [];
  for (const s of [plain, server]) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await connectServer(s, a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    clients.push(client);
  }
  return { plainClient: clients[0], client: clients[1] };
}

test("a host lists the same input schema as without the wrapper", async () => {
  const { plainClient, client } = await probe();
  assert.deepEqual(
    (await client.listTools()).tools[0].inputSchema,
    (await plainClient.listTools()).tools[0].inputSchema,
  );
});

test("a call with mistyped arguments reaches the handler with the values meant", async () => {
  const { client } = await probe();
  const result = await client.callTool({
    name: "probe",
    arguments: { command: 7, sudo: "true", timeout: "30", keys: '["enter"]' },
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    command: "7",
    sudo: true,
    timeout: 30,
    keys: ["enter"],
  });
});

test("a call whose arguments object arrives as one JSON string is unwrapped", async () => {
  const { client } = await probe();
  const result = await client.callTool({
    name: "probe",
    arguments: '{"command":"id","sudo":"true"}',
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), { command: "id", sudo: true });
});

test("a string that encodes nothing the parameter takes is refused naming it", async () => {
  const { client } = await probe();
  const result = await client.callTool({
    name: "probe",
    arguments: { command: "id", sudo: "yes" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /expected boolean, received string/);
  assert.match(result.content[0].text, /\bsudo\b/);
});

test("agentry_knowledge_build takes a stringified web choice as the choice", async () => {
  const { client, argvFile } = await connect();
  const dir = mkdtempSync(join(tmpdir(), "agentry-toolargs-"));
  const briefFile = join(dir, "brief.md");
  writeFileSync(briefFile, "A brief.");
  const typed = { action: "create", name: "notes", briefFile, web: true, out: join(dir, "out") };
  const first = await client.callTool({
    name: "agentry_knowledge_build",
    arguments: { ...typed, web: "true", maxPackMB: "5" },
  });
  assert.equal(first.isError, undefined, first.content[0].text);
  const again = await client.callTool({
    name: "agentry_knowledge_build",
    arguments: { ...typed, maxPackMB: 5 },
  });
  assert.equal(
    JSON.parse(again.content[0].text).digest,
    JSON.parse(first.content[0].text).digest,
    "the coerced call and the typed call are one operation",
  );
  const done = await client.callTool({
    name: "agentry_knowledge_build",
    arguments: {
      ...typed,
      web: "true",
      maxPackMB: "5",
      confirm: JSON.parse(first.content[0].text).digest,
    },
  });
  assert.equal(done.isError, undefined, done.content[0].text);
  const last = receivedArgv(argvFile).at(-1);
  assert.ok(last.includes("--web") && !last.includes("--no-web"), last.join(" "));
  assert.equal(last[last.indexOf("--max-pack-mb") + 1], "5");
});

test("arguments that are one JSON string but not an object are not unwrapped", async () => {
  const { client } = await probe();
  for (const text of ["[1,2]", '"{}"', "not json"]) {
    await assert.rejects(client.callTool({ name: "probe", arguments: text }), /-32602|Invalid/);
  }
});

test("coerced consent words count only as what they say", async () => {
  const writes = join(mkdtempSync(join(tmpdir(), "agentry-toolargs-")), "writes");
  const { client, argvFile } = await connect({ FAKE_WRITES: writes, FAKE_ATTEST: "unsigned" });
  const p = await client.callTool({ name: "agentry_install", arguments: { ref: "acme/widget" } });
  const { digest } = JSON.parse(p.content[0].text);
  const no = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: digest, acceptUnsigned: "false" },
  });
  assert.equal(no.isError, true);
  assert.match(no.content[0].text, /acceptUnsigned: true/);
  for (const confirm of [12345, { digest }]) {
    const wrong = await client.callTool({
      name: "agentry_install",
      arguments: { ref: "acme/widget", confirm, acceptUnsigned: true },
    });
    assert.equal(wrong.isError, true, `confirm ${JSON.stringify(confirm)} was accepted`);
  }
  assert.equal(existsSync(writes), false);
  const yes = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: digest, acceptUnsigned: "true" },
  });
  assert.equal(yes.isError, undefined, yes.content[0].text);
  assert.deepEqual(receivedArgv(argvFile).at(-1), [
    "install",
    "acme/widget@1.0.0",
    "--json",
    "--yes",
    "--allow-unsigned",
  ]);
});

test("a number sent for a string parameter that reads as a flag is refused before the CLI", async () => {
  const { client, argvFile } = await connect();
  const r = await client.callTool({ name: "agentry_install", arguments: { ref: -1 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /must not start with "-"/);
  assert.deepEqual(receivedArgv(argvFile), []);
});

function tsFiles(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

test("every tool of both servers is registered through the wrapper", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const offenders = [join(root, "src"), join(root, "secureagentry-mcp/src")]
    .flatMap(tsFiles)
    .filter((f) => !f.endsWith("toolargs.ts"))
    .filter((f) => /\.registerTool\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});
