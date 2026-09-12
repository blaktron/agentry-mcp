#!/usr/bin/env bash
# A fake `agentry` for the tests: canned JSON per subcommand on stdout,
# narration on stderr, and knobs through the environment —
#   FAKE_VERSION  what `--version` says (default a release)
#   FAKE_EXIT     exit with this code after printing (default 0)
#   FAKE_STDOUT   print exactly this instead of the canned JSON
#   FAKE_ARGV     a file to append the received argv to, one arg per line
#   FAKE_SLEEP    seconds to hang before answering
set -u
if [ -n "${FAKE_ARGV:-}" ]; then printf '%s\n' "$@" >> "$FAKE_ARGV"; printf -- '--\n' >> "$FAKE_ARGV"; fi
if [ "${1:-}" = "--version" ]; then echo "agentry version ${FAKE_VERSION:-0.4.0}"; exit 0; fi
echo "narration: running $1" >&2
if [ -n "${FAKE_SLEEP:-}" ]; then sleep "$FAKE_SLEEP"; fi
if [ -n "${FAKE_STDOUT+x}" ]; then printf '%s' "$FAKE_STDOUT"; exit "${FAKE_EXIT:-0}"; fi
case "$1" in
  search) echo '{"results":[{"namespace":"acme","name":"widget","modes":["autonomous"],"summary":"x","installs30d":2,"quarantineState":"none"}],"facets":{},"total":1}' ;;
  info) echo '{"agent":{"namespace":"acme","name":"widget"},"latest":{"version":"1.0.0","capabilities":{"network":{"egress":"none"}}}}' ;;
  verify) echo '{"ref":"acme/widget@1.0.0","digestMatch":true,"attestation":{"state":"verified"}}' ;;
  doctor) echo '{"checks":[{"name":"docker","status":"ok"}],"ok":true}' ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
exit "${FAKE_EXIT:-0}"
