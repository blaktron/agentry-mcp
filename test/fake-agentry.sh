#!/usr/bin/env bash
# A fake `agentry` for the tests: canned JSON per subcommand on stdout,
# narration on stderr, and knobs through the environment —
#   FAKE_VERSION   what `--version` says (default a release)
#   FAKE_EXIT      exit with this code after printing (default 0)
#   FAKE_STDOUT    print exactly this instead of the canned JSON
#   FAKE_ARGV      a file to append the received argv to, one arg per line
#   FAKE_SLEEP     seconds to hang before answering
#   FAKE_NO_PLAN   set to make `install --help` omit --plan (an old CLI)
#   FAKE_NO_RUN_PLAN  set to make `run --help` omit --plan (a CLI without run --plan)
#   FAKE_RUN_DESKTOP  a computer use scope (app or screen): the run plan uses Blender on the person's computer with it
#   FAKE_RUN_ATTEST   the run plan's attestation for a registry ref (default verified; --local is always local)
#   FAKE_RUN_REFUSAL  the run plan's attestation refusal, in place of the verdict's own (no lift)
#   FAKE_RUN_LIFT     the lift FAKE_RUN_REFUSAL carries (default none)
#   FAKE_RUN_VULN     a vulnerable_server refusal the run plan reports after the attestation's (lift --allow-vulnerable-mcp)
#   FAKE_RUN_VULN_FILE  a file whose content, when it exists, is FAKE_RUN_VULN (so a test can change it between calls)
#   FAKE_RUN_LEGACY   the run plan prints only the one deprecated `refusal`, as a CLI without the refusals list
#   FAKE_RUN_REFUSALS_RAW  the run plan's `refusals` value, verbatim JSON (a malformed CLI)
#   FAKE_INTAKE_REQUIRED  the run (not the plan) fails on a missing --intake, as the CLI does
#   FAKE_SESSION_IDLE     seconds an interactive session waits for a turn before ending on idle_timeout
#   FAKE_SESSION_FAIL_START  the interactive run stops (exit 13, colour on the screen) before any receipt
#   FAKE_SESSION_PID      a file the interactive run writes its process id to, so a test can tell when it has exited
#   FAKE_TURN_DELAY       seconds a session takes to answer a turn
#   FAKE_CONTRACT  the install plan's contract (JSON; default a workspace read)
#   FAKE_ATTEST    the install plan's attestation (default verified; unsigned and unscanned bring their refusal)
#   FAKE_REFUSAL   the install plan's refusal (default none)
#   FAKE_WRITES    a file the fake touches on a real install/uninstall
#   FAKE_NO_DELIVER  set to make `run --help` omit --deliver-to (a CLI from before deliverables)
#   FAKE_NO_DESTINATION  set to make `run --help` omit --destination (a CLI from before destinations)
#   FAKE_NO_SOURCES  set to make `knowledge create --help` omit --repo and --url
#   FAKE_NO_VOICE_URL  set to make `voice create --help` omit --url
#   FAKE_NO_DESIGNER  set to make `report-design design --help` print the parent's help (a CLI without the Report Designer)
#   FAKE_NO_DESIGN_DOCUMENT  set to leave --document out of `report-design design --help` (a CLI before it)
#   FAKE_RUN_OUT     the run envelope's outDir (default /tmp/out)
#   FAKE_DELIVERABLES  the run envelope's deliverables block, verbatim JSON
#   FAKE_DELIVERIES    the run envelope's deliveries block, verbatim JSON
#   FAKE_DESTINATIONS  what `destinations list --json` prints (default none saved)
#   FAKE_DESTINATIONS_FILE  a file whose content, when it exists, is FAKE_DESTINATIONS
#   FAKE_RUN_REFUSED_INPUTS  the run is refused for its inputs (class policy): this is its refusedInputs, verbatim JSON
#   FAKE_DOCTOR        the checks `doctor --json` prints, verbatim JSON (default: every check ok)
#   FAKE_DOCTOR_FILE   a file whose content, when it exists, is FAKE_DOCTOR (so a test can change it between calls)
#   FAKE_DOCTOR_KEY_UNSET  the model check fails: the key's variable is not set (doctor exits 1)
#   FAKE_DOCTOR_EXIT   doctor exits with this code whatever its checks say
#   FAKE_RUN_FAIL      the run (not the plan) fails in the policy class, as with no model key; a draft or review in the gateway class
#   FAKE_RUN_CLASS_WORDS  the failed run's envelope carries exitClassName, exitClassMeaning and retryLikelyHelps
#   FAKE_RUN_PID       a file the autonomous run writes its process id to, so a test can tell whether it is still there
#   FAKE_RUN_RESULT_FILE  set to make the autonomous run also write its envelope to result.json under --out, as the CLI does
#   FAKE_NO_AGENTS     set to make `agent attach --help` print the parent's help (a CLI without attach)
#   FAKE_AGENT_STATE   what `agent show` says the assistant is (default stopped)
#   FAKE_AGENT_LINE_FILE  a file whose content, when it exists, is the share entry's consent sentence
#   FAKE_AGENT_AGREED  set to make `agent start` without --yes start (nothing new to agree to)
#   FAKE_AGENT_NEEDS_FILE  a file whose content, when it exists, is the line `agent start` needs agreement to
#   FAKE_AGENT_BUSY    an attached send is refused busy
#   FAKE_AGENT_STALE   an attached send first sees the end of another chat's turn
#   FAKE_AGENT_QUESTION  an attached send first puts this question to the person and waits for the answer
#   FAKE_NO_AGENT_INSTALL  set to make `agent install --help` print the parent's help (a CLI without agent install)
#   FAKE_MODES         the install plan's one mode (default autonomous)
#   FAKE_INSTALLED_AS_AGENT  the install plan is refused because the release is installed as a persistent agent
#   FAKE_INFO_VERSION  the latest version `info` reports (default 1.0.0)
#   FAKE_NO_AGENT_PLAN  set to make `agent install --help` omit --plan (a CLI without agent install --plan)
#   FAKE_NO_SAVED_MODELS  set to make `run --help` omit --model (a CLI without saved model runs)
#   FAKE_NO_AGENT_MODELS  set to make `agent configure --help` omit --model (a CLI before agents named saved models)
#   FAKE_NO_RUNHOST_MODELS  set to make `run --help` and `agent configure --help` omit what --on --model adds (a CLI before runhosts held saved models)
#   FAKE_AGENT_MODEL_FILE  a file whose content, when it exists, is the `model` `agent show` says the assistant runs on
#   FAKE_PIN_VERSION   the version `agent install --plan` pins acme/summarizer to (default 1.2.0; "none" resolves to none)
#   FAKE_PIN_FILE      a file whose content, when it exists, is FAKE_PIN_VERSION (so a test can move the pin between calls)
#   FAKE_AGENT_RUNNING  the agent runs: with FAKE_NO_RUNNING_UPDATES, `agent install --plan` reports it as its refusal
#   FAKE_NO_RUNNING_UPDATES  set to make `agent install --help` omit the running agent's update (a CLI before v0.7.19)
set -u
if [ -n "${FAKE_ARGV:-}" ]; then
  printf '%s\n' "$@" >> "$FAKE_ARGV"
  # FAKE_STAT_INPUT: also record the mode of the --input file, while it exists.
  if [ -n "${FAKE_STAT_INPUT:-}" ]; then prev=""; for a in "$@"; do if [ "$prev" = "--input" ]; then printf 'mode=%s\n' "$(stat -c %a "$a")" >> "$FAKE_ARGV"; fi; prev="$a"; done; fi
  printf -- '--\n' >> "$FAKE_ARGV"
fi
if [ "${1:-}" = "--version" ]; then echo "agentry version ${FAKE_VERSION:-0.6.63}"; exit 0; fi
if [ "${1:-}" = "install" ] && [ "${2:-}" = "--help" ]; then
  if [ -n "${FAKE_NO_PLAN:-}" ]; then echo "Flags: --yes --allow-unsigned --target"; else echo "Flags: --plan --yes --allow-unsigned --target"; fi; exit 0
fi
if [ "${1:-}" = "run" ] && [ "${2:-}" = "--help" ]; then
  if [ -n "${FAKE_NO_RUN_PLAN:-}" ]; then echo "Flags: --dry-run --yes --allow-unsigned --mode"; else echo "Flags: --plan --dry-run --yes --allow-unsigned --mode ${FAKE_NO_PROTOCOL:+removed} ${FAKE_NO_PROTOCOL:---session-protocol} ${FAKE_NO_DELIVER:---deliver-to} ${FAKE_NO_DESTINATION:---destination} ${FAKE_NO_RUNHOST:---on}${FAKE_NO_RUNHOST:+}${FAKE_OLD_RUNHOST:- carrying the secrets, files and intake}${FAKE_OLD_RUNHOST:-; runhost model --sign-in}${FAKE_NO_RUNHOST_SESSIONS:- --detach} ${FAKE_NO_SAVED_MODELS:---model} ${FAKE_NO_RUNHOST_MODELS:-(with --on, its credential alone travels with the run)}"; fi; exit 0
fi
if [ "${1:-}" = "knowledge" ] && [ "${2:-}" = "create" ] && [ "${3:-}" = "--help" ]; then
  echo "Flags: --file --brief-file --web --no-web ${FAKE_NO_SOURCES:---repo --url}"; exit 0
fi
if [ "${1:-}" = "voice" ] && [ "${2:-}" = "create" ] && [ "${3:-}" = "--help" ]; then
  echo "Flags: --file --brief --write ${FAKE_NO_VOICE_URL:---url}"; exit 0
fi
if [ "${1:-}" = "report-design" ] && [ "${3:-}" = "--help" ] && { [ "${2:-}" = "design" ] || [ "${2:-}" = "cover" ]; }; then
  if [ -n "${FAKE_NO_DESIGNER:-}" ]; then echo "Usage: agentry report-design [command]"
  elif [ "$2" = design ] && [ -z "${FAKE_NO_DESIGN_DOCUMENT:-}" ]; then echo "Usage: agentry report-design design --brief TEXT [--document FILE] [flags]"
  else echo "Usage: agentry report-design $2 --brief TEXT [flags]"; fi; exit 0
fi
if [ "${1:-}" = "agent" ] && [ "${2:-}" = "attach" ] && [ "${3:-}" = "--help" ]; then
  if [ -n "${FAKE_NO_AGENTS:-}" ]; then echo "Usage: agentry agent [command]"; else echo "Usage: agentry agent attach <name> --json [flags]"; fi; exit 0
fi
if [ "${1:-}" = "agent" ] && [ "${2:-}" = "tasks" ] && [ "${3:-}" = "--help" ]; then
  if [ -n "${FAKE_NO_TASKS:-}" ]; then echo "Usage: agentry agent [command]"; else echo "Usage: agentry agent tasks <name> [pause|resume|remove <task>] [flags]"; fi; exit 0
fi
if [ "${1:-}" = "agent" ] && [ "${2:-}" = "compact" ] && [ "${3:-}" = "--help" ]; then
  if [ -n "${FAKE_NO_COMPACT:-}" ]; then echo "Usage: agentry agent [command]"; else echo "Usage: agentry agent compact <name> [flags]"; fi; exit 0
fi
if [ "${1:-}" = "agent" ] && [ "${2:-}" = "install" ] && [ "${3:-}" = "--help" ]; then
  if [ -n "${FAKE_NO_AGENT_INSTALL:-}" ]; then echo "Usage: agentry agent [command]"; else echo "Usage: agentry agent install <ns/name[@version]> | --local <folder> [flags]"; [ -z "${FAKE_NO_AGENT_PLAN:-}" ] && echo "      --plan   preview only"; [ -z "${FAKE_NO_RUNNING_UPDATES:-}" ] && printf 'A running agent takes the update at its next turn,\nits conversation continuing.\n'; fi; exit 0
fi
if [ "${1:-}" = "agent" ] && [ "${2:-}" = "configure" ] && [ "${3:-}" = "--help" ]; then
  echo "Usage: agentry agent configure <name> [flags]"; [ -z "${FAKE_NO_AGENT_MODELS:-}" ] && echo "      --model string   the saved model it runs on, by name or id (agentry models list); default follows the default${FAKE_NO_RUNHOST_MODELS:-; with --on, one the runhost holds (agentry runhost model <runhost>)}"; exit 0
fi
if [ "${1:-}" = "agent" ] && [ "${2:-}" = "uninstall" ] && [ "${3:-}" = "--help" ]; then
  if [ -n "${FAKE_NO_AGENT_INSTALL:-}" ]; then echo "Usage: agentry agent [command]"; else echo "Usage: agentry agent uninstall <name> [flags]"; fi; exit 0
fi
if [ "${2:-}" = "--help" ]; then echo "Usage: agentry $1"; exit 0; fi
echo "narration: running $1" >&2
if [ -n "${FAKE_SLEEP:-}" ]; then sleep "$FAKE_SLEEP"; fi
if [ -n "${FAKE_STDOUT+x}" ]; then printf '%s' "$FAKE_STDOUT"; exit "${FAKE_EXIT:-0}"; fi
has() { for a in "$@"; do :; done; case " $ARGS " in *" $1 "*) return 0;; esac; return 1; }
ARGS="$*"
contract="${FAKE_CONTRACT:-}"
[ -z "$contract" ] && contract='{"filesystem":{"read":"workspace"}}'
attest="${FAKE_ATTEST:-verified}"
signed=false; [ "$attest" = verified ] && signed=true
refusal="${FAKE_REFUSAL:-}"
[ "$attest" = unsigned ] && [ -z "$refusal" ] && refusal="unsigned — registry offers no attestation; re-run with --allow-unsigned to install it anyway"
[ "$attest" = unscanned ] && [ -z "$refusal" ] && refusal="unscanned — the registry admitted acme/widget@1.0.0 without a scan: no findings, no report and no attestation stand behind it; re-run with --allow-unscanned to install it anyway, accepting that nothing about its contents was checked"
if [ "$1" = "agent" ]; then
  share_line="the folder /home/me/agentry/assistantshare, read and write"
  [ -n "${FAKE_AGENT_LINE_FILE:-}" ] && [ -f "$FAKE_AGENT_LINE_FILE" ] && share_line=$(cat "$FAKE_AGENT_LINE_FILE")
  agent_model='{"savedModel":{"id":"71903d13","name":"anthropic"},"model":"anthropic/claude-sonnet-5-5","followsDefault":true}'
  [ -n "${FAKE_AGENT_MODEL_FILE:-}" ] && [ -f "$FAKE_AGENT_MODEL_FILE" ] && agent_model=$(cat "$FAKE_AGENT_MODEL_FILE")
  case "$2" in
    list) echo '[{"agent":"main","displayName":"Agentry Helper","state":"desktop only","desktopOnly":true},{"agent":"assistant","displayName":"Assistant","state":"stopped"}]' ;;
    show)
      case "$3" in
        acme/widget|acme.widget|widget)
          printf '{"agent":"acme.widget","ref":"acme/widget","version":"1.0.0","source":"registry","persona":{"name":"Wally","text":"Be brief.","editable":false},"packs":["handbook"],"subagents":[{"ref":"acme/summarizer","constraint":"^1.0.0","why":"Summarises long documents.","version":"1.2.0","reach":"nothing beyond its model"}],"displayName":"Wally","state":"%s","roster":[{"id":"subagent:acme/summarizer","kind":"subagent","name":"acme/summarizer@1.2.0","grantedBy":"release","state":"on","on":true,"line":"start acme/summarizer as a run of its own"},{"id":"subagent:acme/summarizer:ask","kind":"subagent","name":"Ask before each run of acme/summarizer","grantedBy":"you","state":"off","on":false,"line":"ask you before each run"}],"config":{"enabled":true,"consented":{}}}\n' "${FAKE_AGENT_STATE:-stopped}"
          exit 0 ;;
      esac
      [ "$3" = main ] && { echo '{"agent":"main","displayName":"Agentry Helper","state":"desktop only","desktopOnly":true}'; exit 0; }
      printf '{"agent":"%s","displayName":"Assistant","state":"%s","roster":[{"id":"data","kind":"folder","name":"its own files","grantedBy":"agent","state":"on","on":true,"line":"its own files","fixed":true},{"id":"share","kind":"folder","name":"share","grantedBy":"person","state":"off","on":false,"line":"%s"},{"id":"desktop:blender","kind":"desktop","name":"Blender on your computer","grantedBy":"built-in","state":"off","on":false,"line":"Can use Blender on your computer through its MCP server, through Agentry Desktop"},{"id":"desktop:blender:exec","kind":"desktop-exec","name":"Blender: code without asking","grantedBy":"built-in","state":"off","on":false,"line":"Runs code inside Blender without Agentry Desktop asking you each time"}],"config":{"enabled":true,"consented":{}},"model":%s}\n' "$3" "${FAKE_AGENT_STATE:-stopped}" "$share_line" "$agent_model" ;;
    start)
      if has --yes || [ -n "${FAKE_AGENT_AGREED:-}" ]; then
        echo '{"segment":1,"state":"running","client":"cli","adapter":"docker-agent","model":"test"}'
      else
        need="$share_line"; [ -n "${FAKE_AGENT_NEEDS_FILE:-}" ] && [ -f "$FAKE_AGENT_NEEDS_FILE" ] && need=$(cat "$FAKE_AGENT_NEEDS_FILE")
        printf '{"agent":"%s","needsAgreement":[{"id":"share","line":"%s"}]}\n' "$3" "$need"
        echo "this needs the person's agreement" >&2; exit 11
      fi ;;
    install)
      if has --plan; then
        if has --yes; then echo "fake: --yes on an agent install plan" >&2; exit 99; fi
        pin="${FAKE_PIN_VERSION:-1.2.0}"
        [ -n "${FAKE_PIN_FILE:-}" ] && [ -f "$FAKE_PIN_FILE" ] && pin=$(cat "$FAKE_PIN_FILE")
        if [ "$pin" = none ]; then
          sub='{"ref":"acme/summarizer","constraint":"^1.0.0","why":"Summarises long documents.","unresolved":"not in the registry, or private where the people who install this release cannot run it"}'
        else
          sub='{"ref":"acme/summarizer","constraint":"^1.0.0","why":"Summarises long documents.","version":"'"$pin"'","reach":"nothing beyond its model: no network, no programs, no server","digest":"sha256:5555'"$pin"'"}'
        fi
        prior=""; inst=""; diff='{}'; reason="a first install"
        if [ -n "${FAKE_INSTALLED_AS_AGENT:-}" ]; then
          prior=',"installed":{"version":"0.9.0","dir":"/home/me/.agentry/runner/agents/acme/widget"}'
          inst=',"installed":{"version":"0.9.0","source":"registry","digest":"sha256:9999","subagents":[{"ref":"acme/summarizer","constraint":"^1.0.0","why":"Summarises long documents.","version":"1.1.0","digest":"sha256:5555old"}]}'
          diff='{"widened":["declares the persistent key memory"]}'; reason="this update widens the declared capabilities"
        fi
        [ -n "${FAKE_AGENT_RUNNING:-}" ] && [ -n "${FAKE_NO_RUNNING_UPDATES:-}" ] && [ -z "$refusal" ] && refusal="acme/widget is running in the CLI (pid 42): stop it first (agentry agent stop acme/widget), then install again"
        [ -n "$refusal" ] && refusal=',"refusal":'"$(printf '%s' "$refusal" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"
        printf '{"ref":"acme/widget@1.0.0","namespace":"acme","name":"widget","version":"1.0.0","digest":"sha256:aaaa","modes":["%s"],"contract":%s,"contractDigest":"sha256:cccc","attestation":"%s","signed":%s%s,"diff":%s,"needsConfirmation":true,"reason":"%s","target":"runner","dir":"/home/me/.agentry/runner/agents/acme/widget","managed":true%s,"agent":{"agent":"acme.widget","persistent":["clock","memory","secrets"],"persona":{"name":"Wally","file":"PERSONA.md","locked":true},"packs":["handbook"],"subagents":[%s],"runsSubagents":true%s}}\n' "${FAKE_MODES:-autonomous}" "$contract" "$attest" "$signed" "$prior" "$diff" "$reason" "$refusal" "$sub" "$inst"
        exit 0
      fi
      if ! has --yes; then echo "fake: agent install asks at the terminal without --yes" >&2; exit 2; fi
      [ -n "${FAKE_WRITES:-}" ] && echo agent-installed >> "$FAKE_WRITES"
      echo '{"agent":"acme.widget","ref":"acme/widget","version":"1.0.0","source":"registry","digest":"sha256:aaaa","persona":"Wally","packs":["handbook"],"subagents":[{"ref":"acme/summarizer","constraint":"^1.0.0","why":"Summarises long documents.","version":"1.2.0","reach":"nothing beyond its model"}],"enabled":true,"recorded":true}' ;;
    uninstall)
      wiped=false
      if has --remove-data; then
        prev=""; conf=""; for a in "$@"; do if [ "$prev" = "--confirm" ]; then conf=$a; fi; prev=$a; done
        if [ "$conf" != "acme/widget" ]; then echo "fake: the reference did not match; nothing was uninstalled" >&2; exit 2; fi
        wiped=true
        [ -n "${FAKE_WRITES:-}" ] && echo agent-wiped >> "$FAKE_WRITES"
      else
        [ -n "${FAKE_WRITES:-}" ] && echo agent-uninstalled >> "$FAKE_WRITES"
      fi
      printf '{"agent":"acme.widget","ref":"acme/widget","dataRemoved":%s,"release":{"ref":"acme/widget","plan":false,"installs":["/home/me/.agentry/runner/agents/acme/widget/1.0.0-aaaa"],"profiles":[],"consentRecord":true}}\n' "$wiped" ;;
    stop) echo '{"status":"ok","resultFile":"/home/me/.agentry/runner/agents/assistant/result.json"}' ;;
    compact) printf '{"agent":"%s","compacted":{"trigger":"manual","swapped":true,"factsBefore":6,"factsAfter":14,"handoffBytes":1326,"swap":"in-segment","swapMillis":30}}\n' "$3" ;;
    grant) printf '[{"id":"share","on":%s}]\n' "$( [ "$5" = on ] && echo true || echo false )" ;;
    attach) exec python3 "$(dirname "$0")/fake-agent-attach.py" "$@" ;;
    tasks)
      st=on; [ "${4:-}" = pause ] && st=paused
      printf '{"agent":"%s","tasks":[{"id":"t1","name":"Morning summary","cron":"0 8 * * 1-5","zone":"Europe/Oslo","instruction":"Summarise my day.","state":"%s","madeBy":"agent","lastResult":"Three meetings today."}]}\n' "$3" "$st" ;;
    configure)
      [ -n "${FAKE_WRITES:-}" ] && echo "agent-configured" >> "$FAKE_WRITES"
      echo '[{"id":"data","kind":"folder","name":"its own files","grantedBy":"agent","state":"on","on":true,"line":"its own files","fixed":true}]' ;;
    *) echo "fake: agent $2" >&2; exit 2 ;;
  esac
  exit 0
fi
if [ "${1:-}" = "runhost" ]; then
  [ -n "${FAKE_NO_RUNHOST:-}" ] && { echo 'Error: unknown command "runhost" for "agentry"' >&2; exit 1; }
  case "${2:-}" in
    list) echo '{"runhosts":[{"name":"lab","host":"192.0.2.10","port":22,"hostKey":"ssh-ed25519 AAAA","hostKeyFingerprint":"SHA256:abc","owner":{"kind":"devices"},"deviceID":"aaaa","cliVersion":"0.6.1017","arch":"amd64","os":"Debian GNU/Linux 13 (trixie)","gvisor":"20261026.0","addedAt":"2026-11-01T00:00:00Z"}]}' ;;
    model) printf '{"runhost":"%s","models":{"models":[{"id":"d3f17234","name":"Qwen","provider":"custom-lab","model":"qwen3","contextWindow":32768,"kind":"no-key","default":true,"users":[{"kind":"agent","id":"assistant","name":"Assistant"}]},{"id":"5a1c0b22","name":"ChatGPT","provider":"openai","model":"gpt-5.2","kind":"sign-in","refusal":"the runhost is not signed in to ChatGPT"}],"default":"d3f17234","max":10}}\n' "$3" ;;
    doctor)
      if [ -n "${FAKE_RUNHOST_DOWN:-}" ]; then
        printf '{"ref":"runhost %s","checks":[{"name":"docker","status":"ok","detail":"Docker Engine 29.0.0"},{"name":"runhost:gvisor","status":"fail","detail":"the policy runs containers under runc","remedy":"run agentry runhost add again"}]}\n' "$3"; exit 1
      fi
      printf '{"ref":"runhost %s","checks":[{"name":"policy","status":"ok","detail":"/var/lib/agentry/.agentry/runner/policy.yaml"},{"name":"docker","status":"ok","detail":"Docker Engine 29.0.0"},{"name":"runhost:gvisor","status":"ok","detail":"every container runs under runsc, the gateway under runsc-uds"}]}\n' "$3" ;;
    schedules)
      if [ "${3:-}" = "--help" ]; then
        [ -n "${FAKE_NO_RUNHOST_SCHEDULES:-}" ] && { echo "Usage: agentry runhost [command]"; exit 0; }
        echo "Usage: agentry runhost schedules <name> [--run <id>] [flags]"; exit 0
      fi
      printf '{"runhost":"%s","schedules":[{"id":"y34k0ku5us","name":"earn-check","ref":"acme/widget@1.0.0","device":"aaaa","when":{"kind":"daily","time":"07:00","zone":"UTC"},"created":"2026-11-02T00:00:00Z","entries":[{"kind":"model-key","name":"anthropic"}]}]}\n' "$3" ;;
    *) echo "fake: runhost $2" >&2; exit 99 ;;
  esac
  exit 0
fi
case "$1" in
  whoami) echo '{"username":"example","tier":"pro"}' ;;
  schedule)
    case "${2:-}" in
      show) echo '{"schedule":{"id":"'"$3"'","name":"weekly","ref":"acme/widget","paused":false,"describe":"every Monday at 09:00"},"next":["2026-11-09T09:00:00Z"],"runs":[]}' ;;
      pause|resume) echo "schedule $3 ${2}d" >&2 ;;
      *) echo '[{"id":"s1","name":"weekly","ref":"acme/widget","paused":false,"describe":"every Monday at 09:00","alarm":true}]' ;;
    esac ;;
  connections) echo '[{"ref":"acme/widget@1.0.0","server":"notion","issuer":"https://auth.example"}]' ;;
  model-signins) echo '[{"vendor":"claude","account":"me@example.com"}]' ;;
  models) echo '{"default":"71903d13","max":10,"models":[{"id":"71903d13","name":"anthropic","provider":"anthropic","model":"claude-sonnet-5-5","default":true},{"id":"d3f17234","name":"Qwen","provider":"custom-lab","model":"qwen3","contextWindow":32768}]}' ;;
  report-design)
    case "$2" in
      design|cover)
        [ -n "${FAKE_WRITES:-}" ] && echo built >> "$FAKE_WRITES"
        echo '{"status":"ok","reportDesign":{"job":"'"$2"'","name":"Fake design","sha256":"00","cover":"band","looked":true,"previews":2,"dir":"out/design"}}' ;;
      list) echo '{"registry":"r","default":"","designs":[{"id":"00000000-0000-4000-8000-000000000001","name":"House","basedOn":"modern","version":1,"default":false,"hasLogo":true,"hasCoverImage":false,"hasCustomCover":false}]}' ;;
      *) echo '{"design":{"name":"Plain","basedOn":"plain"},"source":"default"}' ;;
    esac ;;
  destinations)
    dests="${FAKE_DESTINATIONS:-}"; [ -n "${FAKE_DESTINATIONS_FILE:-}" ] && [ -f "$FAKE_DESTINATIONS_FILE" ] && dests=$(cat "$FAKE_DESTINATIONS_FILE")
    echo "${dests:-{\"destinations\":[]\}}" ;;
  deliver)
    [ -n "${FAKE_WRITES:-}" ] && echo delivered >> "$FAKE_WRITES"
    echo '{"deliveries":[{"destination":"/home/me/Documents/Agentry","kind":"folder","object":"/home/me/Documents/Agentry/widget/a.md","sha256":"00","status":"delivered"}]}' ;;
  builtins) echo '[{"ref":"agentry/drafter@1.6.0","digest":"sha256:builtin"}]' ;;
  knowledge)
    if [ "${2:-}" = list ]; then echo '{"packs":[]}'; else
      [ -n "${FAKE_WRITES:-}" ] && echo built >> "$FAKE_WRITES"
      echo '{"status":"ok","knowledge":{"written":["index.md"]}}'
    fi ;;
  voice)
    if [ "${2:-}" = status ]; then echo '{"registry":"https://r.example","local":null,"signedIn":false}'
    elif [ "${2:-}" = show ]; then echo '{"voice":"# Voice\nShort sentences.\n","path":"/home/me/.agentry/voice/VOICE.md"}'; else
      [ -n "${FAKE_WRITES:-}" ] && echo built >> "$FAKE_WRITES"
      echo '{"status":"ok","voice":{"written":true}}'
    fi ;;
  draft|review)
    [ -n "${FAKE_WRITES:-}" ] && echo built >> "$FAKE_WRITES"
    if [ -n "${FAKE_RUN_FAIL:-}" ]; then echo '{"status":"error","exitCode":13,"exitClass":"gateway","error":"the gateway did not start"}'; exit 13; fi
    echo '{"status":"ok","report":"report.json","reason":"example"}' ;;
  search) echo '{"results":[{"namespace":"acme","name":"widget","modes":["autonomous"],"summary":"x","installs30d":2,"quarantineState":"none"}],"facets":{},"total":1}' ;;
  info) echo '{"agent":{"namespace":"acme","name":"widget"},"latest":{"version":"'"${FAKE_INFO_VERSION:-1.0.0}"'","capabilities":{"network":{"egress":"none"}},"manifest":{"persona":{"name":"Wally","file":"PERSONA.md","editable":false}}},"run":{"intake":[{"id":"repo","type":"repository","required":false,"prompt":"The repository","personsOwn":false,"answer":"The repository'"'"'s https address"}],"takes":["code"],"inputView":"original","secrets":[],"modes":["autonomous"],"guide":{"overview":"Audits a repository."}}}' ;;
  verify) echo '{"ref":"acme/widget@1.0.0","digestMatch":true,"attestation":{"state":"verified"}}' ;;
  doctor)
    # The report as the CLI prints it, with the ref when one was given:
    # FAKE_DOCTOR (or FAKE_DOCTOR_FILE's content) replaces the checks, and
    # FAKE_DOCTOR_KEY_UNSET makes the model check fail as the CLI does when
    # the key's variable is not set. A failing check exits 1 (class cli).
    dchecks="${FAKE_DOCTOR:-}"; [ -n "${FAKE_DOCTOR_FILE:-}" ] && [ -f "$FAKE_DOCTOR_FILE" ] && dchecks=$(cat "$FAKE_DOCTOR_FILE")
    if [ -z "$dchecks" ]; then
      model='{"name":"model","status":"ok","detail":"anthropic/claude-sonnet-5-5 (key from $ANTHROPIC_API_KEY)"}'
      [ -n "${FAKE_DOCTOR_KEY_UNSET:-}" ] && model='{"name":"model","status":"fail","detail":"anthropic/claude-sonnet-5-5: $ANTHROPIC_API_KEY is not set in this environment","remedy":"export ANTHROPIC_API_KEY, or run `agentry setup` to store the key"}'
      dchecks='[{"name":"policy","status":"ok","detail":"/home/me/.agentry/runner/policy.yaml"},'"$model"',{"name":"secretSource","status":"ok","detail":"env"},{"name":"docker","status":"ok","detail":"Docker Engine 29.0.0 at /var/run/docker.sock"},{"name":"image:gateway","status":"ok","detail":"ghcr.io/blaktron/agentry-mcp-gateway:v0.44.3"},{"name":"image:harness","status":"ok","detail":"docker/docker-agent:1.150.0"},{"name":"registry","status":"ok","detail":"https://r.example reachable (credential stored)"}'
      dref=""; case "${2:-}" in --*|"") ;; *) dref="$2" ;; esac
      if [ -n "$dref" ] || has --local; then dchecks="$dchecks"',{"name":"resolve","status":"ok","detail":"acme/widget@1.0.0 (sha256:aaaa)"},{"name":"install","status":"warn","detail":"not installed yet — `agentry run acme/widget@1.0.0 --prepare` downloads, verifies and installs it"},{"name":"secrets","status":"ok","detail":"all 1 declared secret(s) resolve"}'; fi
      dchecks="$dchecks]"
    fi
    dref=""; case "${2:-}" in --*|"") ;; *) dref="$2" ;; esac
    printf '{%s"checks":%s}\n' "$( [ -n "$dref" ] && printf '"ref":"%s",' "$dref" )" "$dchecks"
    [ -n "${FAKE_DOCTOR_EXIT:-}" ] && exit "$FAKE_DOCTOR_EXIT"
    case "$dchecks" in *'"status":"fail"'*) echo "doctor: 1 check(s) failed" >&2; exit 1 ;; esac ;;
  list) echo '{"path":"/home/me/.config/agentry/installed.yaml","records":[{"registry":"r","namespace":"acme","name":"widget","target":"claude-skill","dir":"/home/me/.claude/skills/widget","version":"1.0.0","present":true},{"registry":"runner","namespace":"acme","name":"gone","target":"runner","dir":"/tmp/gone","version":"1.0.0","present":false}]}' ;;
  install)
    if has --plan; then
      # A plan lifts nothing: a consent flag on it is a test failure.
      if has --allow-unsigned || has --allow-unscanned; then echo "fake: a consent flag on an install plan" >&2; exit 99; fi
      if [ -n "${FAKE_INSTALLED_AS_AGENT:-}" ]; then echo "agentry: acme/widget is installed as a persistent agent: update it with agentry agent install acme/widget" >&2; exit 2; fi
      printf '{"ref":"acme/widget@1.0.0","namespace":"acme","name":"widget","version":"1.0.0","digest":"sha256:aaaa","modes":["%s"],"contract":%s,"contractDigest":"sha256:cccc","attestation":"%s","signed":%s,"diff":{},"needsConfirmation":true,"reason":"a first install","target":"claude-skill","dir":"/home/me/.claude/skills/widget","managed":true%s}\n' "${FAKE_MODES:-autonomous}" "$contract" "$attest" "$signed" "$( [ -n "$refusal" ] && printf ',"refusal":%s' "$(printf '%s' "$refusal" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" )"
    else
      [ -n "${FAKE_WRITES:-}" ] && echo written >> "$FAKE_WRITES"
      echo '{"ref":"acme/widget@1.0.0","namespace":"acme","name":"widget","version":"1.0.0","digest":"sha256:aaaa","target":"claude-skill","dir":"/home/me/.claude/skills/widget","managed":true,"attestation":"'"$attest"'","signed":'"$signed"',"contract":'"$contract"',"contractDigest":"sha256:cccc","recorded":true}'
    fi ;;
  uninstall)
    if has --plan; then
      if has --keep-mcp; then
        echo '{"ref":"acme/widget","plan":true,"installs":["/home/me/.agentry/runner/agents/acme/widget/1.0.0-aaaa"],"profiles":[],"keptProfiles":["/home/me/.agentry/runner/profiles/p1"],"consentRecord":true}'
      else
        echo '{"ref":"acme/widget","plan":true,"installs":["/home/me/.agentry/runner/agents/acme/widget/1.0.0-aaaa"],"profiles":["/home/me/.agentry/runner/profiles/p1"],"consentRecord":true}'
      fi
    else
      [ -n "${FAKE_WRITES:-}" ] && echo removed >> "$FAKE_WRITES"
      echo '{"ref":"acme/widget","plan":false,"installs":["/home/me/.agentry/runner/agents/acme/widget/1.0.0-aaaa"],"profiles":[],"consentRecord":true}'
    fi ;;
  setup)
    echo "narration: policy written: /home/me/.agentry/runner/policy.yaml" >&2
    echo "narration: image gateway ready" >&2
    images=ready; has --skip-images && images=skipped
    echo '{"policyPath":"/home/me/.agentry/runner/policy.yaml","provider":"openai","model":"gpt-5.2","apiKeyEnv":"OPENAI_API_KEY","images":"'"$images"'"}' ;;
  validate)
    echo '{"passed":false,"manifest":{"name":"demo"},"issues":[{"rule":"V7","severity":"error","message":"public publish requires README.md"}],"inventory":[],"findings":[],"counts":{"errors":1}}'; exit 1 ;;
  run)
    if has --plan; then
      # The plan asks nothing and lifts nothing: the attestation and the
      # refusal are reported, --allow-unsigned on a plan is a test failure.
      if has --allow-unsigned; then echo "fake: --allow-unsigned on a plan" >&2; exit 99; fi
      if has --allow-unscanned; then echo "fake: --allow-unscanned on a plan" >&2; exit 99; fi
      # The CLI plans on this computer: --on never reaches a plan.
      if has --on; then echo "fake: --on on a plan" >&2; exit 99; fi
      ratt="${FAKE_RUN_ATTEST:-verified}"; has --local && ratt=local
      rsigned=false; [ "$ratt" = verified ] && rsigned=true
      rref='acme/widget@1.0.0'; has --local && rref='fixtures/hello-report@1.0.0'
      rrefusal="${FAKE_RUN_REFUSAL:-}"; rlift="${FAKE_RUN_LIFT:-}"
      rvuln="${FAKE_RUN_VULN:-}"; [ -n "${FAKE_RUN_VULN_FILE:-}" ] && [ -f "$FAKE_RUN_VULN_FILE" ] && rvuln=$(cat "$FAKE_RUN_VULN_FILE")
      case "$ratt" in
        unsigned|local) [ -z "$rrefusal" ] && rrefusal="the release is $ratt; a run needs --allow-unsigned" && rlift=--allow-unsigned ;;
        unscanned) [ -z "$rrefusal" ] && rrefusal="the release is unscanned — the registry admitted it without a scan; a run needs --allow-unscanned" && rlift=--allow-unscanned ;;
        verified) ;;
        *) [ -z "$rrefusal" ] && rrefusal="attestation $ratt — a run refuses" ;;
      esac
      # refusals[] as the CLI prints it; refusal is its first message.
      rjson=$(RREF="$rrefusal" RLIFT="$rlift" RVULN="$rvuln" LEGACY="${FAKE_RUN_LEGACY:-}" RAW="${FAKE_RUN_REFUSALS_RAW:-}" python3 -c '
import json, os
rs = []
if os.environ["RREF"]:
    r = {"kind": "attestation", "message": os.environ["RREF"]}
    if os.environ["RLIFT"]: r["lift"] = os.environ["RLIFT"]
    rs.append(r)
if os.environ["RVULN"]:
    rs.append({"kind": "vulnerable_server", "message": os.environ["RVULN"], "lift": "--allow-vulnerable-mcp"})
out = ""
if rs:
    out += ",\"refusal\":" + json.dumps(rs[0]["message"])
    if not os.environ["LEGACY"] and not os.environ["RAW"]: out += ",\"refusals\":" + json.dumps(rs)
if os.environ["RAW"]:
    out += ",\"refusals\":" + os.environ["RAW"]
print(out, end="")')
      rdesktop=""
      [ -n "${FAKE_RUN_DESKTOP_LINE:-}" ] && rdesktop=",\"desktop\":${FAKE_RUN_DESKTOP_LINE}"
      [ -n "${FAKE_RUN_DESKTOP:-}" ] && rdesktop=',"desktop":{"servers":[{"id":"blender","application":"Blender","package":"pypi:mcp-for-blender@2.2.7","tools":[{"name":"get_scene_info","class":"read"},{"name":"execute_blender_code","class":"exec"}]}],"computerUse":"'"${FAKE_RUN_DESKTOP}"'"}'
      timeout=900; mode=autonomous; rmodel=""; prev=""; for a in "$@"; do if [ "$prev" = "--timeout" ]; then timeout=$a; fi; if [ "$prev" = "--mode" ]; then mode=$a; fi; if [ "$prev" = "--model" ]; then rmodel=$a; fi; prev=$a; done
      # The plan is compiled on the saved model --model names.
      rharness=""
      [ -n "$rmodel" ] && rharness=',"harness":{"adapter":"docker-agent","model":"custom/qwen3","savedModel":{"id":"d3f17234","name":"'"$rmodel"'"}}'
      [ "$rmodel" = Gone ] && { echo 'agentry: there is no saved model "Gone" on this computer, and a run never takes the default in its place' >&2; exit 11; }
      echo "narration: compiled plan" >&2
      printf '{"ref":"%s","version":"1.0.0","digest":"sha256:aaaa","mode":"%s","modes":["autonomous","interactive"],"summary":"x","plan":{"planVersion":2,"ref":"%s","digest":"sha256:aaaa","mode":"%s","policySha256":"sha256:pppp","capabilities":{"egressMode":"none","fsReadMode":"workspace"%s},"enforcement":{"network":"gateway --block-network"},"tools":["write_report"],"gateway":{"image":"ghcr.io/blaktron/agentry-mcp-gateway:v0.44.3"},"proxy":{},"budgets":{"timeoutSeconds":%s}%s},"planSha256":"abc","contract":%s,"contractDigest":"sha256:cccc","attestation":"%s","signed":%s,"diff":{},"needsConfirmation":true,"reason":"a first run"%s}\n' "$rref" "$mode" "$rref" "$mode" "$rdesktop" "$timeout" "$rharness" "$contract" "$ratt" "$rsigned" "$rjson"
    elif has --mode && [ "$(prev=""; for a in "$@"; do if [ "$prev" = "--mode" ]; then echo "$a"; fi; prev=$a; done)" = interactive ]; then
      if ! has --session-protocol; then echo "fake: sessions require the protocol" >&2; exit 2; fi
      exec python3 "$(dirname "$0")/fake-session.py" "$@"
    else
      if [ -n "${FAKE_INTAKE_REQUIRED:-}" ] && ! has "--intake"; then echo 'agentry: intake question "audience" is required (answer it on a terminal or pass --intake audience=...)' >&2; exit 2; fi
      [ -n "${FAKE_WRITES:-}" ] && echo ran >> "$FAKE_WRITES"
      [ -n "${FAKE_RUN_PID:-}" ] && echo $$ > "$FAKE_RUN_PID"
      echo "narration: verify ok" >&2; echo "narration: gateway up" >&2
      if [ -n "${FAKE_RUN_SLEEP:-}" ]; then
        # SIGINT: what the real CLI does: tear down,
        # write the envelope with error interrupted under class cli.
        trap 'kill $SLEEPER 2>/dev/null; echo "narration: SIGINT: tearing down" >&2; echo "{\"status\":\"error\",\"exitCode\":1,\"exitClass\":\"cli\",\"error\":\"interrupted\",\"outDir\":\"/tmp/out\",\"resultFile\":\"/tmp/out/result.json\",\"receipts\":{\"dir\":\"/tmp/out/receipts\",\"runPlanSha256\":\"abc\"},\"result\":\"\"}"; exit 1' INT
        sleep "$FAKE_RUN_SLEEP" & SLEEPER=$!; wait $SLEEPER
      fi
      if [ -n "${FAKE_RUN_REFUSED_INPUTS:-}" ]; then
        echo '{"status":"error","exitCode":11,"exitClass":"policy","error":"the run was refused before the agent started: malware found in an input","stage":"prepare","reason":{"code":"input-refused","detail":"malware"},"refusedInputs":'"$FAKE_RUN_REFUSED_INPUTS"',"refusedInputsMore":2,"runId":"r1","ref":"acme/widget@1.0.0","outDir":"/tmp/out","resultFile":"/tmp/out/result.json","receipts":{"dir":"/tmp/out/receipts","runPlanSha256":"abc"},"result":""}'
        exit 11
      fi
      if [ -n "${FAKE_RUN_FAIL:-}" ]; then
        # The run fails in the policy class as it does with no model key;
        # FAKE_RUN_CLASS_WORDS adds the class's name, meaning and retry hint.
        words=""; [ -n "${FAKE_RUN_CLASS_WORDS:-}" ] && words=',"exitClassName":"policy","exitClassMeaning":"the runner policy refused the run before the agent started","retryLikelyHelps":false'
        echo '{"status":"error","exitCode":11,"exitClass":"policy","error":"model key: $ANTHROPIC_API_KEY is not set","stage":"prepare","runId":"r1","ref":"acme/widget@1.0.0","outDir":"/tmp/out","resultFile":"/tmp/out/result.json","receipts":{"dir":"/tmp/out/receipts","runPlanSha256":"abc"},"result":""'"$words"'}'
        exit 11
      fi
      rout="${FAKE_RUN_OUT:-/tmp/out}"; rextra=""
      [ -n "${FAKE_DELIVERABLES:-}" ] && rextra=",\"deliverables\":$FAKE_DELIVERABLES"
      [ -n "${FAKE_DELIVERIES:-}" ] && rextra="$rextra,\"deliveries\":$FAKE_DELIVERIES"
      renv='{"agentry":"fake","status":"ok","exitCode":0,"exitClass":"ok","runId":"r1","ref":"acme/widget@1.0.0","result":"done","outDir":"'"$rout"'","resultFile":"'"$rout"'/result.json","receipts":{"dir":"'"$rout"'/receipts","runPlanSha256":"abc"},"usage":{"inputTokens":10}'"$rextra"'}'
      if [ -n "${FAKE_RUN_RESULT_FILE:-}" ]; then
        prev=""; for a in "$@"; do if [ "$prev" = "--out" ]; then mkdir -p "$a" && printf '%s\n' "$renv" > "$a/result.json"; fi; prev="$a"; done
      fi
      echo "$renv"
    fi ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
exit "${FAKE_EXIT:-0}"
