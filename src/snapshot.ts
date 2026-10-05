/** Consent fingerprints local inputs without returning their contents. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { ArgumentError } from "./argv.js";

export async function fingerprint(path: string, cwd?: string): Promise<string> {
  const hash = createHash("sha256");
  let count = 0;
  let bytes = 0;
  async function visit(full: string, relative: string): Promise<void> {
    const st = await lstat(full);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()))
      throw new ArgumentError(
        `consent input ${full} must be a regular file or directory, without links`,
      );
    if (++count > 20000 || (bytes += st.size) > 1024 ** 3)
      throw new ArgumentError("consent inputs exceed 20,000 entries or 1 GiB");
    hash.update(JSON.stringify([relative, st.isDirectory() ? "dir" : "file", st.size]));
    if (st.isDirectory()) {
      for (const name of (await readdir(full)).sort())
        await visit(join(full, name), join(relative, name));
    } else {
      for await (const chunk of createReadStream(full)) hash.update(chunk);
    }
  }
  try {
    await visit(resolve(cwd ?? process.cwd(), path), "");
  } catch (err) {
    if (err instanceof ArgumentError) throw err;
    throw new ArgumentError(`cannot fingerprint ${path}: ${(err as Error).message}`);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Bare directory names are valid pack paths too; stored names remain metadata-only. */
export async function localPackPaths(names: string[], cwd?: string): Promise<string[]> {
  const paths: string[] = [];
  for (const name of names) {
    try {
      await lstat(resolve(cwd ?? process.cwd(), name));
      paths.push(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || /[\\/]/.test(name))
        throw new ArgumentError(`cannot locate Knowledge input ${name}: ${(err as Error).message}`);
    }
  }
  return paths;
}
