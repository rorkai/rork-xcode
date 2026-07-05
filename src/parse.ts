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

/** Whitespace classification as a table read — the single hottest check in the scanner. */
const IS_WHITESPACE: Uint8Array = (() => {
  const table = new Uint8Array(256);
  table[CODE_SPACE] = 1;
  table[CODE_TAB] = 1;
  table[CODE_CARRIAGE_RETURN] = 1;
  table[CODE_LINE_FEED] = 1;
  return table;
})();

function isDigit(code: number): boolean {
  return code >= CODE_ZERO && code <= CODE_NINE;
}

function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
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
    let pos = this.pos;

    for (;;) {
      while (pos < length && IS_WHITESPACE[input.charCodeAt(pos)] === 1) {
        pos++;
      }

      if (pos >= length) break;

      if (input.charCodeAt(pos) === CODE_SLASH && pos + 1 < length) {
        const next = input.charCodeAt(pos + 1);
        if (next === CODE_SLASH) {
          pos += 2;
          while (pos < length && input.charCodeAt(pos) !== CODE_LINE_FEED) {
            pos++;
          }
          continue;
        }
        if (next === CODE_ASTERISK) {
          pos += 2;
          while (pos + 1 < length) {
            if (input.charCodeAt(pos) === CODE_ASTERISK && input.charCodeAt(pos + 1) === CODE_SLASH) {
              pos += 2;
              break;
            }
            pos++;
          }
          continue;
        }
      }

      break;
    }

    this.pos = pos;
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
    let pos = start;
    while (pos < length && IS_LITERAL_CHAR[input.charCodeAt(pos)] === 1) {
      pos++;
    }
    this.pos = pos;
    return input.slice(start, pos);
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
      } else if (IS_WHITESPACE[code] !== 1) {
        this.fail(`Invalid character '${input[i]}' in data run`, i);
      }
    }
    this.pos++; // skip >

    // Apple's parser rejects odd digit counts; padding would guess a byte.
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
   * Reads an unquoted literal value, classifying it as number or string in
   * the same scan. Projects are dominated by 24-character identifiers that
   * start with a digit, so a separate classification pass would re-scan
   * almost every reference in the document.
   *
   * See the module documentation of `types.ts` for the exact policy and the
   * reasoning behind the string preservations (leading zeros, trailing-zero
   * decimals, unsafe integers).
   */
  readLiteralValue(): PbxprojValue {
    const input = this.input;
    const length = input.length;
    const start = this.pos;

    // A leading '-' is the only position where a sign reads as numeric.
    const leadingSign = input.charCodeAt(start) === CODE_MINUS;

    let digits = 0;
    let dots = 0;
    let others = leadingSign ? -1 : 0; // discount the sign itself
    let pos = start;
    let lastCode = 0;
    while (pos < length) {
      const code = input.charCodeAt(pos);
      if (IS_LITERAL_CHAR[code] !== 1) break;
      if (code >= CODE_ZERO && code <= CODE_NINE) {
        digits++;
      } else if (code === CODE_DOT) {
        dots++;
      } else {
        others++;
      }
      lastCode = code;
      pos++;
    }
    this.pos = pos;
    const runLength = pos - start;
    const literal = input.slice(start, pos);

    if (others !== 0 || digits === 0) {
      return literal;
    }

    if (dots === 0 && !leadingSign) {
      // Pure digit run. Leading zeros carry meaning (file modes, padded
      // ids); a too-large run cannot survive the trip through a double.
      if (runLength === 1) {
        return input.charCodeAt(start) - CODE_ZERO;
      }
      if (input.charCodeAt(start) === CODE_ZERO) {
        return literal;
      }
      const value = Number(literal);
      return value <= Number.MAX_SAFE_INTEGER ? value : literal;
    }

    if (dots === 1) {
      // Decimal with digit-only halves. Trailing-zero decimals stay strings
      // to survive round-trips.
      if (lastCode === CODE_ZERO) {
        return literal;
      }
      return Number(literal);
    }

    return literal;
  }

  parseDocument(): PbxprojValue {
    const code = this.peek();
    if (code === CODE_OPEN_BRACE) return this.parseObject();
    if (code === CODE_OPEN_PAREN) return this.parseArray();
    if (code === -1) this.fail("Empty input");
    this.fail(`Expected '{' or '(' at the start of the document but found '${this.input[this.pos]}'`);
  }

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
      items.push(this.parseValueAtSignificant());
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

  parseValue(): PbxprojValue {
    this.skipTrivia();
    if (this.pos >= this.input.length) {
      this.fail("Expected a value but found end of input");
    }
    return this.parseValueAtSignificant();
  }

  /** Dispatches on the current character; the caller has skipped trivia and checked bounds. */
  parseValueAtSignificant(): PbxprojValue {
    const code = this.input.charCodeAt(this.pos);
    if (code === CODE_OPEN_BRACE) return this.parseObject();
    if (code === CODE_OPEN_PAREN) return this.parseArray();
    if (code === CODE_QUOTE || code === CODE_SINGLE_QUOTE) return this.readQuotedString();
    if (IS_LITERAL_CHAR[code] === 1) return this.readLiteralValue();
    if (code === CODE_LESS_THAN) return this.readData();
    this.fail(`Expected a value but found '${this.input[this.pos]}'`);
  }
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
