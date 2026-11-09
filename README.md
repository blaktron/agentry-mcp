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

| Tool                         | Runs                                                                                                      | Returns                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentry_search`             | `agentry search --json`                                                                                   | results, facets, total                                                                                                                                                                                                                                |
| `agentry_info`               | `agentry info --json`                                                                                     | the agent, its latest published version, the capability contract, whether it carries an attestation (signed or unsigned), and how to run it: its questions and how to answer each, the files it takes, its keys and its guide (CLI 0.6.1011 or later) |
| `agentry_verify`             | `agentry verify --json`                                                                                   | the digest match and the attestation's verdict                                                                                                                                                                                                        |
| `agentry_whoami`             | `agentry whoami --json`                                                                                   | signed-in account and tier                                                                                                                                                                                                                            |
| `agentry_builtins`           | `agentry builtins --json`                                                                                 | embedded package refs and archive digests                                                                                                                                                                                                             |
| `agentry_knowledge_list`     | `agentry knowledge list --json`                                                                           | local packs or an organization's shared packs                                                                                                                                                                                                         |
| `agentry_voice_status`       | `agentry voice status --json`                                                                             | local and account Voice metadata and review                                                                                                                                                                                                           |
| `agentry_voice_show`         | `agentry voice show --json`                                                                               | the Writing Voice kept on this computer, its VOICE.md                                                                                                                                                                                                 |
| `agentry_doctor`             | `agentry doctor --json`                                                                                   | machine readiness: policy, provider key **name**, docker, images, exec catalog                                                                                                                                                                        |
| `agentry_schedule_list`      | `agentry schedule list --json`                                                                            | the schedules on this computer: repeat, next run, output folder, paused; with `on`, a runhost's (`agentry runhost schedules <on> --json`, CLI v0.7.11 or later): next run, what each keeps in its store, its runs' jobs                               |
| `agentry_schedule_show`      | `agentry schedule show <id> --json`                                                                       | one schedule: its QuickAgent, repeat, next occurrences, paused, its runs                                                                                                                                                                              |
| `agentry_schedule_pause`     | `agentry schedule pause <id>` or `agentry schedule resume <id>`, then `agentry schedule show <id> --json` | the schedule as `agentry_schedule_show` gives it, paused or resumed                                                                                                                                                                                   |
| `agentry_connections_list`   | `agentry connections list --json`                                                                         | the OAuth connections kept for QuickAgent versions' MCP servers, never a token                                                                                                                                                                        |
| `agentry_model_signins_list` | `agentry model-signins list --json`                                                                       | the model sign-ins local runs can spend, never a token                                                                                                                                                                                                |
| `agentry_models_list`        | `agentry models list --json`                                                                              | the saved models on this computer (each a provider and a model id under the person's name for it) and which is the default, never a key (CLI v0.7.39 or later)                                                                                        |
| `agentry_report_design_list` | `agentry report-design list --json`                                                                       | the account's report design library: each design's name, the built-in it started from, which is the default and which images it carries (CLI v0.7.22 or later)                                                                                        |
| `agentry_report_design_show` | `agentry report-design show --json`                                                                       | the report design a run's PDFs would take, and what chose it                                                                                                                                                                                          |
| `agentry_destinations_list`  | `agentry destinations list --json`                                                                        | the saved destinations (name, kind, host, on my network) and the QuickAgents each is a default for, never a secret                                                                                                                                    |
| `agentry_runhost_list`       | `agentry runhost list --json`                                                                             | this computer's remote runhosts: name, address, host key fingerprint, owner, server CLI version, system                                                                                                                                               |

`agentry_run` and `agentry_session_start` take `model`, a saved model's name
or id from `agentry_models_list`, to run on that saved model instead of the
default (`agentry run --model`, CLI v0.7.39 or later). Its provider's
credential pays, and the harness follows that credential unless `adapter`
names one. The preview's summary names the saved model, and a run on another
model is another plan and needs its own confirm. A name the computer does not
have is refused by the CLI, never replaced by the default. `model` is not
taken with `on`: a runhost runs on the model it keeps. Saving, editing,
removing or checking a saved model, changing the default and adding a
provider stay in a terminal or the desktop, and so does making a schedule
(`agentry schedule add --model`); `agentry_schedule_show` names the saved
model each schedule runs on.

`agentry_run` takes `on`, a remote runhost's name from `agentry_runhost_list`,
to run there instead of on this computer (`agentry run --on`, CLI v0.6.1017 or
later). The release is verified on this computer and sent over SSH with the
model key; the runhost verifies it again, runs it under gVisor and seals the
output to this computer, which opens it into the output folder. The preview's
readiness is `agentry runhost doctor` for that runhost. With CLI v0.6.1019 or
later a run on a runhost takes what a run on this computer takes: `files`,
`knowledge`, the voice arguments, `intake` and `intakeTokens`, `reportTheme` or `reportDesign`,
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

The persistent agent tools take `on` too (CLI v0.7.14 or later):
`agentry_agent_list`, `agentry_agent_show`, `agentry_agent_start`,
`agentry_agent_stop`, `agentry_agent_send` and `agentry_agent_tasks` drive the
agent on that runhost (`agentry agent … --on <name>`), where it runs under the
runhost's service on the runhost's own model. `agentry_agent_grant` names the
runhost `runhost`, because its `on` is the switch. Giving the runhost its
agents' model (`agentry runhost model <name> --provider …`, an API key) and
storing an agent's secret or git host account there (`agentry agent secret set
--on`, `agentry agent configure --account --on`) stay in a terminal, because
they take a key or a secret.

Setting a runhost up (`agentry runhost add`), removing it (`agentry runhost
remove`), pairing another computer with it or taking this one off (`agentry
runhost pair`, `agentry runhost unpair`), changing its settings and choosing its
model stay in a terminal. Each takes an administrator's sign-in to the person's
server, a sign-in in the browser, or a change only the person decides on, and a
host agent never holds those. So does making a schedule there (`agentry schedule
add --on`), whose consent names what the runhost's store will keep; listing a
runhost's schedules is `agentry_schedule_list` with `on`. So does `agentry runhost update`, which installs
this computer's CLI on the person's server; the CLI also does it by itself on
the first runhost command after it updates. A run on a runhost whose CLI is not
this computer's version is refused, naming both versions: the person runs
`agentry runhost update <name>` in a terminal, or updates this computer's CLI
when the runhost's is newer.

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
| `agentry_validate`   | `agentry validate DIR --json`                                                                                                        | the rules, scan findings and scaffold lines as data, with the stages it ran and those only the registry runs                                                                                                                 |

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
`agentry_voice_build` and `agentry_report_design_build` take `detach` too. Every run leaves a record under
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
run's PDFs, and `reportDesign` a design of the person's library by name or
id, or a file holding one (`agentry_report_design_list` lists the library;
CLI v0.7.22 or later). An input source's token and a target host's password, passphrase
or sudo password are passed as the **name** of an environment variable
(`intakeTokens`, `hostPasswords`, `hostPassphrases`, `hostSudoPasswords`) and
a host key as a file path (`hostKeys`); otherwise the CLI uses what the
person saved in the system keychain. The preview's `signIns` and the
question put to the person name each variable and the source or host it
signs in to, since its value goes there. A release that uses applications
on the person's own computer (`capabilities.desktop`; CLI v0.7.33 or later) runs
only with `desktop`: `applications` names each application id the preview
names once the person agreed (any application's id, such as `blender` or
`my-cad`, through its MCP server or its windows; Agentry Desktop resolves it
to an application the person approved), `choose` agrees to an application the
person chooses when the run starts (CLI v0.7.35 or later), `computerUse`
agrees to its computer use, and `allowScreen` passes `--allow-screen` for a
whole-screen one; an id missing or unknown is refused, naming it. The run uses
them through Agentry Desktop, which must be running on the person's computer
(on this computer, or with `on` the one that follows the run), asks before
code runs inside an application, logs each call, and stops on the person's
Stop. Adding and approving applications (Settings → Your computer), the
system's permissions and opening an application stay in Agentry Desktop. A session's preview names its
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
that is unsigned, unscanned or not persistent is refused, and before CLI v0.7.8
an update of an agent already installed stays at a terminal, where the CLI
previews it. With CLI v0.7.19 or later a running agent takes an update at its
next turn, its conversation continuing, and an uninstall stops it first; an
older CLI refuses both while it runs. The
uninstall preview says what goes and what stays: the conversation and files stay
unless `removeData` is set, which also needs the agent's reference as
`confirmRef` (the CLI's `--confirm`). A subagent is a roster entry
(`subagent:<ns>/<name>`, with a `:ask` switch that asks the person before each
run), switched with `agentry_agent_grant`. So is each application on the
person's computer an agent may use through Agentry Desktop (`desktop:<id>`,
with `desktop:<id>:exec`, the agreement that its code runs without asking,
and `desktop:computer`, CLI v0.7.34 or later); Agentry Desktop's Settings →
Your computer and the system's permissions stay in the app. A question the agent puts to the
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
the person's own screen, or removes what the person set up. With CLI v0.7.19 or
later none of them needs the agent stopped: a running agent takes each at its
next turn.

Each agent runs on one of this computer's saved models (CLI v0.7.39 or
later): the one it names, or the default it follows. `agentry_agent_list` and
`agentry_agent_show` return it as `model` (`savedModel`, `model`,
`followsDefault`, or `refusal` when its next turn would be refused for it), and
a running agent's `status.savedModel` names its segment's.
`agentry_agent_model` moves an agent to another saved model, or back to the
default, in two calls: the preview names the model it runs on and the one it
would move to, with a `digest`, and the confirm re-reads both and refuses any
change. A running agent takes the move at its next turn without a stop, and is
told. No new agreement is asked: the model's provider was set up by the
person. A turn on a saved model the computer no longer has, or cannot use,
fails and never runs on another. The rest of `agentry agent configure` stays in
a terminal or the desktop.

| Tool                      | Runs                                                                                                                                                                              | Returns                                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentry_agent_list`      | `agentry agent list --json`                                                                                                                                                       | each agent, whether it is running, stopped, disabled or desktop only, and its saved model (CLI v0.7.39 or later)                                                                                     |
| `agentry_agent_show`      | `agentry agent show <name> --json`                                                                                                                                                | its state, segment, roster, share folder, usage and the transcript's end; for a registry agent its reference, version, persona, packs and subagent pins, and its subagent runs (CLI v0.7.8 or later) |
| `agentry_agent_install`   | `agentry agent install <ns/name> --plan --json` (before CLI v0.7.8, `agentry install --plan` and `agentry info`), then `agentry agent install <ns/name@version> --json` consented | the capabilities, persona, knowledge and subagent pins and, for an update, the installed release and its widening, with a `digest`; then the agent's record                                          |
| `agentry_agent_uninstall` | `agentry agent show <name> --json`, then `agentry agent uninstall <name> [--remove-data --confirm <ns/name>] --json`                                                              | what goes and what stays with a `digest`, then whether the data was removed                                                                                                                          |
| `agentry_agent_start`     | `agentry agent start <name> --json`, consented with `--yes` when agreement is needed                                                                                              | the running status, or what needs agreement with a `digest`                                                                                                                                          |
| `agentry_agent_stop`      | `agentry agent stop <name> --json`                                                                                                                                                | the stop's status and the segment's result file                                                                                                                                                      |
| `agentry_agent_send`      | `agentry agent attach <name> --json`, one turn over the session protocol                                                                                                          | the agent's reply, the tools it called and the usage, or busy                                                                                                                                        |
| `agentry_agent_grant`     | `agentry agent show <name> --json`, then `agentry agent grant` consented                                                                                                          | the entry and its sentence with a `digest`, then the changed roster                                                                                                                                  |
| `agentry_agent_model`     | `agentry agent show <name> --json` and `agentry models list --json`, then `agentry agent configure <name> --model <id\|default> --json`                                           | the model it runs on and the one it would move to, with a `digest`; then the roster (CLI v0.7.39 or later)                                                                                           |
| `agentry_agent_tasks`     | `agentry agent tasks <name> [pause\|resume <task>] --json`                                                                                                                        | each task's schedule, state, next and last fire, or the changed tasks                                                                                                                                |
| `agentry_agent_compact`   | `agentry agent show <name> --json`, then `agentry agent compact <name> --json`                                                                                                    | what it does and spends with a `digest`, then whether a fresh conversation started                                                                                                                   |

Authoring tools use operation previews, since the CLI offers no compiled plan
mode for them. The preview names the command, input fingerprints, output, web
choice, budgets, policy digest, embedded-package digests and current
Knowledge and Voice metadata; the confirm re-reads those facts and refuses
changes. These runs use the person's keys and can incur model, AI Review and
search charges.

| Tool                          | Runs                                                      | Returns                                                                                                                     |
| ----------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `agentry_draft`               | `agentry draft --output-format json`                      | the operation's summary, readiness and facts with a `digest`, then the draft/package and receipts                           |
| `agentry_review`              | `agentry review DIR --json`                               | the same preview, then the Examiner report and expected or undetermined gate outcome                                        |
| `agentry_knowledge_build`     | `agentry knowledge create/add --output-format json`       | the same preview (the sources it will fetch among the facts), then the Creator build report and receipts                    |
| `agentry_voice_build`         | `agentry voice create/improve/edit --output-format json`  | the same preview, then the Voice Writer build report, each page's outcome, receipts                                         |
| `agentry_report_design_build` | `agentry report-design design/cover --output-format json` | the same preview, then the Report Designer's result (`reportDesign`: name, cover, previews, where it was written), receipts |

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

`agentry_report_design_build` runs the Report Designer: `job: design` writes a
whole report design from a `brief`, starting from `from` (one of the account's
designs, a built-in theme or a design file) when given, with a `logo`, up to
four reference `images` it looks at and never keeps, and up to two https
`urls` about the person or brand; `job: cover` writes a custom Typst cover
page for the design named by `design`, with images it may draw. The preview
lists the files it reads, each address with the host it reaches, and that
every page is read by AI Review with the person's own TypeSafe key. The design
is written under the output folder (`design/design.json`) and nothing is added
to the account: `--save`, `agentry report-design import`, `use` and `delete`
stay in a terminal. It needs CLI 0.7.23 or later; the server checks at start
and refuses the tool with a request to update otherwise.

`job: design` also takes one `document`, a PDF or a Word document (`.docx`)
up to 20 MB, that the Designer builds the design around: it looks at the
first twelve pages of a PDF, reads a Word document's theme, header, footer and
pictures (no Word layout is rendered), and can take the logo from it. With
CLI 0.7.29 or later it also reads the pictures a PDF's pages draw, and the
design can keep the cover page's artwork and a custom cover modelled on the
cover page; never a whole page or the document's text. The
preview lists the document among the files read and says it is read in full
and kept only for the run: the CLI checks it like any input and stages images
and text it makes from it, never the document itself. It needs CLI 0.7.26 or
later.

Not exposed: signing in (`agentry login`, `agentry connect`, `agentry
model-signins add`, `agentry providers add`), adding, changing, checking or
removing saved models and choosing the default (`agentry models`), publishing (`agentry publish`), shipping a Knowledge
pack with a QuickAgent (`agentry knowledge ship`, `agentry draft --ship`, and
the per-pack confirmation `agentry publish` asks), forking and yanking,
adding, editing, pausing or removing schedules, saving or removing
destinations and default sets, adding, replacing, picking the default or deleting a report design,
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

## Terminal-only commands

Every command of the CLI is either run by a tool above or listed here, with
the reason it stays in a terminal or the desktop. A test holds this list and
the tools against the CLI's command tree (`spec/cli-commands.txt`, read from
the CLI's help with `node scripts/cli-commands.mjs <agentry>`), so a command
the CLI gains is given a tool or a row here before the server ships.

| Command                             | Why it stays in a terminal                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentry acp`                       | is the Agent Client Protocol server itself, which a host starts directly instead of this one                                                                                                                          |
| `agentry agent chat`                | an interactive terminal interface, not a command a program reads                                                                                                                                                      |
| `agentry agent disable`             | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent enable`              | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent memory export`       | deletes, downloads, exports or imports a kept pack, voice, design or memory on this computer; the person does it in a terminal or the desktop                                                                         |
| `agentry agent messenger add`       | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent messenger list`      | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent messenger manifest`  | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent messenger pair`      | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent messenger remove`    | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent messenger test`      | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent reset`               | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent secret list`         | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent secret remove`       | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent secret set`          | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent skill add`           | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent skill list`          | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry agent skill remove`        | configures a persistent agent's accounts, messengers, skills or secrets, each of which takes a sign-in, a key or a file the person holds                                                                              |
| `agentry browser ensure`            | fetches or builds a runner image; agentry_run and agentry_setup do it when a run needs it                                                                                                                             |
| `agentry builtins publish`          | publishes to the registry or changes what the person's account holds there; a person decides that in a terminal or on the site                                                                                        |
| `agentry connect`                   | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry connections client list`   | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry connections client remove` | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry connections client set`    | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry connections remove`        | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry destinations add`          | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry destinations default`      | changes what every later run takes or where its results go, which the person decides once in a terminal or the desktop                                                                                                |
| `agentry destinations remove`       | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry files ensure`              | fetches or builds a runner image; agentry_run and agentry_setup do it when a run needs it                                                                                                                             |
| `agentry fork`                      | publishes to the registry or changes what the person's account holds there; a person decides that in a terminal or on the site                                                                                        |
| `agentry init`                      | writes a new workspace in a folder of the person's; agentry_draft drafts one from a description                                                                                                                       |
| `agentry knowledge delete`          | deletes, downloads, exports or imports a kept pack, voice, design or memory on this computer; the person does it in a terminal or the desktop                                                                         |
| `agentry knowledge download`        | deletes, downloads, exports or imports a kept pack, voice, design or memory on this computer; the person does it in a terminal or the desktop                                                                         |
| `agentry knowledge export`          | deletes, downloads, exports or imports a kept pack, voice, design or memory on this computer; the person does it in a terminal or the desktop                                                                         |
| `agentry knowledge import`          | deletes, downloads, exports or imports a kept pack, voice, design or memory on this computer; the person does it in a terminal or the desktop                                                                         |
| `agentry knowledge ship`            | publishes to the registry or changes what the person's account holds there; a person decides that in a terminal or on the site                                                                                        |
| `agentry knowledge upload`          | publishes to the registry or changes what the person's account holds there; a person decides that in a terminal or on the site                                                                                        |
| `agentry login`                     | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry logout`                    | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry managed refresh`           | reads or refreshes what the person's organization manages; the desktop and the terminal show it where the person can act on it                                                                                        |
| `agentry managed show`              | reads or refreshes what the person's organization manages; the desktop and the terminal show it where the person can act on it                                                                                        |
| `agentry model-signins add`         | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry model-signins remove`      | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry models add`                | changes the saved models every later run, schedule and agent may take, or checks one by asking its provider (a Claude subscription's check spends one message), which the person decides in a terminal or the desktop |
| `agentry models check`              | changes the saved models every later run, schedule and agent may take, or checks one by asking its provider (a Claude subscription's check spends one message), which the person decides in a terminal or the desktop |
| `agentry models default`            | changes the saved models every later run, schedule and agent may take, or checks one by asking its provider (a Claude subscription's check spends one message), which the person decides in a terminal or the desktop |
| `agentry models edit`               | changes the saved models every later run, schedule and agent may take, or checks one by asking its provider (a Claude subscription's check spends one message), which the person decides in a terminal or the desktop |
| `agentry models remove`             | changes the saved models every later run, schedule and agent may take, or checks one by asking its provider (a Claude subscription's check spends one message), which the person decides in a terminal or the desktop |
| `agentry open`                      | acts on this computer's folders and desktop (lists the runs made from here, or opens a folder in the file manager)                                                                                                    |
| `agentry profiles list`             | changes the stored MCP profiles, which hold the keys a QuickAgent's servers use                                                                                                                                       |
| `agentry profiles remove`           | changes the stored MCP profiles, which hold the keys a QuickAgent's servers use                                                                                                                                       |
| `agentry providers add`             | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry providers list`            | lists the providers on this computer, each with its credential's kind; agentry_models_list names each saved model's provider                                                                                          |
| `agentry providers remove`          | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry publish`                   | publishes to the registry or changes what the person's account holds there; a person decides that in a terminal or on the site                                                                                        |
| `agentry report-design delete`      | publishes to the registry or changes what the person's account holds there; a person decides that in a terminal or on the site                                                                                        |
| `agentry report-design export`      | deletes, downloads, exports or imports a kept pack, voice, design or memory on this computer; the person does it in a terminal or the desktop                                                                         |
| `agentry report-design import`      | publishes to the registry or changes what the person's account holds there; a person decides that in a terminal or on the site                                                                                        |
| `agentry report-design use`         | publishes to the registry or changes what the person's account holds there; a person decides that in a terminal or on the site                                                                                        |
| `agentry runhost add`               | sets up, pairs, updates or removes a remote runhost, which takes the person's own server and sign-in                                                                                                                  |
| `agentry runhost attach`            | follows or collects a job on a remote runhost; agentry_run with `on` starts and follows its own runs                                                                                                                  |
| `agentry runhost cancel`            | follows or collects a job on a remote runhost; agentry_run with `on` starts and follows its own runs                                                                                                                  |
| `agentry runhost collect`           | follows or collects a job on a remote runhost; agentry_run with `on` starts and follows its own runs                                                                                                                  |
| `agentry runhost jobs`              | follows or collects a job on a remote runhost; agentry_run with `on` starts and follows its own runs                                                                                                                  |
| `agentry runhost model`             | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry runhost pair`              | sets up, pairs, updates or removes a remote runhost, which takes the person's own server and sign-in                                                                                                                  |
| `agentry runhost remove`            | sets up, pairs, updates or removes a remote runhost, which takes the person's own server and sign-in                                                                                                                  |
| `agentry runhost set`               | sets up, pairs, updates or removes a remote runhost, which takes the person's own server and sign-in                                                                                                                  |
| `agentry runhost status`            | follows or collects a job on a remote runhost; agentry_run with `on` starts and follows its own runs                                                                                                                  |
| `agentry runhost store`             | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry runhost unpair`            | sets up, pairs, updates or removes a remote runhost, which takes the person's own server and sign-in                                                                                                                  |
| `agentry runhost update`            | sets up, pairs, updates or removes a remote runhost, which takes the person's own server and sign-in                                                                                                                  |
| `agentry runs`                      | acts on this computer's folders and desktop (lists the runs made from here, or opens a folder in the file manager)                                                                                                    |
| `agentry schedule add`              | makes, changes or removes a schedule, which runs a QuickAgent later with nobody asked; the person does it in a terminal or the desktop                                                                                |
| `agentry schedule check-signed-out` | checks this computer's keychain and login session for running schedules signed out, which the person sets up in a terminal                                                                                            |
| `agentry schedule edit`             | makes, changes or removes a schedule, which runs a QuickAgent later with nobody asked; the person does it in a terminal or the desktop                                                                                |
| `agentry schedule remove`           | makes, changes or removes a schedule, which runs a QuickAgent later with nobody asked; the person does it in a terminal or the desktop                                                                                |
| `agentry schedule reseal`           | signs in or out, or takes a credential: the person types it where they can see the prompt, never through a host's model                                                                                               |
| `agentry schedule run`              | runs a schedule's QuickAgent now on the consent given when the schedule was made; agentry_run asks for a run's consent itself                                                                                         |
| `agentry schedule sync`             | makes, changes or removes a schedule, which runs a QuickAgent later with nobody asked; the person does it in a terminal or the desktop                                                                                |
| `agentry voice attach`              | changes what every later run takes or where its results go, which the person decides once in a terminal or the desktop                                                                                                |
| `agentry voice delete`              | deletes, downloads, exports or imports a kept pack, voice, design or memory on this computer; the person does it in a terminal or the desktop                                                                         |
| `agentry voice download`            | deletes, downloads, exports or imports a kept pack, voice, design or memory on this computer; the person does it in a terminal or the desktop                                                                         |
| `agentry voice set`                 | changes what every later run takes or where its results go, which the person decides once in a terminal or the desktop                                                                                                |
| `agentry voice upload`              | publishes to the registry or changes what the person's account holds there; a person decides that in a terminal or on the site                                                                                        |
| `agentry yank`                      | publishes to the registry or changes what the person's account holds there; a person decides that in a terminal or on the site                                                                                        |

## Layout

| Path                 | Contents                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| `src/`               | the server: CLI seam, consent, runs, sessions, tools                    |
| `test/`              | tests against a fake `agentry` CLI (`fake-agentry.sh`)                  |
| `scripts/`           | packaging, the prose gate and the workflow fork-guard check             |
| `spec/`              | the CLI command tree the parity test reads (`scripts/cli-commands.mjs`) |
| `secureagentry-mcp/` | a separate registry-API server with its own build, see its README       |

## Licence

MIT, see [LICENSE](LICENSE). Security reports: [SECURITY.md](SECURITY.md).

## Documentation

- [Agentry MCP server](https://docs.secureagentry.net/agentry/mcp/)
- [The `agentry` CLI](https://docs.secureagentry.net/runner/)
