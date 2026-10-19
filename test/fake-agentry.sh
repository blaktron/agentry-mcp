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
#   FAKE_TURN_DELAY       seconds a session takes to answer a turn
#   FAKE_CONTRACT  the install plan's contract (JSON; default a workspace read)
#   FAKE_ATTEST    the install plan's attestation (default verified; unsigned and unscanned bring their refusal)
#   FAKE_REFUSAL   the install plan's refusal (default none)
#   FAKE_WRITES    a file the fake touches on a real install/uninstall
#   FAKE_NO_DELIVER  set to make `run --help` omit --deliver-to (a CLI from before deliverables)
#   FAKE_NO_DESTINATION  set to make `run --help` omit --destination (a CLI from before destinations)
#   FAKE_RUN_OUT     the run envelope's outDir (default /tmp/out)
#   FAKE_DELIVERABLES  the run envelope's deliverables block, verbatim JSON
#   FAKE_DELIVERIES    the run envelope's deliveries block, verbatim JSON
#   FAKE_DESTINATIONS  what `destinations list --json` prints (default none saved)
#   FAKE_DESTINATIONS_FILE  a file whose content, when it exists, is FAKE_DESTINATIONS
#   FAKE_RUN_REFUSED_INPUTS  the run is refused for its inputs (class policy): this is its refusedInputs, verbatim JSON
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
  if [ -n "${FAKE_NO_RUN_PLAN:-}" ]; then echo "Flags: --dry-run --yes --allow-unsigned --mode"; else echo "Flags: --plan --dry-run --yes --allow-unsigned --mode ${FAKE_NO_PROTOCOL:+removed} ${FAKE_NO_PROTOCOL:---session-protocol} ${FAKE_NO_DELIVER:---deliver-to} ${FAKE_NO_DESTINATION:---destination}"; fi; exit 0
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
case "$1" in
  whoami) echo '{"username":"example","tier":"pro"}' ;;
  schedule) echo '[{"id":"s1","name":"weekly","ref":"acme/widget","paused":false,"describe":"every Monday at 09:00","alarm":true}]' ;;
  connections) echo '[{"ref":"acme/widget@1.0.0","server":"notion","issuer":"https://auth.example"}]' ;;
  model-signins) echo '[{"vendor":"claude","account":"me@example.com"}]' ;;
  report-design) echo '{"design":{"name":"Plain","basedOn":"plain"},"source":"default"}' ;;
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
    if [ "${2:-}" = status ]; then echo '{"registry":"https://r.example","local":null,"signedIn":false}'; else
      [ -n "${FAKE_WRITES:-}" ] && echo built >> "$FAKE_WRITES"
      echo '{"status":"ok","voice":{"written":true}}'
    fi ;;
  draft|review)
    [ -n "${FAKE_WRITES:-}" ] && echo built >> "$FAKE_WRITES"
    echo '{"status":"ok","report":"report.json","reason":"example"}' ;;
  search) echo '{"results":[{"namespace":"acme","name":"widget","modes":["autonomous"],"summary":"x","installs30d":2,"quarantineState":"none"}],"facets":{},"total":1}' ;;
  info) echo '{"agent":{"namespace":"acme","name":"widget"},"latest":{"version":"1.0.0","capabilities":{"network":{"egress":"none"}}}}' ;;
  verify) echo '{"ref":"acme/widget@1.0.0","digestMatch":true,"attestation":{"state":"verified"}}' ;;
  doctor) echo '{"checks":[{"name":"docker","status":"ok"}],"ok":true}' ;;
  list) echo '{"path":"/home/me/.config/agentry/installed.yaml","records":[{"registry":"r","namespace":"acme","name":"widget","target":"claude-skill","dir":"/home/me/.claude/skills/widget","version":"1.0.0","present":true},{"registry":"runner","namespace":"acme","name":"gone","target":"runner","dir":"/tmp/gone","version":"1.0.0","present":false}]}' ;;
  install)
    if has --plan; then
      # A plan lifts nothing: a consent flag on it is a test failure.
      if has --allow-unsigned || has --allow-unscanned; then echo "fake: a consent flag on an install plan" >&2; exit 99; fi
      printf '{"ref":"acme/widget@1.0.0","namespace":"acme","name":"widget","version":"1.0.0","digest":"sha256:aaaa","modes":["autonomous"],"contract":%s,"contractDigest":"sha256:cccc","attestation":"%s","signed":%s,"diff":{},"needsConfirmation":true,"reason":"a first install","target":"claude-skill","dir":"/home/me/.claude/skills/widget","managed":true%s}\n' "$contract" "$attest" "$signed" "$( [ -n "$refusal" ] && printf ',"refusal":%s' "$(printf '%s' "$refusal" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" )"
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
      timeout=900; mode=autonomous; prev=""; for a in "$@"; do if [ "$prev" = "--timeout" ]; then timeout=$a; fi; if [ "$prev" = "--mode" ]; then mode=$a; fi; prev=$a; done
      echo "narration: compiled plan" >&2
      printf '{"ref":"%s","version":"1.0.0","digest":"sha256:aaaa","mode":"%s","modes":["autonomous","interactive"],"summary":"x","plan":{"planVersion":2,"ref":"%s","digest":"sha256:aaaa","mode":"%s","policySha256":"sha256:pppp","capabilities":{"egressMode":"none","fsReadMode":"workspace"},"enforcement":{"network":"gateway --block-network"},"tools":["write_report"],"gateway":{"image":"docker/mcp-gateway:v0.43.3"},"proxy":{},"budgets":{"timeoutSeconds":%s}},"planSha256":"abc","contract":%s,"contractDigest":"sha256:cccc","attestation":"%s","signed":%s,"diff":{},"needsConfirmation":true,"reason":"a first run"%s}\n' "$rref" "$mode" "$rref" "$mode" "$timeout" "$contract" "$ratt" "$rsigned" "$rjson"
    elif has --mode && [ "$(prev=""; for a in "$@"; do if [ "$prev" = "--mode" ]; then echo "$a"; fi; prev=$a; done)" = interactive ]; then
      if ! has --session-protocol; then echo "fake: sessions require the protocol" >&2; exit 2; fi
      exec python3 "$(dirname "$0")/fake-session.py" "$@"
    else
      if [ -n "${FAKE_INTAKE_REQUIRED:-}" ] && ! has "--intake"; then echo 'agentry: intake question "audience" is required (answer it on a terminal or pass --intake audience=...)' >&2; exit 2; fi
      [ -n "${FAKE_WRITES:-}" ] && echo ran >> "$FAKE_WRITES"
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
      rout="${FAKE_RUN_OUT:-/tmp/out}"; rextra=""
      [ -n "${FAKE_DELIVERABLES:-}" ] && rextra=",\"deliverables\":$FAKE_DELIVERABLES"
      [ -n "${FAKE_DELIVERIES:-}" ] && rextra="$rextra,\"deliveries\":$FAKE_DELIVERIES"
      echo '{"status":"ok","exitCode":0,"exitClass":"ok","runId":"r1","ref":"acme/widget@1.0.0","result":"done","outDir":"'"$rout"'","resultFile":"'"$rout"'/result.json","receipts":{"dir":"'"$rout"'/receipts","runPlanSha256":"abc"},"usage":{"inputTokens":10}'"$rextra"'}'
    fi ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
exit "${FAKE_EXIT:-0}"
