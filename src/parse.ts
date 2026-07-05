/**
 * Single-pass recursive-descent parser for `project.pbxproj` files.
 *
 * The grammar is the OpenStep-style property list Xcode reads and writes:
 * `{ key = value; ... }` dictionaries, `( item, ... )` arrays, quoted and
 * unquoted strings, `<hex>` data runs, and `//` and `/* *​/` comments as
 * insignificant trivia.
 *
 * @module
 */

import { PbxprojParseError } from "./errors";
import { unescapeString } from "./escape";
import type { PbxprojObject, PbxprojValue } from "./types";

/**
 * Characters allowed in unquoted string literals: `[A-Za-z0-9_$/:.-]`.
 *
 * A 256-entry lookup table keyed by code unit keeps classification to a
 * single array read in the hot loop. Non-ASCII units index past the table
 * and read `undefined`, which is correctly falsy — non-ASCII text only
 * appears inside quoted strings.
 */
const IS_LITERAL_CHAR: Uint8Array = (() => {
  const table = new Uint8Array(256);
  for (let i = 0x61; i <= 0x7a; i++) table[i] = 1; // a-z
  for (let i = 0x41; i <= 0x5a; i++) table[i] = 1; // A-Z
  for (let i = 0x30; i <= 0x39; i++) table[i] = 1; // 0-9
  for (const ch of "_$/:.-") table[ch.charCodeAt(0)] = 1;
  return table;
})();

// UTF-16 code units of the characters the scanner dispatches on.
const CODE_TAB = 0x09;
const CODE_LINE_FEED = 0x0a;
const CODE_CARRIAGE_RETURN = 0x0d;
const CODE_SPACE = 0x20;
const CODE_QUOTE = 0x22;
const CODE_SINGLE_QUOTE = 0x27;
const CODE_OPEN_PAREN = 0x28;
const CODE_CLOSE_PAREN = 0x29;
const CODE_ASTERISK = 0x2a;
const CODE_COMMA = 0x2c;
const CODE_MINUS = 0x2d;
const CODE_DOT = 0x2e;
const CODE_SLASH = 0x2f;
const CODE_ZERO = 0x30;
const CODE_NINE = 0x39;
const CODE_SEMICOLON = 0x3b;
const CODE_LESS_THAN = 0x3c;
const CODE_EQUALS = 0x3d;
const CODE_GREATER_THAN = 0x3e;
const CODE_BACKSLASH = 0x5c;
const CODE_OPEN_BRACE = 0x7b;
const CODE_CLOSE_BRACE = 0x7d;

/**
 * Whitespace classification as a 256-entry table.
 *
 * This is the single hottest check in the scanner, so it compiles to one
 * array read instead of four comparisons.
 */
const IS_WHITESPACE: Uint8Array = (() => {
  const table = new Uint8Array(256);
  table[CODE_SPACE] = 1;
  table[CODE_TAB] = 1;
  table[CODE_CARRIAGE_RETURN] = 1;
  table[CODE_LINE_FEED] = 1;
  return table;
})();

/**
 * Whether the code unit is an ASCII decimal digit (`0-9`).
 */
function isDigit(code: number): boolean {
  return code >= CODE_ZERO && code <= CODE_NINE;
}

/**
 * Whether the code unit is an ASCII hexadecimal digit (`0-9A-Fa-f`).
 */
function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

/**
 * Scanner state and grammar productions for one parse call.
 *
 * The parser holds a single cursor into the source string and advances it
 * through the `read*` and `parse*` methods; there is no separate tokenizer
 * stage and no token objects.
 */
class Parser {
  /** Source text of the document being parsed. */
  readonly input: string;

  /** Cursor position as a UTF-16 code unit offset into {@link input}. */
  pos = 0;

  /**
   * @param input Source text of the document.
   */
  constructor(input: string) {
    this.input = input;
  }

  /**
   * Throws a {@link PbxprojParseError} carrying the line and column of the
   * failure.
   *
   * @param message Failure description without location.
   * @param offset Offset of the failure; defaults to the current cursor.
   */
  fail(message: string, offset = this.pos): never {
    throw new PbxprojParseError(message, this.input, offset);
  }

  /**
   * Skips whitespace and `//` / `/* *​/` comments in bulk.
   *
   * Comment bodies are jumped over with `indexOf` rather than scanned per
   * character — reference comments make up a sizable share of a canonical
   * document's bytes, and `indexOf` uses the engine's vectorized search.
   */
  skipTrivia(): void {
    const input = this.input;
    const length = input.length;
    let pos = this.pos;

    for (;;) {
      while (pos < length && IS_WHITESPACE[input.charCodeAt(pos)] === 1) {
        pos++;
      }

      if (pos >= length) break;

      if (input.charCodeAt(pos) === CODE_SLASH && pos + 1 < length) {
        const next = input.charCodeAt(pos + 1);
        if (next === CODE_SLASH) {
          const lineEnd = input.indexOf("\n", pos + 2);
          pos = lineEnd === -1 ? length : lineEnd;
          continue;
        }
        if (next === CODE_ASTERISK) {
          const commentEnd = input.indexOf("*/", pos + 2);
          pos = commentEnd === -1 ? length : commentEnd + 2;
          continue;
        }
      }

      break;
    }

    this.pos = pos;
  }

  /**
   * Returns the next significant code unit without consuming it, or -1 at
   * end of input. Trivia before it is consumed.
   */
  peek(): number {
    this.skipTrivia();
    return this.pos < this.input.length ? this.input.charCodeAt(this.pos) : -1;
  }

  /**
   * Consumes the expected code unit or fails with a message naming it.
   *
   * @param code The expected UTF-16 code unit.
   * @param description How the character reads in the error message.
   */
  expect(code: number, description: string): void {
    // Canonical documents place `=` and `;` directly after tokens, so the
    // expected character is usually at the cursor with no trivia before it
    // (charCodeAt returns NaN past the end, which simply misses the match).
    if (this.input.charCodeAt(this.pos) === code) {
      this.pos++;
      return;
    }
    this.skipTrivia();
    if (this.pos < this.input.length && this.input.charCodeAt(this.pos) === code) {
      this.pos++;
      return;
    }
    const found = this.pos < this.input.length ? `'${this.input[this.pos]}'` : "end of input";
    this.fail(`Expected '${description}' but found ${found}`);
  }

  /**
   * Reads an unquoted literal run and returns it as text.
   *
   * The caller guarantees the cursor is on at least one literal character.
   */
  readLiteral(): string {
    const input = this.input;
    const length = input.length;
    const start = this.pos;
    let pos = start;
    while (pos < length && IS_LITERAL_CHAR[input.charCodeAt(pos)] === 1) {
      pos++;
    }
    this.pos = pos;
    return input.slice(start, pos);
  }

  /**
   * Reads a quoted string; the opening quote is at the current position.
   *
   * The scan tracks whether any escape sequence occurred: unescaped strings
   * (the overwhelming majority) return as a direct slice, and only escaped
   * ones pay for {@link unescapeString}.
   */
  readQuotedString(): string {
    const input = this.input;
    const length = input.length;
    const quote = input.charCodeAt(this.pos);
    const start = ++this.pos;

    let hasEscape = false;
    let end = start;
    while (end < length) {
      const code = input.charCodeAt(end);
      if (code === quote) break;
      if (code === CODE_BACKSLASH) {
        hasEscape = true;
        end += 2;
      } else {
        end += 1;
      }
    }

    if (end >= length) {
      this.fail("Unterminated string", start - 1);
    }

    const raw = input.slice(start, end);
    this.pos = end + 1;
    return hasEscape ? unescapeString(raw) : raw;
  }

  /**
   * Reads a `<hex bytes>` data run into a `Uint8Array`; the `<` is at the
   * current position.
   *
   * Whitespace between digits is allowed (Xcode writes `<AB CD>`), and the
   * digit count must be even — Apple's parser rejects odd counts, and
   * padding would guess a byte.
   */
  readData(): Uint8Array {
    const input = this.input;
    const length = input.length;
    const start = ++this.pos;

    while (this.pos < length && input.charCodeAt(this.pos) !== CODE_GREATER_THAN) {
      this.pos++;
    }
    if (this.pos >= length) {
      this.fail("Unterminated data run", start - 1);
    }

    let hex = "";
    for (let i = start; i < this.pos; i++) {
      const code = input.charCodeAt(i);
      if (isHexDigit(code)) {
        hex += input[i];
      } else if (IS_WHITESPACE[code] !== 1) {
        this.fail(`Invalid character '${input[i]}' in data run`, i);
      }
    }
    this.pos++; // skip >

    if (hex.length % 2 !== 0) {
      this.fail("Data run has an odd number of hex digits", start);
    }

    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i >> 1] = Number.parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }

  /**
   * Parses the document root: a dictionary or an array.
   */
  parseDocument(): PbxprojValue {
    const code = this.peek();
    if (code === CODE_OPEN_BRACE) return this.parseObject();
    if (code === CODE_OPEN_PAREN) return this.parseArray();
    if (code === -1) this.fail("Empty input");
    this.fail(`Expected '{' or '(' at the start of the document but found '${this.input[this.pos]}'`);
  }

  /**
   * Parses a `{ key = value; ... }` dictionary; the `{` is at the current
   * position. Keys may be quoted or unquoted, and every entry requires the
   * `=` and terminating `;`.
   */
  parseObject(): PbxprojObject {
    const input = this.input;
    const length = input.length;
    this.pos++; // skip {
    const result: PbxprojObject = {};

    for (;;) {
      this.skipTrivia();
      if (this.pos >= length) {
        this.fail("Unterminated dictionary");
      }
      const code = input.charCodeAt(this.pos);
      if (code === CODE_CLOSE_BRACE) {
        this.pos++;
        return result;
      }

      let key: string;
      if (code === CODE_QUOTE || code === CODE_SINGLE_QUOTE) {
        key = this.readQuotedString();
      } else if (IS_LITERAL_CHAR[code] === 1) {
        key = this.readLiteral();
      } else {
        this.fail(`Expected a key but found '${input[this.pos]}'`);
      }

      this.expect(CODE_EQUALS, "=");
      const value = this.parseValue();
      this.expect(CODE_SEMICOLON, ";");

      if (key === "__proto__") {
        // A literal __proto__ key becomes an own property, so parsing
        // untrusted documents cannot pollute Object.prototype. Ordinary keys
        // take the fast assignment path and keep the object in shape mode.
        Object.defineProperty(result, key, { value, writable: true, enumerable: true, configurable: true });
      } else {
        result[key] = value;
      }
    }
  }

  /**
   * Parses a `( item, item, ... )` array; the `(` is at the current
   * position. A trailing comma before `)` is allowed — Xcode writes one
   * after every item.
   */
  parseArray(): PbxprojValue[] {
    const input = this.input;
    const length = input.length;
    this.pos++; // skip (
    const items: PbxprojValue[] = [];

    for (;;) {
      this.skipTrivia();
      if (this.pos >= length) {
        this.fail("Unterminated array");
      }
      if (input.charCodeAt(this.pos) === CODE_CLOSE_PAREN) {
        this.pos++;
        return items;
      }
      items.push(this.parseValueAtCursor());
      // Items are comma-separated; accepting bare whitespace would silently
      // merge malformed input (Apple's parser rejects it too).
      const next = this.peek();
      if (next === CODE_COMMA) {
        this.pos++;
      } else if (next !== CODE_CLOSE_PAREN) {
        this.fail(next === -1 ? "Unterminated array" : "Expected ',' or ')' after an array item");
      }
    }
  }

  /**
   * Parses any value after consuming leading trivia.
   */
  parseValue(): PbxprojValue {
    this.skipTrivia();
    if (this.pos >= this.input.length) {
      this.fail("Expected a value but found end of input");
    }
    return this.parseValueAtCursor();
  }

  /**
   * Parses the value starting exactly at the cursor, dispatching on its
   * first character. The caller has already skipped trivia and checked
   * bounds, so the loops that call this in sequence skip one redundant
   * trivia scan per element.
   */
  parseValueAtCursor(): PbxprojValue {
    const code = this.input.charCodeAt(this.pos);
    if (code === CODE_OPEN_BRACE) return this.parseObject();
    if (code === CODE_OPEN_PAREN) return this.parseArray();
    if (code === CODE_QUOTE || code === CODE_SINGLE_QUOTE) return this.readQuotedString();
    if (IS_LITERAL_CHAR[code] === 1) return interpretLiteral(this.readLiteral());
    if (code === CODE_LESS_THAN) return this.readData();
    this.fail(`Expected a value but found '${this.input[this.pos]}'`);
  }
}

/**
 * Decides whether an unquoted literal is a number or a string.
 *
 * One loop with an early exit: the first character outside `[0-9.]` (after
 * an optional leading `-`) settles the token as a string, so the
 * 24-character identifiers that dominate project documents are classified
 * within their first few characters.
 *
 * See the module documentation of `types.ts` for the exact policy and the
 * reasoning behind the string preservations (leading zeros, trailing-zero
 * decimals, unsafe integers).
 */
function interpretLiteral(literal: string): PbxprojValue {
  const length = literal.length;
  const first = literal.charCodeAt(0);

  // A leading '-' is the only position where a sign reads as numeric.
  let start = 0;
  let negative = false;
  if (first === CODE_MINUS && length > 1) {
    negative = true;
    start = 1;
  } else if (!isDigit(first) && first !== CODE_DOT) {
    return literal;
  }

  let digits = 0;
  let dots = 0;
  for (let i = start; i < length; i++) {
    const code = literal.charCodeAt(i);
    if (code >= CODE_ZERO && code <= CODE_NINE) {
      digits++;
    } else if (code === CODE_DOT && dots === 0) {
      dots = 1;
    } else {
      return literal;
    }
  }
  if (digits === 0) {
    return literal; // "-", ".", "-."
  }

  if (dots === 0) {
    // Pure digit runs: negative integers stay strings (Xcode never writes
    // them unquoted), leading zeros carry meaning (file modes, padded ids),
    // and a too-large run cannot survive the trip through a double.
    if (negative) {
      return literal;
    }
    if (length === 1) {
      return first - CODE_ZERO;
    }
    if (first === CODE_ZERO) {
      return literal;
    }
    const value = Number(literal);
    return value <= Number.MAX_SAFE_INTEGER ? value : literal;
  }

  // Exactly one dot. Trailing-zero decimals stay strings to survive
  // round-trips.
  if (literal.charCodeAt(length - 1) === CODE_ZERO) {
    return literal;
  }
  return Number(literal);
}

/**
 * Parses a `project.pbxproj` document into JavaScript values.
 *
 * Accepts the leading `// !$*UTF8*$!` marker and any other comments as
 * trivia. Content after the root value is ignored. See the module
 * documentation of `types.ts` for how source shapes map to JavaScript
 * values.
 *
 * @param text Source text of the document.
 * @returns The document's root value — for real project files, the root
 *   dictionary with `objects`, `rootObject`, and version fields.
 * @throws PbxprojParseError when the document is malformed; the error
 *   carries the line and column of the failure.
 */
export function parsePbxproj(text: string): PbxprojValue {
  return new Parser(text).parseDocument();
}
