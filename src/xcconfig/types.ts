/**
 * Document types for Xcode build configuration files (`.xcconfig`).
 *
 * The format is line based, so the document is the ordered list of parsed
 * lines. Every statement keeps the exact text it was parsed from (`raw`)
 * and its line terminator (`eol`), which is what lets an untouched
 * document rebuild byte for byte even though the format is hand-authored
 * and has no canonical layout.
 *
 * @module
 */

/**
 * One `[name=value]` condition attached to a setting assignment, as in
 * `LDFLAGS[sdk=iphoneos*] = -lfoo`.
 */
export interface XcconfigCondition {
  /** The condition name, for example `sdk`, `arch`, or `config`. */
  name: string;

  /** The condition value, which may carry a trailing `*` wildcard. */
  value: string;
}

/**
 * A `KEY = value` line, optionally with conditions between the key and
 * the equals sign. The value has surrounding whitespace, an optional
 * trailing semicolon, and any trailing `//` comment removed.
 */
export interface XcconfigAssignment {
  kind: "assignment";

  /** The setting name. */
  key: string;

  /** The `[name=value]` conditions, in written order. Usually empty. */
  conditions: readonly XcconfigCondition[];

  /** The assigned value with comment, semicolon, and padding stripped. */
  value: string;

  /** The exact source line, without its terminator. */
  raw: string;

  /** The line terminator, `"\n"`, `"\r\n"`, or `""` on a final line. */
  eol: string;
}

/**
 * An `#include "path"` line. The optional form `#include? "path"` tells
 * Xcode to ignore a missing file, and callers should mirror that when
 * resolving includes.
 */
export interface XcconfigInclude {
  kind: "include";

  /** The include path exactly as written between the quotes. */
  path: string;

  /** True for the `#include?` form. */
  optional: boolean;

  /** The exact source line, without its terminator. */
  raw: string;

  /** The line terminator, `"\n"`, `"\r\n"`, or `""` on a final line. */
  eol: string;
}

/**
 * A line holding only a `//` comment.
 */
export interface XcconfigComment {
  kind: "comment";

  /** The comment text after `//`, untrimmed. */
  text: string;

  /** The exact source line, without its terminator. */
  raw: string;

  /** The line terminator, `"\n"`, `"\r\n"`, or `""` on a final line. */
  eol: string;
}

/**
 * A line that is empty or holds only whitespace.
 */
export interface XcconfigBlank {
  kind: "blank";

  /** The exact source line, without its terminator. */
  raw: string;

  /** The line terminator, `"\n"`, `"\r\n"`, or `""` on a final line. */
  eol: string;
}

/**
 * Any parsed `.xcconfig` line.
 */
export type XcconfigStatement = XcconfigAssignment | XcconfigBlank | XcconfigComment | XcconfigInclude;

/**
 * A parsed `.xcconfig` file: its lines in order.
 */
export interface XcconfigDocument {
  statements: XcconfigStatement[];
}
