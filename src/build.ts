/**
 * Serializer producing the exact layout Xcode writes.
 *
 * The layout rules that matter for diffability against Xcode's own output:
 *
 * - the `// !$*UTF8*$!` marker on the first line;
 * - tab indentation, one level per nesting depth;
 * - the root `objects` dictionary grouped into `/* Begin <isa> section *​/`
 *   blocks, sections ordered by isa and entries ordered by uuid;
 * - `PBXBuildFile` and `PBXFileReference` entries rendered on a single line;
 * - reference comments (`13B07F86… /* AppDelegate.swift in Sources *​/`)
 *   derived from the object graph.
 *
 * Numbers render exactly as JavaScript formats them; the version-like
 * settings Xcode writes with a trailing zero (`SWIFT_VERSION = 5.0`) arrive
 * from the parser as strings and round-trip verbatim, so no reformatting
 * heuristic is needed or applied.
 *
 * @module
 */

import { createReferenceComments, isDictionary } from "./comments";
import { PbxprojBuildError } from "./errors";
import { ensureQuotes, formatData } from "./quotes";

import type { PbxprojObject, PbxprojValue } from "./types";

/** The encoding marker Xcode writes on the first line of every document. */
const SHEBANG = "// !$*UTF8*$!";

/**
 * Creates the error for a `NaN` or infinite number at the given value path.
 */
function nonFiniteNumber(value: number, path: string): PbxprojBuildError {
  return new PbxprojBuildError(`Cannot serialize non-finite number ${String(value)}`, path);
}

/**
 * Creates the error for a value outside the pbxproj value model (`null`,
 * booleans, bigints, functions, symbols, class instances) at the given
 * value path.
 */
function invalidValue(value: unknown, path: string): PbxprojBuildError {
  const kind = value === null ? "null" : typeof value;
  return new PbxprojBuildError(
    `Cannot serialize a ${kind} value; the pbxproj format carries strings, numbers, data, arrays, and dictionaries`,
    path,
  );
}

/**
 * Defuses `*​/` sequences inside derived comment text.
 *
 * Comments derive from document fields (names, paths), so a crafted value
 * containing `*​/` could otherwise terminate the comment early and corrupt
 * the surrounding document.
 */
function sanitizeComment(comment: string): string {
  return comment.includes("*/") ? comment.replaceAll("*/", "* /") : comment;
}

/**
 * Indentation strings by depth, extended on demand.
 *
 * Sharing the strings avoids a `"\t".repeat(depth)` allocation on every
 * line of output.
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
    known += "\t";
    INDENTS.push(known);
  }
  return known;
}

/**
 * Serialization state for one {@link buildPbxproj} call.
 *
 * The `write*` methods append directly to the output string; the `render*`
 * methods return fragments for the caller to place. Output accumulates by
 * appending, because engines represent growing strings as ropes: appends
 * stay cheap where template interpolation would allocate an intermediate
 * string per line.
 */
class Writer {
  /** The document text accumulated so far. */
  private out = "";

  /** Current nesting depth; one tab per level. */
  private indent = 0;

  /** Display comment per referenced uuid, derived once from the object graph. */
  private readonly comments: Map<string, string>;

  /**
   * Rendered string values by input string: `id /* comment *​/` for
   * referenced uuids, quoted text for everything else. Referenced objects
   * render at least twice (their section entry plus each referencing site)
   * and build settings repeat across configurations, so most renders are
   * cache hits. The map lives for one build call only.
   */
  private readonly renderedReferences = new Map<string, string>();

  /**
   * Quoting decisions for dictionary keys, which draw from a small repeated
   * vocabulary (`isa`, `fileRef`, build-setting names).
   */
  private readonly quotedKeys = new Map<string, string>();

  /**
   * Serializes the whole document eagerly; read it back with
   * {@link toString}.
   *
   * @param root The document root dictionary.
   */
  constructor(root: PbxprojObject) {
    this.comments = createReferenceComments(root);
    this.out = `${SHEBANG}\n`;
    this.writeLine("{");
    this.indent++;
    this.writeObjectBody(root, true, "$");
    this.indent--;
    this.writeLine("}");
  }

  /**
   * Returns the serialized document text.
   */
  toString(): string {
    return this.out;
  }

  /**
   * Appends the indentation for the current depth.
   */
  private writeIndent(): void {
    this.out += indentString(this.indent);
  }

  /**
   * Appends one indented line followed by a newline.
   */
  private writeLine(text: string): void {
    this.out += `${indentString(this.indent)}${text}\n`;
  }

  /**
   * Renders a string as a uuid reference with its display comment, or as a
   * plain quoted value when no comment is derived for it.
   *
   * Most calls hit the cache, and the writers call this for every key and
   * reference, so the method body stays small enough for the engine to
   * inline; the miss path lives in {@link renderReferenceUncached}.
   */
  private renderReference(id: string): string {
    const cached = this.renderedReferences.get(id);
    if (cached != null) {
      return cached;
    }
    return this.renderReferenceUncached(id);
  }

  /**
   * Renders and caches one reference on its first occurrence. Annotated ids
   * are quoted too when the format requires it: Xcode ids never need
   * quotes, but object keys in hand-written documents can.
   */
  private renderReferenceUncached(id: string): string {
    const comment = this.comments.get(id);
    const quoted = ensureQuotes(id);
    const rendered = comment != null && comment.length > 0 ? `${quoted} /* ${sanitizeComment(comment)} */` : quoted;
    this.renderedReferences.set(id, rendered);
    return rendered;
  }

  /**
   * Renders a dictionary key with quotes when the format requires them,
   * memoized across the document. As with {@link renderReference}, the
   * cache-hit path stays small and the miss path is a separate method.
   */
  private renderKey(key: string): string {
    const cached = this.quotedKeys.get(key);
    if (cached != null) {
      return cached;
    }
    return this.renderKeyUncached(key);
  }

  /**
   * Quotes and caches one dictionary key on its first occurrence.
   */
  private renderKeyUncached(key: string): string {
    const quoted = ensureQuotes(key);
    this.quotedKeys.set(key, quoted);
    return quoted;
  }

  /**
   * Renders a string value in its key's context.
   *
   * `remoteGlobalIDString` and `TestTargetID` hold uuids of objects in
   * another container; annotating them with this container's comments would
   * be wrong, so they render bare.
   */
  private renderStringValue(key: string, value: string): string {
    if (key === "remoteGlobalIDString" || key === "TestTargetID") {
      return ensureQuotes(value);
    }
    return this.renderReference(value);
  }

  /**
   * Appends the entries of a dictionary, one `key = value;` line each.
   *
   * Value paths (`$.objects.AA….name`) exist for error messages and are
   * only constructed in the branches that recurse or throw; the flat string
   * and number lines that dominate documents skip the concatenation.
   *
   * @param object The dictionary whose entries to write.
   * @param isBase Whether this is the document root, where the `objects`
   *   dictionary gets section grouping and empty dictionaries render
   *   multi-line.
   * @param path Value path of `object`, for error messages.
   */
  private writeObjectBody(object: PbxprojObject, isBase: boolean, path: string): void {
    for (const key of Object.keys(object)) {
      const value = object[key];
      if (typeof value === "string") {
        this.out += indentString(this.indent);
        this.out += this.renderKey(key);
        this.out += " = ";
        this.out += this.renderStringValue(key, value);
        this.out += ";\n";
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          throw nonFiniteNumber(value, `${path}.${key}`);
        }
        this.out += indentString(this.indent);
        this.out += this.renderKey(key);
        this.out += " = ";
        this.out += String(value);
        this.out += ";\n";
      } else if (value instanceof Uint8Array) {
        this.writeLine(`${this.renderKey(key)} = ${formatData(value)};`);
      } else if (Array.isArray(value)) {
        this.writeArray(key, value, `${path}.${key}`);
      } else if (isDictionary(value)) {
        if (!isBase && Object.keys(value).length === 0) {
          this.writeLine(`${this.renderKey(key)} = {};`);
          continue;
        }
        this.writeLine(`${this.renderKey(key)} = {`);
        this.indent++;
        if (isBase && key === "objects") {
          this.writeObjectsSections(value, `${path}.${key}`);
        } else {
          // The base flag applies to root-level keys only; nested empty
          // dictionaries collapse to `{}` even under a root dictionary.
          this.writeObjectBody(value, false, `${path}.${key}`);
        }
        this.indent--;
        this.writeLine("};");
      } else {
        throw invalidValue(value, `${path}.${key}`);
      }
    }
  }

  /**
   * Appends the root `objects` dictionary grouped into per-isa sections.
   *
   * Sections are ordered by isa name and entries within a section by uuid,
   * exactly as Xcode sorts them.
   */
  private writeObjectsSections(objects: PbxprojObject, path: string): void {
    const byIsa = new Map<string, [string, PbxprojObject][]>();
    for (const id of Object.keys(objects)) {
      const object = objects[id];
      if (!isDictionary(object)) {
        throw invalidValue(object, `${path}.${id}`);
      }
      const isaValue = object["isa"];
      const isa = typeof isaValue === "string" ? isaValue : "Unknown";
      const entries = byIsa.get(isa);
      if (entries == null) {
        byIsa.set(isa, [[id, object]]);
      } else {
        entries.push([id, object]);
      }
    }

    for (const isa of [...byIsa.keys()].toSorted()) {
      this.out += `\n/* Begin ${sanitizeComment(isa)} section */\n`;

      const entries = (byIsa.get(isa) ?? []).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

      for (const [id, object] of entries) {
        this.writeIndent();
        // Build files and file references render inline; Xcode keeps these
        // high-volume sections one entry per line.
        if (isa === "PBXBuildFile" || isa === "PBXFileReference") {
          let text = this.renderInlineObject(id, object, `${path}.${id}`);
          if (text.endsWith(" ")) {
            text = text.slice(0, -1);
          }
          this.out += text;
          this.out += "\n";
        } else {
          this.out += `${this.renderReference(id)} = {\n`;
          this.indent++;
          this.writeObjectBody(object, false, `${path}.${id}`);
          this.indent--;
          this.writeLine("};");
        }
      }

      this.out += `/* End ${sanitizeComment(isa)} section */\n`;
    }
  }

  /**
   * Renders one object as a single `uuid /* comment *​/ = {isa = …; };`
   * fragment, recursing into nested dictionaries inline.
   */
  private renderInlineObject(key: string, object: PbxprojObject, path: string): string {
    let text = `${this.renderReference(key)} = {`;

    for (const innerKey of Object.keys(object)) {
      const value = object[innerKey];
      if (typeof value === "string") {
        text += `${this.renderKey(innerKey)} = ${this.renderStringValue(innerKey, value)}; `;
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          throw nonFiniteNumber(value, `${path}.${innerKey}`);
        }
        text += `${this.renderKey(innerKey)} = ${String(value)}; `;
      } else if (value instanceof Uint8Array) {
        text += `${this.renderKey(innerKey)} = ${formatData(value)}; `;
      } else if (Array.isArray(value)) {
        text += `${this.renderKey(innerKey)} = (`;
        for (let index = 0; index < value.length; index++) {
          const item = value[index];
          if (typeof item === "string") {
            text += `${ensureQuotes(item)}, `;
          } else if (typeof item === "number" && Number.isFinite(item)) {
            text += `${String(item)}, `;
          } else {
            throw typeof item === "number"
              ? nonFiniteNumber(item, `${path}.${innerKey}[${index}]`)
              : invalidValue(item, `${path}.${innerKey}[${index}]`);
          }
        }
        text += "); ";
      } else if (isDictionary(value)) {
        text += this.renderInlineObject(innerKey, value, `${path}.${innerKey}`);
      } else {
        throw invalidValue(value, `${path}.${innerKey}`);
      }
    }

    text += "}; ";
    return text;
  }

  /**
   * Appends a `key = ( item, … );` array with one indented line per item,
   * the layout Xcode uses for every multi-line list.
   */
  private writeArray(key: string, items: PbxprojValue[], path: string): void {
    this.writeLine(`${this.renderKey(key)} = (`);
    this.indent++;

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (typeof item === "string") {
        this.out += indentString(this.indent);
        this.out += this.renderReference(item);
        this.out += ",\n";
      } else if (typeof item === "number") {
        if (!Number.isFinite(item)) {
          throw nonFiniteNumber(item, `${path}[${index}]`);
        }
        this.writeLine(`${String(item)},`);
      } else if (item instanceof Uint8Array) {
        this.writeLine(`${formatData(item)},`);
      } else if (isDictionary(item)) {
        this.writeLine("{");
        this.indent++;
        this.writeObjectBody(item, false, `${path}[${index}]`);
        this.indent--;
        this.writeLine("},");
      } else {
        throw invalidValue(item, `${path}[${index}]`);
      }
    }

    this.indent--;
    this.writeLine(");");
  }
}

/**
 * Serializes a project document to `project.pbxproj` text.
 *
 * The input is the same shape {@link parsePbxproj} produces; see the module
 * documentation of `types.ts` for the value model. Output is stable: two
 * calls with semantically equal documents produce identical text, and the
 * layout matches what Xcode itself writes so diffs stay minimal.
 *
 * @param root The document root. Real project documents carry `objects`,
 *   `rootObject`, and the version fields, but any dictionary serializes.
 * @returns The document text, terminated by a newline.
 * @throws PbxprojBuildError when a value has no pbxproj representation:
 *   `null`, `undefined`, booleans, bigints, functions, symbols, class
 *   instances, or non-finite numbers. The error names the path of the
 *   offending value.
 */
export function buildPbxproj(root: PbxprojObject): string {
  if (!isDictionary(root)) {
    throw new PbxprojBuildError("The document root must be a dictionary", "$");
  }
  return new Writer(root).toString();
}
