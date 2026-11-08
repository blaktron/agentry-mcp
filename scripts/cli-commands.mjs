#!/usr/bin/env node
// The CLI's command tree, read from its help: every command path a person
// can type, one per line, after a line naming the CLI version it was read
// from. The tree is written to spec/cli-commands.txt, which the parity test
// (test/commands.test.js) holds against src/commands.ts. Read it again from
// the CLI the server is released with:
//
//   node scripts/cli-commands.mjs [path/to/agentry]           write the file
//   node scripts/cli-commands.mjs [path/to/agentry] --check   fail when it differs
//
// Only the sections after a help's "Usage:" list commands; hidden commands
// are not listed there, and help and completion are cobra's own.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("../spec/cli-commands.txt", import.meta.url);
const args = process.argv.slice(2);
const check = args.includes("--check");
const bin = args.find((a) => a !== "--check") ?? "agentry";
const NOT_LISTS = new Set(["Usage:", "Flags:", "Global Flags:", "Examples:", "Aliases:"]);

function help(path) {
  try {
    return execFileSync(bin, [...path, "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return err.stdout ?? "";
  }
}

/** The subcommands a command's help lists. */
export function subcommands(text) {
  const names = [];
  let afterUsage = false;
  let inList = false;
  for (const line of text.split("\n")) {
    if (line === "Usage:") afterUsage = true;
    if (!afterUsage || line.trim() === "") continue;
    if (/^\S.*:$/.test(line)) {
      inList = !NOT_LISTS.has(line.trim());
      continue;
    }
    const m = /^ {2}([a-z][a-z0-9-]*) +\S/.exec(line);
    if (inList && m) names.push(m[1]);
    else if (!/^\s/.test(line)) inList = false;
  }
  return names.filter((n) => n !== "help" && n !== "completion");
}

function walk(path, out) {
  if (path.length) out.push(path.join(" "));
  for (const name of subcommands(help(path))) walk([...path, name], out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).split("\n")[0].trim();
  const tree = [];
  walk([], tree);
  const text = `# ${version}\n${tree.sort().join("\n")}\n`;
  if (check) {
    const old = readFileSync(OUT, "utf8").split("\n").slice(1).join("\n");
    if (old !== text.split("\n").slice(1).join("\n")) {
      process.stderr.write(
        "spec/cli-commands.txt differs from this CLI's command tree: run scripts/cli-commands.mjs and update src/commands.ts\n",
      );
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, text);
  }
}
