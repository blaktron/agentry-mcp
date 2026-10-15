#!/usr/bin/env bash
# Refresh the vendored Agentry API contract from a local checkout of
# blaktron/agentry, then regenerate the action catalog.
#
# Two files come across, because the contract is split across two sources of
# truth in that repo:
#
#   schemas/openapi.yaml        -> spec/openapi.yaml     (paths, schemas)
#   internal/api/authz_routes.go -> spec/session-only.json (routes that reject
#                                   PATs regardless of scope)
#
# The second is not expressible in OpenAPI, but it decides whether a tool can
# work at all under the PAT auth this server normally uses, so it is extracted
# rather than hand-maintained.
#
# Usage: scripts/sync-spec.sh [path-to-agentry-checkout]   (default ../agentry)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The registry-API server sits one level down in this repository, so the core
# checkout is two levels up from here; pass a path to use another.
src="${1:-$here/../../agentry}"

[ -f "$src/schemas/openapi.yaml" ] || { echo "no openapi.yaml under $src" >&2; exit 1; }
[ -f "$src/internal/api/authz_routes.go" ] || { echo "no authz_routes.go under $src" >&2; exit 1; }

cp "$src/schemas/openapi.yaml" "$here/spec/openapi.yaml"

python3 - "$src" "$here" <<'PY'
import json, re, subprocess, sys, hashlib, datetime

src, here = sys.argv[1], sys.argv[2]

routes = open(f"{src}/internal/api/authz_routes.go").read()
session_only = sorted(set(re.findall(r'"(\w+)":\s*\{[^}]*SessionOnly:\s*true', routes)))
if not session_only:
    raise SystemExit("extracted no SessionOnly routes; has authz_routes.go changed shape?")

def git(*args):
    return subprocess.check_output(["git", "-C", src, *args], text=True).strip()

spec_bytes = open(f"{here}/spec/openapi.yaml", "rb").read()

json.dump({
    "source": "https://github.com/blaktron/agentry/blob/main/internal/api/authz_routes.go",
    "note": "Operations the API refuses to serve to a personal access token, "
            "whatever its scopes: token minting and revocation, SSH keys, "
            "session and 2FA management, account erasure. They need a browser "
            "session cookie (AGENTRY_SESSION_COOKIE).",
    "operationIds": session_only,
}, open(f"{here}/spec/session-only.json", "w"), indent=2)
open(f"{here}/spec/session-only.json", "a").write("\n")

json.dump({
    "source": "https://github.com/blaktron/agentry/blob/main/schemas/openapi.yaml",
    "commit": git("rev-parse", "HEAD"),
    "committedAt": git("log", "-1", "--format=%cI"),
    "vendoredAt": datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "sha256": hashlib.sha256(spec_bytes).hexdigest(),
    "note": "Vendored copy of the Agentry API contract. Refresh with "
            "scripts/sync-spec.sh, then npm run generate. CI fails if "
            "src/catalog.generated.ts does not match this file.",
}, open(f"{here}/spec/PROVENANCE.json", "w"), indent=2)
open(f"{here}/spec/PROVENANCE.json", "a").write("\n")

print(f"vendored openapi.yaml and {len(session_only)} session-only routes from {git('rev-parse', '--short', 'HEAD')}")
PY

node "$here/scripts/generate-catalog.mjs"
