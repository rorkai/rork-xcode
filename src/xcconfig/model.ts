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
 *
 * Cycles are detected while a file is being expanded, by the include
 * path exactly as written and by model instance. A cycle reached through
 * two different spellings of the same path escapes the path check, so
 * resolvers that memoize per path make the instance check catch it.
 */
export type XcconfigIncludeResolver = (path: string, optional: boolean) => Xcconfig | undefined;

/**
 * The build context conditional assignments are matched against. Keys
 * mirror the condition names of the format, so `KEY[sdk=iphoneos*]`
 * matches against {@link sdk}.
 */
export interface XcconfigBuildContext {
  /** The SDK identifier, for example `iphoneos` or `appletvsimulator`. */
  sdk?: string;

  /** The architecture, for example `arm64`. */
  arch?: string;

  /** The configuration name, for example `Debug`. */
  config?: string;
}

/**
 * Options for {@link Xcconfig.settings}.
 */
export interface XcconfigSettingsOptions {
  /**
   * Called for every `#include` directive, in document order. Without a
   * resolver, includes contribute nothing.
   */
  resolveInclude?: XcconfigIncludeResolver;

  /**
   * The build context conditional assignments apply under. An assignment
   * takes part when every one of its conditions matches, with trailing
   * `*` wildcards honored the way Xcode matches SDK names. Without a
   * context, and for dimensions the context leaves out, conditional
   * assignments are skipped.
   */
  context?: XcconfigBuildContext;
}

/**
 * Whether a condition value matches a context value. A bare `*` matches
 * anything, a trailing `*` matches by prefix, and anything else matches
 * exactly.
 */
function matchesCondition(conditionValue: string, contextValue: string): boolean {
  if (conditionValue === "*") {
    return true;
  }
  if (conditionValue.endsWith("*")) {
    return contextValue.startsWith(conditionValue.slice(0, -1));
  }
  return conditionValue === contextValue;
}

/**
 * Splices a prior value into `$(inherited)` and `${inherited}`
 * references. With no prior value the references stay literal, because
 * they then refer to layers below the file chain, which resolve later.
 */
function spliceInherited(value: string, prior: string | undefined): string {
  if (prior == null) {
    return value;
  }
  return value.replaceAll("$(inherited)", prior).replaceAll("${inherited}", prior);
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
   * document order. The items are the document's own nodes, not copies,
   * so treat them as read-only views. Writes belong on {@link set},
   * which keeps a statement's value and its source text in step.
   */
  assignments(): readonly XcconfigAssignment[] {
    return this.document.statements.filter((statement) => statement.kind === "assignment");
  }

  /**
   * The `#include` directives of this file, in document order. The items
   * are the document's own nodes, not copies, so treat them as read-only
   * views.
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
   * yet is appended at the end, following the document's line-ending
   * convention.
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

    const eol = this.document.statements.find((statement) => statement.eol !== "")?.eol ?? "\n";
    const last = this.document.statements.at(-1);
    if (last != null && last.eol === "") {
      last.eol = eol;
    }
    this.document.statements.push({
      kind: "assignment",
      key,
      conditions: [],
      value,
      raw: `${key} = ${value}`,
      eol,
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
   * after an include override it.
   *
   * Conditional assignments apply when every condition matches
   * {@link XcconfigSettingsOptions.context}; without a context they are
   * skipped. `$(inherited)` references splice in the value accumulated
   * earlier in the chain, and stay literal when there is none, since
   * they then refer to layers below the file, which resolve later.
   *
   * Includes only take part when {@link XcconfigSettingsOptions.resolveInclude}
   * is provided, since the library never touches the filesystem itself.
   * A file included again later re-applies, exactly like pasting its text
   * a second time. Only re-entry while a file is still being expanded is
   * skipped, tracked by include path and by instance, so cyclic includes
   * terminate even when the resolver parses a fresh instance per call.
   */
  settings(options: XcconfigSettingsOptions = {}): Record<string, string> {
    const merged: Record<string, string> = {};
    const pathStack = new Set<string>();
    const instanceStack = new Set<Xcconfig>();
    const context = options.context;

    const applies = (statement: XcconfigAssignment): boolean =>
      statement.conditions.every((condition) => {
        const contextValue =
          condition.name === "sdk" || condition.name === "arch" || condition.name === "config"
            ? context?.[condition.name]
            : undefined;
        return contextValue != null && matchesCondition(condition.value, contextValue);
      });

    const visit = (config: Xcconfig): void => {
      if (instanceStack.has(config)) {
        return;
      }
      instanceStack.add(config);
      for (const statement of config.document.statements) {
        if (statement.kind === "include") {
          if (pathStack.has(statement.path)) {
            continue;
          }
          const included = options.resolveInclude?.(statement.path, statement.optional);
          if (included != null) {
            pathStack.add(statement.path);
            visit(included);
            pathStack.delete(statement.path);
          }
        } else if (statement.kind === "assignment" && applies(statement)) {
          merged[statement.key] = spliceInherited(statement.value, merged[statement.key]);
        }
      }
      instanceStack.delete(config);
    };

    visit(this);
    return merged;
  }
}
