/**
 * Object model for Xcode build configuration files (`.xcconfig`).
 *
 * {@link Xcconfig} wraps a parsed document the way `XcodeProject` wraps a
 * pbxproj: the document stays the single source of truth, reads and
 * writes go through it, and {@link Xcconfig.build} emits it back with
 * untouched lines preserved byte for byte.
 *
 * @module
 */

import { buildXcconfig } from "./build";
import { parseXcconfig } from "./parse";

import type { XcconfigAssignment, XcconfigDocument, XcconfigInclude } from "./types";

/**
 * Resolves an `#include` path to the included file's model. Returning
 * `undefined` skips the include, which is always legal for the
 * `#include?` form and mirrors a missing file for the strict form.
 */
export type XcconfigIncludeResolver = (path: string, optional: boolean) => Xcconfig | undefined;

/**
 * Options for {@link Xcconfig.settings}.
 */
export interface XcconfigSettingsOptions {
  /**
   * Called for every `#include` directive, in document order. Without a
   * resolver, includes contribute nothing.
   */
  resolveInclude?: XcconfigIncludeResolver;
}

/**
 * A build configuration file with typed, mutable access to its settings.
 *
 * ```ts
 * const config = Xcconfig.parse(text);
 * config.get("PRODUCT_BUNDLE_IDENTIFIER");
 * config.set("MARKETING_VERSION", "1.2.0");
 * const updated = config.build();
 * ```
 */
export class Xcconfig {
  /** The parsed document this model wraps. */
  readonly document: XcconfigDocument;

  private constructor(document: XcconfigDocument) {
    this.document = document;
  }

  /**
   * Parses `.xcconfig` text and wraps it in a model.
   *
   * @throws XcconfigParseError when the text is malformed.
   */
  static parse(text: string): Xcconfig {
    return new Xcconfig(parseXcconfig(text));
  }

  /**
   * Creates an empty configuration file.
   */
  static create(): Xcconfig {
    return new Xcconfig({ statements: [] });
  }

  /**
   * Serializes the current document state to `.xcconfig` text.
   */
  build(): string {
    return buildXcconfig(this.document);
  }

  /**
   * The names of the settings this file assigns unconditionally, in
   * first-assignment order. Conditional assignments such as
   * `KEY[sdk=iphoneos*]` are reachable through {@link assignments}.
   */
  keys(): string[] {
    const keys: string[] = [];
    for (const statement of this.document.statements) {
      if (statement.kind === "assignment" && statement.conditions.length === 0 && !keys.includes(statement.key)) {
        keys.push(statement.key);
      }
    }
    return keys;
  }

  /**
   * Every assignment of this file, conditional ones included, in
   * document order.
   */
  assignments(): readonly XcconfigAssignment[] {
    return this.document.statements.filter((statement) => statement.kind === "assignment");
  }

  /**
   * The `#include` directives of this file, in document order.
   */
  includes(): readonly XcconfigInclude[] {
    return this.document.statements.filter((statement) => statement.kind === "include");
  }

  /**
   * Reads the value of a setting from this file alone. When the key is
   * assigned more than once the last assignment wins, matching how Xcode
   * reads the file top to bottom. Conditional assignments are ignored.
   */
  get(key: string): string | undefined {
    let value: string | undefined;
    for (const statement of this.document.statements) {
      if (statement.kind === "assignment" && statement.key === key && statement.conditions.length === 0) {
        value = statement.value;
      }
    }
    return value;
  }

  /**
   * Writes a setting. The last unconditional assignment of the key is
   * rewritten in place as a canonical `KEY = value` line, replacing any
   * trailing comment the line carried. A key the file does not assign
   * yet is appended at the end.
   */
  set(key: string, value: string): void {
    let target: XcconfigAssignment | undefined;
    for (const statement of this.document.statements) {
      if (statement.kind === "assignment" && statement.key === key && statement.conditions.length === 0) {
        target = statement;
      }
    }

    if (target != null) {
      target.value = value;
      target.raw = `${key} = ${value}`;
      return;
    }

    const last = this.document.statements.at(-1);
    if (last != null && last.eol === "") {
      last.eol = "\n";
    }
    this.document.statements.push({
      kind: "assignment",
      key,
      conditions: [],
      value,
      raw: `${key} = ${value}`,
      eol: "\n",
    });
  }

  /**
   * Removes every unconditional assignment of a setting.
   *
   * @returns True when at least one assignment was removed.
   */
  remove(key: string): boolean {
    const kept = this.document.statements.filter(
      (statement) => statement.kind !== "assignment" || statement.key !== key || statement.conditions.length > 0,
    );
    const removed = kept.length !== this.document.statements.length;
    this.document.statements = kept;
    return removed;
  }

  /**
   * Flattens the file into a settings dictionary the way Xcode reads it:
   * top to bottom with later assignments winning, and every `#include`
   * contributing its settings at the point of the directive, so lines
   * after an include override it. Conditional assignments are skipped.
   *
   * Includes only take part when {@link XcconfigSettingsOptions.resolveInclude}
   * is provided, since the library never touches the filesystem itself.
   * A file reachable through more than one include path is applied once.
   */
  settings(options: XcconfigSettingsOptions = {}): Record<string, string> {
    const merged: Record<string, string> = {};
    const visited = new Set<Xcconfig>();

    const visit = (config: Xcconfig): void => {
      if (visited.has(config)) {
        return;
      }
      visited.add(config);
      for (const statement of config.document.statements) {
        if (statement.kind === "include") {
          const included = options.resolveInclude?.(statement.path, statement.optional);
          if (included != null) {
            visit(included);
          }
        } else if (statement.kind === "assignment" && statement.conditions.length === 0) {
          merged[statement.key] = statement.value;
        }
      }
    };

    visit(this);
    return merged;
  }
}
