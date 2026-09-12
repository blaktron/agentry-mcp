/**
 * The argv builder: typed tool arguments become CLI flags one token at a
 * time, and a value that looks like a flag is refused rather than passed,
 * so a model cannot reach a consent flag, or any other flag, through a text field.
 */

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

/** A positional or flag value: non-empty, single-line, not a flag. */
export function value(name: string, v: string): string {
  const s = v.trim();
  if (s === "") throw new ArgumentError(`${name} must not be empty`);
  if (s.startsWith("-"))
    throw new ArgumentError(`${name} must not start with "-" (got ${JSON.stringify(s)})`);
  if (/[\r\n\0]/.test(s)) throw new ArgumentError(`${name} must be a single line`);
  return s;
}

/** Appends `--flag value` when v is set. */
export function flag(argv: string[], name: string, v: string | number | undefined): void {
  if (v === undefined || v === "") return;
  argv.push(`--${name}`, value(`--${name}`, String(v)));
}

/** Appends `--flag` when v is true. */
export function bool(argv: string[], name: string, v: boolean | undefined): void {
  if (v) argv.push(`--${name}`);
}
