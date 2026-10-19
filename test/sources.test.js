// A knowledge build's repositories and addresses, and a voice's addresses:
// passed to the CLI only after confirmation, listed in the consent facts
// with the host each fetch reaches, and refused by a CLI without them.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ALL_FEATURES } from "../dist/cli.js";
import { connect, receivedArgv } from "./helpers.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentry-sources-"));
  const file = join(dir, "sample.md");
  writeFileSync(file, "A sample.");
  return { dir, file, out: join(dir, "out") };
}

async function preview(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

test("a knowledge build takes repositories and addresses, listed with their hosts before it runs", async () => {
  const f = fixture();
  const { client, argvFile } = await connect();
  const args = {
    action: "create",
    name: "uuid-docs",
    repos: ["https://github.com/google/uuid@v1.6.0"],
    urls: ["https://arxiv.org/pdf/1706.03762"],
    web: false,
    out: f.out,
  };
  const p = await preview(client, "agentry_knowledge_build", args);
  assert.deepEqual(p.operation.fetches, [
    { kind: "repository", address: "https://github.com/google/uuid@v1.6.0", host: "github.com" },
    { kind: "url", address: "https://arxiv.org/pdf/1706.03762", host: "arxiv.org" },
  ]);
  assert.ok(
    !receivedArgv(argvFile).some((a) => a.includes("--repo")),
    "a source reached the CLI before confirmation",
  );
  const changed = await client.callTool({
    name: "agentry_knowledge_build",
    arguments: { ...args, urls: ["https://example.org/other.pdf"], confirm: p.digest },
  });
  assert.equal(changed.isError, true);
  const done = await client.callTool({
    name: "agentry_knowledge_build",
    arguments: { ...args, confirm: p.digest },
  });
  assert.equal(done.isError, undefined, done.content[0].text);
  const last = receivedArgv(argvFile).at(-1);
  assert.equal(last[last.indexOf("--repo") + 1], "https://github.com/google/uuid@v1.6.0");
  assert.equal(last[last.indexOf("--url") + 1], "https://arxiv.org/pdf/1706.03762");
  assert.ok(!last.includes("--source-token"));
});

test("a voice takes addresses, with the review the CLI runs named before it runs", async () => {
  const f = fixture();
  const { client, argvFile } = await connect();
  const args = {
    action: "create",
    urls: ["https://paulgraham.com/hwh.html"],
    write: join(f.dir, "VOICE.md"),
    out: f.out,
  };
  const p = await preview(client, "agentry_voice_build", args);
  assert.deepEqual(p.operation.fetches, [
    { kind: "url", address: "https://paulgraham.com/hwh.html", host: "paulgraham.com" },
  ]);
  assert.match(p.operation.review, /AI Review with the person's own TypeSafe key/);
  const done = await client.callTool({
    name: "agentry_voice_build",
    arguments: { ...args, confirm: p.digest },
  });
  assert.equal(done.isError, undefined, done.content[0].text);
  const last = receivedArgv(argvFile).at(-1);
  assert.deepEqual(last.slice(0, 4), ["voice", "create", "--output-format", "json"]);
  assert.equal(last[last.indexOf("--url") + 1], "https://paulgraham.com/hwh.html");
});

test("a CLI without sources or voice addresses is told to update, and nothing runs", async () => {
  const f = fixture();
  const { client, argvFile } = await connect({}, {}, undefined, {
    ...ALL_FEATURES,
    buildSources: false,
    voiceURLs: false,
  });
  const k = await client.callTool({
    name: "agentry_knowledge_build",
    arguments: {
      action: "create",
      name: "n",
      repos: ["https://github.com/o/r"],
      web: false,
      out: f.out,
    },
  });
  assert.equal(k.isError, true);
  assert.match(k.content[0].text, /no knowledge --repo or --url; update the CLI/);
  const v = await client.callTool({
    name: "agentry_voice_build",
    arguments: { action: "create", urls: ["https://example.org/post"], out: f.out },
  });
  assert.equal(v.isError, true);
  assert.match(v.content[0].text, /no voice --url; update the CLI/);
  assert.equal(receivedArgv(argvFile).length, 0);
});

test("a build with neither files, sources nor a brief is refused", async () => {
  const f = fixture();
  const { client } = await connect();
  const r = await client.callTool({
    name: "agentry_knowledge_build",
    arguments: { action: "create", name: "n", web: false, out: f.out },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /files, repos, urls, briefFile/);
  const many = await client.callTool({
    name: "agentry_voice_build",
    arguments: {
      action: "create",
      urls: Array.from({ length: 21 }, (_, i) => `https://example.org/${i}`),
      out: f.out,
    },
  });
  assert.equal(many.isError, true);
});
