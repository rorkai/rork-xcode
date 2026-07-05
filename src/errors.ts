/**
 * Error types raised by this library.
 *
 * Both error classes are exported so callers can distinguish "the document is
 * malformed" ({@link PbxprojParseError}) from "this value cannot be written"
 * ({@link PbxprojBuildError}) and report precise context for each.
 *
 * @module
 */

/** UTF-16 code unit of `\n`, used to count lines when reporting a failure. */
const LINE_FEED = 0x0a;

/**
 * Location of a parse failure inside the source text.
 *
 * Offsets count UTF-16 code units from the start of the string (the same
 * units `String.prototype.slice` uses), so editors and log tooling can jump
 * straight to the failure.
 */
export interface PbxprojErrorPosition {
  /** Zero-based character offset into the source string. */
  offset: number;

  /** One-based line number. */
  line: number;

  /** One-based column number, in characters from the start of the line. */
  column: number;
}

/**
 * Converts a source offset into a position.
 *
 * Runs only when an error is actually thrown, so parsing never pays for line
 * tracking on the happy path.
 */
function positionAt(source: string, offset: number): PbxprojErrorPosition {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === LINE_FEED) {
      line++;
      lineStart = i + 1;
    }
  }
  return { offset, line, column: offset - lineStart + 1 };
}

/**
 * Thrown when the source text is not a well-formed OpenStep-style property
 * list (the format of `project.pbxproj` files).
 *
 * The message always embeds the line and column of the failure, and the same
 * information is available in structured form on {@link position} for
 * programmatic use.
 */
export class PbxprojParseError extends Error {
  /** Where in the source text parsing failed. */
  readonly position: PbxprojErrorPosition;

  /**
   * @param message Failure description without location; the location is
   *   appended automatically.
   * @param source Full source text, used to compute the position.
   * @param offset Character offset of the failure inside `source`.
   */
  constructor(message: string, source: string, offset: number) {
    const position = positionAt(source, offset);
    super(`${message} (line ${position.line}, column ${position.column})`);
    this.name = "PbxprojParseError";
    this.position = position;
  }
}

/**
 * Thrown when a value cannot be represented in a `project.pbxproj` document.
 *
 * Raised for `null`, `undefined`, booleans, bigints, functions, symbols,
 * class instances, and non-finite numbers. The format itself has no boolean
 * or null notation — Xcode models booleans as the strings `YES`/`NO` — so
 * rejecting them loudly beats writing a value Xcode would misread. The
 * {@link path} pinpoints the offending value inside the input, which matters
 * when serializing a project with thousands of objects.
 */
export class PbxprojBuildError extends Error {
  /** Path to the offending value from the root, e.g. `$.objects.13B07F86.name`. */
  readonly path: string;

  /**
   * @param message Failure description without location; the value path is
   *   appended automatically.
   * @param path Path to the offending value from the root, `$`.
   */
  constructor(message: string, path: string) {
    super(`${message} (at ${path})`);
    this.name = "PbxprojBuildError";
    this.path = path;
  }
}
