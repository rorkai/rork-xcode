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

function formatNumber(value: number, key: string, path: string): string {
  if (!Number.isFinite(value)) {
    throw new PbxprojBuildError(`Cannot serialize non-finite number ${String(value)}`, path);
  }
  if (Number.isInteger(value) && keyHasFloatValue(key)) {
    return `${value}.0`;
  }
  return String(value);
}

function invalidValue(value: unknown, path: string): PbxprojBuildError {
  const kind = value === null ? "null" : typeof value;
  return new PbxprojBuildError(
    `Cannot serialize a ${kind} value; the pbxproj format carries strings, numbers, data, arrays, and dictionaries`,
    path,
  );
}

class Writer {
  private out = "";
  private indent = 0;
  private readonly comments: Map<string, string>;

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
    this.out += "\t".repeat(this.indent);
  }

  private line(text: string): void {
    this.pad();
    this.out += text;
    this.out += "\n";
  }

  /** A uuid reference with its display comment, or a plain quoted value. */
  private referenceOrValue(id: string): string {
    const comment = this.comments.get(id);
    if (comment != null && comment.length > 0) {
      return `${id} /* ${comment} */`;
    }
    return ensureQuotes(id);
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

  private writeObjectBody(object: PbxprojObject, isBase: boolean, path: string): void {
    for (const [key, value] of Object.entries(object)) {
      const valuePath = `${path}.${key}`;
      if (typeof value === "string") {
        this.line(`${ensureQuotes(key)} = ${this.stringValue(key, value)};`);
      } else if (typeof value === "number") {
        this.line(`${ensureQuotes(key)} = ${formatNumber(value, key, valuePath)};`);
      } else if (value instanceof Uint8Array) {
        this.line(`${ensureQuotes(key)} = ${formatData(value)};`);
      } else if (Array.isArray(value)) {
        this.writeArray(key, value, valuePath);
      } else if (isDictionary(value)) {
        if (!isBase && Object.keys(value).length === 0) {
          this.line(`${ensureQuotes(key)} = {};`);
          continue;
        }
        this.line(`${ensureQuotes(key)} = {`);
        this.indent++;
        if (isBase && key === "objects") {
          this.writeObjectsSections(value, valuePath);
        } else {
          this.writeObjectBody(value, isBase, valuePath);
        }
        this.indent--;
        this.line("};");
      } else {
        throw invalidValue(value, valuePath);
      }
    }
  }

  /** The root `objects` dictionary, grouped into per-isa sections. */
  private writeObjectsSections(objects: PbxprojObject, path: string): void {
    const byIsa = new Map<string, [string, PbxprojObject][]>();
    for (const [id, object] of Object.entries(objects)) {
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

    for (const [innerKey, value] of Object.entries(object)) {
      const valuePath = `${path}.${innerKey}`;
      if (typeof value === "string") {
        text += `${ensureQuotes(innerKey)} = ${this.stringValue(innerKey, value)}; `;
      } else if (typeof value === "number") {
        text += `${ensureQuotes(innerKey)} = ${formatNumber(value, innerKey, valuePath)}; `;
      } else if (value instanceof Uint8Array) {
        text += `${ensureQuotes(innerKey)} = ${formatData(value)}; `;
      } else if (Array.isArray(value)) {
        text += `${ensureQuotes(innerKey)} = (`;
        for (const [index, item] of value.entries()) {
          if (typeof item === "string") {
            text += `${ensureQuotes(item)}, `;
          } else if (typeof item === "number") {
            text += `${formatNumber(item, "", `${valuePath}[${index}]`)}, `;
          } else {
            throw invalidValue(item, `${valuePath}[${index}]`);
          }
        }
        text += "); ";
      } else if (isDictionary(value)) {
        text += this.inlineObject(innerKey, value, valuePath);
      } else {
        throw invalidValue(value, valuePath);
      }
    }

    text += "}; ";
    return text;
  }

  private writeArray(key: string, items: PbxprojValue[], path: string): void {
    this.line(`${ensureQuotes(key)} = (`);
    this.indent++;

    for (const [index, item] of items.entries()) {
      const itemPath = `${path}[${index}]`;
      if (typeof item === "string") {
        this.line(`${this.referenceOrValue(item)},`);
      } else if (typeof item === "number") {
        this.line(`${formatNumber(item, "", itemPath)},`);
      } else if (item instanceof Uint8Array) {
        this.line(`${formatData(item)},`);
      } else if (Array.isArray(item)) {
        throw invalidValue(item, itemPath);
      } else if (isDictionary(item)) {
        this.line("{");
        this.indent++;
        this.writeObjectBody(item, false, itemPath);
        this.indent--;
        this.line("},");
      } else {
        throw invalidValue(item, itemPath);
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
