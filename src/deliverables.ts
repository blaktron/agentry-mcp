/**
 * A run's deliverables, handed back to the calling agent. The CLI's result
 * envelope lists them (`deliverables.files`: path under reports/, title,
 * SHA-256, size, type) and, for each copy the run made with --deliver-to, a
 * `deliveries` entry naming the copy. The listing is the runner's word; the
 * files are what the agent wrote, so nothing is returned on the listing
 * alone: each file is read here, through no link, and its bytes must hash to
 * the listed digest before it is inlined or linked. A file that does not
 * match is withheld and says why.
 *
 * Text deliverables come back inline as embedded resources, up to
 * INLINE_EACH_BYTES each and INLINE_TOTAL_BYTES in all; every other one is a
 * resource link, to the delivered copy when the run made one whose bytes
 * match, else to the file in the run folder.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

/** The most bytes one text deliverable may have and still be inlined. */
export const INLINE_EACH_BYTES = 256 * 1024;
/** The most bytes of text inlined across one run's deliverables. */
export const INLINE_TOTAL_BYTES = 1024 * 1024;

/** The deliverable types returned as text, and the media type each is labelled with. */
const TEXT_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  ndjson: "application/x-ndjson",
  jsonl: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
};

/** Media types for the common deliverables that are linked, never inlined. */
const OTHER_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

/** One entry of the envelope's deliverables block, as the CLI writes it. */
interface Listed {
  path: string;
  title: string;
  sha256: string;
  bytes: number;
  type: string;
  marked: boolean;
}

/** One entry of the envelope's deliveries block. */
interface Delivery {
  kind?: string;
  object?: string;
  sha256?: string;
  status?: string;
}

/** How a deliverable came back. */
export interface Returned {
  path: string;
  title: string;
  type: string;
  bytes: number;
  sha256: string;
  marked: boolean;
  /** inline: an embedded resource; link: a resource link; withheld: neither. */
  returned: "inline" | "link" | "withheld";
  /** The file the resource names: the delivered copy, or the file in the run folder. */
  uri?: string;
  /** Why a deliverable was withheld, or linked rather than inlined. */
  reason?: string;
}

export interface DeliverablesBack {
  /** What happened to each listed deliverable, in the envelope's order. */
  deliverables: Returned[];
  /** The listing named more files than the runner lists. */
  truncated?: boolean;
  /** The content blocks to append after the envelope. */
  content: ContentBlock[];
}

/**
 * Reads the envelope's deliverables and returns what goes back to the host,
 * or undefined when the run listed none (a failed run, or a CLI that does
 * not list them).
 */
export async function deliverablesBack(
  result: unknown,
  cwd?: string,
): Promise<DeliverablesBack | undefined> {
  const r = result as {
    outDir?: unknown;
    deliverables?: { files?: unknown; truncated?: unknown };
    deliveries?: unknown;
  };
  const files = r?.deliverables?.files;
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const outDir = typeof r.outDir === "string" && r.outDir !== "" ? r.outDir : undefined;
  const deliveries = Array.isArray(r.deliveries) ? (r.deliveries as Delivery[]) : [];
  const back: DeliverablesBack = { deliverables: [], content: [] };
  if (r.deliverables?.truncated === true) back.truncated = true;
  let inlined = 0;
  for (const raw of files) {
    const f = listed(raw);
    if (!f) continue;
    const entry: Returned = {
      path: f.path,
      title: f.title,
      type: f.type,
      bytes: f.bytes,
      sha256: f.sha256,
      marked: f.marked,
      returned: "withheld",
    };
    back.deliverables.push(entry);
    if (!outDir) {
      entry.reason = "the run named no output folder";
      continue;
    }
    const inRun = await readChecked(runFile(outDir, f.path, cwd), f, true);
    if (typeof inRun === "string") {
      entry.reason = inRun;
      continue;
    }
    const copy = await verifiedCopy(deliveries, f);
    const file = copy ?? inRun.file;
    entry.uri = pathToFileURL(file).href;
    const textType = TEXT_TYPES[f.type];
    const text = textType !== undefined ? utf8(inRun.bytes) : undefined;
    if (
      text !== undefined &&
      f.bytes <= INLINE_EACH_BYTES &&
      inlined + f.bytes <= INLINE_TOTAL_BYTES
    ) {
      inlined += f.bytes;
      entry.returned = "inline";
      back.content.push({
        type: "resource",
        resource: { uri: entry.uri, mimeType: textType, text },
      });
      continue;
    }
    entry.returned = "link";
    if (textType !== undefined)
      entry.reason =
        text === undefined
          ? "not UTF-8 text"
          : f.bytes > INLINE_EACH_BYTES
            ? `over ${INLINE_EACH_BYTES} bytes`
            : `the run's inline text reached ${INLINE_TOTAL_BYTES} bytes`;
    back.content.push({
      type: "resource_link",
      uri: entry.uri,
      name: basename(file),
      title: f.title,
      mimeType: textType ?? OTHER_TYPES[f.type] ?? "application/octet-stream",
      size: f.bytes,
    });
  }
  return back;
}

/** An entry of the block with the shape the CLI writes, or undefined. */
function listed(v: unknown): Listed | undefined {
  const f = v as Partial<Listed> | null;
  if (
    !f ||
    typeof f.path !== "string" ||
    typeof f.sha256 !== "string" ||
    typeof f.bytes !== "number" ||
    !/^[0-9a-f]{64}$/.test(f.sha256)
  )
    return undefined;
  return {
    path: f.path,
    title: typeof f.title === "string" ? f.title : basename(f.path),
    sha256: f.sha256,
    bytes: f.bytes,
    type: typeof f.type === "string" ? f.type.toLowerCase() : "",
    marked: f.marked === true,
  };
}

/**
 * The listed path inside the run folder, or a reason it is not one: a
 * deliverable is a file under reports/, named by a relative path with no
 * `..` or empty segment.
 */
function runFile(
  outDir: string,
  rel: string,
  cwd?: string,
): { root: string; parts: string[] } | string {
  const parts = rel.split("/");
  if (
    isAbsolute(rel) ||
    rel.includes("\\") ||
    parts[0] !== "reports" ||
    parts.length < 2 ||
    parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\0"))
  )
    return "not a file under reports/";
  return { root: isAbsolute(outDir) ? outDir : join(cwd ?? process.cwd(), outDir), parts };
}

/**
 * Reads a file reached by no link and checks it against the listing: size
 * and SHA-256. inRun: the path is checked component by component beneath
 * the run folder; otherwise (a delivered copy) the file itself must not be
 * a link. Returns the bytes, or why the file is not the one listed.
 */
async function readChecked(
  where: { root: string; parts: string[] } | string,
  f: Listed,
  inRun: boolean,
): Promise<{ file: string; bytes: Buffer } | string> {
  if (typeof where === "string") return where;
  let file = where.root;
  for (const [i, part] of where.parts.entries()) {
    file = join(file, part);
    if (!inRun && i < where.parts.length - 1) continue;
    let st;
    try {
      st = await lstat(file);
    } catch {
      return "missing";
    }
    if (st.isSymbolicLink()) return "reached through a link";
    if (i === where.parts.length - 1 && !st.isFile()) return "not a regular file";
  }
  let bytes: Buffer;
  try {
    const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await h.stat();
      if (!st.isFile()) return "not a regular file";
      if (st.size !== f.bytes) return "changed since the run listed it";
      bytes = await h.readFile();
    } finally {
      await h.close();
    }
  } catch {
    return "unreadable";
  }
  if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256)
    return "changed since the run listed it";
  return { file, bytes };
}

/** The run's own copy of f, when it made one and its bytes still match. */
async function verifiedCopy(deliveries: Delivery[], f: Listed): Promise<string | undefined> {
  for (const d of deliveries) {
    if (d.kind !== "folder" || d.status !== "delivered" || d.sha256 !== f.sha256) continue;
    if (typeof d.object !== "string" || !isAbsolute(d.object)) continue;
    const got = await readChecked(
      { root: dirname(d.object), parts: [basename(d.object)] },
      f,
      false,
    );
    if (typeof got !== "string") return d.object;
  }
  return undefined;
}

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

/** The bytes as text when they are well-formed UTF-8, else undefined. */
function utf8(b: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return undefined;
  }
}
