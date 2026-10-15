#!/usr/bin/env bash
# Agentry operator wizard.
#
# Everything above the "STAGES" marker is the library and is identical in every
# wizard: do not hand-edit it. Author your procedure below the marker, one
# `stage` per step, and set TOTAL_STAGES to the number you wrote.
#
#   bash -n <this file>     # syntax check
#   run shellcheck on this file (if available)
#   ./<this file>           # run it (a human runs this, not an agent)

set -uo pipefail

# ---------------------------------------------------------------- library ---

TOTAL_STAGES=${TOTAL_STAGES:-0}
STAGE_NO=0
ENV_FILE=${ENV_FILE:-.env}
SUMMARY=()

c_reset=$'\033[0m'; c_dim=$'\033[2m'; c_bold=$'\033[1m'
c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_blue=$'\033[36m'

say()  { printf '%s\n' "$*"; }
step() { printf '  %s->%s %s\n' "$c_blue" "$c_reset" "$*"; }
note() { printf '  %s%s%s\n' "$c_dim" "$*" "$c_reset"; }
warn() { printf '  %s! %s%s\n' "$c_yellow" "$*" "$c_reset"; }
die()  { printf '\n%serror:%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }

# stage "<title>": clear the screen and start a numbered stage.
stage() {
  STAGE_NO=$((STAGE_NO + 1))
  clear 2>/dev/null || true
  printf '%s[%d/%d] %s%s\n\n' "$c_bold" "$STAGE_NO" "$TOTAL_STAGES" "$1" "$c_reset"
}

# open_url "<url>": open it in the human's browser, on Linux, macOS or WSL.
open_url() {
  local url=$1
  step "opening $url"
  if command -v xdg-open >/dev/null 2>&1;      then xdg-open "$url" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1;        then open "$url" >/dev/null 2>&1 &
  elif command -v wslview >/dev/null 2>&1;     then wslview "$url" >/dev/null 2>&1 &
  elif [ -x /mnt/c/Windows/System32/cmd.exe ]; then /mnt/c/Windows/System32/cmd.exe /c start "" "$url" >/dev/null 2>&1 &
  else note "open it yourself: $url"; fi
  sleep 1
}

# ask "<prompt>" VARNAME [default]: read a visible value.
ask() {
  local prompt=$1 var=$2 def=${3:-} val=""
  if [ -n "$def" ]; then read -r -p "  $prompt [$def]: " val; val=${val:-$def}
  else while [ -z "$val" ]; do read -r -p "  $prompt: " val; done; fi
  printf -v "$var" '%s' "$val"
}

# ask_secret "<prompt>" VARNAME: read a value without echoing it.
ask_secret() {
  local prompt=$1 var=$2 val=""
  while [ -z "$val" ]; do read -r -s -p "  $prompt: " val; printf '\n'; done
  printf -v "$var" '%s' "$val"
}

# confirm "<question>": yes/no gate. Anything but y/yes aborts the wizard.
confirm() {
  local ans=""
  read -r -p "  $1 [y/N]: " ans
  case "$ans" in y|Y|yes|YES) return 0 ;; *) die "stopped at stage $STAGE_NO by the operator" ;; esac
}

# pause: wait for the human to finish something in the browser.
pause() { read -r -p "  press enter when done "; }

# write_env KEY "<value>": idempotent upsert into $ENV_FILE (0600).
write_env() {
  local key=$1 value=$2
  [ -f "$ENV_FILE" ] || { : > "$ENV_FILE"; chmod 600 "$ENV_FILE"; }
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    local tmp; tmp=$(mktemp)
    # grep exits 1 when it removes the only line, so never chain mv on its status
    grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true
    mv "$tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  step "wrote $key to $ENV_FILE"
  SUMMARY+=("$key -> $ENV_FILE")
}

# set_secret NAME "<value>" [owner/repo]: a GitHub Actions secret. The value
# reaches gh on stdin, which gh reads when --body is NOT given (`--body -`
# stores a literal "-"), and the secret's updated_at is read back.
set_secret() {
  local name=$1 value=$2 repo=${3:-} since
  command -v gh >/dev/null 2>&1 || { warn "gh not installed; skipped secret $name"; return 0; }
  case "$value" in ""|-) warn "refusing to store an empty or '-' value in $name"; return 1 ;; esac
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ -n "$repo" ]; then printf '%s' "$value" | gh secret set "$name" -R "$repo" >/dev/null
  else printf '%s' "$value" | gh secret set "$name" >/dev/null; fi \
    || { warn "could not set secret $name"; return 1; }
  local at; at=$(gh api "repos/${repo:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}/actions/secrets/$name" -q .updated_at 2>/dev/null)
  if [ -n "$at" ] && [ ! "$at" \< "$since" ]; then
    step "set GitHub secret $name (updated $at)"; SUMMARY+=("$name -> GitHub secret ${repo:-current repo}")
  else
    warn "secret $name was not updated (updated_at ${at:-unknown}, want ${since} or later)"; return 1
  fi
}

# set_var NAME "<value>" [owner/repo]: a GitHub Actions variable (not secret).
set_var() {
  local name=$1 value=$2 repo=${3:-}
  command -v gh >/dev/null 2>&1 || { warn "gh not installed; skipped variable $name"; return 0; }
  if [ -n "$repo" ]; then gh variable set "$name" -R "$repo" --body "$value" >/dev/null
  else gh variable set "$name" --body "$value" >/dev/null; fi \
    && { step "set GitHub variable $name"; SUMMARY+=("$name -> GitHub variable ${repo:-current repo}"); } \
    || warn "could not set variable $name"
}

finish() {
  clear 2>/dev/null || true
  printf '%s%sdone%s\n\n' "$c_bold" "$c_green" "$c_reset"
  if [ ${#SUMMARY[@]} -gt 0 ]; then
    say "What this wizard wrote:"
    printf '  - %s\n' "${SUMMARY[@]}"
    printf '\n'
  fi
  say "Nothing above printed a secret value. Keep $ENV_FILE out of git."
}

# ------------------------------------------------------------------ STAGES ---
# Author below this line. One `stage` per step, in dependency order.
# Set TOTAL_STAGES to the number of stages you wrote.

TOTAL_STAGES=6

# ---------------------------------------------------------------------------
# agentry-mcp: what the signed release needs that only the operator holds.
#
#   1. the `release` environment, admitting only main and v* tags;
#   2. AGENTRY_UPDATE_SIGNING_KEY, the estate's update-signing key, decrypted
#      from your password-protected backup into memory and piped into the
#      environment's secret — the decrypted key never touches disk or the
#      terminal; the backup's password sits in a 0600 file inside a 0700
#      temporary directory while the helper reads it, removed on exit,
#      failure or interrupt;
#   3. AGENTRY_BUILD_TOKEN, a token that can read blaktron/agentry-desktop,
#      where the signer lives;
#   4. a dry run of the release workflow on main.
#
# Run it from a clone of agentry-mcp, on a machine with gh signed in as an
# account that administers blaktron/agentry-mcp, and Go installed. Safe to
# re-run: every stage replaces what it sets.
# ---------------------------------------------------------------------------

REPO="blaktron/agentry-mcp"
ENV_NAME="release"
KEY_SECRET="AGENTRY_UPDATE_SIGNING_KEY"
TOKEN_SECRET="AGENTRY_BUILD_TOKEN"
WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; return 0; }
trap cleanup EXIT
trap 'cleanup; printf "\n"; die "interrupted"' INT TERM

stage "Where you are"
[ -f .github/workflows/release.yaml ] || die "run this from the root of an agentry-mcp clone"
command -v gh >/dev/null 2>&1 || die "gh is needed; install it and sign in"
command -v go >/dev/null 2>&1 || die "Go is needed to decrypt the key backup"
gh auth status >/dev/null 2>&1 || die "gh is not signed in: run 'gh auth login'"
admin=$(gh api "repos/$REPO" --jq '.permissions.admin' 2>/dev/null)
[ "$admin" = "true" ] || die "the account gh is signed in as does not administer $REPO"
PIN=$(sed -n 's/^  DESKTOP_SIGNRELEASE_REF: *//p' .github/workflows/release.yaml)
[ -n "$PIN" ] || die "no DESKTOP_SIGNRELEASE_REF in .github/workflows/release.yaml"
step "repository $REPO (you administer it)"
step "the release signs with the desktop's signrelease at $PIN"
say ""
say "Nothing this wizard does prints a secret. It sets an environment and two"
say "of its secrets on $REPO, then runs the release workflow once as a dry run."
confirm "carry on?"

stage "The release environment"
say "The release job runs in '$ENV_NAME', and the signing key is its secret, so"
say "only a job on main or a v* tag can read it — the desktop's policy."
say ""
gh api -X PUT "repos/$REPO/environments/$ENV_NAME" --input - >/dev/null <<'JSON' || die "could not create the environment"
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
step "environment '$ENV_NAME' exists, with custom deployment policies"
have=$(gh api "repos/$REPO/environments/$ENV_NAME/deployment-branch-policies" --jq '.branch_policies[] | .type+":"+.name' 2>/dev/null)
for want in "branch:main" "tag:v*"; do
  if printf '%s\n' "$have" | grep -qx "$want"; then
    step "policy $want already there"
  else
    gh api -X POST "repos/$REPO/environments/$ENV_NAME/deployment-branch-policies" \
      -f name="${want#*:}" -f type="${want%%:*}" >/dev/null || die "could not add policy $want"
    step "added policy $want"
  fi
done
extra=$(printf '%s\n' "$have" | grep -vx -e "branch:main" -e "tag:v\*" | grep -v '^$' || true)
[ -z "$extra" ] || warn "the environment also admits: $extra — remove it in the repository settings unless you meant it"
SUMMARY+=("environment $ENV_NAME on $REPO -> main and v* tags")
pause

stage "The update-signing key, from your backup"
say "The release signs with the SAME key the desktop does; its public half is"
say "already in the desktop's committed key set. You need the password-protected"
say "backup the desktop's update-signing-key.sh wrote when the key was made."
say ""
ask "path to the key backup" BACKUP_PATH
BACKUP_PATH=${BACKUP_PATH/#\~/$HOME}
[ -f "$BACKUP_PATH" ] || die "$BACKUP_PATH is not a file"
ask_secret "the backup's password" BACKUP_PASSWORD
WORK=$(mktemp -d)
chmod 700 "$WORK"
( umask 077; printf '%s' "$BACKUP_PASSWORD" > "$WORK/password" )
BACKUP_PASSWORD=""
# A throwaway module with the one library the desktop signs with, at the
# desktop's version: it decrypts the backup onto stdout (a pipe) and prints
# the key id on stderr.
mkdir -p "$WORK/unprotect"
cat > "$WORK/unprotect/main.go" <<'GO'
package main

import (
	"fmt"
	"os"
	"strings"

	"aead.dev/minisign"
)

func main() {
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		fail("reading the backup: %v", err)
	}
	raw = []byte(strings.TrimSpace(string(raw)))
	pass, err := os.ReadFile(os.Args[2])
	if err != nil {
		fail("reading the password: %v", err)
	}
	var priv minisign.PrivateKey
	if minisign.IsEncrypted(raw) {
		if priv, err = minisign.DecryptKey(strings.TrimRight(string(pass), "\r\n"), raw); err != nil {
			fail("the backup did not decrypt: is the password right? (%v)", err)
		}
	} else if err = priv.UnmarshalText(raw); err != nil {
		fail("not a minisign secret key: %v", err)
	}
	text, err := priv.MarshalText()
	if err != nil {
		fail("encoding the key: %v", err)
	}
	fmt.Fprintf(os.Stderr, "%016X\n", priv.Public().(minisign.PublicKey).ID())
	os.Stdout.Write(text)
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "unprotect: "+format+"\n", a...)
	os.Exit(1)
}
GO
( cd "$WORK/unprotect" && go mod init unprotect >/dev/null 2>&1 \
    && GOWORK=off GOFLAGS=-mod=mod go get aead.dev/minisign@v0.3.0 >/dev/null 2>&1 \
    && GOWORK=off go build -o "$WORK/unprotect-bin" . ) || die "could not build the decryption helper"
KEY_ID=$("$WORK/unprotect-bin" "$BACKUP_PATH" "$WORK/password" 2>&1 >/dev/null) || die "$KEY_ID"
step "the backup decrypts; its key id is $KEY_ID"
# The key the pinned desktop commit carries as current: the signer refuses any
# other, so loading one would only fail the release later.
CURRENT=$(gh api "repos/blaktron/agentry-desktop/contents/internal/selfupdate/keys.json?ref=$PIN" \
  -H "Accept: application/vnd.github.raw" --jq '.keys[] | select(.retired != true) | .keyID' 2>/dev/null)
[ -n "$CURRENT" ] || die "could not read the desktop's key set at $PIN"
printf '%s\n' "$CURRENT" | grep -qx "$KEY_ID" \
  || die "key $KEY_ID is not a current key of the desktop's key set at $PIN (current: $(printf '%s' "$CURRENT" | tr '\n' ' ')) — wrong backup?"
step "$KEY_ID is a current key of the desktop's committed key set"
confirm "load it as $KEY_SECRET of the '$ENV_NAME' environment on $REPO?"
# Decrypted into this shell's memory, never a file, and checked non-empty
# before anything is sent, so a failed decrypt cannot set an empty secret.
KEY_TEXT=$("$WORK/unprotect-bin" "$BACKUP_PATH" "$WORK/password" 2>/dev/null) || die "the backup did not decrypt the second time"
rm -rf "$WORK"; WORK=""
case "$KEY_TEXT" in *"secret key"*) ;; *) KEY_TEXT=""; die "the decrypted key is not a minisign secret key" ;; esac
printf '%s\n' "$KEY_TEXT" | gh secret set "$KEY_SECRET" -R "$REPO" --env "$ENV_NAME" >/dev/null \
  || { KEY_TEXT=""; die "could not set $KEY_SECRET"; }
KEY_TEXT=""
step "set $KEY_SECRET (environment $ENV_NAME); the decrypted key touched no disk"
SUMMARY+=("$KEY_SECRET -> $REPO, environment $ENV_NAME (key $KEY_ID)")
pause

stage "A token that can read the signer's module"
say "The signer is installed from blaktron/agentry-desktop, a private module."
say "The release needs a token that can read it: the value the desktop and CLI"
say "repositories hold as AGENTRY_BUILD_TOKEN serves, or a fine-grained token"
say "with Contents: read on blaktron/agentry-desktop and nothing else."
say ""
open_url "https://github.com/settings/personal-access-tokens"
note "Only if you are making a new one; otherwise paste the existing value."
ask_secret "the token" BUILD_TOKEN
full=$(GH_TOKEN="$BUILD_TOKEN" gh api repos/blaktron/agentry-desktop --jq '.full_name' 2>/dev/null)
[ "$full" = "blaktron/agentry-desktop" ] || { BUILD_TOKEN=""; die "that token cannot read blaktron/agentry-desktop"; }
step "the token reads blaktron/agentry-desktop"
printf '%s' "$BUILD_TOKEN" | gh secret set "$TOKEN_SECRET" -R "$REPO" --env "$ENV_NAME" >/dev/null \
  || { BUILD_TOKEN=""; die "could not set $TOKEN_SECRET"; }
BUILD_TOKEN=""
step "set $TOKEN_SECRET (environment $ENV_NAME)"
SUMMARY+=("$TOKEN_SECRET -> $REPO, environment $ENV_NAME")
pause

stage "Keep signing on"
say "The release signs where it can and ships unsigned where it cannot:"
say "with neither secret a tag is released unsigned, and says so. Now that both"
say "exist, AGENTRY_REQUIRE_SIGNING=true makes a missing one fail the release, so"
say "a recreated environment or a deleted secret cannot quietly turn signing off."
set_var AGENTRY_REQUIRE_SIGNING true "$REPO"
pause

stage "Check what is set"
gh secret list -R "$REPO" --env "$ENV_NAME" | sed 's/^/  /'
gh api "repos/$REPO/environments/$ENV_NAME/deployment-branch-policies" \
  --jq '.branch_policies[] | "  admits " + .type + " " + .name'
say ""
note "Names and dates only: GitHub never shows a secret's value back."
pause

stage "A dry run of the release on main"
say "workflow_dispatch runs the release exactly as a tag does — package, smoke,"
say "sign — and the site's importer refuses its bundle as a dry run. Green here"
say "means the first tag will sign."
say ""
if gh workflow view release -R "$REPO" --ref main >/dev/null 2>&1; then
  confirm "dispatch the release dry run on main now?"
  SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run release -R "$REPO" --ref main || die "could not dispatch the release workflow"
  RUN_ID=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sleep 5
    RUN_ID=$(gh run list -R "$REPO" --workflow release --event workflow_dispatch --limit 5 \
      --json databaseId,createdAt --jq "[.[] | select(.createdAt >= \"$SINCE\")] | last | .databaseId // empty")
    [ -n "$RUN_ID" ] && break
  done
  [ -n "$RUN_ID" ] || die "the dispatched run did not appear within a minute; find it under Actions › release"
  step "run $RUN_ID: https://github.com/$REPO/actions/runs/$RUN_ID"
  gh run watch "$RUN_ID" -R "$REPO" --exit-status && step "the dry run is green" \
    || warn "the dry run did not pass; its log says which step"
  SUMMARY+=("release dry run $RUN_ID")
else
  warn "release.yaml is not on main yet; run this stage later with:"
  note "gh workflow run release -R $REPO --ref main"
fi
pause

finish
