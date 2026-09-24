#!/usr/bin/env bash
# A fake `agentry` for the tests: canned JSON per subcommand on stdout,
# narration on stderr, and knobs through the environment —
#   FAKE_VERSION   what `--version` says (default a release)
#   FAKE_EXIT      exit with this code after printing (default 0)
#   FAKE_STDOUT    print exactly this instead of the canned JSON
#   FAKE_ARGV      a file to append the received argv to, one arg per line
#   FAKE_SLEEP     seconds to hang before answering
#   FAKE_NO_PLAN   set to make `install --help` omit --plan (an old CLI)
#   FAKE_NO_RUN_PLAN  set to make `run --help` omit --plan (a CLI between #123 and #124)
#   FAKE_RUN_ATTEST   the run plan's attestation for a registry ref (default verified; --local is always local)
#   FAKE_RUN_REFUSAL  a refusal the run plan reports besides the attestation's
#   FAKE_INTAKE_REQUIRED  the run (not the plan) fails on a missing --intake, as the CLI does
#   FAKE_SESSION_IDLE     seconds an interactive session waits for a turn before ending on idle_timeout
#   FAKE_SESSION_FAIL_START  the interactive run stops (exit 13, colour on the screen) before any receipt
#   FAKE_TURN_DELAY       seconds a session takes to answer a turn
#   FAKE_CONTRACT  the install plan's contract (JSON; default a workspace read)
#   FAKE_ATTEST    the install plan's attestation (default verified; unsigned and unscanned bring their refusal)
#   FAKE_REFUSAL   the install plan's refusal (default none)
#   FAKE_WRITES    a file the fake touches on a real install/uninstall
set -u
if [ -n "${FAKE_ARGV:-}" ]; then
  printf '%s\n' "$@" >> "$FAKE_ARGV"
  # FAKE_STAT_INPUT: also record the mode of the --input file, while it exists.
  if [ -n "${FAKE_STAT_INPUT:-}" ]; then prev=""; for a in "$@"; do if [ "$prev" = "--input" ]; then printf 'mode=%s\n' "$(stat -c %a "$a")" >> "$FAKE_ARGV"; fi; prev="$a"; done; fi
  printf -- '--\n' >> "$FAKE_ARGV"
fi
if [ "${1:-}" = "--version" ]; then echo "agentry version ${FAKE_VERSION:-0.4.0}"; exit 0; fi
if [ "${1:-}" = "install" ] && [ "${2:-}" = "--help" ]; then
  if [ -n "${FAKE_NO_PLAN:-}" ]; then echo "Flags: --yes --allow-unsigned --target"; else echo "Flags: --plan --yes --allow-unsigned --target"; fi; exit 0
fi
if [ "${1:-}" = "run" ] && [ "${2:-}" = "--help" ]; then
  if [ -n "${FAKE_NO_RUN_PLAN:-}" ]; then echo "Flags: --dry-run --yes --allow-unsigned --mode"; else echo "Flags: --plan --dry-run --yes --allow-unsigned --mode"; fi; exit 0
fi
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
      rrefusal="${FAKE_RUN_REFUSAL:-}"
      case "$ratt" in
        unsigned|local) [ -z "$rrefusal" ] && rrefusal="the release is $ratt; a run needs --allow-unsigned" ;;
        unscanned) [ -z "$rrefusal" ] && rrefusal="the release is unscanned — the registry admitted it without a scan; a run needs --allow-unscanned" ;;
        verified) ;;
        *) [ -z "$rrefusal" ] && rrefusal="attestation $ratt — a run refuses" ;;
      esac
      timeout=900; mode=autonomous; prev=""; for a in "$@"; do if [ "$prev" = "--timeout" ]; then timeout=$a; fi; if [ "$prev" = "--mode" ]; then mode=$a; fi; prev=$a; done
      echo "narration: compiled plan" >&2
      printf '{"ref":"%s","version":"1.0.0","digest":"sha256:aaaa","mode":"%s","modes":["autonomous","interactive"],"summary":"x","plan":{"planVersion":2,"ref":"%s","digest":"sha256:aaaa","mode":"%s","policySha256":"sha256:pppp","capabilities":{"egressMode":"none","fsReadMode":"workspace"},"enforcement":{"network":"gateway --block-network"},"tools":["write_report"],"gateway":{"image":"docker/mcp-gateway:v0.43.3"},"proxy":{},"budgets":{"timeoutSeconds":%s}},"planSha256":"abc","contract":%s,"contractDigest":"sha256:cccc","attestation":"%s","signed":%s,"diff":{},"needsConfirmation":true,"reason":"a first run"%s}\n' "$rref" "$mode" "$rref" "$mode" "$timeout" "$contract" "$ratt" "$rsigned" "$( [ -n "$rrefusal" ] && printf ',"refusal":%s' "$(printf '%s' "$rrefusal" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" )"
    elif has --mode && [ "$(prev=""; for a in "$@"; do if [ "$prev" = "--mode" ]; then echo "$a"; fi; prev=$a; done)" = interactive ]; then
      # The chat on a terminal: colour and cursor codes on the screen, the
      # record in the events receipt, /finish and /quit end it, idle ends it.
      if [ ! -t 0 ]; then echo "agentry: an interactive run needs a terminal on stdin (the chat is the input)" >&2; exit 2; fi
      if has --output-format; then echo "agentry: --output-format json is not available for an interactive run" >&2; exit 2; fi
      if [ -n "${FAKE_SESSION_FAIL_START:-}" ]; then printf '\033[1;31magentry: gateway image \033[0mnot present\033[2K\r\n'; exit 13; fi
      out=""; prev=""; for a in "$@"; do if [ "$prev" = "--out" ]; then out=$a; fi; prev=$a; done
      [ -n "${FAKE_WRITES:-}" ] && echo session >> "$FAKE_WRITES"
      mkdir -p "$out/receipts"; ev="$out/receipts/events.ndjson"; : > "$ev"
      j() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }
      event() { printf '{"kind":"%s","time":"2026-09-12T00:00:00Z"%s}\n' "$1" "$2" >> "$ev"; }
      end() { event session_end ",\"reason\":\"$1\""; printf '{"status":"ok","exitCode":0,"exitClass":"ok","result":"final: %s","outDir":"%s","receipts":{"dir":"%s/receipts"},"harness":{"mode":"interactive"}}' "$1" "$out" "$out" > "$out/result.json"; printf '# transcript\n\n%s\n' "$(cat "$ev")" > "$out/receipts/transcript.md"; printf '\033[?1049lsession ended: %s\r\n' "$1"; exit 0; }
      # The handshake: the receipt exists before the chat is up, as in the CLI.
      sleep 0.3
      printf '\033[?1049h\033[2J\033[H\033[7m acme/widget@1.0.0 · interactive · turns 0/200 · tools 0/60 \033[0m\r\n> '
      turns=0
      while true; do
        if [ "${FAKE_SESSION_IDLE:-0}" -gt 0 ]; then
          read -r -t "$FAKE_SESSION_IDLE" line || end idle_timeout
        else
          read -r line || end harness_exit
        fi
        case "$line" in
          /finish) end finished ;;
          /quit) end quit ;;
          *)
            turns=$((turns+1))
            event user_turn ",\"text\":$(j "$line")"
            sleep "${FAKE_TURN_DELAY:-0}"
            event permission_granted ',"text":"fs_read"'
            event tool_call ',"text":"fs_read"'
            event assistant_text ',"text":"echo: "'
            event assistant_turn ",\"text\":$(j "echo: $line"),\"stopReason\":\"end_turn\""
            event usage ',"inputTokens":10,"outputTokens":4'
            printf '\033[2J\033[H\033[1;34myou\033[0m %s\r\n\033[3magent\033[0m echo: %s\r\n\033[7m acme/widget@1.0.0 · interactive · turns %s/200 · tools 1/60 \033[0m\r\n> ' "$line" "$line" "$turns"
            ;;
        esac
      done
    else
      if [ -n "${FAKE_INTAKE_REQUIRED:-}" ] && ! has "--intake"; then echo 'agentry: intake question "audience" is required (answer it on a terminal or pass --intake audience=...)' >&2; exit 2; fi
      [ -n "${FAKE_WRITES:-}" ] && echo ran >> "$FAKE_WRITES"
      echo "narration: verify ok" >&2; echo "narration: gateway up" >&2
      if [ -n "${FAKE_RUN_SLEEP:-}" ]; then
        # SIGINT: what the real CLI does since agentry-cli#124 — tear down,
        # write the envelope with error interrupted under class cli.
        trap 'kill $SLEEPER 2>/dev/null; echo "narration: SIGINT: tearing down" >&2; echo "{\"status\":\"error\",\"exitCode\":1,\"exitClass\":\"cli\",\"error\":\"interrupted\",\"outDir\":\"/tmp/out\",\"resultFile\":\"/tmp/out/result.json\",\"receipts\":{\"dir\":\"/tmp/out/receipts\",\"runPlanSha256\":\"abc\"},\"result\":\"\"}"; exit 1' INT
        sleep "$FAKE_RUN_SLEEP" & SLEEPER=$!; wait $SLEEPER
      fi
      echo '{"status":"ok","exitCode":0,"exitClass":"ok","runId":"r1","ref":"acme/widget@1.0.0","result":"done","outDir":"/tmp/out","resultFile":"/tmp/out/result.json","receipts":{"dir":"/tmp/out/receipts","runPlanSha256":"abc"},"usage":{"inputTokens":10}}'
    fi ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
exit "${FAKE_EXIT:-0}"
