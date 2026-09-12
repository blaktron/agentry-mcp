// Redaction and the context budget. The redaction tests are the ones that
// matter: a minted PAT reaching a transcript is the failure this module exists
// to prevent.
import assert from "node:assert/strict";
import { test } from "node:test";

import { REDACTED, clip, redactSecrets, renderResponse } from "../dist/shaping.js";

test("secret-named fields are replaced wherever they sit", () => {
  const shaped = redactSecrets({
    token: "agy_abcdefghij",
    nested: { clientSecret: "hunter2", refresh_token: "r" },
    list: [{ password: "p" }],
  });
  assert.equal(shaped.token, REDACTED);
  assert.equal(shaped.nested.clientSecret, REDACTED);
  assert.equal(shaped.nested.refresh_token, REDACTED);
  assert.equal(shaped.list[0].password, REDACTED);
});

test("identifiers that merely contain the word token survive", () => {
  const shaped = redactSecrets({ tokenId: "01a0-uuid", tokenName: "ci", name: "publish" });
  assert.equal(shaped.tokenId, "01a0-uuid");
  assert.equal(shaped.tokenName, "ci");
  assert.equal(shaped.name, "publish");
});

test("a PAT is redacted even when it turns up inside prose", () => {
  const shaped = redactSecrets({ detail: "use agy_livetokenvalue123 to authenticate" });
  assert.equal(shaped.detail, `use ${REDACTED} to authenticate`);
});

test("redaction leaves other values, and empty ones, alone", () => {
  const shaped = redactSecrets({ token: "", count: 3, ok: true, when: null });
  assert.equal(shaped.token, "");
  assert.equal(shaped.count, 3);
  assert.equal(shaped.ok, true);
  assert.equal(shaped.when, null);
});

test("clip keeps short payloads untouched", () => {
  const { text, clipped } = clip("short", 100);
  assert.equal(text, "short");
  assert.equal(clipped, false);
});

test("clip truncates on a line boundary and says how much is missing", () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const { text, clipped } = clip(long, 300);
  assert.equal(clipped, true);
  assert.match(text, /truncated: \d+ of \d+ characters not shown/);
  assert.ok(text.length < long.length);
  assert.ok(
    !text
      .split("\n")
      .slice(0, -3)
      .some((l) => l.length > 0 && !/^line \d+$/.test(l)),
  );
});

test("a response renders its data redacted by default", () => {
  const text = renderResponse(
    { status: 201, data: { id: "1", token: "agy_secretvalue1" } },
    { maxChars: 5000 },
  );
  assert.match(text, /"id": "1"/);
  assert.doesNotMatch(text, /agy_secretvalue1/);
});

test("reveal is honoured when a caller explicitly asks", () => {
  const text = renderResponse(
    { status: 201, data: { token: "agy_secretvalue1" } },
    { maxChars: 5000, reveal: true },
  );
  assert.match(text, /agy_secretvalue1/);
});

test("an empty response reads as done rather than as null", () => {
  assert.match(
    renderResponse({ status: 204, data: undefined }, { maxChars: 500 }),
    /Done \(HTTP 204, no content\)/,
  );
});

test("a next cursor is offered as the next call to make", () => {
  const text = renderResponse({ status: 200, data: [], nextCursor: "c9" }, { maxChars: 5000 });
  assert.match(text, /cursor="c9"/);
});

test("a nearly spent rate limit is called out", () => {
  const text = renderResponse(
    { status: 200, data: {}, rateLimit: { limit: 100, remaining: 2, reset: 30 } },
    { maxChars: 5000 },
  );
  assert.match(text, /Rate limit nearly spent: 2 of 100/);
});

test("a healthy rate limit is not mentioned", () => {
  const text = renderResponse(
    { status: 200, data: {}, rateLimit: { limit: 100, remaining: 99, reset: 30 } },
    { maxChars: 5000 },
  );
  assert.doesNotMatch(text, /Rate limit/);
});

test("the note leads the payload", () => {
  const text = renderResponse(
    { status: 200, data: { a: 1 } },
    { maxChars: 5000, note: "Created x." },
  );
  assert.ok(text.startsWith("Created x."));
});
