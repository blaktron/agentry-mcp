# Security policy

agentry-mcp is part of the Agentry open core; one policy covers all of it.
**Do not open a public issue for a security vulnerability.**

Report it as described in the core's
[SECURITY.md](https://github.com/blaktron/agentry/blob/main/SECURITY.md):
email **security@secureagentry.net** (or use GitHub's private vulnerability
reporting on this repository) with what you found, how to reproduce it and
what an attacker gains. The same response targets apply (a human reads it
within 2 business days; an assessment within 5; a fix or mitigation for
high/critical issues within 30 days; credit with the advisory if you want it).

Particularly interesting here:

- **Credential exposure** — the personal access token (from `AGENTRY_TOKEN`
  or the CLI's config) reaching a tool result, a log, or an error message;
  a token minted through a tool shown more than the once the registry
  returns it.
- **Scope escape** — a tool doing something the token's scopes or the
  registry's authorization would refuse, or reaching a session-only route
  with a token (the server refuses those by design, `spec/session-only.json`).
- **Catalog injection** — a registry response steering the catalog's
  search/execute path into a request the user did not ask for.

Malicious content on a registry is reported to that registry (the report
control on the agent page, or its abuse address), not here.
