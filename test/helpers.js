// Shared test wiring: a server driving the fake CLI over an in-memory
// transport, and a scratch argv file to read back what the CLI received.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../dist/server.js";

export const FAKE = new URL("./fake-agentry.sh", import.meta.url).pathname;

export function scratchArgv() {
  return join(mkdtempSync(join(tmpdir(), "agentry-mcp-")), "argv");
}

/** Every argv the fake received, as arrays. */
export function receivedArgv(path) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("--\n")
    .filter((s) => s.length)
    .map((s) => s.trimEnd().split("\n"));
}

export async function connect(env = {}, cli = {}) {
  const argvFile = scratchArgv();
  const server = createServer({
    bin: FAKE,
    cliVersion: "0.4.0",
    cli: { env: { FAKE_ARGV: argvFile, ...env }, timeoutMs: 10_000, ...cli },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { client, server, argvFile };
}

export function envelope(result) {
  const text = result.content?.[0]?.text ?? "";
  return { text, json: result.isError ? undefined : JSON.parse(text) };
}
