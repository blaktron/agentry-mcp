// The CLI seam: discovery, the version floor, the parse of `--version`.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkCli, findCli, MIN_CLI_VERSION, parseVersion } from "../dist/cli.js";
import { FAKE } from "./helpers.js";

test("parseVersion reads releases and leaves dev builds unversioned", () => {
  assert.deepEqual(parseVersion("agentry version 0.4.0\n"), { raw: "0.4.0", semver: "0.4.0" });
  assert.deepEqual(parseVersion("agentry version v1.2.3-rc1"), {
    raw: "1.2.3-rc1",
    semver: "1.2.3",
  });
  assert.deepEqual(parseVersion("agentry version 9d89740-dirty"), { raw: "9d89740-dirty" });
  assert.deepEqual(parseVersion("agentry version 0.0.0-dev"), { raw: "0.0.0-dev" });
  assert.equal(parseVersion("gh version 2.0"), undefined);
});

test("findCli: AGENTRY_BIN first, then PATH, else a message naming what to do", async () => {
  assert.equal(await findCli({ AGENTRY_BIN: FAKE }), FAKE);
  const dir = mkdtempSync(join(tmpdir(), "agentry-path-"));
  writeFileSync(join(dir, "agentry"), "#!/bin/sh\necho agentry version 0.4.0\n");
  chmodSync(join(dir, "agentry"), 0o755);
  assert.equal(await findCli({ PATH: `/nonexistent:${dir}` }), join(dir, "agentry"));
  await assert.rejects(findCli({ PATH: "/nonexistent" }), /no `agentry` binary on PATH/);
  await assert.rejects(findCli({ AGENTRY_BIN: "/nonexistent/agentry" }), /not an executable file/);
});

test("checkCli: a release at or above the floor passes, an older one is refused naming the floor", async () => {
  for (const [version, semver] of [
    ["0.6.63", "0.6.63"],
    ["0.6.64-dev.2", "0.6.64"],
  ]) {
    process.env.FAKE_VERSION = version;
    try {
      const v = await checkCli(FAKE);
      assert.equal(v.semver, semver);
      assert.equal(v.floorChecked, true);
    } finally {
      delete process.env.FAKE_VERSION;
    }
  }
  process.env.FAKE_VERSION = "0.5.9";
  try {
    await assert.rejects(checkCli(FAKE), /is agentry 0\.5\.9; this server needs 0\.6\.63 or newer/);
  } finally {
    delete process.env.FAKE_VERSION;
  }
  // The shipped floor is the CLI's first tagged release (agentry-cli#327);
  // the comparison is proven against an injected floor above the fake's
  // version.
  assert.equal(MIN_CLI_VERSION, "0.6.63");
  process.env.FAKE_VERSION = "0.4.0";
  try {
    await assert.rejects(
      checkCli(FAKE, "0.5.0"),
      /is agentry 0\.4\.0; this server needs 0\.5\.0 or newer/,
    );
  } finally {
    delete process.env.FAKE_VERSION;
  }
  const dir = mkdtempSync(join(tmpdir(), "agentry-old-"));
  const foreign = join(dir, "gh");
  writeFileSync(foreign, "#!/bin/sh\necho gh version 2.0\n");
  chmodSync(foreign, 0o755);
  await assert.rejects(checkCli(foreign), /did not answer `--version` like the Agentry CLI/);
});

test("checkCli: a dev build is accepted with the floor unchecked", async () => {
  process.env.FAKE_VERSION = "9d89740-dirty";
  try {
    const v = await checkCli(FAKE);
    assert.equal(v.semver, undefined);
    assert.equal(v.floorChecked, false);
  } finally {
    delete process.env.FAKE_VERSION;
  }
});

test("checkCli: a CLI without install --plan or run --plan is refused naming what is needed", async () => {
  process.env.FAKE_NO_PLAN = "1";
  try {
    await assert.rejects(
      checkCli(FAKE),
      /has no `install --plan`; this server needs the CLI from agentry-cli#123/,
    );
  } finally {
    delete process.env.FAKE_NO_PLAN;
  }
  process.env.FAKE_NO_RUN_PLAN = "1";
  try {
    await assert.rejects(
      checkCli(FAKE),
      /has no `run --plan`; this server needs the CLI from agentry-cli#124/,
    );
  } finally {
    delete process.env.FAKE_NO_RUN_PLAN;
  }
});

test("an untagged CLI without the pipe protocol is refused", async () => {
  process.env.FAKE_VERSION = "0.0.0-dev";
  process.env.FAKE_NO_PROTOCOL = "1";
  try {
    await assert.rejects(checkCli(FAKE), /no run --session-protocol/);
  } finally {
    delete process.env.FAKE_VERSION;
    delete process.env.FAKE_NO_PROTOCOL;
  }
});
