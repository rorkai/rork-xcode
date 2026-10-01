/**
 * Serializer producing the exact text Xcode writes for `project.xcproj`
 * files.
 *
 * Xcode indents by two spaces per level and writes a trailing comma after
 * every entry of a multi-line container. Single-line containers read
 * `{ "a": 1, "b": 2 }` and `[ "a", "b" ]`, with empty ones as `{}` and
 * `[]`. Two adjacent multi-line containers in an array share a line as
 * `}, {`. Records list their keys in a fixed order, dictionaries and sets
 * without a meaningful order are sorted, and strings are escaped exactly
 * as Foundation's JSON encoder escapes them.
 *
 * Which containers print on one line, which keys come first, and which
 * collections are sorted follows the project schema in `schema.ts`.
 *
 * @module
 */

import { XcprojBuildError } from "../errors";
import { compareStrings, PLAIN_SHAPE, PROJECT_SHAPE } from "./schema";

import type { XcprojShape } from "./schema";
import type { XcprojArray, XcprojObject, XcprojValue } from "./types";

/**
 * The escape sequence of each ASCII code unit Foundation's JSON encoder
 * escapes, indexed by code unit. That covers the quote, the backslash, and
 * the C0 control characters, of which five get short escapes and the rest
 * a lowercase `\u00xx`. Everything else, including `/` and non-ASCII
 * text, is written as is.
 */
const ESCAPES: readonly (string | undefined)[] = (() => {
  const table: (string | undefined)[] = Array.from({ length: 0x80 });
  for (let code = 0; code < 0x20; code++) {
    table[code] = `\\u00${code.toString(16).padStart(2, "0")}`;
  }
  table[0x08] = "\\b";
  table[0x09] = "\\t";
  table[0x0a] = "\\n";
  table[0x0c] = "\\f";
  table[0x0d] = "\\r";
  table[0x22] = '\\"';
  table[0x5c] = "\\\\";
  return table;
})();

/**
 * Matches any character that needs an escape or a closer look, so the
 * plain strings that make up nearly all of a project skip the per-character
 * loop. In Unicode mode the surrogate range matches only unpaired halves,
 * so text with emoji takes the fast path too.
 */
// oxlint-disable-next-line no-control-regex -- the control characters are part of the scanned-for set
const NEEDS_SCAN = /[\u0000-\u001F"\\\uD800-\uDFFF]/u;

/**
 * Keys that can follow a `.` in a value path without quoting.
 */
const SIMPLE_KEY = /^[A-Za-z_$][\w$-]*$/u;

/**
 * Indentation strings by depth, extended on demand.
 */
const INDENTS: string[] = [""];

/**
 * Returns the shared indentation string for a nesting depth.
 */
function indentString(depth: number): string {
  const cached = INDENTS[depth];
  if (cached != null) {
    return cached;
  }
  let known = INDENTS.at(-1)!;
  while (INDENTS.length <= depth) {
    known += "  ";
    INDENTS.push(known);
  }
  return known;
}

/**
 * Appends a dictionary key or an array index to a value path.
 */
function childPath(path: string, segment: string | number): string {
  if (typeof segment === "number") {
    return `${path}[${segment}]`;
  }
  return SIMPLE_KEY.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}

/**
 * Whether a value is a plain dictionary, as opposed to an array, a class
 * instance, or a scalar.
 */
function isPlainObject(value: unknown): value is XcprojObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Encodes a string as a quoted JSON string the way Foundation does, or
 * returns `undefined` when Xcode could not read the string back. That
 * covers unpaired surrogates, which no UTF-8 file can hold, and U+0000,
 * which Xcode's JSON reader rejects even in its escaped form.
 */
function encodeString(value: string): string | undefined {
  if (!NEEDS_SCAN.test(value)) {
    return `"${value}"`;
  }
  let out = '"';
  let chunkStart = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      return undefined;
    }
    if (code < 0x80) {
      const escape = ESCAPES[code];
      if (escape != null) {
        out += value.slice(chunkStart, i) + escape;
        chunkStart = i + 1;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const next = value.charCodeAt(i + 1);
      if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) {
        return undefined;
      }
      i++;
    }
  }
  return `${out}${value.slice(chunkStart)}"`;
}

/**
 * Formats a finite number the way Foundation's JSON encoder does.
 * Integers in the safe range and values from 1e-4 up to 2^53 print in
 * plain decimal notation. Anything else prints in exponent notation with a
 * signed exponent of at least two digits, as in `1e-05` and `1e+16`. The
 * digits are the shortest that read back as the same number, which both
 * Foundation and JavaScript produce.
 */
function formatNumber(value: number): string {
  if (Number.isSafeInteger(value)) {
    return String(value);
  }
  const magnitude = Math.abs(value);
  if (magnitude >= 1e-4 && magnitude <= 2 ** 53) {
    return String(value);
  }
  const [mantissa, exponent = "+0"] = value.toExponential().split("e");
  const sign = exponent.startsWith("-") ? "-" : "+";
  const digits = exponent.replace(/^[+-]/u, "");
  return `${mantissa}e${sign}${digits.padStart(2, "0")}`;
}

/**
 * Creates the error for a value outside the JSON value model at the given
 * value path.
 */
function invalidValue(value: unknown, path: string): XcprojBuildError {
  const kind = typeof value === "object" ? "non-plain object" : typeof value;
  return new XcprojBuildError(
    `Cannot serialize a ${kind} value; the xcproj format carries strings, numbers, booleans, null, arrays, and dictionaries`,
    path,
  );
}

/**
 * Whether the container at a position prints on a single line.
 */
function isCompact(shape: XcprojShape, container: XcprojObject | XcprojArray): boolean {
  const compact = shape.compact;
  return typeof compact === "function" ? compact(container) : compact === true;
}

/**
 * Returns the keys of a dictionary in the order Xcode writes them.
 *
 * Dictionaries keyed by arbitrary names sort their keys. Records put their
 * known keys in canonical order and any unknown keys after them in
 * document order. Documents Xcode wrote are already in this order, which
 * the first loop confirms without allocating a sorted copy.
 */
function orderedKeys(object: XcprojObject, shape: XcprojShape): string[] {
  const keys = Object.keys(object);
  if (shape.values != null) {
    for (let i = 1; i < keys.length; i++) {
      if (compareStrings(keys[i - 1]!, keys[i]!) > 0) {
        return keys.toSorted(compareStrings);
      }
    }
    return keys;
  }

  const rank = shape.rank;
  if (rank == null) {
    return keys;
  }
  const unknown = rank.size;
  let last = -1;
  for (const key of keys) {
    const position = rank.get(key) ?? unknown;
    if (position < last) {
      return keys.toSorted((a, b) => (rank.get(a) ?? unknown) - (rank.get(b) ?? unknown));
    }
    last = position;
  }
  return keys;
}

/**
 * Serialization state for one {@link buildXcproj} call.
 *
 * Output accumulates by appending to one string, because engines
 * represent growing strings as ropes and appends stay cheap. Value paths
 * exist for error messages only, so each value carries its parent's path
 * and its own key or index, and the full path is joined only when the
 * writer enters a container or a failure is actually reported.
 */
class Writer {
  /** The document text accumulated so far. */
  private out = "";

  /**
   * Encoded dictionary keys, memoized because keys draw from a small
   * vocabulary of schema keys and build setting names.
   */
  private readonly encodedKeys = new Map<string, string>();

  /**
   * Serializes the whole document eagerly. Read it back with
   * {@link toString}.
   *
   * @param root The document root.
   */
  constructor(root: XcprojValue) {
    this.writeValue(root, isPlainObject(root) ? PROJECT_SHAPE : PLAIN_SHAPE, 0, false, "");
    this.out += "\n";
  }

  /**
   * Returns the serialized document text.
   */
  toString(): string {
    return this.out;
  }

  /**
   * Appends one value.
   *
   * @param value The value to write.
   * @param shape The schema shape of the value's position.
   * @param depth Nesting depth of the value, for indentation.
   * @param inline Whether an enclosing container prints on one line.
   * @param parentPath Value path of the enclosing container, for error
   *   messages.
   * @param segment The value's key or index in that container, omitted
   *   for the root.
   */
  private writeValue(
    value: unknown,
    shape: XcprojShape,
    depth: number,
    inline: boolean,
    parentPath: string,
    segment?: string | number,
  ): void {
    const path = (): string => (segment == null ? "$" : childPath(parentPath, segment));
    switch (typeof value) {
      case "string": {
        const encoded = encodeString(value);
        if (encoded == null) {
          throw new XcprojBuildError(
            "Cannot serialize a string with an unpaired surrogate or U+0000, which Xcode cannot read",
            path(),
          );
        }
        this.out += encoded;
        return;
      }
      case "boolean":
        this.out += value ? "true" : "false";
        return;
      case "number":
        if (!Number.isFinite(value)) {
          throw new XcprojBuildError(`Cannot serialize non-finite number ${String(value)}`, path());
        }
        this.out += formatNumber(value);
        return;
      case "object":
        if (value === null) {
          this.out += "null";
          return;
        }
        if (Array.isArray(value)) {
          const items = value as XcprojArray;
          this.writeArray(items, shape, depth, inline || isCompact(shape, items), path());
          return;
        }
        if (isPlainObject(value)) {
          const concrete = shape.variant?.(value) ?? shape;
          this.writeObject(value, concrete, depth, inline || isCompact(concrete, value), path());
          return;
        }
        break;
      default:
        break;
    }
    throw invalidValue(value, path());
  }

  /**
   * Appends an array, on one line or one element per line.
   *
   * In the multi-line form, an element that is itself a multi-line
   * container shares its closing line with the next element when that one
   * is a multi-line container too, which is how Xcode writes lists of
   * targets and groups as `}, {`.
   */
  private writeArray(items: XcprojArray, shape: XcprojShape, depth: number, inline: boolean, path: string): void {
    const ordered = shape.order == null ? items : shape.order(items);
    const itemShape = shape.items ?? PLAIN_SHAPE;
    // Paths name positions in the document, so a sorted element reports
    // where it sits in the input rather than in the output.
    const position = (index: number): number =>
      ordered === items ? index : items.indexOf(ordered[index] as XcprojValue);

    if (inline) {
      if (ordered.length === 0) {
        this.out += "[]";
        return;
      }
      this.out += "[ ";
      for (let index = 0; index < ordered.length; index++) {
        if (index > 0) {
          this.out += ", ";
        }
        this.writeValue(ordered[index], itemShape, depth, true, path, position(index));
      }
      this.out += " ]";
      return;
    }

    this.out += "[\n";
    const indent = indentString(depth + 1);
    let atLineStart = true;
    let sprawling = this.isSprawlingContainer(ordered[0], itemShape);
    for (let index = 0; index < ordered.length; index++) {
      if (atLineStart) {
        this.out += indent;
      }
      this.writeValue(ordered[index], itemShape, depth + 1, false, path, position(index));
      const nextSprawling = index + 1 < ordered.length && this.isSprawlingContainer(ordered[index + 1], itemShape);
      const joined = sprawling && nextSprawling;
      this.out += joined ? ", " : ",\n";
      atLineStart = !joined;
      sprawling = nextSprawling;
    }
    this.out += indentString(depth);
    this.out += "]";
  }

  /**
   * Whether an array element is a container that prints over multiple
   * lines.
   */
  private isSprawlingContainer(value: XcprojValue | undefined, shape: XcprojShape): boolean {
    if (Array.isArray(value)) {
      return !isCompact(shape, value);
    }
    if (isPlainObject(value)) {
      return !isCompact(shape.variant?.(value) ?? shape, value);
    }
    return false;
  }

  /**
   * Appends a dictionary, on one line or one entry per line.
   */
  private writeObject(object: XcprojObject, shape: XcprojShape, depth: number, inline: boolean, path: string): void {
    const keys = orderedKeys(object, shape);

    if (inline) {
      if (keys.length === 0) {
        this.out += "{}";
        return;
      }
      this.out += "{ ";
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!;
        if (index > 0) {
          this.out += ", ";
        }
        this.out += this.encodeKey(key, path);
        this.out += ": ";
        this.writeValue(object[key], this.fieldShape(shape, key), depth, true, path, key);
      }
      this.out += " }";
      return;
    }

    this.out += "{\n";
    const indent = indentString(depth + 1);
    for (const key of keys) {
      this.out += indent;
      this.out += this.encodeKey(key, path);
      this.out += ": ";
      this.writeValue(object[key], this.fieldShape(shape, key), depth + 1, false, path, key);
      this.out += ",\n";
    }
    this.out += indentString(depth);
    this.out += "}";
  }

  /**
   * The shape of the value under a key of a dictionary.
   */
  private fieldShape(shape: XcprojShape, key: string): XcprojShape {
    return shape.values ?? shape.fields?.get(key) ?? PLAIN_SHAPE;
  }

  /**
   * Encodes a dictionary key, memoized across the document.
   */
  private encodeKey(key: string, path: string): string {
    const cached = this.encodedKeys.get(key);
    if (cached != null) {
      return cached;
    }
    const encoded = encodeString(key);
    if (encoded == null) {
      throw new XcprojBuildError(
        `Cannot serialize the key ${JSON.stringify(key)}, which carries an unpaired surrogate or U+0000 Xcode cannot read`,
        path,
      );
    }
    this.encodedKeys.set(key, encoded);
    return encoded;
  }
}

/**
 * Serializes a project document to `project.xcproj` text.
 *
 * The input is the same shape {@link parseXcproj} produces. A dictionary
 * root is laid out as a project, with keys in Xcode's order, sorted
 * settings and sets, and Xcode's choice of single-line and multi-line
 * containers, so an Xcode-written document rebuilds byte for byte and an
 * edited one diffs the way Xcode would write it. Any other root value
 * serializes too, with every container over multiple lines.
 *
 * The builder never adds, drops, or rewrites values. Defaults Xcode
 * would omit stay in the output when the document carries them.
 *
 * @param root The document root.
 * @returns The document text, terminated by a newline.
 * @throws XcprojBuildError when a value has no JSON representation,
 *   meaning `undefined`, bigints, functions, symbols, class instances,
 *   non-finite numbers, or strings with an unpaired surrogate. The error
 *   names the path of the offending value.
 */
export function buildXcproj(root: XcprojValue): string {
  return new Writer(root).toString();
}
