/**
 * Parser for Xcode build configuration files (`.xcconfig`).
 *
 * The grammar is line based. A line is blank, a `//` comment, an
 * `#include "path"` directive, or a `KEY[conditions] = value` assignment.
 * `//` starts a comment anywhere on a line, including inside values, which
 * matches Xcode's reading of the format. Every parsed statement keeps its
 * exact source text, so an untouched document rebuilds byte for byte.
 *
 * @module
 */

import { XcconfigParseError } from "../errors";

import type { XcconfigCondition, XcconfigDocument, XcconfigStatement } from "./types";

/**
 * Matches `#include "path"` and `#include? "path"`, with an optional
 * trailing comment.
 */
const INCLUDE_PATTERN = /^#include(\?)?\s*"([^"]*)"\s*(?:\/\/.*)?$/u;

/**
 * Matches the head of an assignment, which is the leading whitespace, the
 * setting name, and the raw conditions block up to the equals sign.
 */
const ASSIGNMENT_HEAD_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*((?:\[[^\]]*\])*)\s*=/u;

/**
 * Matches one `[name=value]` condition group inside the conditions block.
 */
const CONDITION_PATTERN = /\[([^=\]]+)=([^\]]*)\]/gu;

/**
 * Strips the trailing comment, surrounding whitespace, and one trailing
 * semicolon from an assignment's right-hand side. Xcode tolerates the
 * semicolon as a leftover from property-list habits and ignores it.
 */
function cleanValue(rightHandSide: string): string {
  const commentStart = rightHandSide.indexOf("//");
  const withoutComment = commentStart === -1 ? rightHandSide : rightHandSide.slice(0, commentStart);
  const trimmed = withoutComment.trim();
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

/**
 * Parses the conditions block of an assignment, for example
 * `[sdk=iphoneos*][arch=arm64]`.
 *
 * @throws XcconfigParseError when the block has content that is not a
 *   well-formed `[name=value]` sequence.
 */
function parseConditions(block: string, source: string, blockOffset: number): XcconfigCondition[] {
  const conditions: XcconfigCondition[] = [];
  let consumed = 0;
  for (const match of block.matchAll(CONDITION_PATTERN)) {
    if (match.index !== consumed) {
      throw new XcconfigParseError("Malformed setting condition", source, blockOffset + consumed);
    }
    conditions.push({ name: match[1]!.trim(), value: match[2]!.trim() });
    consumed = match.index + match[0].length;
  }
  if (consumed !== block.length) {
    throw new XcconfigParseError("Malformed setting condition", source, blockOffset + consumed);
  }
  return conditions;
}

/**
 * Parses one line into a statement.
 *
 * @param content The line without its terminator.
 * @param source The full source text, for error positions.
 * @param lineOffset Offset of the line inside `source`.
 */
function parseLine(content: string, eol: string, source: string, lineOffset: number): XcconfigStatement {
  const trimmed = content.trim();

  if (trimmed === "") {
    return { kind: "blank", raw: content, eol };
  }

  if (trimmed.startsWith("//")) {
    return { kind: "comment", text: trimmed.slice(2), raw: content, eol };
  }

  if (trimmed.startsWith("#")) {
    const include = INCLUDE_PATTERN.exec(trimmed);
    if (include == null) {
      throw new XcconfigParseError("Malformed #include directive", source, lineOffset + content.indexOf("#"));
    }
    return { kind: "include", path: include[2]!, optional: include[1] === "?", raw: content, eol };
  }

  const head = ASSIGNMENT_HEAD_PATTERN.exec(content);
  if (head == null) {
    throw new XcconfigParseError(
      "Expected a setting assignment, an #include directive, or a // comment",
      source,
      lineOffset + (content.length - content.trimStart().length),
    );
  }

  const conditionsBlock = head[2]!;
  const conditionsOffset = lineOffset + head[0].indexOf(conditionsBlock, head[1]!.length);
  const conditions = conditionsBlock === "" ? [] : parseConditions(conditionsBlock, source, conditionsOffset);

  return {
    kind: "assignment",
    key: head[1]!,
    conditions,
    value: cleanValue(content.slice(head[0].length)),
    raw: content,
    eol,
  };
}

/**
 * Parses `.xcconfig` text into its document form.
 *
 * @throws XcconfigParseError when a line is not a blank, a comment, an
 *   include, or a well-formed assignment. The error carries the line and
 *   column of the failure.
 */
export function parseXcconfig(source: string): XcconfigDocument {
  if (source === "") {
    return { statements: [] };
  }

  const statements: XcconfigStatement[] = [];
  let offset = 0;

  // A trailing newline belongs to the last statement's terminator rather
  // than opening an extra empty line, hence the length guard.
  while (offset < source.length) {
    const lineFeed = source.indexOf("\n", offset);
    const end = lineFeed === -1 ? source.length : lineFeed;
    const hasCarriageReturn = end > offset && source.charCodeAt(end - 1) === 0x0d;
    const content = source.slice(offset, hasCarriageReturn ? end - 1 : end);
    const eol = lineFeed === -1 ? "" : hasCarriageReturn ? "\r\n" : "\n";

    statements.push(parseLine(content, eol, source, offset));

    if (lineFeed === -1) {
      break;
    }
    offset = lineFeed + 1;
  }

  return { statements };
}
