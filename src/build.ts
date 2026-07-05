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
 *   derived from the object graph;
 * - build settings whose keys end in `SWIFT_VERSION`, `MARKETING_VERSION`,
 *   or `_DEPLOYMENT_TARGET` rendered with a trailing `.0` when integral.
 *
 * @module
 */

import { createReferenceComments, isDictionary } from "./comments";
import { PbxprojBuildError } from "./errors";
import { ensureQuotes, formatData } from "./quotes";
import type { PbxprojObject, PbxprojValue } from "./types";

const SHEBANG = "// !$*UTF8*$!";

/**
 * Build-setting keys whose integral values Xcode writes with a trailing
 * `.0` (`SWIFT_VERSION = 5.0;`). The all-uppercase guard keeps ordinary
 * lowercase keys like `name` out of the heuristic.
 */
function keyHasFloatValue(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code >= 0x61 && code <= 0x7a) {
      return false;
    }
  }
  return key.endsWith("SWIFT_VERSION") || key.endsWith("MARKETING_VERSION") || key.endsWith("_DEPLOYMENT_TARGET");
}

/** The caller has already rejected non-finite values (with the value's path). */
function formatNumber(value: number, key: string): string {
  if (Number.isInteger(value) && keyHasFloatValue(key)) {
    return `${value}.0`;
  }
  return String(value);
}

function nonFiniteNumber(value: number, path: string): PbxprojBuildError {
  return new PbxprojBuildError(`Cannot serialize non-finite number ${String(value)}`, path);
}

function invalidValue(value: unknown, path: string): PbxprojBuildError {
  const kind = value === null ? "null" : typeof value;
  return new PbxprojBuildError(
    `Cannot serialize a ${kind} value; the pbxproj format carries strings, numbers, data, arrays, and dictionaries`,
    path,
  );
}

/** Indentation strings by depth, extended on demand; avoids a `repeat` allocation per line. */
const INDENTS: string[] = [""];
function indentString(depth: number): string {
  let known = INDENTS[INDENTS.length - 1]!;
  while (INDENTS.length <= depth) {
    known += "\t";
    INDENTS.push(known);
  }
  return INDENTS[depth]!;
}

class Writer {
  private out = "";
  private indent = 0;
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

  constructor(root: PbxprojObject) {
    this.comments = createReferenceComments(root);
    this.out = `${SHEBANG}\n`;
    this.line("{");
    this.indent++;
    this.writeObjectBody(root, true, "$");
    this.indent--;
    this.line("}");
  }

  result(): string {
    return this.out;
  }

  private pad(): void {
    this.out += indentString(this.indent);
  }

  private line(text: string): void {
    this.out += `${indentString(this.indent)}${text}\n`;
  }

  /** A uuid reference with its display comment, or a plain quoted value. */
  private referenceOrValue(id: string): string {
    const cached = this.renderedReferences.get(id);
    if (cached != null) {
      return cached;
    }
    const comment = this.comments.get(id);
    const rendered = comment != null && comment.length > 0 ? `${id} /* ${comment} */` : ensureQuotes(id);
    this.renderedReferences.set(id, rendered);
    return rendered;
  }

  private quotedKey(key: string): string {
    const cached = this.quotedKeys.get(key);
    if (cached != null) {
      return cached;
    }
    const quoted = ensureQuotes(key);
    this.quotedKeys.set(key, quoted);
    return quoted;
  }

  /**
   * `remoteGlobalIDString` and `TestTargetID` hold uuids of objects in
   * *another* container; annotating them with this container's comments
   * would be wrong, so they render bare.
   */
  private stringValue(key: string, value: string): string {
    if (key === "remoteGlobalIDString" || key === "TestTargetID") {
      return ensureQuotes(value);
    }
    return this.referenceOrValue(value);
  }

  // Value paths (`$.objects.AA….name`) exist for error messages and are only
  // constructed in the branches that recurse or throw; the flat string and
  // number lines that dominate documents skip the concatenation. Output is
  // appended piecewise — engines represent string concatenation as ropes, so
  // appends are cheap while interpolation templates would allocate an
  // intermediate string per line.
  private writeObjectBody(object: PbxprojObject, isBase: boolean, path: string): void {
    for (const key of Object.keys(object)) {
      const value = object[key];
      if (typeof value === "string") {
        this.out += indentString(this.indent);
        this.out += this.quotedKey(key);
        this.out += " = ";
        this.out += this.stringValue(key, value);
        this.out += ";\n";
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          throw nonFiniteNumber(value, `${path}.${key}`);
        }
        this.out += indentString(this.indent);
        this.out += this.quotedKey(key);
        this.out += " = ";
        this.out += formatNumber(value, key);
        this.out += ";\n";
      } else if (value instanceof Uint8Array) {
        this.line(`${this.quotedKey(key)} = ${formatData(value)};`);
      } else if (Array.isArray(value)) {
        this.writeArray(key, value, `${path}.${key}`);
      } else if (isDictionary(value)) {
        if (!isBase && Object.keys(value).length === 0) {
          this.line(`${this.quotedKey(key)} = {};`);
          continue;
        }
        this.line(`${this.quotedKey(key)} = {`);
        this.indent++;
        if (isBase && key === "objects") {
          this.writeObjectsSections(value, `${path}.${key}`);
        } else {
          // The base flag applies to root-level keys only; nested empty
          // dictionaries collapse to `{}` even under a root dictionary.
          this.writeObjectBody(value, false, `${path}.${key}`);
        }
        this.indent--;
        this.line("};");
      } else {
        throw invalidValue(value, `${path}.${key}`);
      }
    }
  }

  /** The root `objects` dictionary, grouped into per-isa sections. */
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
      this.out += `\n/* Begin ${isa} section */\n`;

      const entries = (byIsa.get(isa) ?? []).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

      for (const [id, object] of entries) {
        this.pad();
        // Build files and file references render inline; Xcode keeps these
        // high-volume sections one entry per line.
        if (isa === "PBXBuildFile" || isa === "PBXFileReference") {
          let text = this.inlineObject(id, object, `${path}.${id}`);
          if (text.endsWith(" ")) {
            text = text.slice(0, -1);
          }
          this.out += text;
          this.out += "\n";
        } else {
          this.out += `${this.referenceOrValue(id)} = {\n`;
          this.indent++;
          this.writeObjectBody(object, false, `${path}.${id}`);
          this.indent--;
          this.line("};");
        }
      }

      this.out += `/* End ${isa} section */\n`;
    }
  }

  /** One `uuid /* comment *​/ = {isa = …; };` line. */
  private inlineObject(key: string, object: PbxprojObject, path: string): string {
    let text = `${this.referenceOrValue(key)} = {`;

    for (const innerKey of Object.keys(object)) {
      const value = object[innerKey];
      if (typeof value === "string") {
        text += `${this.quotedKey(innerKey)} = ${this.stringValue(innerKey, value)}; `;
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          throw nonFiniteNumber(value, `${path}.${innerKey}`);
        }
        text += `${this.quotedKey(innerKey)} = ${formatNumber(value, innerKey)}; `;
      } else if (value instanceof Uint8Array) {
        text += `${this.quotedKey(innerKey)} = ${formatData(value)}; `;
      } else if (Array.isArray(value)) {
        text += `${this.quotedKey(innerKey)} = (`;
        for (let index = 0; index < value.length; index++) {
          const item = value[index];
          if (typeof item === "string") {
            text += `${ensureQuotes(item)}, `;
          } else if (typeof item === "number" && Number.isFinite(item)) {
            text += `${formatNumber(item, "")}, `;
          } else {
            throw typeof item === "number"
              ? nonFiniteNumber(item, `${path}.${innerKey}[${index}]`)
              : invalidValue(item, `${path}.${innerKey}[${index}]`);
          }
        }
        text += "); ";
      } else if (isDictionary(value)) {
        text += this.inlineObject(innerKey, value, `${path}.${innerKey}`);
      } else {
        throw invalidValue(value, `${path}.${innerKey}`);
      }
    }

    text += "}; ";
    return text;
  }

  private writeArray(key: string, items: PbxprojValue[], path: string): void {
    this.line(`${this.quotedKey(key)} = (`);
    this.indent++;

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (typeof item === "string") {
        this.out += indentString(this.indent);
        this.out += this.referenceOrValue(item);
        this.out += ",\n";
      } else if (typeof item === "number") {
        if (!Number.isFinite(item)) {
          throw nonFiniteNumber(item, `${path}[${index}]`);
        }
        this.line(`${formatNumber(item, "")},`);
      } else if (item instanceof Uint8Array) {
        this.line(`${formatData(item)},`);
      } else if (isDictionary(item)) {
        this.line("{");
        this.indent++;
        this.writeObjectBody(item, false, `${path}[${index}]`);
        this.indent--;
        this.line("},");
      } else {
        throw invalidValue(item, `${path}[${index}]`);
      }
    }

    this.indent--;
    this.line(");");
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
  return new Writer(root).result();
}
