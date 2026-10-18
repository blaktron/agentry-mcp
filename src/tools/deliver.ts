/**
 * agentry_deliver: a finished run's deliverables copied to a folder or sent
 * to saved destinations again, after the fact (`agentry deliver`). It sends
 * what an agent wrote to a place outside the run, so it takes the same two
 * calls as a write: the preview lists the run's deliverables as its
 * result.json names them, the folder, and each destination as the person
 * saved it; the confirm re-reads all of it and refuses a change. The CLI
 * checks every file against its digest before it copies or sends it.
 */

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { ArgumentError, flag, value } from "../argv.js";
import { confirmed, isConsent, previewText, runPlan } from "../consent.js";
import { guard, type Driver } from "../driver.js";
import { registerTool } from "../toolargs.js";

interface DeliverArgs {
  runFolder: string;
  to?: string;
  destinations?: string[];
  confirm?: string;
}

/** The run's result.json, read through no link: its digest and its deliverables block. */
async function runListing(
  runFolder: string,
  cwd?: string,
): Promise<{ sha256: string; deliverables: unknown; status: unknown }> {
  const file = join(resolve(cwd ?? process.cwd(), runFolder), "result.json");
  const st = await lstat(file).catch(() => undefined);
  if (!st || !st.isFile())
    throw new ArgumentError(
      `${runFolder} is not a run's output folder: it has no result.json (a regular file)`,
    );
  const bytes = await readFile(file);
  let parsed: { deliverables?: unknown; status?: unknown };
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ArgumentError(`${file} is not the JSON a run writes`);
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    deliverables: parsed.deliverables ?? null,
    status: parsed.status ?? null,
  };
}

async function deliver(d: Driver, a: DeliverArgs) {
  const tool = "agentry_deliver";
  if (a.to === undefined && !a.destinations?.length)
    throw new ArgumentError("give a folder (to), saved destinations, or both");
  if (!d.features.deliverTo)
    throw new ArgumentError("this agentry CLI has no deliver command; update the CLI");
  if (a.destinations?.length && !d.features.destinations)
    throw new ArgumentError(
      "this agentry CLI cannot send to a destination; update the CLI to deliver to one",
    );
  const argv = ["deliver", value("runFolder", a.runFolder), "--json"];
  flag(argv, "to", a.to);
  for (const name of a.destinations ?? []) argv.push("--destination", value("destinations", name));
  const listing = await runListing(a.runFolder, d.cwd);
  let destinationsState: unknown = null;
  if (a.destinations?.length) {
    const state = await runPlan<unknown>(d, tool, ["destinations", "list", "--json"]);
    if (!state.ok) return state.result;
    destinationsState = state.plan;
  }
  const facts = { tool, argv, listing, destinationsState };
  if (a.confirm === undefined)
    return previewText(
      {
        operation: {
          runFolder: a.runFolder,
          runStatus: listing.status,
          deliverables: listing.deliverables,
          to: a.to ?? null,
          destinations: a.destinations ?? [],
          savedDestinations: destinationsState,
        },
        writes: false,
        note:
          "Delivery preview. The CLI copies each listed deliverable to the folder and sends the run's result " +
          "and deliverables to each destination, after checking every file against the digest the run listed; " +
          "the run folder is left as it is. A destination receives the files' contents.",
      },
      facts,
    );
  const consent = await confirmed(d.server, tool, a.confirm, facts, {
    unsigned: false,
    ask:
      `Deliver the run in ${a.runFolder}` +
      `${a.to !== undefined ? ` to the folder ${a.to}` : ""}` +
      `${a.destinations?.length ? `${a.to !== undefined ? " and" : ""} to ${a.destinations.join(", ")}` : ""}?`,
  });
  if (!isConsent(consent)) return consent;
  return d.run(tool, argv);
}

export function registerDeliverTools(d: Driver): void {
  registerTool(
    d.server,
    "agentry_deliver",
    {
      description:
        "Deliver a run already made, from its output folder, with the installed agentry CLI (`agentry deliver " +
        "RUN-FOLDER --json`), in two calls: copy its deliverables to a folder (`to`) and/or send its result and " +
        "deliverables to saved destinations (see agentry_destinations_list); this is how a failed delivery is " +
        "retried. Without `confirm`: a preview listing the run's deliverables, the folder and the destinations, " +
        "plus `digest`; nothing is copied or sent. Show the person where the files would go, and only when they " +
        "agree call again with `confirm` set to that digest. Returns the CLI's deliveries, one a file and " +
        'destination; exitClass "cli" beside them means at least one was not delivered.',
      inputSchema: {
        runFolder: z
          .string()
          .describe("The run's output folder, as the run printed it (it holds result.json)."),
        to: z.string().optional().describe("The folder to copy the deliverables to."),
        destinations: z
          .array(z.string())
          .optional()
          .describe("Saved destinations to send the result and deliverables to."),
        confirm: z
          .string()
          .optional()
          .describe("The `digest` a preview of this exact call returned. Omit to preview."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (a) => guard("agentry_deliver", () => deliver(d, a)),
  );
}
