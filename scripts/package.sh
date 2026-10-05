#!/usr/bin/env bash
# The downloadable server (agentry-mcp#32): one self-contained tarball,
# agentry-mcp-<version>.tar.gz, holding the built server, its production
# dependencies, the README and the licence under one top-level directory
# agentry-mcp-<version>/. A person unpacks it anywhere and points their host at
# dist/index.js; nothing is installed and no network is needed after the
# download. The release workflow calls this, and so does CI on every pull
# request, so what a tag ships is what the gate built.
#
#   scripts/package.sh VERSION OUT_DIR
#
# The tarball is reproducible from a commit: a clean dist/, entries sorted by
# name, every mtime set to the commit's time, owner and group 0, modes
# normalised (so the caller's umask does not leak in), gzip without a name or
# a timestamp. Two runs on one commit produce the same digest (CI checks
# this). No install script runs anywhere: neither the server's two runtime
# dependencies nor its dev tools need one, and the release packages in a job
# that later jobs trust.
set -euo pipefail

usage() { echo "usage: scripts/package.sh VERSION OUT_DIR" >&2; exit 2; }
[ $# -eq 2 ] || usage
version=$1
out=$2
# A version is part of a file name the site's importer parses: letters,
# digits, dots and dashes only.
[[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z.-]*$ ]] || { echo "package.sh: '$version' is not a version" >&2; exit 2; }

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
name="agentry-mcp-$version"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cd "$root"
rm -rf dist
npm ci --ignore-scripts --no-audit --no-fund
npm run build

dest="$stage/$name"
mkdir -p "$dest"
cp -R dist package.json package-lock.json README.md SKILL.md LICENSE "$dest/"
# Production dependencies only, from the lockfile, with no install scripts: the
# two runtime dependencies are plain JavaScript, so the tarball serves every
# platform Node runs on.
(cd "$dest" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
rm -f "$dest/node_modules/.package-lock.json"

epoch=$(git -C "$root" log -1 --format=%ct)
mkdir -p "$out"
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner --format=gnu \
  --mode='u+rwX,go+rX,go-w' \
  -C "$stage" -cf - "$name" | gzip -n -9 > "$out/$name.tar.gz"
echo "$out/$name.tar.gz"
