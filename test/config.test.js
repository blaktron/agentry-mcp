// Credential and registry resolution. These run against dist/, so what is
// tested is what ships.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig, configDir } from "../dist/config.js";
import { ConfigError } from "../dist/errors.js";

/** A config dir holding the CLI's config.yaml, as `agentry login` writes it. */
function cliConfigDir(contents) {
  const dir = mkdtempSync(join(tmpdir(), "agentry-mcp-test-"));
  writeFileSync(join(dir, "config.yaml"), contents);
  return dir;
}

const SAMPLE = `defaultRegistry: https://registry.example
registries:
    - url: https://registry.example
      tokenRef: file
      token: agy_fromconfigfile
    - url: https://other.example
      token: agy_otherregistry
`;

test("reads registry and token from the CLI config", () => {
  const dir = cliConfigDir(SAMPLE);
  const config = loadConfig({ AGENTRY_CONFIG_DIR: dir });
  assert.equal(config.registry, "https://registry.example");
  assert.equal(config.apiBase, "https://registry.example/api/v1");
  assert.equal(config.token, "agy_fromconfigfile");
  assert.equal(config.credentialSource, "config.yaml");
});

test("picks the token belonging to the registry in use", () => {
  const dir = cliConfigDir(SAMPLE);
  const config = loadConfig({ AGENTRY_CONFIG_DIR: dir, AGENTRY_REGISTRY: "https://other.example" });
  assert.equal(config.token, "agy_otherregistry");
});

test("a registry with no entry in the config yields no token", () => {
  const dir = cliConfigDir(SAMPLE);
  const config = loadConfig({ AGENTRY_CONFIG_DIR: dir, AGENTRY_REGISTRY: "https://third.example" });
  assert.equal(config.token, undefined);
  assert.equal(config.credentialSource, "none");
});

test("the environment beats the config file", () => {
  const dir = cliConfigDir(SAMPLE);
  const config = loadConfig({ AGENTRY_CONFIG_DIR: dir, AGENTRY_TOKEN: "agy_fromenv" });
  assert.equal(config.token, "agy_fromenv");
  assert.equal(config.credentialSource, "AGENTRY_TOKEN");
});

test("a trailing slash on the registry does not double up in the API base", () => {
  const config = loadConfig({
    AGENTRY_CONFIG_DIR: cliConfigDir(""),
    AGENTRY_REGISTRY: "https://registry.example/",
    AGENTRY_TOKEN: "agy_x",
  });
  assert.equal(config.apiBase, "https://registry.example/api/v1");
});

test("a session cookie alone is a credential", () => {
  const config = loadConfig({
    AGENTRY_CONFIG_DIR: cliConfigDir(""),
    AGENTRY_REGISTRY: "https://registry.example",
    AGENTRY_SESSION_COOKIE: "abc123",
  });
  assert.equal(config.credentialSource, "AGENTRY_SESSION_COOKIE");
  assert.equal(config.sessionCookie, "abc123");
});

test("no registry anywhere is a configuration error naming the fix", () => {
  const dir = cliConfigDir("");
  assert.throws(
    () => loadConfig({ AGENTRY_CONFIG_DIR: dir }),
    (err) => err instanceof ConfigError && /AGENTRY_REGISTRY/.test(err.toToolMessage()),
  );
});

test("an unparseable registry URL is rejected", () => {
  assert.throws(
    () => loadConfig({ AGENTRY_CONFIG_DIR: cliConfigDir(""), AGENTRY_REGISTRY: "not a url" }),
    ConfigError,
  );
});

test("read-only is armed by the words people type, and only those", () => {
  const base = { AGENTRY_CONFIG_DIR: cliConfigDir(""), AGENTRY_REGISTRY: "https://r.example" };
  for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
    assert.equal(loadConfig({ ...base, AGENTRY_MCP_READ_ONLY: value }).readOnly, true, value);
  }
  for (const value of ["", "0", "false", "no", "off"]) {
    assert.equal(loadConfig({ ...base, AGENTRY_MCP_READ_ONLY: value }).readOnly, false, value);
  }
  assert.equal(loadConfig(base).readOnly, false);
});

test("a nonsense timeout is refused rather than silently defaulted", () => {
  const base = { AGENTRY_CONFIG_DIR: cliConfigDir(""), AGENTRY_REGISTRY: "https://r.example" };
  assert.throws(() => loadConfig({ ...base, AGENTRY_MCP_TIMEOUT_MS: "-5" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, AGENTRY_MCP_TIMEOUT_MS: "soon" }), ConfigError);
  assert.equal(loadConfig({ ...base, AGENTRY_MCP_TIMEOUT_MS: "5000" }).timeoutMs, 5000);
});

test("an unreadable config dir is not fatal when the environment is complete", () => {
  const config = loadConfig({
    AGENTRY_CONFIG_DIR: "/nonexistent/agentry",
    AGENTRY_REGISTRY: "https://r.example",
    AGENTRY_TOKEN: "agy_x",
  });
  assert.equal(config.token, "agy_x");
});

test("the config dir default matches the CLI's", () => {
  assert.equal(configDir({ HOME: "/home/someone" }), "/home/someone/.config/agentry");
  assert.equal(configDir({ AGENTRY_CONFIG_DIR: "/elsewhere" }), "/elsewhere");
});
