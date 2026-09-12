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

## Reading

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

## Installing, in two calls

| Tool                     | Runs                                                                 | Returns                                                           |
| ------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `agentry_install`        | `agentry install --plan --json`, then `agentry install --json --yes` | the preview with a `digest`, then the install result              |
| `agentry_uninstall`      | `agentry uninstall --plan --json`, then `agentry uninstall --json`   | the preview with a `digest`, then what was removed                |
| `agentry_list_installed` | `agentry list --json`                                                | every install record, with `present` (its directory still exists) |

The CLI asks you on a terminal before it installs. This server has no
terminal, and the model is not you. So installing is two calls:

1. **Preview.** `agentry_install` without `confirm` runs the CLI's plan mode
   and writes nothing. It returns what consent would cover — the resolved
   version, the capability contract, the diff against what this machine
   accepted before, whether the release is signed, the refusal an install
   would meet, where it would go — plus `digest`: an HMAC-SHA-256, under a
   key only this server process holds, over exactly those facts. The model
   is told to show you the contract.
2. **Confirm.** The same call with `confirm` set to that digest. The server
   runs the preview again, refuses if anything changed (the version, the
   contract, the signature, the directory), and only then runs the install
   with `--yes`. An unsigned release needs `acceptUnsigned: true` on the
   confirm as well, which the model is told to pass only if you said so.

The digest is the control, not the instruction: a model cannot confirm what
the server did not show it — it cannot mint a digest from the facts, since
the key is the server's — and `--yes` reaches the CLI from no other path (CI
greps for it). The install names the release the preview resolved, never a
floating range. When your host supports MCP elicitation, the server also
asks you directly before the write, and a "no" cancels. Removing is the
same two calls.

## Running

| Tool               | Runs                                                                                             | Returns                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `agentry_setup`    | `agentry setup --json` (with or without the image pulls)                                         | the policy as configured — provider, model, the key's variable **name** — and whether the images are ready        |
| `agentry_run`      | `agentry run --plan --json`, then `agentry run --mode autonomous --output-format json` consented | the run plan with a `digest`, then the CLI's result envelope with `receiptsDir`, `resultFile`, `outDir` beside it |
| `agentry_validate` | `agentry validate DIR --json`                                                                    | the rules and scan findings as data, and whether publish would pass                                               |

A run is the same two calls as an install. The preview is the CLI's run
plan (`run --plan --json`, agentry-cli#124): the compiled plan — the release
that resolved, the capabilities and enforcement a run would apply, the tools
it would be served, the gateway and proxy shape, the budgets — which is
exactly what the run enforces, with the attestation verdict and the refusal
a run would meet. The CLI asks nothing and records nothing for it, and the
server lifts nothing: the preview carries no consent flag. The digest is
over the whole plan plus what the call itself brings to the run — the intake
answers, the files and the input file, where the output lands, the budget —
so a policy, an image, a budget or an answer that changed between the two
calls changes the digest; the task input as text is not in it, since it
changes nothing about what the run may reach. The
confirm re-plans, asks you when the host can, and runs the release the
preview resolved. The runner's isolation and receipts are the CLI's,
untouched: the server invokes `agentry run` as you would from a terminal,
and the result names the receipts directory, which is the record of what
was enforced; its `runPlanSha256` is the preview's `planSha256`.

`setup` carries no consent flag either: the server gives the CLI no
terminal, and setup without one fills every gap from its provider table
instead of asking.

`input` text is written to a temp file the server removes after the run;
`inputFile` passes a path you already have; `intake` answers the
BriefAgent's questions by id, and a required one left unanswered is an
error from the run naming it. A run stops at `timeoutSeconds`, or at the
runner policy's own budget when the call names none (the preview shows
which): the CLI ends it, and if the process is still there 30 s later the
server sends SIGINT, on which the CLI tears down and writes its envelope
(`error: interrupted`, class `cli`) — the result comes back with
`timedOut: true` beside it. A CLI that has not exited 60 s after that is
killed, and the error says so and that its teardown may not have run. Progress — the CLI's
own narration — streams as MCP progress notifications when the host asks
for them, and the last lines come back as `log`. A local workspace
(`local`) has attestation `local` and needs `acceptUnsigned` on the
confirm, like an unsigned release; a verdict the person cannot lift
(`mismatch`, `unverifiable`) stops the confirm.

## Sessions

| Tool                    | Runs                                                                                                      | Returns                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `agentry_session_start` | `agentry run --plan --json --mode interactive`, then `agentry run --mode interactive` consented, on a pty | the plan with a `digest`, then the session id, the output folder and the receipts directory     |
| `agentry_session_send`  | one line typed into the chat                                                                              | the agent's reply as the events receipt recorded it, the tools it called, the usage             |
| `agentry_session_close` | `/finish` (or `/quit`) typed into the chat, then the CLI's teardown                                       | why the session ended, the envelope's status and result, the transcript, the receipts directory |

An interactive run is the CLI's own chat: it insists on a terminal (the chat
is the input) and has no JSON form (the transcript and receipts are the
record). So the server gives it a terminal — `dist/pty-host.py`, a small
Python program that forks the CLI on a pseudo-terminal and pumps bytes both
ways, no shell in between; `python3` must be on the path — and drives it as
you would: a line, Enter, the reply. The start is the run's two calls with
the interactive plan. The reply to each turn is read from the run's own
events receipt (`receipts/events.ndjson`), which the engine appends to as
the session goes and redacts as it does — `assistant_turn` closes a turn,
`session_end` says why the session is over — not scraped off the screen: the
chat is a full-screen redraw, and the receipt is the record anyway.
Everything the terminal showed is kept raw in a `.pty.log` beside the output
folder; when the CLI stops before the session starts, its last lines,
control sequences stripped, are what the error quotes.

One session per server at a time; a second start is refused naming the open
one. A turn waits up to `turnTimeoutSeconds` (default 300) and past that the
session stays open; a host that caps a tool call lower (the MCP SDK's own
default is 60 s) needs `turnTimeoutSeconds` under its cap, or the host gives
up on a turn the session is still answering. The release's idle timeout and budgets end a session as
they would in a terminal, and the next send reports it, with the reason;
close then returns the record. Text is one line — the chat's own commands
(`/finish`, `/quit`, `/add`, `/caps`) are not turns. When the server is told
to stop with an open session, the CLI gets the interrupt it handles, so the
teardown, the envelope and the receipts are written.

Not here, on purpose: **signing in** (`agentry login` once in a terminal; the
server uses that login) and **publishing** (`agentry publish` in a terminal,
where the person sees the pipeline's verdict).

## Install

```sh
npm install
npm run build
claude mcp add agentry -- node /path/to/agentry-mcp/dist/index.js
```

The server finds the CLI through `AGENTRY_BIN`, else `agentry` on `PATH`,
runs `agentry --version` once at start, and refuses to start without a CLI
at or above `MIN_CLI_VERSION` (`src/cli.ts`) that has `install --plan` and
`run --plan` (agentry-cli#123 and #124 or newer; the CLI has no release tag
for them yet, so the floor is nominal and the plan modes are probed
directly). A dev build of the
CLI reports a git describe rather than a version; it is accepted and the
start-up line says the floor was not checked.

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
