// The request seam: path expansion, pagination, the two refusals that happen
// before a request goes out, and the translation of problem+json into errors a
// model can act on.
import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentryClient, cursorFromLink, expandPath } from "../dist/client.js";
import {
  ApiError,
  ConfigError,
  ReadOnlyError,
  SessionRequiredError,
  TransportError,
} from "../dist/errors.js";

const BASE_CONFIG = {
  registry: "https://registry.example",
  apiBase: "https://registry.example/api/v1",
  token: "agy_test",
  credentialSource: "AGENTRY_TOKEN",
  readOnly: false,
  timeoutMs: 5000,
  maxResponseChars: 60000,
};

/** A fetch stand-in that records the request and replies with what it is given. */
function stubFetch(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: url.toString(), init });
    const { status = 200, body = "", headers = {} } = typeof reply === "function" ? reply() : reply;
    // 204 and friends may not carry a body at all, per the fetch spec.
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : body, { status, headers });
  };
  impl.calls = calls;
  return impl;
}

function client(overrides = {}, fetchImpl = stubFetch({ body: "{}" })) {
  return new AgentryClient({ ...BASE_CONFIG, ...overrides }, fetchImpl);
}

test("expandPath fills every placeholder and encodes values", () => {
  assert.equal(
    expandPath("/agents/{ns}/{name}", { ns: "acme", name: "linter" }),
    "/agents/acme/linter",
  );
  assert.equal(expandPath("/x/{v}", { v: "1.0.0+build" }), "/x/1.0.0%2Bbuild");
  assert.equal(expandPath("/user/tokens"), "/user/tokens");
});

test("a missing path parameter is an error, not a path with a hole in it", () => {
  assert.throws(() => expandPath("/agents/{ns}/{name}", { ns: "acme" }), ConfigError);
  assert.throws(() => expandPath("/agents/{ns}", { ns: "" }), ConfigError);
});

test("cursorFromLink reads the next cursor and ignores everything else", () => {
  assert.equal(cursorFromLink('</api/v1/agents?cursor=abc123>; rel="next"'), "abc123");
  assert.equal(cursorFromLink('</a?cursor=p1>; rel="prev", </a?cursor=n1>; rel="next"'), "n1");
  assert.equal(cursorFromLink('</a?cursor=p1>; rel="prev"'), undefined);
  assert.equal(cursorFromLink(null), undefined);
  assert.equal(cursorFromLink("garbage"), undefined);
});

test("a GET carries the bearer token and the accept header", async () => {
  const fetchImpl = stubFetch({ body: '{"handle":"someone"}' });
  await client({}, fetchImpl).call("getCurrentUser");
  const [call] = fetchImpl.calls;
  assert.equal(call.url, "https://registry.example/api/v1/user");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.headers.get("Authorization"), "Bearer agy_test");
  assert.equal(call.init.headers.get("Accept"), "application/json");
  assert.equal(call.init.body, undefined);
});

test("a session cookie is sent as the session cookie", async () => {
  const fetchImpl = stubFetch({ body: "{}" });
  await client(
    { token: undefined, sessionCookie: "s3ss", credentialSource: "AGENTRY_SESSION_COOKIE" },
    fetchImpl,
  ).call("getCurrentUser");
  assert.equal(fetchImpl.calls[0].init.headers.get("Cookie"), "agentry_session=s3ss");
});

test("query parameters are set, and undefined ones are dropped", async () => {
  const fetchImpl = stubFetch({ body: "{}" });
  await client({}, fetchImpl).call("searchAgents", {
    query: { q: "lint", mode: undefined, limit: 5 },
  });
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get("q"), "lint");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(url.searchParams.has("mode"), false);
});

test("a body is serialised as JSON with the idempotency key passed through", async () => {
  const fetchImpl = stubFetch({ status: 201, body: '{"handle":"acme"}' });
  await client({}, fetchImpl).call("createOrg", {
    body: { handle: "acme", displayName: "Acme" },
    idempotencyKey: "key-1",
  });
  const [call] = fetchImpl.calls;
  assert.equal(call.init.headers.get("Content-Type"), "application/json");
  assert.equal(call.init.headers.get("Idempotency-Key"), "key-1");
  assert.deepEqual(JSON.parse(call.init.body), { handle: "acme", displayName: "Acme" });
});

test("session-only routes are refused before a request is made", async () => {
  const fetchImpl = stubFetch({ body: "{}" });
  await assert.rejects(
    () =>
      client({}, fetchImpl).call("createToken", { body: { name: "x", scopes: ["agent:read"] } }),
    SessionRequiredError,
  );
  assert.equal(fetchImpl.calls.length, 0, "nothing should have been sent");
});

test("a session cookie unlocks the session-only routes", async () => {
  const fetchImpl = stubFetch({ status: 201, body: "{}" });
  await client({ sessionCookie: "s3ss" }, fetchImpl).call("createToken", {
    body: { name: "x", scopes: ["agent:read"] },
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test("read-only mode refuses writes and still allows reads", async () => {
  const fetchImpl = stubFetch({ body: "{}" });
  const c = client({ readOnly: true }, fetchImpl);
  await assert.rejects(
    () => c.call("deleteAgent", { path: { ns: "a", name: "b" } }),
    ReadOnlyError,
  );
  assert.equal(fetchImpl.calls.length, 0);
  await c.call("getAgent", { path: { ns: "a", name: "b" } });
  assert.equal(fetchImpl.calls.length, 1);
});

test("an authenticated route with no credential says so before calling", async () => {
  const fetchImpl = stubFetch({ body: "{}" });
  await assert.rejects(
    () => client({ token: undefined, credentialSource: "none" }, fetchImpl).call("getCurrentUser"),
    ConfigError,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("public routes work with no credential at all", async () => {
  const fetchImpl = stubFetch({ body: "{}" });
  await client({ token: undefined, credentialSource: "none" }, fetchImpl).call("getMeta");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].init.headers.get("Authorization"), null);
});

test("an unknown operation id points at the search tool", async () => {
  await assert.rejects(
    () => client().call("noSuchOperation"),
    (err) => err instanceof ConfigError && /agentry_search_actions/.test(err.toToolMessage()),
  );
});

test("a problem+json body becomes an error carrying title, detail and remedy", async () => {
  const fetchImpl = stubFetch({
    status: 403,
    body: JSON.stringify({
      type: "https://agentry.dev/problems/forbidden",
      title: "Forbidden",
      status: 403,
      detail: "token lacks scope org:admin",
    }),
    headers: { "Content-Type": "application/problem+json" },
  });
  await assert.rejects(
    () => client({}, fetchImpl).call("getAgent", { path: { ns: "a", name: "b" } }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 403);
      const message = err.toToolMessage();
      assert.match(message, /403 Forbidden/);
      assert.match(message, /token lacks scope org:admin/);
      assert.match(message, /scope this route needs/);
      return true;
    },
  );
});

test("a 429 surfaces the retry interval", async () => {
  const fetchImpl = stubFetch({
    status: 429,
    body: JSON.stringify({ title: "Too Many Requests" }),
    headers: { "Retry-After": "30" },
  });
  await assert.rejects(
    () => client({}, fetchImpl).call("getMeta"),
    (err) => err.retryAfter === 30 && /Retry after 30s/.test(err.toToolMessage()),
  );
});

test("a non-JSON error body still produces a usable message", async () => {
  const fetchImpl = stubFetch({ status: 502, body: "<html>bad gateway</html>" });
  await assert.rejects(
    () => client({}, fetchImpl).call("getMeta"),
    (err) => err instanceof ApiError && /502/.test(err.message),
  );
});

test("a connection failure is reported as transport, not as an API answer", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    () => client({}, fetchImpl).call("getMeta"),
    (err) => err instanceof TransportError && /could not reach/.test(err.message),
  );
});

test("204 yields no data rather than a parse failure", async () => {
  const response = await client({}, stubFetch({ status: 204, body: "" })).call("deleteAgent", {
    path: { ns: "a", name: "b" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.data, undefined);
});

test("the next cursor is read from the body or the Link header", async () => {
  const fromBody = await client({}, stubFetch({ body: '{"items":[],"nextCursor":"c1"}' })).call(
    "listPlatformAudit",
  );
  assert.equal(fromBody.nextCursor, "c1");

  const fromHeader = await client(
    {},
    stubFetch({
      body: "[]",
      headers: { Link: '</api/v1/agents?cursor=c2>; rel="next"' },
    }),
  ).call("listAgents", { query: { namespace: "acme" } });
  assert.equal(fromHeader.nextCursor, "c2");
});

test("rate-limit headers are lifted off the response", async () => {
  const response = await client(
    {},
    stubFetch({
      body: "{}",
      headers: { "RateLimit-Limit": "100", "RateLimit-Remaining": "3", "RateLimit-Reset": "60" },
    }),
  ).call("getMeta");
  assert.deepEqual(response.rateLimit, { limit: 100, remaining: 3, reset: 60 });
});
