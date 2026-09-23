#!/usr/bin/env node
// The packaged server, started the way a person starts it (agentry-mcp#32):
// unpack the tarball into an empty directory, far from this checkout's
// node_modules, and run its dist/index.js.
//
//   node scripts/package-smoke.mjs TARBALL [--expect-version V]
//
// Three proofs. With no `agentry` on PATH and no AGENTRY_BIN the server
// refuses to start and says why — what a person who unpacked it before
// installing the CLI meets — and with AGENTRY_BIN pointing at nothing it
// refuses the same way. With the tests' fake CLI it answers an MCP
// initialize with its name and version and lists its tools, so the tarball
// carries every module it imports.
// --expect-version makes the release refuse a tarball whose server reports
// another version than the tag it is named for.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const tarball = args[0];
const expectAt = args.indexOf("--expect-version");
const expectVersion = expectAt >= 0 ? args[expectAt + 1] : undefined;
if (!tarball || (expectAt >= 0 && !expectVersion)) {
  console.error("usage: node scripts/package-smoke.mjs TARBALL [--expect-version V]");
  process.exit(2);
}

const fake = fileURLToPath(new URL("../test/fake-agentry.sh", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "agentry-mcp-smoke-"));
const fail = (msg) => {
  console.error(`package-smoke: ${msg}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
};

execFileSync("tar", ["-xzf", tarball, "-C", work]);
const dir = join(work, basename(tarball).replace(/\.tar\.gz$/, ""));
const entry = join(dir, "dist", "index.js");

// 1. No CLI: a non-zero exit and the sentence that names the missing binary.
function run(env, input, ms) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, ms);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (input) child.stdin.write(input);
  });
}

const none = await run({}, "", 10_000);
if (none.code === 0) fail("the server started with no agentry on PATH");
if (!/no `agentry` binary on PATH/.test(none.err))
  fail(`no CLI on PATH, but not the expected refusal: ${none.err.trim()}`);
console.log("ok: with no agentry on PATH it refuses to start and says why");

const missing = await run({ AGENTRY_BIN: join(work, "no-such-agentry") }, "", 10_000);
if (missing.code === 0) fail("the server started with AGENTRY_BIN pointing at nothing");
if (!/not an executable file/.test(missing.err))
  fail(`AGENTRY_BIN pointing at nothing, but not the expected refusal: ${missing.err.trim()}`);
console.log("ok: with AGENTRY_BIN pointing at nothing it refuses the same way");

// 2. The fake CLI: initialize, then tools/list, newline-delimited JSON-RPC.
const frames =
  [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "package-smoke", version: "0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]
    .map((f) => JSON.stringify(f))
    .join("\n") + "\n";
const live = await run({ AGENTRY_BIN: fake }, frames, 5_000);
const replies = live.out
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      fail(`a line on stdout is not an MCP frame: ${l}`);
    }
  });
const init = replies.find((r) => r.id === 1)?.result;
const tools = replies.find((r) => r.id === 2)?.result?.tools ?? [];
if (!init) fail(`no initialize result; stderr: ${live.err.trim()}`);
if (init.serverInfo?.name !== "agentry-mcp") fail(`serverInfo.name is ${init.serverInfo?.name}`);
if (expectVersion && init.serverInfo?.version !== expectVersion) {
  fail(`the server reports version ${init.serverInfo?.version}, the release is ${expectVersion}`);
}
if (!tools.some((t) => t.name === "agentry_search"))
  fail(`tools/list has no agentry_search (${tools.length} tools)`);
console.log(
  `ok: ${init.serverInfo.name} ${init.serverInfo.version} answers initialize and lists ${tools.length} tools`,
);

rmSync(work, { recursive: true, force: true });
