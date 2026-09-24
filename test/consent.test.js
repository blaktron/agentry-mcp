// The two-call consent (plan §5, D4) over the fake CLI: a preview writes
// nothing and returns a digest; a confirm with the right digest runs the
// write with --yes; a stale, wrong or missing digest is refused with a
// message that says to preview again; --allow-unsigned reaches argv only
// with unsigned in the preview and acceptUnsigned in the call, and
// --allow-unscanned only with unscanned and acceptUnscanned; elicitation
// asks the person when the host has it, and a "no" cancels.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { canonical, consentDigest } from "../dist/consent.js";
import { connect, receivedArgv, scratchArgv } from "./helpers.js";

const CONTRACT = { filesystem: { read: "workspace" } };

function writesFile() {
  return join(scratchArgv() + "-writes");
}

async function preview(client, extra = {}) {
  const r = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", ...extra },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
}

test("canonical JSON sorts keys at every level; the digest is over it, under a key only this process holds", () => {
  assert.equal(
    canonical({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }),
    '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
  );
  assert.equal(consentDigest({ a: 1, b: 2 }), consentDigest({ b: 2, a: 1 }));
  assert.notEqual(consentDigest({ a: 1 }), consentDigest({ a: 2 }));
  // A plain sha256 of the same facts is not the digest: a model that
  // assembles the facts from the read tools cannot mint one.
  const plain =
    "sha256:" +
    createHash("sha256")
      .update(canonical({ a: 1, b: 2 }))
      .digest("hex");
  assert.notEqual(consentDigest({ a: 1, b: 2 }), plain);
});

test("preview: the CLI's plan, a digest, writes nothing, no --yes", async () => {
  const writes = writesFile();
  const { client, argvFile } = await connect({ FAKE_WRITES: writes });
  const p = await preview(client);
  assert.equal(p.writes, false);
  assert.deepEqual(p.plan.contract, CONTRACT);
  assert.equal(p.plan.attestation, "verified");
  assert.equal(p.unsigned, false);
  assert.match(p.digest, /^sha256:[0-9a-f]{64}$/);
  const argv = receivedArgv(argvFile);
  assert.equal(argv.length, 1);
  assert.deepEqual(argv[0], ["install", "acme/widget", "--plan", "--json"]);
  assert.equal(existsSync(writes), false, "the preview must not write");
});

test("confirm with the preview's digest re-plans, then installs with --yes and no --allow-unsigned", async () => {
  const writes = writesFile();
  const { client, argvFile } = await connect({ FAKE_WRITES: writes });
  const p = await preview(client, { provider: "claude" });
  const r = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", provider: "claude", confirm: p.digest },
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const env = JSON.parse(r.content[0].text);
  assert.equal(env.exitClass, "ok");
  assert.equal(env.result.recorded, true);
  const argv = receivedArgv(argvFile);
  assert.deepEqual(
    argv[1],
    ["install", "acme/widget", "--plan", "--json", "--provider", "claude"],
    "the confirm re-runs the plan first",
  );
  assert.deepEqual(
    argv[2],
    ["install", "acme/widget@1.0.0", "--json", "--provider", "claude", "--yes"],
    "the write names the resolved release",
  );
  assert.equal(readFileSync(writes, "utf8"), "written\n");
});

test("a wrong digest, a stale digest (the contract moved) and a made-up digest are refused, and nothing is written", async () => {
  const writes = writesFile();
  const { client, argvFile } = await connect({ FAKE_WRITES: writes });
  const p = await preview(client);
  const wrong = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: "sha256:" + "0".repeat(64) },
  });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /does not match this preview/);
  assert.match(wrong.content[0].text, /Preview again/);

  // The release moved between the two calls: a different contract now.
  const moved = await connect({
    FAKE_WRITES: writes,
    FAKE_CONTRACT: JSON.stringify({ network: { egress: ["api.example.com"] } }),
  });
  const stale = await moved.client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: p.digest },
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /does not match this preview/);

  const madeUp = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: "yes please" },
  });
  assert.equal(madeUp.isError, true);
  assert.equal(existsSync(writes), false, "nothing was written by any refused confirm");
  for (const a of receivedArgv(argvFile))
    assert.ok(!a.includes("--yes"), `--yes reached the CLI: ${a}`);
});

test("--allow-unsigned reaches argv only with unsigned in the preview and acceptUnsigned in the call", async () => {
  const writes = writesFile();
  const { client, argvFile } = await connect({ FAKE_WRITES: writes, FAKE_ATTEST: "unsigned" });
  const p = await preview(client);
  assert.equal(p.unsigned, true);
  assert.match(p.plan.refusal, /--allow-unsigned/);
  const without = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: p.digest },
  });
  assert.equal(without.isError, true);
  assert.match(without.content[0].text, /acceptUnsigned: true/);
  assert.equal(existsSync(writes), false);
  const withIt = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: p.digest, acceptUnsigned: true },
  });
  assert.equal(withIt.isError, undefined, withIt.content[0].text);
  const argv = receivedArgv(argvFile);
  assert.deepEqual(argv.at(-1), [
    "install",
    "acme/widget@1.0.0",
    "--json",
    "--yes",
    "--allow-unsigned",
  ]);

  // A signed release never gets --allow-unsigned, whatever the call says.
  const signed = await connect({ FAKE_WRITES: writesFile() });
  const sp = await preview(signed.client);
  await signed.client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: sp.digest, acceptUnsigned: true },
  });
  for (const a of receivedArgv(signed.argvFile))
    assert.ok(!a.includes("--allow-unsigned"), `--allow-unsigned leaked: ${a}`);
});

test("unscanned is its own consent: the preview says so, acceptUnsigned does not lift it, acceptUnscanned adds --allow-unscanned alone", async () => {
  const writes = writesFile();
  const { client, argvFile } = await connect({ FAKE_WRITES: writes, FAKE_ATTEST: "unscanned" });
  const p = await preview(client);
  assert.equal(p.unscanned, true);
  assert.equal(p.unsigned, false);
  assert.equal(p.plan.attestation, "unscanned");
  assert.match(p.plan.refusal, /--allow-unscanned/);

  const without = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: p.digest },
  });
  assert.equal(without.isError, true);
  assert.match(without.content[0].text, /unscanned/);
  assert.match(without.content[0].text, /acceptUnscanned: true/);

  // The wrong acceptance: unsigned's word does not cover unscanned.
  const wrongWord = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: p.digest, acceptUnsigned: true },
  });
  assert.equal(wrongWord.isError, true);
  assert.match(wrongWord.content[0].text, /acceptUnsigned does not cover it/);
  assert.equal(existsSync(writes), false, "no refused confirm wrote");

  const withIt = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: p.digest, acceptUnscanned: true },
  });
  assert.equal(withIt.isError, undefined, withIt.content[0].text);
  assert.deepEqual(receivedArgv(argvFile).at(-1), [
    "install",
    "acme/widget@1.0.0",
    "--json",
    "--yes",
    "--allow-unscanned",
  ]);
  assert.equal(readFileSync(writes, "utf8"), "written\n");

  // Unscanned's word does not lift unsigned either.
  const unsignedOnly = await connect({ FAKE_WRITES: writesFile(), FAKE_ATTEST: "unsigned" });
  const up = await preview(unsignedOnly.client);
  const crossed = await unsignedOnly.client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: up.digest, acceptUnscanned: true },
  });
  assert.equal(crossed.isError, true);
  assert.match(crossed.content[0].text, /acceptUnsigned: true/);

  // A signed or an unsigned release never gets --allow-unscanned, whatever the call says.
  for (const attest of ["verified", "unsigned"]) {
    const other = await connect({ FAKE_WRITES: writesFile(), FAKE_ATTEST: attest });
    const op = await preview(other.client);
    assert.equal(op.unscanned, false);
    await other.client.callTool({
      name: "agentry_install",
      arguments: {
        ref: "acme/widget",
        confirm: op.digest,
        acceptUnsigned: true,
        acceptUnscanned: true,
      },
    });
    for (const a of receivedArgv(other.argvFile))
      assert.ok(!a.includes("--allow-unscanned"), `${attest}: --allow-unscanned leaked: ${a}`);
  }
});

test("a refusal the person cannot lift (an attestation mismatch) is refused at confirm too", async () => {
  const writes = writesFile();
  const { client } = await connect({
    FAKE_WRITES: writes,
    FAKE_ATTEST: "mismatch",
    FAKE_REFUSAL:
      "attestation mismatch: no pinned key verifies this signature — refusing to install",
  });
  const p = await preview(client);
  const r = await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: p.digest, acceptUnsigned: true },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /would refuse this/);
  assert.equal(existsSync(writes), false);
});

test("elicitation: the host is asked when it can be; accept installs, decline and cancel do not", async () => {
  for (const [answer, installs] of [
    ["accept", true],
    ["decline", false],
    ["cancel", false],
    ["accept-unticked", false],
  ]) {
    const writes = writesFile();
    const { client, elicitations } = await connect({ FAKE_WRITES: writes }, {}, answer);
    const p = await preview(client);
    assert.equal(elicitations.length, 0, "the preview asks nobody");
    const r = await client.callTool({
      name: "agentry_install",
      arguments: { ref: "acme/widget", confirm: p.digest },
    });
    assert.equal(elicitations.length, 1, `${answer}: the confirm asks the person once`);
    assert.match(
      elicitations[0],
      /Install acme\/widget@1\.0\.0 to \/home\/me\/\.claude\/skills\/widget/,
    );
    assert.match(elicitations[0], /"read":"workspace"/);
    assert.equal(existsSync(writes), installs, `${answer}: written=${existsSync(writes)}`);
    if (!installs) assert.match(r.content[0].text, /declined; nothing was done/);
  }
  // A host without elicitation gets the two-call shape alone.
  const writes = writesFile();
  const { client, elicitations } = await connect({ FAKE_WRITES: writes });
  const p = await preview(client);
  await client.callTool({
    name: "agentry_install",
    arguments: { ref: "acme/widget", confirm: p.digest },
  });
  assert.equal(elicitations.length, 0);
  assert.equal(existsSync(writes), true);
});

test("uninstall: preview names what would go and removes nothing; confirm removes; a stale digest is refused", async () => {
  const writes = writesFile();
  const { client, argvFile, elicitations } = await connect({ FAKE_WRITES: writes }, {}, "accept");
  const r = await client.callTool({ name: "agentry_uninstall", arguments: { ref: "acme/widget" } });
  const p = JSON.parse(r.content[0].text);
  assert.equal(p.writes, false);
  assert.equal(p.plan.installs.length, 1);
  assert.equal(existsSync(writes), false);
  const bad = await client.callTool({
    name: "agentry_uninstall",
    arguments: { ref: "acme/widget", confirm: "sha256:nope" },
  });
  assert.equal(bad.isError, true);
  // A digest from a preview of a different removal (keepMcp changes what
  // goes) is stale for this one.
  const kept = JSON.parse(
    (
      await client.callTool({
        name: "agentry_uninstall",
        arguments: { ref: "acme/widget", keepMcp: true },
      })
    ).content[0].text,
  );
  assert.notEqual(kept.digest, p.digest);
  const stale = await client.callTool({
    name: "agentry_uninstall",
    arguments: { ref: "acme/widget", confirm: kept.digest },
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /Preview again/);
  assert.equal(existsSync(writes), false);
  const ok = await client.callTool({
    name: "agentry_uninstall",
    arguments: { ref: "acme/widget", confirm: p.digest },
  });
  assert.equal(ok.isError, undefined, ok.content[0].text);
  assert.equal(readFileSync(writes, "utf8"), "removed\n");
  assert.equal(elicitations.length, 1);
  assert.match(elicitations[0], /Remove acme\/widget/);
  assert.deepEqual(receivedArgv(argvFile).at(-1), ["uninstall", "acme/widget", "--json"]);
});

test("list_installed passes list --json through; a gone directory carries present: false", async () => {
  const { client } = await connect();
  const r = await client.callTool({ name: "agentry_list_installed", arguments: {} });
  const env = JSON.parse(r.content[0].text);
  assert.equal(env.result.records.length, 2);
  assert.deepEqual(
    env.result.records.map((x) => x.present),
    [true, false],
  );
});

test("the writing tools are not read-only and tell the model to show the person the contract", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const install = tools.find((t) => t.name === "agentry_install");
  assert.equal(install.annotations.readOnlyHint, false);
  assert.match(install.description, /Show the person the contract/);
  assert.ok(tools.find((t) => t.name === "agentry_uninstall").annotations.destructiveHint);
});
