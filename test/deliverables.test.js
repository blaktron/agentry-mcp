// A run's deliverables handed back: text inline up to the caps, the rest as
// links, each only after its bytes match the runner's digest; a delivered
// copy is linked when it still matches; --deliver-to is in the digest and on
// the run alone; a CLI without it is told to update.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { connect, receivedArgv } from "./helpers.js";

const KiB = 1024;

function sha(b) {
  return createHash("sha256").update(b).digest("hex");
}

/** A run folder with reports/<name> for each entry, and the block that lists them. */
function runFolder(files) {
  const out = mkdtempSync(join(tmpdir(), "agentry-mcp-out-"));
  mkdirSync(join(out, "reports"));
  const listed = [];
  for (const [name, body, extra = {}] of files) {
    const b = Buffer.from(body);
    writeFileSync(join(out, "reports", name), b);
    listed.push({
      path: `reports/${name}`,
      title: name.replace(/\.[^.]*$/, ""),
      sha256: sha(b),
      bytes: b.length,
      type: name.split(".").pop(),
      marked: true,
      ...extra,
    });
  }
  return { out, listed };
}

/** Previews then confirms a run against the fake whose envelope lists `block`. */
async function runWith(out, block, { deliveries, args = {}, features } = {}) {
  const env = { FAKE_RUN_OUT: out, FAKE_DELIVERABLES: JSON.stringify(block) };
  if (deliveries) env.FAKE_DELIVERIES = JSON.stringify(deliveries);
  const { client, argvFile } = await connect(env, {}, undefined, features);
  const call = { ref: "acme/widget", ...args };
  const p = await client.callTool({ name: "agentry_run", arguments: call });
  assert.equal(p.isError, undefined, p.content[0].text);
  const { digest } = JSON.parse(p.content[0].text);
  const r = await client.callTool({ name: "agentry_run", arguments: { ...call, confirm: digest } });
  assert.equal(r.isError, undefined, r.content[0].text);
  return { r, env: JSON.parse(r.content[0].text), argvFile };
}

test("text deliverables come back inline, a PDF as a link, each named in the envelope", async () => {
  const { out, listed } = runFolder([
    ["summary.md", "# Weekly\n\nAll quiet.\n"],
    ["report.pdf", "%PDF-1.7 not really"],
  ]);
  const { r, env } = await runWith(out, { files: listed });
  assert.equal(r.content.length, 3);
  const [inline, link] = r.content.slice(1);
  assert.equal(inline.type, "resource");
  assert.equal(inline.resource.text, "# Weekly\n\nAll quiet.\n");
  assert.equal(inline.resource.mimeType, "text/markdown");
  assert.equal(inline.resource.uri, pathToFileURL(join(out, "reports", "summary.md")).href);
  assert.equal(link.type, "resource_link");
  assert.equal(link.uri, pathToFileURL(join(out, "reports", "report.pdf")).href);
  assert.equal(link.mimeType, "application/pdf");
  assert.equal(link.title, "report");
  assert.equal(link.size, listed[1].bytes);
  assert.deepEqual(
    env.deliverables.map((d) => [d.path, d.returned]),
    [
      ["reports/summary.md", "inline"],
      ["reports/report.pdf", "link"],
    ],
  );
});

test("the caps: 256 KiB inline, one byte more is a link; past 1 MiB in all the rest are links", async () => {
  const { out, listed } = runFolder([
    ["at-cap.txt", "a".repeat(256 * KiB)],
    ["over-cap.txt", "b".repeat(256 * KiB + 1)],
    ["c1.txt", "c".repeat(250 * KiB)],
    ["c2.txt", "d".repeat(250 * KiB)],
    ["c3.txt", "e".repeat(250 * KiB)],
    ["c4.txt", "f".repeat(250 * KiB)],
  ]);
  const { r, env } = await runWith(out, { files: listed });
  assert.deepEqual(
    env.deliverables.map((d) => d.returned),
    ["inline", "link", "inline", "inline", "inline", "link"],
  );
  assert.match(env.deliverables[1].reason, /over 262144 bytes/);
  assert.match(env.deliverables[5].reason, /reached 1048576 bytes/);
  const inlined = r.content
    .filter((c) => c.type === "resource")
    .reduce((n, c) => n + Buffer.byteLength(c.resource.text), 0);
  assert.ok(inlined <= 1024 * KiB, `${inlined} bytes inlined`);
});

test("a digest or size mismatch, a link, a missing file and a path outside reports/ are neither inlined nor linked", async () => {
  const { out, listed } = runFolder([
    ["changed.md", "what the agent wrote"],
    ["resized.md", "short"],
    ["fine.md", "kept"],
  ]);
  listed[0].sha256 = sha(Buffer.from("something else entirely!"));
  listed[1].bytes += 1;
  writeFileSync(join(out, "secret.txt"), "outside the reports folder");
  symlinkSync(join(out, "secret.txt"), join(out, "reports", "linked.md"));
  const outside = { ...listed[2], path: "../secret.txt" };
  const receipts = { ...listed[2], path: "receipts/run.json" };
  const linked = {
    ...listed[2],
    path: "reports/linked.md",
    sha256: sha(Buffer.from("outside the reports folder")),
    bytes: 26,
  };
  const missing = { ...listed[2], path: "reports/gone.md" };
  const { r, env } = await runWith(out, {
    files: [listed[0], listed[1], outside, receipts, linked, missing, listed[2]],
  });
  const got = Object.fromEntries(env.deliverables.map((d) => [d.path, d]));
  for (const p of [
    "reports/changed.md",
    "reports/resized.md",
    "../secret.txt",
    "receipts/run.json",
    "reports/linked.md",
    "reports/gone.md",
  ]) {
    assert.equal(got[p].returned, "withheld", p);
    assert.equal(got[p].uri, undefined, p);
  }
  assert.match(got["reports/changed.md"].reason, /changed/);
  assert.match(got["reports/linked.md"].reason, /link/);
  // Only the one that matches comes back, and nothing of the others' bytes.
  assert.equal(r.content.length, 2);
  assert.equal(r.content[1].resource.text, "kept");
  assert.doesNotMatch(JSON.stringify(r.content), /outside the reports folder|what the agent wrote/);
});

test("a delivered copy is what the link names, while its bytes match; a changed copy falls back to the run folder", async () => {
  const { out, listed } = runFolder([
    ["report.pdf", "%PDF-1.7 one"],
    ["other.pdf", "%PDF-1.7 two"],
  ]);
  const dest = mkdtempSync(join(tmpdir(), "agentry-mcp-dest-"));
  const good = join(dest, "report.pdf");
  const bad = join(dest, "other.pdf");
  writeFileSync(good, "%PDF-1.7 one");
  writeFileSync(bad, "%PDF-1.7 tw0");
  const deliveries = [
    {
      destination: dest,
      kind: "folder",
      object: good,
      sha256: listed[0].sha256,
      status: "delivered",
    },
    {
      destination: dest,
      kind: "folder",
      object: bad,
      sha256: listed[1].sha256,
      status: "delivered",
    },
  ];
  const { r } = await runWith(out, { files: listed }, { deliveries });
  assert.equal(r.content[1].uri, pathToFileURL(good).href);
  assert.equal(r.content[2].uri, pathToFileURL(join(out, "reports", "other.pdf")).href);
});

test("deliverTo: on the run, not the plan, and in the digest", async () => {
  const { out, listed } = runFolder([["a.md", "x"]]);
  const dest = mkdtempSync(join(tmpdir(), "agentry-mcp-dest-"));
  const { argvFile } = await runWith(out, { files: listed }, { args: { deliverTo: dest } });
  const runs = receivedArgv(argvFile).filter((a) => a[0] === "run");
  const plan = runs.at(-2);
  const run = runs.at(-1);
  assert.ok(plan.includes("--plan") && !plan.includes("--deliver-to"));
  assert.equal(run[run.indexOf("--deliver-to") + 1], dest);

  const { client } = await connect({ FAKE_RUN_OUT: out });
  const p = JSON.parse(
    (
      await client.callTool({
        name: "agentry_run",
        arguments: { ref: "acme/widget", deliverTo: dest },
      })
    ).content[0].text,
  );
  const elsewhere = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", deliverTo: `${dest}-elsewhere`, confirm: p.digest },
  });
  assert.equal(elsewhere.isError, true);
  assert.match(elsewhere.content[0].text, /digest does not match/);
});

test("a CLI without --deliver-to: deliverTo is refused naming the update, before any CLI call; a run without it still works", async () => {
  const { client, argvFile } = await connect({}, {}, undefined, { deliverTo: false });
  const r = await client.callTool({
    name: "agentry_run",
    arguments: { ref: "acme/widget", deliverTo: "/tmp/somewhere" },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no run --deliver-to; update the CLI/);
  assert.deepEqual(receivedArgv(argvFile), []);
  const p = await client.callTool({ name: "agentry_run", arguments: { ref: "acme/widget" } });
  assert.equal(p.isError, undefined, p.content[0].text);
});

test("a run that lists no deliverables returns the envelope alone", async () => {
  const { client } = await connect();
  const call = { ref: "acme/widget" };
  const { digest } = JSON.parse(
    (await client.callTool({ name: "agentry_run", arguments: call })).content[0].text,
  );
  const r = await client.callTool({ name: "agentry_run", arguments: { ...call, confirm: digest } });
  assert.equal(r.content.length, 1);
  assert.equal(JSON.parse(r.content[0].text).deliverables, undefined);
});

test("a text file that is not UTF-8 is linked, saying so; a reports folder reached through a link is withheld", async () => {
  const { out, listed } = runFolder([["notes.txt", Buffer.from([0xff, 0xfe, 0x41])]]);
  const elsewhere = mkdtempSync(join(tmpdir(), "agentry-mcp-elsewhere-"));
  writeFileSync(join(elsewhere, "x.md"), "behind a linked folder");
  symlinkSync(elsewhere, join(out, "reports", "sub"));
  const viaLink = {
    path: "reports/sub/x.md",
    title: "x",
    sha256: sha(Buffer.from("behind a linked folder")),
    bytes: 22,
    type: "md",
    marked: true,
  };
  const { r, env } = await runWith(out, { files: [listed[0], viaLink] });
  assert.equal(env.deliverables[0].returned, "link");
  assert.equal(env.deliverables[0].reason, "not UTF-8 text");
  assert.equal(env.deliverables[1].returned, "withheld");
  assert.match(env.deliverables[1].reason, /link/);
  assert.doesNotMatch(JSON.stringify(r.content), /behind a linked folder/);
});

test("a malformed deliveries block never turns a finished run into an error", async () => {
  const { out, listed } = runFolder([["a.md", "fine"]]);
  const { r, env } = await runWith(
    out,
    { files: listed },
    { deliveries: [null, 3, { kind: "folder" }] },
  );
  assert.equal(env.exitClass, "ok");
  assert.equal(r.content[1].resource.text, "fine");
});

test("the person is asked about the folder a run copies its deliverables to", async () => {
  const { out } = runFolder([["a.md", "x"]]);
  const { client, elicitations } = await connect({ FAKE_RUN_OUT: out }, {}, "accept");
  const call = { ref: "acme/widget", deliverTo: "/home/me/Documents/Agentry" };
  const { digest } = JSON.parse(
    (await client.callTool({ name: "agentry_run", arguments: call })).content[0].text,
  );
  await client.callTool({ name: "agentry_run", arguments: { ...call, confirm: digest } });
  assert.match(elicitations[0], /Copies its deliverables to \/home\/me\/Documents\/Agentry/);
});
