# agentry-mcp

An MCP server that drives the `agentry` CLI already installed on your
machine, so a coding agent (Claude Code, Codex or any MCP host) can search a
registry, read a QuickAgent's capability contract, verify a release, check the
machine, install and remove QuickAgents, run them and hold an interactive
session with one. Tool results are the CLI's own JSON. Anything that writes or
runs asks for the same consent the CLI asks for on a terminal.

It is a local stdio server written in TypeScript on the official
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).
It bundles no CLI: the login, consent memory and runner policy are the
CLI's.

## Prerequisites

- Node 20 or newer.
- The `agentry` CLI on the machine, found through `AGENTRY_BIN` or `PATH`
  (see the [CLI documentation](https://docs.secureagentry.net/runner/)). The
  server runs `agentry --version` at start and refuses to start below
  `MIN_CLI_VERSION` (`src/cli.ts`) or without `install --plan` and
  `run --plan`.
- Signing in (`agentry login`) is done once in a terminal; the server uses
  that login and never sees the token.

## Build, test and lint

```sh
npm ci
npm run build      # tsc into dist/
npm test           # builds, then runs the tests against a fake agentry CLI
npm run check      # typecheck, prettier, prose gate, tests
npm run format     # prettier --write
npm run workflows-check  # no fork-reachable workflow job on a self-hosted runner (python3 with PyYAML)
```

`scripts/package.sh <version> <out-dir>` builds the downloadable tarball and
`node scripts/package-smoke.mjs <tarball>` unpacks it and starts the server.
CI runs both on every pull request.

## Register it with a coding agent

The server is `dist/index.js`, from a source build or from an unpacked
`agentry-mcp-<version>.tar.gz`.

**Claude Code**

```sh
claude mcp add agentry -- node /path/to/agentry-mcp/dist/index.js
```

**Codex**

```sh
codex mcp add agentry -- node /path/to/agentry-mcp/dist/index.js
```

Either host can pass `AGENTRY_BIN` when the CLI is not on its `PATH`:

```sh
claude mcp add agentry -e AGENTRY_BIN=/path/to/agentry -- node /path/to/agentry-mcp/dist/index.js
codex mcp add agentry --env AGENTRY_BIN=/path/to/agentry -- node /path/to/agentry-mcp/dist/index.js
```

[SKILL.md](SKILL.md) is a skill for the host (copy it to
`~/.claude/skills/agentry/SKILL.md` or `~/.codex/skills/agentry/SKILL.md`)
that covers installation, registration, consent, runs, sessions, Knowledge,
Writing Voice and authoring.

## Tools

Read tools run one CLI command with an argv built from typed arguments, never
a shell string. The result is the CLI's JSON in an envelope with `exitClass`
and the CLI's last stderr lines as `log`.

| Tool                         | Runs                                | Returns                                                                                                                  |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `agentry_search`             | `agentry search --json`             | results, facets, total                                                                                                   |
| `agentry_info`               | `agentry info --json`               | the agent, its latest published version, the capability contract, whether it carries an attestation (signed or unsigned) |
| `agentry_verify`             | `agentry verify --json`             | the digest match and the attestation's verdict                                                                           |
| `agentry_whoami`             | `agentry whoami --json`             | signed-in account and tier                                                                                               |
| `agentry_builtins`           | `agentry builtins --json`           | embedded package refs and archive digests                                                                                |
| `agentry_knowledge_list`     | `agentry knowledge list --json`     | local packs or an organization's shared packs                                                                            |
| `agentry_voice_status`       | `agentry voice status --json`       | local and account Voice metadata and review                                                                              |
| `agentry_doctor`             | `agentry doctor --json`             | machine readiness: policy, provider key **name**, docker, images, exec catalog                                           |
| `agentry_schedule_list`      | `agentry schedule list --json`      | the schedules on this computer: repeat, next run, output folder, paused                                                  |
| `agentry_connections_list`   | `agentry connections list --json`   | the OAuth connections kept for QuickAgent versions' MCP servers, never a token                                           |
| `agentry_model_signins_list` | `agentry model-signins list --json` | the model sign-ins local runs can spend, never a token                                                                   |
| `agentry_report_design_show` | `agentry report-design show --json` | the report design a run's PDFs would take, and what chose it                                                             |
| `agentry_destinations_list`  | `agentry destinations list --json`  | the saved destinations (name, kind, host, on my network) and the QuickAgents each is a default for, never a secret       |

Writing and running tools take two calls. The first, without `confirm`, runs
the CLI's plan mode, writes nothing and returns what consent would cover plus
a `digest`: an HMAC-SHA-256, under a key only the server process holds, over
exactly those facts. The second carries that digest. The server plans again,
refuses if anything changed, and only then runs the command. `--yes`,
`--allow-unsigned` and `--allow-unscanned` reach the CLI from no other path
(CI checks this). An unsigned release needs `acceptUnsigned: true` on the
confirm, an unscanned one `acceptUnscanned: true`; other refusals stop the
confirm. When the host supports MCP elicitation, the server also asks the
person before the write.

| Tool                     | Runs                                                                 | Returns                                                           |
| ------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `agentry_install`        | `agentry install --plan --json`, then `agentry install --json --yes` | the preview with a `digest`, then the install result              |
| `agentry_uninstall`      | `agentry uninstall --plan --json`, then `agentry uninstall --json`   | the preview with a `digest`, then what was removed                |
| `agentry_list_installed` | `agentry list --json`                                                | every install record, with `present` (its directory still exists) |

| Tool               | Runs                                                                                             | Returns                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentry_setup`    | `agentry setup --json` (with or without the image pulls)                                         | the policy as configured — provider, model, the key's variable **name** — and whether the images are ready                                    |
| `agentry_run`      | `agentry run --plan --json`, then `agentry run --mode autonomous --output-format json` consented | the run plan with a `digest`, then the CLI's result envelope with `receiptsDir`, `resultFile`, `outDir` beside it, and the run's deliverables |
| `agentry_deliver`  | `agentry deliver RUN-FOLDER --json` consented                                                    | a preview of the run's deliverables, the folder and the destinations with a `digest`, then the CLI's deliveries                               |
| `agentry_validate` | `agentry validate DIR --json`                                                                    | the rules and scan findings as data, and whether publish would pass                                                                           |

A run's preview is the CLI's compiled run plan with the attestation verdict
and every refusal a run would meet. A run stops at `timeoutSeconds`, or at the
runner policy's own budget when the call names none: the CLI ends it, the
server sends SIGINT 30 s later if the process is still there, and kills it
60 s after that. Progress streams as MCP progress notifications when the
host asks for them.

A run's deliverables, the files it was for, come back after the envelope.
Text ones (Markdown, plain text, CSV, JSON, YAML, XML, HTML) are embedded
resources, up to 256 KiB each and 1 MiB in all. Every other one is a resource
link: to the copy the run delivered with `deliverTo` (or the CLI's
`deliver.folder` setting) when that copy still matches, else to the file in the
run folder. Each file is read through no link and must match the size and
SHA-256 the runner listed before it is inlined or linked; one that does not is
withheld. A link names the file as it was when the server checked it; the
envelope carries each file's SHA-256 for a reader that opens it later. The
envelope's `deliverables` says what came of each file, and why
one was linked rather than inlined, or withheld. `deliverTo` needs a CLI with
`run --deliver-to`.

The run preview's `delivery` says where the run sends its result: the folder,
and the saved destinations, the call's `destinations` or else the default set
the person saved for that QuickAgent (`noDestination` sends to none). The
default set is in the digest, so one changed between the preview and the
confirm refuses the confirm. `reportTheme` picks a built-in theme for the
run's PDFs. An input source's token and a target host's password, passphrase
or sudo password are passed as the **name** of an environment variable
(`intakeTokens`, `hostPasswords`, `hostPassphrases`, `hostSudoPasswords`) and
a host key as a file path (`hostKeys`); otherwise the CLI uses what the
person saved in the system keychain. The preview's `signIns` and the
question put to the person name each variable and the source or host it
signs in to, since its value goes there. A session's preview names its
destinations too: a session delivers at its end. The destination list shows a
destination's host, never its path or secret, so one saved again under the
same name and host reads as the same destination. `agentry_deliver` sends a run already
made to a folder or to saved destinations again, behind the same two calls.

Interactive sessions launch `agentry run --mode interactive
--session-protocol --output-format json`, with JSON-line commands on stdin
and an event pipe on descriptor 3. One session runs at a time. Windows uses
the terminal CLI because the pipe protocol is unavailable there.

| Tool                    | Runs                                                                                                                       | Returns                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `agentry_session_start` | `agentry run --plan --json --mode interactive`, then `agentry run --mode interactive` consented, over the session protocol | the plan with a `digest`, then the session id, the output folder and the receipts directory     |
| `agentry_session_send`  | a JSON send command to the open chat session                                                                               | the agent's reply as the events receipt recorded it, the tools it called, the usage             |
| `agentry_session_add`   | a consented JSON add command to the open chat session                                                                      | staged file submission; collect its notice or refusal with send                                 |
| `agentry_session_close` | a JSON end command to the open chat session, then the CLI's teardown                                                       | why the session ended, the envelope's status and result, the transcript, the receipts directory |

Persistent agents run in the background once started and keep their
conversation from one start to the next: the Assistant and the Coding agent.
Main runs only in Agentry Desktop. A start that would give the agent something
the person has not agreed to on this computer, and every roster switch, are
two calls like an install: the preview lists each consent sentence with a
`digest`, and the confirm re-reads them and refuses any change. A send is one
`agentry agent attach --json` process that leaves the agent running; another
chat's turn in flight makes it busy. Windows uses `agentry agent chat` in a
terminal because the pipe protocol is unavailable there.

| Tool                  | Runs                                                                                 | Returns                                                                  |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `agentry_agent_list`  | `agentry agent list --json`                                                          | each agent and whether it is running, stopped, disabled or desktop only  |
| `agentry_agent_show`  | `agentry agent show <name> --json`                                                   | its state, segment, roster, share folder, usage and the transcript's end |
| `agentry_agent_start` | `agentry agent start <name> --json`, consented with `--yes` when agreement is needed | the running status, or what needs agreement with a `digest`              |
| `agentry_agent_stop`  | `agentry agent stop <name> --json`                                                   | the stop's status and the segment's result file                          |
| `agentry_agent_send`  | `agentry agent attach <name> --json`, one turn over the session protocol             | the agent's reply, the tools it called and the usage, or busy            |
| `agentry_agent_grant` | `agentry agent show <name> --json`, then `agentry agent grant` consented             | the entry and its sentence with a `digest`, then the changed roster      |

Authoring tools use operation previews, since the CLI offers no compiled plan
mode for them. The preview names the command, input fingerprints, output, web
choice, budgets, policy digest, embedded-package digests and current
Knowledge and Voice metadata; the confirm re-reads those facts and refuses
changes. These runs use the person's keys and can incur model, AI Review and
search charges.

| Tool                      | Runs                                                     | Returns                                                   |
| ------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| `agentry_draft`           | `agentry draft --output-format json`                     | draft/package and receipts                                |
| `agentry_review`          | `agentry review DIR --json`                              | Examiner report and expected or undetermined gate outcome |
| `agentry_knowledge_build` | `agentry knowledge create/add --output-format json`      | Creator build report, the sources it fetched, receipts    |
| `agentry_voice_build`     | `agentry voice create/improve/edit --output-format json` | Voice Writer build report, each page's outcome, receipts  |

A knowledge build takes git repositories (`repos`, https, with `@ref` for a
branch, tag or commit) and file addresses (`urls`) beside its files, and a
voice takes pages of the person's writing (`urls`). The CLI fetches each one
before the run, through a proxy to its host alone, and the preview lists every
address with the host it reaches. A voice's pages are read by AI Review with
the person's own TypeSafe key before the Voice Writer reads them, so a voice
with `urls` needs that key. A private repository's access token is the one
saved for its host in the system keychain; the server never takes or passes a
token (`--source-token` stays in a terminal). Both need a CLI that has them:
the server checks at start and asks for an update otherwise.

Not exposed: signing in (`agentry login`, `agentry connect`, `agentry
model-signins add`), publishing (`agentry publish`), shipping a Knowledge
pack with a QuickAgent (`agentry knowledge ship`, `agentry draft --ship`, and
the per-pack confirmation `agentry publish` asks), forking and yanking,
adding, editing, pausing or removing schedules, saving or removing
destinations and default sets, importing or resetting the report design,
Knowledge import/upload/download/export/delete, Voice
set/attach/delete and account upload/download, enabling, configuring and
resetting a persistent agent (`agentry agent enable`, `configure`, `reset`),
`agentry files ensure`,
Unsafe Mode and vulnerable-server lifts, and a build's source tokens. Those
stay in a terminal.

Shipping a Knowledge pack publishes its contents: everyone who can download
the release can read the pack, and it stays in that version. The person
confirms each pack in a terminal, so `agentry_draft` takes no `ship` argument
and no tool passes `--ship`, `--namespace` or `--yes`. A draft reads the packs
named in `knowledge` and ships none of them.

The server has no credential store. Tools take key names and never return
their values.

## Layout

| Path                 | Contents                                                          |
| -------------------- | ----------------------------------------------------------------- |
| `src/`               | the server: CLI seam, consent, runs, sessions, tools              |
| `test/`              | tests against a fake `agentry` CLI (`fake-agentry.sh`)            |
| `scripts/`           | packaging, the prose gate and the workflow fork-guard check       |
| `secureagentry-mcp/` | a separate registry-API server with its own build, see its README |

## Licence

MIT, see [LICENSE](LICENSE). Security reports: [SECURITY.md](SECURITY.md).

## Documentation

- [Agentry MCP server](https://docs.secureagentry.net/agentry/mcp/)
- [The `agentry` CLI](https://docs.secureagentry.net/runner/)
