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

const CODE_TAB = 0x09;
const CODE_LINE_FEED = 0x0a;
const CODE_CARRIAGE_RETURN = 0x0d;
const CODE_SPACE = 0x20;
const CODE_QUOTE = 0x22;
const CODE_SINGLE_QUOTE = 0x27;
const CODE_OPEN_PAREN = 0x28;
const CODE_CLOSE_PAREN = 0x29;
const CODE_ASTERISK = 0x2a;
const CODE_PLUS = 0x2b;
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

function isDigit(code: number): boolean {
  return code >= CODE_ZERO && code <= CODE_NINE;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function isWhitespace(code: number): boolean {
  return code === CODE_SPACE || code === CODE_TAB || code === CODE_CARRIAGE_RETURN || code === CODE_LINE_FEED;
}

class Parser {
  readonly input: string;
  pos = 0;

  constructor(input: string) {
    this.input = input;
  }

  fail(message: string, offset = this.pos): never {
    throw new PbxprojParseError(message, this.input, offset);
  }

  /** Skips whitespace and `//` / `/* *​/` comments in bulk. */
  skipTrivia(): void {
    const input = this.input;
    const length = input.length;

    for (;;) {
      while (this.pos < length && isWhitespace(input.charCodeAt(this.pos))) {
        this.pos++;
      }

      if (this.pos >= length) return;

      if (input.charCodeAt(this.pos) === CODE_SLASH && this.pos + 1 < length) {
        const next = input.charCodeAt(this.pos + 1);
        if (next === CODE_SLASH) {
          this.pos += 2;
          while (this.pos < length && input.charCodeAt(this.pos) !== CODE_LINE_FEED) {
            this.pos++;
          }
          continue;
        }
        if (next === CODE_ASTERISK) {
          this.pos += 2;
          while (this.pos + 1 < length) {
            if (input.charCodeAt(this.pos) === CODE_ASTERISK && input.charCodeAt(this.pos + 1) === CODE_SLASH) {
              this.pos += 2;
              break;
            }
            this.pos++;
          }
          continue;
        }
      }

      return;
    }
  }

  /** The next significant code unit, or -1 at end of input. */
  peek(): number {
    this.skipTrivia();
    return this.pos < this.input.length ? this.input.charCodeAt(this.pos) : -1;
  }

  expect(code: number, description: string): void {
    this.skipTrivia();
    if (this.pos < this.input.length && this.input.charCodeAt(this.pos) === code) {
      this.pos++;
      return;
    }
    const found = this.pos < this.input.length ? `'${this.input[this.pos]}'` : "end of input";
    this.fail(`Expected '${description}' but found ${found}`);
  }

  /** Reads an unquoted literal run. The caller guarantees at least one literal character. */
  readLiteral(): string {
    const input = this.input;
    const length = input.length;
    const start = this.pos;
    while (this.pos < length && IS_LITERAL_CHAR[input.charCodeAt(this.pos)] === 1) {
      this.pos++;
    }
    return input.slice(start, this.pos);
  }

  /** Reads a quoted string; the opening quote is at the current position. */
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

  /** Reads a `<hex bytes>` data run; the `<` is at the current position. */
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
      } else if (!isWhitespace(code)) {
        this.fail(`Invalid character '${input[i]}' in data run`, i);
      }
    }
    this.pos++; // skip >

    const bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i >> 1] = Number.parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }

  /** Reads a dictionary key: a quoted or unquoted string. */
  readKey(): string {
    this.skipTrivia();
    if (this.pos >= this.input.length) {
      this.fail("Expected a key but found end of input");
    }
    const code = this.input.charCodeAt(this.pos);
    if (code === CODE_QUOTE || code === CODE_SINGLE_QUOTE) {
      return this.readQuotedString();
    }
    if (IS_LITERAL_CHAR[code] === 1) {
      return this.readLiteral();
    }
    this.fail(`Expected a key but found '${this.input[this.pos]}'`);
  }

  parseDocument(): PbxprojValue {
    const code = this.peek();
    if (code === CODE_OPEN_BRACE) return this.parseObject();
    if (code === CODE_OPEN_PAREN) return this.parseArray();
    if (code === -1) this.fail("Empty input");
    this.fail(`Expected '{' or '(' at the start of the document but found '${this.input[this.pos]}'`);
  }

  parseObject(): PbxprojObject {
    this.pos++; // skip {
    const result: PbxprojObject = {};

    for (;;) {
      const code = this.peek();
      if (code === CODE_CLOSE_BRACE) {
        this.pos++;
        return result;
      }
      if (code === -1) {
        this.fail("Unterminated dictionary");
      }
      const key = this.readKey();
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

  parseArray(): PbxprojValue[] {
    this.pos++; // skip (
    const items: PbxprojValue[] = [];

    for (;;) {
      const code = this.peek();
      if (code === CODE_CLOSE_PAREN) {
        this.pos++;
        return items;
      }
      if (code === -1) {
        this.fail("Unterminated array");
      }
      items.push(this.parseValue());
      if (this.peek() === CODE_COMMA) {
        this.pos++;
      }
    }
  }

  parseValue(): PbxprojValue {
    const code = this.peek();
    switch (code) {
      case CODE_OPEN_BRACE:
        return this.parseObject();
      case CODE_OPEN_PAREN:
        return this.parseArray();
      case CODE_LESS_THAN:
        return this.readData();
      case CODE_QUOTE:
      case CODE_SINGLE_QUOTE:
        return this.readQuotedString();
      case -1:
        this.fail("Expected a value but found end of input");
    }
    if (IS_LITERAL_CHAR[code] === 1) {
      return interpretLiteral(this.readLiteral());
    }
    this.fail(`Expected a value but found '${this.input[this.pos]}'`);
  }
}

/**
 * Decides whether an unquoted literal is a number or a string.
 *
 * See the module documentation of `types.ts` for the exact policy and the
 * reasoning behind the string preservations (leading zeros, trailing-zero
 * decimals, unsafe integers).
 */
function interpretLiteral(literal: string): PbxprojValue {
  if (literal.length === 0) {
    return literal;
  }

  const first = literal.charCodeAt(0);

  // Fast path: anything not starting with a digit, sign, or dot is a plain
  // string — identifiers, uuids, and paths, i.e. the vast majority of values.
  if (!isDigit(first) && first !== CODE_PLUS && first !== CODE_MINUS && first !== CODE_DOT) {
    return literal;
  }

  if (isDigit(first)) {
    if (literal.length === 1) {
      return first - CODE_ZERO;
    }
    let allDigits = true;
    for (let i = 1; i < literal.length; i++) {
      if (!isDigit(literal.charCodeAt(i))) {
        allDigits = false;
        break;
      }
    }
    if (allDigits) {
      // Leading zeros carry meaning (file modes, padded ids); a too-large
      // digit run cannot survive the trip through a double.
      if (first === CODE_ZERO) {
        return literal;
      }
      const value = Number(literal);
      return value <= Number.MAX_SAFE_INTEGER ? value : literal;
    }
  }

  // Decimal check: a single dot with digit-only halves, at least one of them
  // non-empty. Trailing-zero decimals stay strings to survive round-trips.
  const unsigned = first === CODE_PLUS || first === CODE_MINUS ? literal.slice(1) : literal;
  const dot = unsigned.indexOf(".");
  if (dot !== -1) {
    const integerPart = unsigned.slice(0, dot);
    const fractionPart = unsigned.slice(dot + 1);
    const digitsOnly = (part: string): boolean => {
      for (let i = 0; i < part.length; i++) {
        if (!isDigit(part.charCodeAt(i))) return false;
      }
      return true;
    };
    if (
      digitsOnly(integerPart) &&
      digitsOnly(fractionPart) &&
      !(integerPart.length === 0 && fractionPart.length === 0)
    ) {
      if (literal.endsWith("0")) {
        return literal;
      }
      const value = Number(literal);
      if (!Number.isNaN(value)) {
        return value;
      }
    }
  }

  return literal;
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
