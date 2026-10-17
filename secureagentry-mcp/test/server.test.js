// The tool surface as a client sees it, driven end to end over an in-memory
// transport with the registry stubbed out.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../dist/server.js";
import { connectServer } from "../dist/toolargs.js";

const CONFIG = {
  registry: "https://registry.example",
  apiBase: "https://registry.example/api/v1",
  token: "agy_test",
  credentialSource: "AGENTRY_TOKEN",
  readOnly: false,
  timeoutMs: 5000,
  maxResponseChars: 60000,
};

/** Answers each request from a {method path: body} table, recording calls. */
function stubRegistry(routes = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const { pathname, searchParams } = new URL(url.toString());
    const key = `${init.method} ${pathname}`;
    calls.push({ key, searchParams, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[key];
    if (route === undefined) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (typeof route === "number") {
      return new Response(JSON.stringify({ title: "Nope", status: route }), { status: route });
    }
    return new Response(JSON.stringify(route), { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

async function connect(config = {}, fetchImpl = stubRegistry()) {
  const server = createServer({ ...CONFIG, ...config }, fetchImpl);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientSide), connectServer(server, serverSide)]);
  return { client, fetchImpl, close: () => client.close() };
}

/** Flatten a tool result to its text, asserting on whether it errored. */
async function callText(client, name, args = {}, { expectError = false } = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(!!result.isError, expectError, `${name}: ${JSON.stringify(result.content)}`);
  return result.content.map((c) => c.text ?? "").join("\n");
}

test("every tool is described, annotated and named consistently", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();

  assert.ok(tools.length >= 25, `only ${tools.length} tools`);
  for (const tool of tools) {
    assert.match(tool.name, /^agentry_[a-z0-9_]+$/, tool.name);
    assert.ok(tool.name.length <= 64, `${tool.name} is too long for the 64-character limit`);
    assert.ok(
      tool.description && tool.description.length > 40,
      `${tool.name} needs a real description`,
    );
    assert.ok(tool.annotations, `${tool.name} has no annotations`);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", tool.name);
    // A tool that writes must say whether it destroys, so a host can gate it.
    if (tool.annotations.readOnlyHint === false) {
      assert.equal(typeof tool.annotations.destructiveHint, "boolean", tool.name);
    }
  }
  await close();
});

test("the tools that delete or revoke are flagged destructive", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const name of [
    "agentry_delete_agent",
    "agentry_yank_version",
    "agentry_revoke_token",
    "agentry_remove_ssh_key",
    "agentry_revoke_session",
    "agentry_remove_org_member",
  ]) {
    assert.equal(byName[name].annotations.destructiveHint, true, name);
  }
  await close();
});

test("the instructions tell the model the rules it cannot infer", async () => {
  const { client, close } = await connect();
  const instructions = client.getInstructions();
  assert.match(instructions, /never as safe/i);
  assert.match(instructions, /yanked/i);
  assert.match(instructions, /Publishing is not exposed here/i);
  await close();
});

test("read-only mode is announced in the instructions", async () => {
  const { client, close } = await connect({ readOnly: true });
  assert.match(client.getInstructions(), /read-only/i);
  await close();
});

test("whoami reports the registry, the credential and the account", async () => {
  const fetchImpl = stubRegistry({
    "GET /api/v1/meta": { version: "1.2.3" },
    "GET /api/v1/user": { handle: "someone", displayName: "Someone" },
  });
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(client, "agentry_whoami");
  assert.match(text, /https:\/\/registry\.example/);
  assert.match(text, /AGENTRY_TOKEN/);
  assert.match(text, /"handle": "someone"/);
  await close();
});

test("whoami with no credential says so instead of calling a protected route", async () => {
  const fetchImpl = stubRegistry({ "GET /api/v1/meta": { version: "1.2.3" } });
  const { client, close } = await connect(
    { token: undefined, credentialSource: "none" },
    fetchImpl,
  );
  const text = await callText(client, "agentry_whoami");
  assert.match(text, /Not authenticated/);
  assert.ok(!fetchImpl.calls.some((c) => c.key === "GET /api/v1/user"));
  await close();
});

test("get_agent folds in stats only when asked", async () => {
  const fetchImpl = stubRegistry({
    "GET /api/v1/agents/acme/linter": { name: "linter" },
    "GET /api/v1/agents/acme/linter/stats": { stars: 4 },
  });
  const { client, close } = await connect({}, fetchImpl);

  await callText(client, "agentry_get_agent", { namespace: "acme", name: "linter" });
  assert.equal(fetchImpl.calls.filter((c) => c.key.endsWith("/stats")).length, 0);

  const text = await callText(client, "agentry_get_agent", {
    namespace: "acme",
    name: "linter",
    includeStats: true,
  });
  assert.match(text, /"stars": 4/);
  await close();
});

test("create_agent sends the body the contract expects", async () => {
  const fetchImpl = stubRegistry({ "POST /api/v1/agents": { name: "linter" } });
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(client, "agentry_create_agent", {
    namespace: "acme",
    name: "linter",
    modes: ["autonomous"],
    summary: "lints",
  });
  assert.deepEqual(fetchImpl.calls[0].body, {
    namespace: "acme",
    name: "linter",
    modes: ["autonomous"],
    summary: "lints",
  });
  assert.match(text, /Created acme\/linter and its git repository/);
  await close();
});

test("update_agent with nothing to change reads the agent back instead of sending an empty patch", async () => {
  const fetchImpl = stubRegistry({ "GET /api/v1/agents/acme/linter": { name: "linter" } });
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(client, "agentry_update_agent", {
    namespace: "acme",
    name: "linter",
  });
  assert.match(text, /Nothing to change/);
  assert.ok(!fetchImpl.calls.some((c) => c.key.startsWith("PATCH")));
  await close();
});

test("update_agent sends only the fields given", async () => {
  const fetchImpl = stubRegistry({ "PATCH /api/v1/agents/acme/linter": { name: "linter" } });
  const { client, close } = await connect({}, fetchImpl);
  await callText(client, "agentry_update_agent", {
    namespace: "acme",
    name: "linter",
    allowForcePush: false,
  });
  assert.deepEqual(fetchImpl.calls[0].body, { allowForcePush: false });
  await close();
});

test("set_grant routes users and teams to their own endpoints", async () => {
  const fetchImpl = stubRegistry();
  const { client, close } = await connect({}, fetchImpl);

  await callText(client, "agentry_set_grant", {
    namespace: "acme",
    name: "linter",
    subjectType: "user",
    subject: "someone",
    role: "write",
  });
  assert.equal(fetchImpl.calls.at(-1).key, "PUT /api/v1/agents/acme/linter/grants/user/someone");
  assert.deepEqual(fetchImpl.calls.at(-1).body, { role: "write" });

  await callText(client, "agentry_set_grant", {
    namespace: "acme",
    name: "linter",
    subjectType: "team",
    subject: "platform",
    role: "publish",
  });
  assert.equal(fetchImpl.calls.at(-1).key, "PUT /api/v1/agents/acme/linter/grants/team/platform");
  await close();
});

test("set_grant with role none deletes the grant", async () => {
  const fetchImpl = stubRegistry();
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(client, "agentry_set_grant", {
    namespace: "acme",
    name: "linter",
    subjectType: "user",
    subject: "someone",
    role: "none",
  });
  assert.equal(fetchImpl.calls.at(-1).key, "DELETE /api/v1/agents/acme/linter/grants/user/someone");
  assert.equal(fetchImpl.calls.at(-1).body, undefined);
  assert.match(text, /Removed the user grant/);
  await close();
});

test("search_agents maps its friendly names onto the contract's query parameters", async () => {
  const fetchImpl = stubRegistry({ "GET /api/v1/search": { results: [] } });
  const { client, close } = await connect({}, fetchImpl);
  await callText(client, "agentry_search_agents", { query: "lint", mode: "interactive", limit: 5 });
  const { searchParams } = fetchImpl.calls[0];
  assert.equal(searchParams.get("q"), "lint");
  assert.equal(searchParams.get("mode"), "interactive");
  assert.equal(searchParams.get("limit"), "5");
  await close();
});

test("a minted token is redacted unless the caller opts in", async () => {
  const fetchImpl = stubRegistry({
    "POST /api/v1/user/tokens": { id: "1", token: "agy_freshsecret1" },
  });
  const { client, close } = await connect({ sessionCookie: "s3ss" }, fetchImpl);

  const hidden = await callText(client, "agentry_create_token", {
    name: "ci",
    scopes: ["agent:read"],
  });
  assert.doesNotMatch(hidden, /agy_freshsecret1/);
  assert.match(hidden, /redacted/);

  const shown = await callText(client, "agentry_create_token", {
    name: "ci",
    scopes: ["agent:read"],
    revealSecret: true,
  });
  assert.match(shown, /agy_freshsecret1/);
  assert.match(shown, /treat the transcript as a credential/);
  await close();
});

test("a session-only tool explains itself rather than returning a bare 403", async () => {
  const fetchImpl = stubRegistry();
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(
    client,
    "agentry_create_token",
    {
      name: "ci",
      scopes: ["agent:read"],
    },
    { expectError: true },
  );
  assert.match(text, /AGENTRY_SESSION_COOKIE/);
  assert.equal(fetchImpl.calls.length, 0);
  await close();
});

test("revoke_session revokes one or all others depending on the argument", async () => {
  const fetchImpl = stubRegistry();
  const { client, close } = await connect({ sessionCookie: "s3ss" }, fetchImpl);
  await callText(client, "agentry_revoke_session", {
    sessionId: "0192b1c4-0000-7000-8000-000000000000",
  });
  assert.match(fetchImpl.calls.at(-1).key, /^DELETE \/api\/v1\/user\/sessions\/[0-9a-f-]+$/);
  await callText(client, "agentry_revoke_session", {});
  assert.equal(fetchImpl.calls.at(-1).key, "DELETE /api/v1/user/sessions");
  await close();
});

test("an API failure comes back as a tool error carrying the remedy", async () => {
  const fetchImpl = stubRegistry({ "GET /api/v1/agents/acme/ghost": 404 });
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(
    client,
    "agentry_get_agent",
    { namespace: "acme", name: "ghost" },
    { expectError: true },
  );
  assert.match(text, /404/);
  assert.match(text, /private agent you cannot read is indistinguishable/);
  await close();
});

test("an invalid handle is rejected by the schema before any request", async () => {
  const fetchImpl = stubRegistry();
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(
    client,
    "agentry_get_org",
    { org: "Not A Handle" },
    { expectError: true },
  );
  assert.match(text, /Invalid arguments/);
  assert.match(text, /lowercase letters, digits and hyphens/);
  assert.equal(fetchImpl.calls.length, 0, "a malformed handle must never reach the registry");
  await close();
});

test("search_actions returns ids the execute tool accepts", async () => {
  const { client, close } = await connect();
  const text = await callText(client, "agentry_search_actions", { query: "webhook deliveries" });
  assert.match(text, /listWebhookDeliveries/);
  assert.match(text, /agentry_execute_action/);
  await close();
});

test("search_actions with no match suggests what to do next", async () => {
  const { client, close } = await connect();
  const text = await callText(client, "agentry_search_actions", { query: "zzzz qqqq" });
  assert.match(text, /No API operation matched/);
  await close();
});

test("execute_action runs a catalog operation", async () => {
  const fetchImpl = stubRegistry({ "GET /api/v1/orgs/acme/webhooks": [{ id: "w1" }] });
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(client, "agentry_execute_action", {
    actionId: "listWebhooks",
    pathParams: { org: "acme" },
  });
  assert.match(text, /"id": "w1"/);
  await close();
});

test("execute_action takes stringified path and query parameters as the maps they encode", async () => {
  const fetchImpl = stubRegistry({ "GET /api/v1/orgs/acme/webhooks": [{ id: "w1" }] });
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(client, "agentry_execute_action", {
    actionId: "listWebhooks",
    pathParams: '{"org":"acme"}',
    queryParams: '{"limit":5}',
    dryRun: "false",
  });
  assert.match(text, /"id": "w1"/);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].key, "GET /api/v1/orgs/acme/webhooks");
  assert.equal(fetchImpl.calls[0].searchParams.get("limit"), "5");
  await close();
});

test("execute_action sends a body that arrives as JSON text as the object it holds", async () => {
  const fetchImpl = stubRegistry();
  const { client, close } = await connect({}, fetchImpl);
  await callText(client, "agentry_execute_action", {
    actionId: "createWebhook",
    pathParams: { org: "acme" },
    body: '{"url":"https://hooks.example/x","events":["agent.published"]}',
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(fetchImpl.calls[0].body, {
    url: "https://hooks.example/x",
    events: ["agent.published"],
  });
  await close();
});

test("a string that encodes nothing a parameter takes is refused naming it", async () => {
  const fetchImpl = stubRegistry();
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(
    client,
    "agentry_execute_action",
    { actionId: "listWebhooks", pathParams: { org: "acme" }, dryRun: "maybe" },
    { expectError: true },
  );
  assert.match(text, /dryRun/);
  assert.equal(fetchImpl.calls.length, 0);
  await close();
});

test("execute_action refuses an incomplete call and shows the schema", async () => {
  const fetchImpl = stubRegistry();
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(
    client,
    "agentry_execute_action",
    { actionId: "listWebhooks" },
    { expectError: true },
  );
  assert.match(text, /missing required input: pathParams\.org/);
  assert.equal(fetchImpl.calls.length, 0);
  await close();
});

test("read-only mode refuses a write whose arguments arrive as JSON text", async () => {
  const fetchImpl = stubRegistry();
  const { client, close } = await connect({ readOnly: true }, fetchImpl);
  const text = await callText(
    client,
    "agentry_execute_action",
    {
      actionId: "deleteWebhook",
      pathParams: '{"org":"acme","id":"0192b1c4-0000-7000-8000-000000000000"}',
      dryRun: "false",
    },
    { expectError: true },
  );
  assert.match(text, /read-only/);
  assert.equal(fetchImpl.calls.length, 0);
  await close();
});

test("execute_action suggests near misses for an unknown id", async () => {
  const { client, close } = await connect();
  const text = await callText(
    client,
    "agentry_execute_action",
    { actionId: "listWebhook" },
    { expectError: true },
  );
  assert.match(text, /Did you mean/);
  await close();
});

test("a dry run sends nothing and reports what would happen", async () => {
  const fetchImpl = stubRegistry();
  const { client, close } = await connect({}, fetchImpl);
  const text = await callText(client, "agentry_execute_action", {
    actionId: "createToken",
    body: { name: "x", scopes: ["agent:read"] },
    dryRun: true,
  });
  assert.match(text, /Dry run/);
  assert.match(text, /"wouldBeRefused": true/);
  assert.equal(fetchImpl.calls.length, 0);
  await close();
});

test("read-only mode refuses writes through the catalog tool too", async () => {
  const fetchImpl = stubRegistry();
  const { client, close } = await connect({ readOnly: true }, fetchImpl);
  const text = await callText(
    client,
    "agentry_execute_action",
    {
      actionId: "deleteWebhook",
      pathParams: { org: "acme", id: "0192b1c4-0000-7000-8000-000000000000" },
    },
    { expectError: true },
  );
  assert.match(text, /read-only/);
  assert.equal(fetchImpl.calls.length, 0);
  await close();
});
