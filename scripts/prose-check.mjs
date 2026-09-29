#!/usr/bin/env node
// The prose gate (plan mcp-cli-driver §3, the honest-posture invariant):
// no never-word of scripts/prose/never.txt appears in a string literal of
// src/**/*.ts or in the README outside an allowlisted phrase. Tool
// descriptions and the instructions block are what a host's model reads
// before it acts, so this is where "safe" would do the most damage.
//
//   node scripts/prose-check.mjs              run the gate
//   node scripts/prose-check.mjs --self-test  prove it fails when it should
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function lines(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
const NEVER = lines(join(ROOT, "scripts/prose/never.txt"));
const ALLOW = lines(join(ROOT, "scripts/prose/allow.txt"));

function tsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// String literals only: a comment may name the rule; a literal reaches a host.
const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

function literalsOf(source) {
  return [...source.matchAll(LITERAL)].map((m) => m[0].slice(1, -1));
}

function maskAllowed(text) {
  let t = text;
  for (const phrase of ALLOW) t = t.split(phrase).join(" ".repeat(phrase.length));
  // A quoted mention on one line ("safe") is a mention, not a claim.
  return t.replace(/"[^"\n]{1,40}"/g, (m) => " ".repeat(m.length));
}

function wordRe(word) {
  const w = word
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+")
    .replace(/'/g, "['’]");
  return new RegExp(`(?<![A-Za-z0-9_])${w}(?![A-Za-z0-9_])`, "i");
}
const NEVER_RES = NEVER.map((w) => [w, wordRe(w)]);

function scan(label, text) {
  const hits = [];
  const masked = maskAllowed(text);
  for (const [word, re] of NEVER_RES) {
    const m = re.exec(masked);
    if (m)
      hits.push(
        `${label}: never-word "${word}" at ${JSON.stringify(masked.slice(Math.max(0, m.index - 30), m.index + 40))}`,
      );
  }
  return hits;
}

function run(root) {
  const hits = [];
  for (const f of tsFiles(join(root, "src"))) {
    const rel = f.slice(root.length);
    literalsOf(readFileSync(f, "utf8")).forEach((lit, i) =>
      hits.push(...scan(`${rel} literal ${i + 1}`, lit)),
    );
  }
  const readme = readFileSync(join(root, "README.md"), "utf8")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  hits.push(...scan("README.md", readme));
  return hits;
}

if (process.argv.includes("--self-test")) {
  const scanSource = (src) => literalsOf(src).flatMap((lit) => scan("fixture", lit));
  const bad = scanSource('const d = "This QuickAgent is safe to run";');
  const ok = scanSource('const d = "scanned, 0 findings, signed — never as safe";');
  if (bad.length !== 1 || ok.length !== 0) {
    console.error("self-test failed", { bad, ok });
    process.exit(1);
  }
  console.log("prose-check self-test ok");
  process.exit(0);
}

const hits = run(ROOT);
if (hits.length) {
  console.error("PROSE CHECK FAILED");
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
console.log(
  `PROSE CHECK PASSED (${NEVER.length} never-words over src/**/*.ts literals and README.md)`,
);
