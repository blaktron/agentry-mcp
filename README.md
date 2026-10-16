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

| Tool                     | Runs                            | Returns                                                                                                                  |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `agentry_search`         | `agentry search --json`         | results, facets, total                                                                                                   |
| `agentry_info`           | `agentry info --json`           | the agent, its latest published version, the capability contract, whether it carries an attestation (signed or unsigned) |
| `agentry_verify`         | `agentry verify --json`         | the digest match and the attestation's verdict                                                                           |
| `agentry_whoami`         | `agentry whoami --json`         | signed-in account and tier                                                                                               |
| `agentry_builtins`       | `agentry builtins --json`       | embedded package refs and archive digests                                                                                |
| `agentry_knowledge_list` | `agentry knowledge list --json` | local packs or an organization's shared packs                                                                            |
| `agentry_voice_status`   | `agentry voice status --json`   | local and account Voice metadata and review                                                                              |
| `agentry_doctor`         | `agentry doctor --json`         | machine readiness: policy, provider key **name**, docker, images, exec catalog                                           |

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

| Tool               | Runs                                                                                             | Returns                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `agentry_setup`    | `agentry setup --json` (with or without the image pulls)                                         | the policy as configured — provider, model, the key's variable **name** — and whether the images are ready        |
| `agentry_run`      | `agentry run --plan --json`, then `agentry run --mode autonomous --output-format json` consented | the run plan with a `digest`, then the CLI's result envelope with `receiptsDir`, `resultFile`, `outDir` beside it |
| `agentry_validate` | `agentry validate DIR --json`                                                                    | the rules and scan findings as data, and whether publish would pass                                               |

A run's preview is the CLI's compiled run plan with the attestation verdict
and every refusal a run would meet. A run stops at `timeoutSeconds`, or at the
runner policy's own budget when the call names none: the CLI ends it, the
server sends SIGINT 30 s later if the process is still there, and kills it
60 s after that. Progress streams as MCP progress notifications when the
host asks for them.

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
| `agentry_knowledge_build` | `agentry knowledge create/add --output-format json`      | Creator build report and receipts                         |
| `agentry_voice_build`     | `agentry voice create/improve/edit --output-format json` | Voice Writer build report and receipts                    |

Not exposed: signing in (`agentry login`), publishing (`agentry publish`),
Knowledge import/upload/download/export/delete, Voice
set/attach/delete and account upload/download, `agentry files ensure`,
Unsafe Mode and vulnerable-server lifts. Those stay in a terminal.

The server has no credential store. Tools take key names and never return
their values.

## Layout

| Path                 | Contents                                                          |
| -------------------- | ----------------------------------------------------------------- |
| `src/`               | the server: CLI seam, consent, runs, sessions, tools              |
| `test/`              | tests against a fake `agentry` CLI (`fake-agentry.sh`)            |
| `scripts/`           | packaging and the prose gate                                      |
| `secureagentry-mcp/` | a separate registry-API server with its own build, see its README |

## Licence

MIT, see [LICENSE](LICENSE). Security reports: [SECURITY.md](SECURITY.md).

## Documentation

- [Agentry MCP server](https://docs.secureagentry.net/agentry/mcp/)
- [The `agentry` CLI](https://docs.secureagentry.net/runner/)
