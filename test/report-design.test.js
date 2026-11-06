// The Report Designer build: a design or a cover, previewed with what it
// reads and fetches, run only after confirmation, never adding to the
// account, and refused by a CLI without the commands.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ALL_FEATURES, checkCli } from "../dist/cli.js";
import { FAKE, connect, receivedArgv } from "./helpers.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentry-design-"));
  const logo = join(dir, "logo.png");
  const image = join(dir, "ref.png");
  const design = join(dir, "house.json");
  for (const f of [logo, image, design]) writeFileSync(f, "x");
  return { dir, logo, image, design, out: join(dir, "out") };
}

async function preview(client, args) {
  const r = await client.callTool({ name: "agentry_report_design_build", arguments: args });
  assert.equal(r.isError, undefined, r.content[0].text);
  return JSON.parse(r.content[0].text);
}

test("a design preview names the files and addresses it reads and says nothing is added to the account", async () => {
  const f = fixture();
  const { client, argvFile } = await connect();
  const args = {
    job: "design",
    brief: "Quiet, navy, serif headings",
    from: f.design,
    logo: f.logo,
    images: [f.image],
    urls: ["https://example.org/about"],
    out: f.out,
  };
  const p = await preview(client, args);
  assert.deepEqual(
    p.operation.inputs.map((i) => i.path),
    [f.logo, f.image, f.design],
  );
  assert.deepEqual(p.operation.fetches, [
    { kind: "url", address: "https://example.org/about", host: "example.org" },
  ]);
  assert.match(p.operation.review, /AI Review with the person's own TypeSafe key/);
  assert.match(p.summary, /Nothing is added to the person's account/);
  assert.match(p.summary, /--save/);
  assert.ok(
    !receivedArgv(argvFile).some((a) => a[0] === "report-design" && a[1] === "design"),
    "the run started before confirmation",
  );
});

test("a confirmed design run passes its flags, never --save, and returns the envelope", async () => {
  const f = fixture();
  const { client, argvFile } = await connect();
  const args = {
    job: "design",
    brief: "Quiet, navy",
    from: "modern",
    logo: f.logo,
    images: [f.image],
    urls: ["https://example.org/about"],
    out: f.out,
    maxCost: 2,
  };
  const p = await preview(client, args);
  const changed = await client.callTool({
    name: "agentry_report_design_build",
    arguments: { ...args, brief: "Loud", confirm: p.digest },
  });
  assert.equal(changed.isError, true);
  const done = await client.callTool({
    name: "agentry_report_design_build",
    arguments: { ...args, confirm: p.digest },
  });
  assert.equal(done.isError, undefined, done.content[0].text);
  assert.match(done.content[0].text, /reportDesign/);
  const last = receivedArgv(argvFile).at(-1);
  assert.deepEqual(last.slice(0, 4), ["report-design", "design", "--output-format", "json"]);
  assert.equal(last[last.indexOf("--brief") + 1], "Quiet, navy");
  assert.equal(last[last.indexOf("--from") + 1], "modern");
  assert.equal(last[last.indexOf("--logo") + 1], f.logo);
  assert.equal(last[last.indexOf("--image") + 1], f.image);
  assert.equal(last[last.indexOf("--url") + 1], "https://example.org/about");
  assert.equal(last[last.indexOf("--out") + 1], f.out);
  assert.ok(!last.includes("--save"));
});

test("a cover run names its design and the images it may draw", async () => {
  const f = fixture();
  const { client, argvFile } = await connect();
  const args = {
    job: "cover",
    brief: "A bold cover",
    design: "House",
    images: [f.image],
    out: f.out,
  };
  const p = await preview(client, args);
  assert.deepEqual(
    p.operation.inputs.map((i) => i.path),
    [f.image],
  );
  assert.equal(p.operation.fetches, undefined);
  const done = await client.callTool({
    name: "agentry_report_design_build",
    arguments: { ...args, confirm: p.digest },
  });
  assert.equal(done.isError, undefined, done.content[0].text);
  const last = receivedArgv(argvFile).at(-1);
  assert.deepEqual(last.slice(0, 4), ["report-design", "cover", "--output-format", "json"]);
  assert.equal(last[last.indexOf("--design") + 1], "House");
  assert.ok(!last.includes("--from") && !last.includes("--save"));
});

test("arguments that belong to the other job, or break a limit, are refused before anything runs", async () => {
  const f = fixture();
  const { client, argvFile } = await connect();
  const png = (i) => `${f.dir}/i${i}.png`;
  const cases = [
    [{ job: "cover", brief: "b" }, /give design/],
    [{ job: "cover", brief: "b", design: "House", logo: f.logo }, /job design only/],
    [
      { job: "cover", brief: "b", design: "House", urls: ["https://example.org"] },
      /job design only/,
    ],
    [{ job: "cover", brief: "b", design: "House", from: "modern" }, /job design only/],
    [{ job: "design", brief: "b", design: "House" }, /applies to job cover/],
    [{ job: "design", brief: "b", images: [1, 2, 3, 4, 5].map(png) }, /at most 4 images/],
    [
      {
        job: "design",
        brief: "b",
        urls: ["https://a.example", "https://b.example", "https://c.example"],
      },
      /at most 2 urls/,
    ],
    [{ job: "design", brief: "b", urls: ["http://example.org"] }, /https/],
    [{ job: "design", brief: "b", urls: ["https://u:p@example.org"] }, /user or a password/],
    [{ job: "design", brief: "b", from: "--save" }, /must not start with/],
    [{ job: "design", brief: "  " }, /brief must not be empty/],
  ];
  for (const [args, want] of cases) {
    const r = await client.callTool({
      name: "agentry_report_design_build",
      arguments: { ...args, out: f.out },
    });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, want);
  }
  assert.ok(!receivedArgv(argvFile).some((a) => a[0] === "report-design"));
});

test("a CLI without report-design design is told to update, and nothing runs", async () => {
  const f = fixture();
  const { client, argvFile } = await connect({}, {}, undefined, {
    ...ALL_FEATURES,
    reportDesigner: false,
  });
  const r = await client.callTool({
    name: "agentry_report_design_build",
    arguments: { job: "design", brief: "b", out: f.out },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no report-design design; update the CLI \(0\.7\.23 or later\)/);
  assert.equal(receivedArgv(argvFile).length, 0);
});

test("checkCli detects the Report Designer from the command's help", async () => {
  assert.equal((await checkCli(FAKE)).features.reportDesigner, true);
  process.env.FAKE_NO_DESIGNER = "1";
  try {
    assert.equal((await checkCli(FAKE)).features.reportDesigner, false);
  } finally {
    delete process.env.FAKE_NO_DESIGNER;
  }
});

test("a document is read in full for a design, passed as --document, and kept only for the run", async () => {
  const f = fixture();
  const doc = join(f.dir, "Annual review.pdf");
  writeFileSync(doc, "%PDF-1.7");
  const { client, argvFile } = await connect();
  const args = { job: "design", brief: "Like our review", document: doc, logo: f.logo, out: f.out };
  const p = await preview(client, args);
  assert.deepEqual(
    p.operation.inputs.map((i) => i.path),
    [f.logo, doc],
  );
  assert.match(p.summary, /read in full and kept only for the run/);
  assert.match(p.summary, /never the document itself/);
  const done = await client.callTool({
    name: "agentry_report_design_build",
    arguments: { ...args, confirm: p.digest },
  });
  assert.equal(done.isError, undefined, done.content[0].text);
  const last = receivedArgv(argvFile).at(-1);
  assert.equal(last[last.indexOf("--document") + 1], doc);
  assert.ok(!last.includes("--save"));
});

test("a document on a cover, of another type, or for a CLI without --document is refused before anything runs", async () => {
  const f = fixture();
  const doc = join(f.dir, "review.pdf");
  writeFileSync(doc, "%PDF-1.7");
  const { client, argvFile } = await connect();
  for (const [args, want] of [
    [{ job: "cover", brief: "b", design: "House", document: doc }, /job design only/],
    [{ job: "design", brief: "b", document: join(f.dir, "deck.pptx") }, /PDF or a Word document/],
  ]) {
    const r = await client.callTool({
      name: "agentry_report_design_build",
      arguments: { ...args, out: f.out },
    });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, want);
  }
  const old = await connect({}, {}, undefined, { ...ALL_FEATURES, designDocument: false });
  const r = await old.client.callTool({
    name: "agentry_report_design_build",
    arguments: { job: "design", brief: "b", document: doc, out: f.out },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no report-design design --document; update the CLI/);
  assert.ok(!receivedArgv(argvFile).some((a) => a[0] === "report-design"));
  assert.ok(!receivedArgv(old.argvFile).some((a) => a[0] === "report-design"));
});

test("checkCli detects --document from the design command's help", async () => {
  assert.equal((await checkCli(FAKE)).features.designDocument, true);
  process.env.FAKE_NO_DESIGN_DOCUMENT = "1";
  try {
    const cli = await checkCli(FAKE);
    assert.equal(cli.features.designDocument, false);
    assert.equal(cli.features.reportDesigner, true);
  } finally {
    delete process.env.FAKE_NO_DESIGN_DOCUMENT;
  }
});
