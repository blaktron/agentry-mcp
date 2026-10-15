# secureagentry-mcp

A standalone MCP server in the `agentry-mcp` repository, separate from the
server at the repository root (which drives the installed `agentry` CLI). It
has its own `package.json`, build and tests, and a CI job of its own. Its
`package.json` names the package `@blaktron/agentry-mcp`.

An MCP server for **Agentry account and repository automation**. It gives an
agent the account, organization and agent-repository surface of an Agentry
registry as tools, and reaches the rest of the API through a searchable catalog
generated from the contract itself.

Local stdio server, TypeScript, built on the official
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).

## What it exposes

**27 dedicated tools** for the work this exists to automate, and **2 catalog
tools** for everything else.

| Area            | Tools                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity        | `agentry_whoami`, `agentry_update_profile`                                                                                                  |
| Tokens          | `agentry_list_tokens`, `agentry_create_token`, `agentry_revoke_token`                                                                       |
| SSH keys        | `agentry_list_ssh_keys`, `agentry_add_ssh_key`, `agentry_remove_ssh_key`                                                                    |
| Sessions        | `agentry_list_sessions`, `agentry_revoke_session`                                                                                           |
| Organizations   | `agentry_create_org`, `agentry_get_org`, `agentry_list_org_members`, `agentry_set_org_member`, `agentry_remove_org_member`                  |
| Agents / repos  | `agentry_search_agents`, `agentry_list_agents`, `agentry_get_agent`, `agentry_create_agent`, `agentry_update_agent`, `agentry_delete_agent` |
| Versions        | `agentry_list_versions`, `agentry_get_version`, `agentry_yank_version`, `agentry_resolve`                                                   |
| Access          | `agentry_list_grants`, `agentry_set_grant`                                                                                                  |
| Everything else | `agentry_search_actions`, `agentry_execute_action`                                                                                          |

The catalog behind the last two carries every operation in the Agentry API
(152 in the vendored contract) — review queues, org policy, SSO and SCIM, webhooks, domain claims,
advisories, audit exports, platform trust-and-safety — so the long tail is
reachable without spending 120 tool schemas of context on it. The model
searches by intent, reads one operation's schema, and executes it.

**Publishing has no dedicated tool here.** Versions reach a registry by pushing
a tag or by the CLI uploading an archive it built, so that what is scanned is
what was published. Wrapping `submitVersion` in a tool of its own would invite
an agent to publish something it had not built. The catalog tools can still
reach that operation, so the server's instructions tell the model not to.

## Install

Requires Node 20 or newer.

```bash
git clone https://github.com/blaktron/agentry-mcp && cd agentry-mcp/secureagentry-mcp
npm ci
npm run build
```

Register it with Claude Code:

```bash
claude mcp add agentry --env AGENTRY_REGISTRY=https://registry.example.test \
  -- node /path/to/agentry-mcp/secureagentry-mcp/dist/index.js
```

Or, in any MCP host's config:

```json
{
  "mcpServers": {
    "agentry": {
      "command": "node",
      "args": ["/path/to/agentry-mcp/secureagentry-mcp/dist/index.js"],
      "env": { "AGENTRY_REGISTRY": "https://registry.example.test" }
    }
  }
}
```

## Configuration

Credentials resolve the same way the `agentry` CLI resolves them, reading the
same config file the CLI writes at login. If you can already use the CLI, the
server needs no configuration beyond the registry URL, and there is one place to
rotate a credential rather than two.

| Variable                 | Meaning                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `AGENTRY_REGISTRY`       | Registry origin. Falls back to `defaultRegistry` in the CLI config.                         |
| `AGENTRY_TOKEN`          | An `agy_…` personal access token. Falls back to the token the CLI stored for this registry. |
| `AGENTRY_SESSION_COOKIE` | Value of the `agentry_session` cookie, for the routes that refuse PATs (below).             |
| `AGENTRY_CONFIG_DIR`     | Relocates the client config directory. Default `~/.config/agentry`.                         |
| `AGENTRY_MCP_READ_ONLY`  | `1`, `true`, `yes` or `on` refuses every write.                                             |
| `AGENTRY_MCP_TIMEOUT_MS` | Per-request timeout. Default 30000.                                                         |
| `AGENTRY_MCP_MAX_CHARS`  | Character budget for a single tool result. Default 60000.                                   |

Run `agentry_whoami` first in any session: it reports the registry, where the
credential came from, whether writes are enabled, and who the account is.

## Two things the API does that will otherwise surprise you

**Some routes refuse personal access tokens entirely.** Token minting and
revocation, SSH keys, session management, 2FA and account erasure are
browser-session routes: the API rejects a PAT there whatever its scopes. This
server knows which eleven operations those are, extracted from the registry's
own authorization table rather than guessed. It refuses them _before_ the
request goes out, with a message saying to set `AGENTRY_SESSION_COOKIE`. A bare
403 does not say why, so an agent reading one retries with different scopes
forever.

**Agent settings, grants and deletion need the `org:admin` scope**, even for an
agent in your own personal namespace: `updateAgent`, `deleteAgent` and the grant
routes all map to `agent.maintain`, which requires `org:admin`. A token minted
for publishing (`agent:publish`, `agent:read`, `repo:read`, `repo:write`) can
create an agent but cannot then change or delete it. Mint accordingly.

## Safety

- **A minted token is never printed by default.** `agentry_create_token`
  redacts the secret, which the registry returns exactly once; pass
  `revealSecret: true` only when the operator has asked for the value itself.
  The server redacts anything that looks like a PAT wherever it appears in any
  response.
- **Read-only mode.** `AGENTRY_MCP_READ_ONLY=1` refuses every non-GET,
  including through `agentry_execute_action`.
- **Annotations.** Every tool declares `readOnlyHint` and, where it writes,
  `destructiveHint`, so a host can gate the dangerous ones.
- **Dry runs.** `agentry_execute_action` takes `dryRun: true` to show what
  would be sent without sending it.

## How the catalog stays honest

`src/catalog.generated.ts` is generated from two vendored files, both copied
from `blaktron/agentry` with their source commit recorded in
`spec/PROVENANCE.json`:

- `spec/openapi.yaml` — the API contract, the source of every path, parameter
  and body schema.
- `spec/session-only.json` — the operations that refuse PATs, extracted from
  `internal/api/authz_routes.go`, because that fact is not expressible in
  OpenAPI but decides whether a tool can work at all.

To track an API change:

```bash
npm run sync-spec      # re-vendor both files from ../../agentry (or a path you pass), regenerate
npm test
```

CI regenerates the catalog and fails if it differs from what is committed, and a
test checks the catalog's recorded spec hash against the vendored file. Neither
check can see the vendored copy falling behind the registry's live contract. The
sync above is what closes that gap, and the provenance file records the commit
that sync last ran against.

## Development

```bash
npm run check     # typecheck, format check, and the full test suite
npm test          # builds, then runs the tests against dist/
npm run generate  # regenerate the catalog from the vendored spec
```

The tests run against the built output, so what is tested is what ships. They
drive the tool surface end to end over an in-memory MCP transport with the
registry stubbed. Between them they cover credential resolution, the request
seam (path expansion, pagination, problem+json translation, both pre-flight
refusals), redaction and catalog search. They check every tool's description and
annotations, and call the ones that shape a request to assert what goes out.

## Licence

MIT.
