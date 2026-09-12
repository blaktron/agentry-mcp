# agentry-mcp

An MCP server that drives the **`agentry` CLI you already have**, so Claude
Code, Codex or any MCP host can search a registry, read a BriefAgent's
capability contract, verify a release and check the machine — and, in later
versions, install, run and manage BriefAgents — through tools whose results
are the CLI's own JSON.

Local stdio server, TypeScript, on the official
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).
It bundles nothing: the CLI is the person's, with the person's login, consent
memory and runner policy. Plan: `agentry-notes/plans/mcp-cli-driver.md`.

## What it exposes today

| Tool             | Runs                    | Returns                                                                                                                  |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `agentry_search` | `agentry search --json` | results, facets, total                                                                                                   |
| `agentry_info`   | `agentry info --json`   | the agent, its latest published version, the capability contract, whether it carries an attestation (signed or unsigned) |
| `agentry_verify` | `agentry verify --json` | the digest match and the attestation's verdict                                                                           |
| `agentry_doctor` | `agentry doctor --json` | machine readiness: policy, provider key **name**, docker, images, exec catalog                                           |

Every tool is one CLI invocation with an argv built from typed arguments —
never a shell string, and a value that looks like a flag is refused. The
result is the CLI's JSON in an envelope:

```json
{
  "result": { "…": "the CLI's own output" },
  "exitClass": "ok",
  "log": "the CLI's last stderr lines"
}
```

`exitClass` is the CLI's §R8 class (`ok`, `usage`, `verify`, `policy`,
`compile`, `gateway`, `harness`, `timeout`, `budget`, `outputSchema`,
`cli`). When the CLI wrote JSON, the envelope comes back whatever the class —
`agentry doctor` writes its report and exits `cli` when a check fails, and
the report is the answer. When there is no JSON, a non-zero exit is an MCP
tool error naming the class and quoting the CLI's last lines; a zero exit
without JSON is an error too. The server never reads the CLI's prose.

Not here, on purpose: **signing in** (`agentry login` once in a terminal; the
server uses that login) and **publishing** (`agentry publish` in a terminal,
where the person sees the pipeline's verdict). Installing, running and
managing BriefAgents arrive in the next versions, each behind the CLI's own
consent — a preview call that shows the contract and a confirm call that
carries the digest of what was shown.

## Install

```sh
npm install
npm run build
claude mcp add agentry -- node /path/to/agentry-mcp/dist/index.js
```

The server finds the CLI through `AGENTRY_BIN`, else `agentry` on `PATH`,
runs `agentry --version` once at start, and refuses to start without a CLI
at or above `MIN_CLI_VERSION` (`src/cli.ts`; nominal at `0.0.0` until the
install tools need newer output). A dev build of the CLI reports a git
describe rather than a version; it is accepted and the start-up line says
the floor was not checked.

## What the server holds

No credential. The registry token stays in the CLI's config, the model
provider's key in the runner policy; the server's environment carries
neither and no tool result does — `agentry doctor` prints key **names**
only.

## Honest posture

The registry reports each release as scanned, with a finding count, and
signed or unsigned — never as safe. The tool descriptions and the
instructions say the same; `npm run prose-check` refuses a never-word in
any string literal under `src/` or in this README.

## Development

```sh
npm run check     # typecheck, prettier, prose gate, tests (a fake agentry on stdin/stdout)
```

`secureagentry-mcp/` is the registry-API server this repository shipped
before 2026-09-12, parked as it was: its own `package.json`, its own
`npm run check`, its CI job kept. See its README.
