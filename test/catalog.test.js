// The generated catalog and the search over it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ACTIONS,
  API_BASE_PATH,
  API_VERSION,
  SPEC_SHA256,
  findAction,
} from "../dist/catalog.generated.js";
import {
  ALL_TAGS,
  describeAction,
  missingParams,
  searchActions,
  summariseHit,
} from "../dist/catalog.js";

const SESSION_ONLY = JSON.parse(
  readFileSync(new URL("../spec/session-only.json", import.meta.url)),
);

test("the catalog was generated from the vendored spec, not some other copy", () => {
  const actual = createHash("sha256")
    .update(readFileSync(new URL("../spec/openapi.yaml", import.meta.url)))
    .digest("hex");
  assert.equal(
    SPEC_SHA256,
    actual,
    "src/catalog.generated.ts is stale — run `npm run generate` after changing spec/openapi.yaml",
  );
});

test("the catalog covers the contract", () => {
  assert.ok(ACTIONS.length > 100, `only ${ACTIONS.length} actions`);
  assert.equal(API_BASE_PATH, "/api/v1");
  assert.match(API_VERSION, /^\d+\.\d+\.\d+$/);
});

test("every action is well formed", () => {
  for (const action of ACTIONS) {
    assert.ok(action.id, "action without an id");
    assert.match(action.method, /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/, action.id);
    assert.ok(action.path.startsWith("/"), action.id);
    assert.equal(typeof action.summary, "string", action.id);
    // Every {placeholder} in the path must be a declared path parameter, or
    // expandPath would throw on a call that looked complete.
    for (const [, placeholder] of action.path.matchAll(/\{([^}]+)\}/g)) {
      assert.ok(
        action.params.some((p) => p.in === "path" && p.name === placeholder),
        `${action.id}: {${placeholder}} is not a declared parameter`,
      );
    }
  }
});

test("the session-only routes carry the flag, and nothing else does", () => {
  const flagged = ACTIONS.filter((a) => a.sessionOnly)
    .map((a) => a.id)
    .sort();
  assert.deepEqual(flagged, SESSION_ONLY.operationIds);
});

test("the routes that mint or revoke credentials are among them", () => {
  for (const id of ["createToken", "revokeToken", "addSshKey", "removeSshKey"]) {
    assert.equal(findAction(id).sessionOnly, true, id);
  }
});

test("findAction resolves ids and rejects the rest", () => {
  assert.equal(findAction("getCurrentUser").path, "/user");
  assert.equal(findAction("nope"), undefined);
});

test("the verb in the query does the work it should", () => {
  // operationIds begin with their verb, so a query that names one must rank
  // that operation first rather than tying with its siblings on the noun.
  for (const [query, expected] of [
    ["list webhooks", "listWebhooks"],
    ["create a webhook", "createWebhook"],
    ["delete a webhook", "deleteWebhook"],
  ]) {
    assert.equal(searchActions(query, 5)[0].action.id, expected, query);
  }
});

test("search finds an operation from a plain description of the job", () => {
  const cases = [
    ["add a webhook to an org", "createWebhook"],
    ["list webhook deliveries", "listWebhookDeliveries"],
    ["decide a review item", "decideReviewItem"],
    ["org audit log", "listOrgAudit"],
    ["scim provisioning tokens", "listScimTokens"],
    ["yank a version", "yankVersion"],
  ];
  for (const [query, expected] of cases) {
    const ids = searchActions(query, 5).map((h) => h.action.id);
    assert.ok(ids.includes(expected), `"${query}" -> ${ids.join(", ")} (wanted ${expected})`);
  }
});

test("a nearly-right operation id finds the real one", () => {
  // The commonest query this search gets is a mistyped operationId, which as
  // one opaque token would match nothing without camel-splitting the query.
  for (const [typo, expected] of [
    ["listWebhook", "listWebhooks"],
    ["getAgentStat", "getAgentStats"],
    ["setOrgMembers", "setOrgMember"],
  ]) {
    const ids = searchActions(typo, 5).map((h) => h.action.id);
    assert.ok(ids.includes(expected), `"${typo}" -> ${ids.join(", ")} (wanted ${expected})`);
  }
});

test("search respects its filters", () => {
  const orgs = searchActions("members", 20, { tag: "orgs" });
  assert.ok(orgs.length > 0);
  assert.ok(orgs.every((h) => h.action.tags.includes("orgs")));

  const reads = searchActions("agent", 20, { readOnly: true });
  assert.ok(reads.every((h) => h.action.method === "GET"));

  const posts = searchActions("agent", 20, { method: "POST" });
  assert.ok(posts.every((h) => h.action.method === "POST"));
});

test("a filter with no query still selects, rather than returning nothing", () => {
  const hits = searchActions("", 50, { tag: "scim" });
  assert.ok(hits.length > 0);
});

test("nonsense matches nothing rather than returning noise", () => {
  assert.equal(searchActions("zzzz qqqq", 5).length, 0);
});

test("search honours the limit", () => {
  assert.ok(searchActions("org", 3).length <= 3);
});

test("a hit summary is short and names what a caller must supply", () => {
  const summary = summariseHit(findAction("setOrgMember"));
  assert.equal(summary.id, "setOrgMember");
  assert.equal(summary.call, "PUT /orgs/{org}/members/{handle}");
  assert.deepEqual(summary.requiredParams, ["org:path", "handle:path"]);
  assert.equal(summary.requiresBody, true);
});

test("a described action carries the full parameter and body schemas", () => {
  const described = describeAction(findAction("createAgent"));
  assert.equal(described.body.required, true);
  assert.ok(described.body.schema.properties.modes.items.enum.includes("interactive"));
  assert.equal(described.sessionOnly, false);
});

test("missingParams names exactly what is absent", () => {
  const action = findAction("setOrgMember");
  assert.deepEqual(missingParams(action, {}), { path: ["org", "handle"], query: [], body: true });
  assert.deepEqual(missingParams(action, { path: { org: "acme" }, body: { role: "member" } }), {
    path: ["handle"],
    query: [],
    body: false,
  });
  assert.deepEqual(
    missingParams(action, { path: { org: "acme", handle: "someone" }, body: { role: "member" } }),
    { path: [], query: [], body: false },
  );
});

test("missingParams treats empty strings as absent", () => {
  assert.deepEqual(missingParams(findAction("getOrg"), { path: { org: "" } }).path, ["org"]);
});

test("a required query parameter counts as missing", () => {
  assert.deepEqual(missingParams(findAction("listAgents"), {}).query, ["namespace"]);
});

test("the tag list is the one offered to callers", () => {
  for (const tag of ["agents", "orgs", "users", "webhooks", "versions"]) {
    assert.ok(ALL_TAGS.includes(tag), tag);
  }
});
