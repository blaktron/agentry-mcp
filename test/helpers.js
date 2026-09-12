// Shared test wiring: a server driving the fake CLI over an in-memory
// transport, and a scratch argv file to read back what the CLI received.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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

/**
 * connect wires a server driving the fake CLI to an in-memory client.
 * `elicit` — when set, the client advertises elicitation and answers every
 * request with it: "accept" | "decline" | "cancel"; the answers are recorded.
 */
export async function connect(env = {}, cli = {}, elicit) {
  const argvFile = scratchArgv();
  const server = createServer({
    bin: FAKE,
    cliVersion: "0.4.0",
    cli: { env: { FAKE_ARGV: argvFile, ...env }, timeoutMs: 10_000, ...cli },
    runTimeoutSlackMs: 500,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const elicitations = [];
  const client = new Client(
    { name: "test", version: "0" },
    elicit ? { capabilities: { elicitation: {} } } : {},
  );
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicitations.push(req.params.message);
      if (elicit === "accept") return { action: "accept", content: { proceed: true } };
      if (elicit === "accept-unticked") return { action: "accept", content: { proceed: false } };
      return { action: elicit };
    });
  }
  await client.connect(b);
  return { client, server, argvFile, elicitations };
}

export function envelope(result) {
  const text = result.content?.[0]?.text ?? "";
  return { text, json: result.isError ? undefined : JSON.parse(text) };
}
