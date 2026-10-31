# Contributing to agentry-mcp

This repository holds an MCP server that drives the `agentry` CLI already
installed on the machine. It bundles no CLI and holds no credential: the
login, the consent memory and the runner policy are the CLI's. Its job is to
turn typed tool arguments into a CLI command line and to return the CLI's
own JSON.

## Before you start

- **Security issues do not go in pull requests or public issues.** See
  [SECURITY.md](SECURITY.md).
- Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- For a large change, open an issue first. A tool that needs something the
  CLI cannot do yet starts in the CLI,
  [blaktron/agentry-cli](https://github.com/blaktron/agentry-cli).

## Contributing from outside

Fork, branch from `dev`, and open a pull request against `dev`. `dev` is
where changes land, and `main` takes only promotions from `dev` (the
`branch-model` check fails any other pull request into `main`). A
maintainer approves the CI run for a first-time contributor. Sign off every
commit (see "Certificate of origin" below), keep a change to one concern,
and say in the pull request what you verified and how.

## Development setup

You need Node 24 or newer. The tests run against a fake `agentry` CLI, so
they do not need the real one.

| Command                   | What                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `npm ci`                  | install the locked dependencies                                            |
| `npm run check`           | type check, prettier, the prose gate and the tests: run it before you push |
| `npm run build`           | compile into `dist/`                                                       |
| `npm test`                | build, then run the tests in `test/`                                       |
| `npm run format`          | `prettier --write .`                                                       |
| `npm run workflows-check` | the workflow fork-guard check (needs python3 with PyYAML)                  |

`scripts/package.sh <version> <out-dir>` builds the downloadable tarball, and
`node scripts/package-smoke.mjs <tarball>` unpacks it and starts the server.
CI runs both on every pull request.

## The rules that matter

**An argv, never a shell string.** Every tool builds the CLI's command line
as an argument array from typed, validated arguments (`src/argv.ts`,
`src/toolargs.ts`). Nothing a tool receives is ever passed through a shell
or concatenated into a command.

**Anything that writes or runs asks for consent.** A tool that installs,
removes, runs or writes asks for the same consent the CLI asks for on a
terminal (`src/consent.ts`). A new tool of that kind states its consent
facts and has a test that it does not proceed without consent.

**The server never sees a credential.** Signing in happens once, in a
terminal, with `agentry login`. The server reads no token and passes none
through a tool argument.

**The tool list matches the documentation.** A new tool or argument updates
the tool table in the [README](README.md) and [SKILL.md](SKILL.md) in the
same pull request.

## Code style

Match the file you are editing. TypeScript strict mode; prettier formats
everything (`npm run format`). Commits follow conventional commits
(`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`, `chore:`,
`security:`, `deps:`), and a release's notes are generated from the merged
pull requests.

## Certificate of origin

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. Sign off your commits:

```bash
git commit -s -m "fix(run): refuse an empty QuickAgent reference"
```

By signing off you state that you wrote the contribution or have the right
to submit it under the project's licence.

## Licensing

The project licence is MIT ([LICENSE](LICENSE)). Do not add dependencies
under the AGPL or the GPL. A new dependency needs a line in the pull request
that explains why an existing one will not do.

## Releasing

Releases are cut by the maintainers. Each one is a `vX.Y.Z` tag that names
the version in `package.json` and `src/server.ts`, with a GitHub Release
carrying the signed tarball.
