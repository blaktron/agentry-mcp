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

- Node 24 or newer.
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

| Tool                         | Runs                                | Returns                                                                                                                                                                                                                                               |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentry_search`             | `agentry search --json`             | results, facets, total                                                                                                                                                                                                                                |
| `agentry_info`               | `agentry info --json`               | the agent, its latest published version, the capability contract, whether it carries an attestation (signed or unsigned), and how to run it: its questions and how to answer each, the files it takes, its keys and its guide (CLI 0.6.1011 or later) |
| `agentry_verify`             | `agentry verify --json`             | the digest match and the attestation's verdict                                                                                                                                                                                                        |
| `agentry_whoami`             | `agentry whoami --json`             | signed-in account and tier                                                                                                                                                                                                                            |
| `agentry_builtins`           | `agentry builtins --json`           | embedded package refs and archive digests                                                                                                                                                                                                             |
| `agentry_knowledge_list`     | `agentry knowledge list --json`     | local packs or an organization's shared packs                                                                                                                                                                                                         |
| `agentry_voice_status`       | `agentry voice status --json`       | local and account Voice metadata and review                                                                                                                                                                                                           |
| `agentry_doctor`             | `agentry doctor --json`             | machine readiness: policy, provider key **name**, docker, images, exec catalog                                                                                                                                                                        |
| `agentry_schedule_list`      | `agentry schedule list --json`      | the schedules on this computer: repeat, next run, output folder, paused                                                                                                                                                                               |
| `agentry_connections_list`   | `agentry connections list --json`   | the OAuth connections kept for QuickAgent versions' MCP servers, never a token                                                                                                                                                                        |
| `agentry_model_signins_list` | `agentry model-signins list --json` | the model sign-ins local runs can spend, never a token                                                                                                                                                                                                |
| `agentry_report_design_show` | `agentry report-design show --json` | the report design a run's PDFs would take, and what chose it                                                                                                                                                                                          |
| `agentry_destinations_list`  | `agentry destinations list --json`  | the saved destinations (name, kind, host, on my network) and the QuickAgents each is a default for, never a secret                                                                                                                                    |
| `agentry_runhost_list`       | `agentry runhost list --json`       | this computer's remote runhosts: name, address, host key fingerprint, owner, server CLI version, system                                                                                                                                               |

`agentry_run` takes `on`, a remote runhost's name from `agentry_runhost_list`,
to run there instead of on this computer (`agentry run --on`, CLI v0.6.1017 or
later). The release is verified on this computer and sent over SSH with the
model key; the runhost verifies it again, runs it under gVisor and seals the
output to this computer, which opens it into the output folder. The preview's
readiness is `agentry runhost doctor` for that runhost. With CLI v0.6.1019 or
later a run on a runhost takes what a run on this computer takes: `files`,
`knowledge`, the voice arguments, `intake` and `intakeTokens`, `reportTheme`,
`deliverTo` and `destinations`. The secrets and intake answers are gathered on
this computer and sent with the files for that run alone; the runhost delivers
to the destinations and deletes everything it was sent when the run ends. A
target host is reached from the runhost with this computer's sign-in, and
only when this computer already knows the host's key. With CLI v0.7.3 or
later a run whose model is Agentry credits pays with the runhost's own
credits token, a token that can only pay for model use, which the person
gives the runhost in a terminal with `agentry runhost model <name> --provider
agentry`, approving it in their browser; `agentry runhost store <name>
--remove credits` and `agentry runhost remove` revoke it. Both stay terminal
commands. With CLI v0.7.6 or later a run whose model is a Claude, ChatGPT or
Copilot plan uses the runhost's own sign-in, which the person makes in a
terminal with `agentry runhost model <name> --sign-in claude|chatgpt|copilot`
from their browser, and `adapter` may be given with `on`: `claude` and `codex`
run there as their images, `claude-image` and `codex-image`, since a runhost
runs no harness as a host process. A destination on the person's own network
is not taken on a runhost yet.

`agentry_session_start` takes `on` as well, with a CLI whose `run` has
`--detach`: the session runs on the runhost and the session tools drive it as
they drive one here. A dropped connection leaves it there to its idle timeout.
Following a run whose connection dropped (`agentry runhost attach`), and
listing, collecting and cancelling a runhost's jobs (`agentry runhost jobs`,
`collect`, `cancel`), are terminal commands.

Setting a runhost up (`agentry runhost add`), removing it (`agentry runhost
remove`), and later pairing another device, changing its settings and choosing
its model stay in a terminal. Each takes an administrator's sign-in to the
person's server or a sign-in in the browser, and a host agent never holds those.

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

| Tool                 | Runs                                                                                                                                 | Returns                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentry_setup`      | `agentry setup --json` (with or without the image pulls)                                                                             | the policy as configured — provider, model, the key's variable **name** — and whether the images are ready                                                                                                                   |
| `agentry_run`        | `agentry run --plan --json` and `agentry doctor <ref> --json`, then `agentry run --mode autonomous --output-format json` consented   | the summary in words, the readiness block and the run plan with a `digest`, then the CLI's result envelope with `receiptsDir`, `resultFile`, `outDir` beside it, and the run's deliverables; a failure class is a tool error |
| `agentry_deliver`    | `agentry deliver RUN-FOLDER --json` consented                                                                                        | a preview of the run's deliverables, the folder and the destinations with a `digest`, then the CLI's deliveries                                                                                                              |
| `agentry_run_status` | no command: reads the run's record, its narration and the envelope the CLI wrote (its stdout, or `result.json` in the output folder) | the run's state (running, ended, cancelled, lost), its progress, and once ended the run tool's own result; without an id, every run on record                                                                                |
| `agentry_run_cancel` | no command: sends the run's record's process SIGINT, SIGKILL after a minute                                                          | the run as `agentry_run_status` reports it once it has ended, or still running if the teardown is not done                                                                                                                   |
| `agentry_validate`   | `agentry validate DIR --json`                                                                                                        | the rules and scan findings as data, and whether publish would pass                                                                                                                                                          |

`agentry_setup`'s `provider` is one of `anthropic`, `openai`, `google`,
`vultr` (Vultr Serverless Inference, key variable `VULTR_INFERENCE_API_KEY`;
CLI v0.6.1000 or later), `openrouter`, `poe`, `huggingface` or `custom` (with
`baseUrl`), each paid by a key whose variable **name** the call gives, or
`agentry` (CLI v0.6.1005 or later), paid with the Agentry credits of the
account the CLI is signed in to, which takes no key variable, base URL or model. Signing
in with a provider's own account (_Connect your account_) stays in a terminal
(`agentry setup`) or the desktop.

A run's preview is the CLI's compiled run plan with the attestation verdict
and every refusal a run would meet, under `plan`, with two things read before
the person is asked: `summary`, the contract in words (what runs and for how
long, the model and how it is paid, what the run may reach on the network,
what it reads and writes, where its result goes, every refusal, and whether
it can start), and `readiness`, the report of `agentry doctor <ref> --json`
(`doctor --local DIR` for a workspace): whether the model key's variable is
set, the container engine answers, the images are present, the registry
sign-in holds and each declared secret resolves, each check as the CLI wrote
it with its remedy, and `ready` when none failed and the model and the engine
were among the checks. Both are in the digest, so
a key set or an engine stopped between the two calls refuses the confirm. A
run whose exit class is not `ok` comes back as a tool error (`isError`)
whose content is still the envelope, with the CLI's `exitClassName`,
`exitClassMeaning` and `retryLikelyHelps` beside `exitClass` when the CLI
printed them. A run stops at `timeoutSeconds`, or at the
runner policy's own budget when the call names none: the CLI ends it, the
server sends SIGINT 30 s later if the process is still there, and kills it
60 s after that. Progress streams as MCP progress notifications when the
host asks for them.

A run blocks its tool call until it ends, which can be many minutes. When
the host cancels the call, the server sends the CLI SIGINT, as Ctrl-C would,
so its teardown runs and its receipts and envelope are written; MCP delivers
no result for a cancelled call, so the envelope is kept under a run id and
`agentry_run_status` (without an id) lists it. A confirm with `detach: true`
starts the run in its own process group and returns its id at once; the run
writes to `out`, or to `./agentry-out/<ns>-<name>-<id>` under the working
folder, and goes on if the server stops. `agentry_run_status` reports its
progress (the narration's line count and tail) while it runs and, once it
ends, the same result the blocking call returns: the envelope, the
deliverables, a failure class as a tool error. `agentry_run_cancel` sends it
SIGINT and waits up to `waitSeconds` for the envelope. The digest is the same
for a waited and a detached start: `detach` is not among the consent facts.
`agentry_draft`, `agentry_review`, `agentry_knowledge_build` and
`agentry_voice_build` take `detach` too. Every run leaves a record under
`AGENTRY_MCP_STATE` (default `~/.agentry/mcp`), so a server started later
reports a run it did not start by its process and its files: still running,
ended with the envelope read from the run's stdout file or the output
folder's `result.json`, or lost when its process is gone and it wrote no
result. Records of ended runs are removed after 14 days.

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

| Tool                    | Runs                                                                                                                                                         | Returns                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `agentry_session_start` | `agentry run --plan --json --mode interactive` and `agentry doctor <ref> --json`, then `agentry run --mode interactive` consented, over the session protocol | the summary, the readiness block and the plan with a `digest`, then the session id, the output folder and the receipts directory |
| `agentry_session_send`  | a JSON send command to the open chat session                                                                                                                 | the agent's reply as the events receipt recorded it, the tools it called, the usage                                              |
| `agentry_session_add`   | a consented JSON add command to the open chat session                                                                                                        | staged file submission; collect its notice or refusal with send                                                                  |
| `agentry_session_close` | a JSON end command to the open chat session, then the CLI's teardown                                                                                         | why the session ended, the envelope's status and result, the transcript, the receipts directory; a failure class is a tool error |

Persistent agents run in the background once started and keep their
conversation from one start to the next: the Assistant, the Coding agent and
the persistent QuickAgents installed from a registry. Main runs only in Agentry
Desktop. Every tool that names an agent takes a built-in's name (`assistant`,
`coder`) or a published agent's `ns/name`. Installing a registry agent
and uninstalling it (CLI v0.7.4 or later) are two calls like an install: the
install preview is `agentry install --plan --json` plus the persona from
`agentry info`, and lists the agent's persistent capabilities (what it may do
beyond a run), the knowledge it ships, its subagents with the reason each
gives and its persona, with a `digest`; the CLI resolves the version each
subagent is pinned to while it installs, and the result names them. A release
that is unsigned, unscanned or not persistent is refused, and an update of an
agent already installed stays at a terminal, where the CLI previews it. The
uninstall preview says what goes and what stays: the conversation and files stay
unless `removeData` is set, which also needs the agent's reference as
`confirmRef` (the CLI's `--confirm`). A subagent is a roster entry
(`subagent:<ns>/<name>`, with a `:ask` switch that asks the person before each
run), switched with `agentry_agent_grant`. A question the agent puts to the
person during a send is asked through the host's elicitation and answered with
what the person says; a host that cannot ask leaves it unanswered and the send
reports `awaitingPerson`. A start that would give the agent something
the person has not agreed to on this computer, and every roster switch, are
two calls like an install: the preview lists each consent sentence with a
`digest`, and the confirm re-reads them and refuses any change. A send is one
`agentry agent attach --json` process that leaves the agent running; another
chat's turn in flight makes it busy. Windows uses `agentry agent chat` in a
terminal because the pipe protocol is unavailable there. The roster names the
agent's skills, stored secrets (by name, never a value), git host accounts,
heartbeat, the Assistant's `meetings` switch (CLI v0.6.195 or later: with
the heartbeat on, it lets the Assistant ask Agentry Desktop to record the
meetings on the person's calendar that they asked it to record, each armed
window shown and cancelled in the desktop), calendar feeds (`calendar:<name>`)
and offered servers, and a grant
switches any of them. The
Assistant's mail servers (Google Workspace, `server:gog`; Microsoft 365 and Outlook.com, `server:ms365`; Fastmail, `server:url-api-fastmail-com-mcp`) are on its roster only
while their mail provider is enabled. Adding a skill, storing a secret, giving
an account, choosing the Assistant's mail providers (`agentry agent configure
assistant --mail-provider`), each provider's sign-in (`--google-client`, `--google-sign-in`, `--microsoft-client`, `--microsoft-sign-in`, and Fastmail's token, `--fastmail-token` and `--no-fastmail`), the Assistant's calendar feeds
(`agentry agent configure assistant --calendar-feed <name>` and
`--no-calendar-feed <name>`, which take a calendar's secret iCal address;
needs CLI v0.6.205 or later), exporting the memory,
removing a task and the Assistant's three resets (`agentry agent reset
assistant --history`, `--keep-credentials`, and plain `reset`) stay in a
terminal or the desktop: each takes a file, a value or a sign-in that belongs on
the person's own screen, or removes what the person set up.

| Tool                      | Runs                                                                                                                                                                              | Returns                                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentry_agent_list`      | `agentry agent list --json`                                                                                                                                                       | each agent and whether it is running, stopped, disabled or desktop only                                                                                                                              |
| `agentry_agent_show`      | `agentry agent show <name> --json`                                                                                                                                                | its state, segment, roster, share folder, usage and the transcript's end; for a registry agent its reference, version, persona, packs and subagent pins, and its subagent runs (CLI v0.7.8 or later) |
| `agentry_agent_install`   | `agentry agent install <ns/name> --plan --json` (before CLI v0.7.8, `agentry install --plan` and `agentry info`), then `agentry agent install <ns/name@version> --json` consented | the capabilities, persona, knowledge and subagent pins and, for an update, the installed release and its widening, with a `digest`; then the agent's record                                          |
| `agentry_agent_uninstall` | `agentry agent show <name> --json`, then `agentry agent uninstall <name> [--remove-data --confirm <ns/name>] --json`                                                              | what goes and what stays with a `digest`, then whether the data was removed                                                                                                                          |
| `agentry_agent_start`     | `agentry agent start <name> --json`, consented with `--yes` when agreement is needed                                                                                              | the running status, or what needs agreement with a `digest`                                                                                                                                          |
| `agentry_agent_stop`      | `agentry agent stop <name> --json`                                                                                                                                                | the stop's status and the segment's result file                                                                                                                                                      |
| `agentry_agent_send`      | `agentry agent attach <name> --json`, one turn over the session protocol                                                                                                          | the agent's reply, the tools it called and the usage, or busy                                                                                                                                        |
| `agentry_agent_grant`     | `agentry agent show <name> --json`, then `agentry agent grant` consented                                                                                                          | the entry and its sentence with a `digest`, then the changed roster                                                                                                                                  |
| `agentry_agent_tasks`     | `agentry agent tasks <name> [pause\|resume <task>] --json`                                                                                                                        | each task's schedule, state, next and last fire, or the changed tasks                                                                                                                                |
| `agentry_agent_compact`   | `agentry agent show <name> --json`, then `agentry agent compact <name> --json`                                                                                                    | what it does and spends with a `digest`, then whether a fresh conversation started                                                                                                                   |

Authoring tools use operation previews, since the CLI offers no compiled plan
mode for them. The preview names the command, input fingerprints, output, web
choice, budgets, policy digest, embedded-package digests and current
Knowledge and Voice metadata; the confirm re-reads those facts and refuses
changes. These runs use the person's keys and can incur model, AI Review and
search charges.

| Tool                      | Runs                                                     | Returns                                                                                                  |
| ------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `agentry_draft`           | `agentry draft --output-format json`                     | the operation's summary, readiness and facts with a `digest`, then the draft/package and receipts        |
| `agentry_review`          | `agentry review DIR --json`                              | the same preview, then the Examiner report and expected or undetermined gate outcome                     |
| `agentry_knowledge_build` | `agentry knowledge create/add --output-format json`      | the same preview (the sources it will fetch among the facts), then the Creator build report and receipts |
| `agentry_voice_build`     | `agentry voice create/improve/edit --output-format json` | the same preview, then the Voice Writer build report, each page's outcome, receipts                      |

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
resetting a persistent agent (`agentry agent enable`, `configure`, `reset`;
the Assistant's mail providers and its three resets among them), installing a
persistent agent from a folder (`agentry agent install --local`),
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
