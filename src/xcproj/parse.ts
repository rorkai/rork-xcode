/**
 * Single-pass recursive-descent parser for `project.xcproj` files.
 *
 * Xcode 27 writes these documents as JSON with a trailing comma after
 * every multi-line entry, and reads them back as JSON5. The parser accepts
 * the whole JSON5 grammar, which adds comments, unquoted keys,
 * single-quoted strings, hexadecimal numbers, and a few more relaxations
 * to JSON, so hand-edited files load the way Xcode loads them. Comments
 * are trivia, because Xcode drops them on its next save as well.
 *
 * @module
 */

import { XcprojParseError } from "../errors";

import type { XcprojArray, XcprojObject, XcprojValue } from "./types";

// UTF-16 code units of the characters the scanner dispatches on.
const CODE_TAB = 0x09;
const CODE_LINE_FEED = 0x0a;
const CODE_VERTICAL_TAB = 0x0b;
const CODE_FORM_FEED = 0x0c;
const CODE_CARRIAGE_RETURN = 0x0d;
const CODE_SPACE = 0x20;
const CODE_QUOTE = 0x22;
const CODE_DOLLAR = 0x24;
const CODE_SINGLE_QUOTE = 0x27;
const CODE_ASTERISK = 0x2a;
const CODE_PLUS = 0x2b;
const CODE_COMMA = 0x2c;
const CODE_MINUS = 0x2d;
const CODE_DOT = 0x2e;
const CODE_SLASH = 0x2f;
const CODE_ZERO = 0x30;
const CODE_NINE = 0x39;
const CODE_COLON = 0x3a;
const CODE_UPPER_E = 0x45;
const CODE_UPPER_I = 0x49;
const CODE_UPPER_N = 0x4e;
const CODE_UPPER_X = 0x58;
const CODE_OPEN_BRACKET = 0x5b;
const CODE_BACKSLASH = 0x5c;
const CODE_CLOSE_BRACKET = 0x5d;
const CODE_UNDERSCORE = 0x5f;
const CODE_LOWER_B = 0x62;
const CODE_LOWER_E = 0x65;
const CODE_LOWER_F = 0x66;
const CODE_LOWER_N = 0x6e;
const CODE_LOWER_R = 0x72;
const CODE_LOWER_T = 0x74;
const CODE_LOWER_U = 0x75;
const CODE_LOWER_V = 0x76;
const CODE_LOWER_X = 0x78;
const CODE_OPEN_BRACE = 0x7b;
const CODE_CLOSE_BRACE = 0x7d;
const CODE_LINE_SEPARATOR = 0x2028;
const CODE_PARAGRAPH_SEPARATOR = 0x2029;

/**
 * The ASCII whitespace JSON5 allows between tokens, as a 128-entry
 * table. Units past the table read `undefined`, which is correctly not
 * whitespace, and the few non-ASCII whitespace characters are checked
 * separately by {@link isUnicodeWhitespace}.
 */
const IS_ASCII_WHITESPACE: Uint8Array = (() => {
  const table = new Uint8Array(128);
  for (const code of [CODE_TAB, CODE_LINE_FEED, CODE_VERTICAL_TAB, CODE_FORM_FEED, CODE_CARRIAGE_RETURN, CODE_SPACE]) {
    table[code] = 1;
  }
  return table;
})();

/**
 * The ASCII characters that may continue an unquoted key, as a 128-entry
 * table. Digits are included, and {@link Parser.readIdentifier} rejects
 * them at the first position.
 */
const IS_ASCII_IDENTIFIER_PART: Uint8Array = (() => {
  const table = new Uint8Array(128);
  for (let code = 0x61; code <= 0x7a; code++) table[code] = 1; // a-z
  for (let code = 0x41; code <= 0x5a; code++) table[code] = 1; // A-Z
  for (let code = CODE_ZERO; code <= CODE_NINE; code++) table[code] = 1;
  table[CODE_DOLLAR] = 1;
  table[CODE_UNDERSCORE] = 1;
  return table;
})();

/**
 * The characters that may start an unquoted key beyond ASCII. JSON5 takes
 * the ECMAScript 5.1 identifier grammar, where a start is a Unicode letter
 * (categories `L` and `Nl`), `$`, or `_`.
 */
const IDENTIFIER_START = /^[\p{L}\p{Nl}$_]$/u;

/**
 * The characters that may continue an unquoted key beyond ASCII, which
 * adds combining marks, decimal digits, connector punctuation, and the
 * zero-width joiners to {@link IDENTIFIER_START}.
 */
const IDENTIFIER_PART = /^[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$_\u200C\u200D]$/u;

/**
 * Whether a non-ASCII code unit is JSON5 whitespace. That covers the
 * no-break space, the byte order mark, the line and paragraph separators,
 * and the remaining `Zs` space separators.
 */
function isUnicodeWhitespace(code: number): boolean {
  return (
    code === 0xa0 ||
    code === 0xfeff ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === CODE_LINE_SEPARATOR ||
    code === CODE_PARAGRAPH_SEPARATOR ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/**
 * Whether the code unit is a JSON5 line terminator, which ends line
 * comments and may not appear unescaped inside strings.
 */
function isLineTerminator(code: number): boolean {
  return (
    code === CODE_LINE_FEED ||
    code === CODE_CARRIAGE_RETURN ||
    code === CODE_LINE_SEPARATOR ||
    code === CODE_PARAGRAPH_SEPARATOR
  );
}

/**
 * Whether the code unit is an ASCII decimal digit.
 */
function isDigit(code: number): boolean {
  return code >= CODE_ZERO && code <= CODE_NINE;
}

/**
 * The value of an ASCII hexadecimal digit, or -1 for any other unit.
 */
function hexValue(code: number): number {
  if (code >= CODE_ZERO && code <= CODE_NINE) return code - CODE_ZERO;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}

/**
 * Scanner state and grammar productions for one parse call.
 *
 * The parser holds a single cursor into the source string and advances it
 * through the `read*` and `parse*` methods. There is no separate tokenizer
 * stage and no token objects.
 */
class Parser {
  /** Source text of the document being parsed. */
  readonly input: string;

  /** Cursor position as a UTF-16 code unit offset into {@link input}. */
  pos = 0;

  /**
   * Offset of the next backslash at or after the last string start, or
   * the input length when there is none. Strings in Xcode-written files
   * almost never contain escapes, so the string scanner asks this cursor
   * instead of inspecting every character, and the cursor only ever moves
   * forward, which keeps the total scanning linear.
   */
  private backslashAt = -1;

  /** Offset of the next line feed, maintained like {@link backslashAt}. */
  private lineFeedAt = -1;

  /** Offset of the next carriage return, maintained like {@link backslashAt}. */
  private carriageReturnAt = -1;

  /**
   * @param input Source text of the document.
   */
  constructor(input: string) {
    this.input = input;
  }

  /**
   * Throws an {@link XcprojParseError} carrying the line and column of the
   * failure.
   *
   * @param message Failure description without location.
   * @param offset Offset of the failure, defaulting to the current cursor.
   */
  fail(message: string, offset = this.pos): never {
    throw new XcprojParseError(message, this.input, offset);
  }

  /**
   * Describes the character at the cursor for an error message.
   */
  found(): string {
    return this.pos < this.input.length
      ? `'${String.fromCodePoint(this.input.codePointAt(this.pos)!)}'`
      : "end of input";
  }

  /**
   * Skips whitespace and comments.
   *
   * Xcode separates tokens with ASCII spaces and line feeds only, so the
   * loop tests a lookup table first and reaches the comment and Unicode
   * whitespace checks only when something else follows.
   */
  skipTrivia(): void {
    const input = this.input;
    const length = input.length;
    let pos = this.pos;

    for (;;) {
      while (pos < length && IS_ASCII_WHITESPACE[input.charCodeAt(pos)] === 1) {
        pos++;
      }
      if (pos >= length) {
        break;
      }
      const code = input.charCodeAt(pos);
      if (code === CODE_SLASH) {
        const after = this.skipComment(pos);
        if (after === pos) {
          break;
        }
        pos = after;
      } else if (code >= 0x80 && isUnicodeWhitespace(code)) {
        pos++;
      } else {
        break;
      }
    }

    this.pos = pos;
  }

  /**
   * Skips the comment whose `/` sits at `pos` and returns the offset after
   * it. A slash that opens no comment returns `pos` unchanged, so the
   * caller reports it as an unexpected character.
   */
  private skipComment(pos: number): number {
    const input = this.input;
    const next = input.charCodeAt(pos + 1);
    if (next === CODE_SLASH) {
      let end = pos + 2;
      while (end < input.length && !isLineTerminator(input.charCodeAt(end))) {
        end++;
      }
      return end;
    }
    if (next === CODE_ASTERISK) {
      const end = input.indexOf("*/", pos + 2);
      if (end === -1) {
        this.fail("Unterminated block comment", pos);
      }
      return end + 2;
    }
    return pos;
  }

  /**
   * Parses the document, which is exactly one value surrounded by trivia.
   */
  parseDocument(): XcprojValue {
    this.skipTrivia();
    if (this.pos >= this.input.length) {
      this.fail("Empty input");
    }
    const value = this.parseValueAtCursor();
    this.skipTrivia();
    if (this.pos < this.input.length) {
      this.fail(`Unexpected ${this.found()} after the document value`);
    }
    return value;
  }

  /**
   * Parses the value starting exactly at the cursor, dispatching on its
   * first character. The caller has already skipped trivia and checked
   * bounds.
   */
  parseValueAtCursor(): XcprojValue {
    const code = this.input.charCodeAt(this.pos);
    if (code === CODE_QUOTE || code === CODE_SINGLE_QUOTE) return this.readString();
    if (code === CODE_OPEN_BRACE) return this.parseObject();
    if (code === CODE_OPEN_BRACKET) return this.parseArray();
    if (code === CODE_LOWER_T) return this.readKeyword("true", true);
    if (code === CODE_LOWER_F) return this.readKeyword("false", false);
    if (code === CODE_LOWER_N) return this.readKeyword("null", null);
    if (
      isDigit(code) ||
      code === CODE_MINUS ||
      code === CODE_PLUS ||
      code === CODE_DOT ||
      code === CODE_UPPER_I ||
      code === CODE_UPPER_N
    ) {
      return this.readNumber();
    }
    this.fail(`Expected a value but found ${this.found()}`);
  }

  /**
   * Parses a `{ key: value, ... }` dictionary whose `{` is at the cursor.
   * A single trailing comma before `}` is allowed, because Xcode writes
   * one after every multi-line entry.
   */
  parseObject(): XcprojObject {
    const input = this.input;
    this.pos++; // skip {
    const result: XcprojObject = {};

    this.skipTrivia();
    if (input.charCodeAt(this.pos) === CODE_CLOSE_BRACE) {
      this.pos++;
      return result;
    }

    for (;;) {
      const key = this.readKey();
      // Xcode writes `"key": value`, so the colon and the single space are
      // checked directly before falling back to a full trivia scan.
      if (input.charCodeAt(this.pos) !== CODE_COLON) {
        this.skipTrivia();
        if (input.charCodeAt(this.pos) !== CODE_COLON) {
          this.fail(`Expected ':' after an object key but found ${this.found()}`);
        }
      }
      this.pos++;
      if (input.charCodeAt(this.pos) === CODE_SPACE && IS_ASCII_WHITESPACE[input.charCodeAt(this.pos + 1)] !== 1) {
        this.pos++;
      }
      this.skipTrivia();
      if (this.pos >= input.length) {
        this.fail("Expected a value but found end of input");
      }
      const value = this.parseValueAtCursor();

      if (key === "__proto__") {
        // A literal __proto__ key becomes an own property, so parsing
        // untrusted documents cannot pollute Object.prototype. Ordinary keys
        // take the fast assignment path and keep the object in shape mode.
        Object.defineProperty(result, key, { value, writable: true, enumerable: true, configurable: true });
      } else {
        result[key] = value;
      }

      this.skipTrivia();
      const next = input.charCodeAt(this.pos);
      if (next === CODE_COMMA) {
        this.pos++;
        this.skipTrivia();
        if (input.charCodeAt(this.pos) === CODE_CLOSE_BRACE) {
          this.pos++;
          return result;
        }
      } else if (next === CODE_CLOSE_BRACE) {
        this.pos++;
        return result;
      } else {
        this.fail(
          this.pos >= input.length
            ? "Unterminated object"
            : `Expected ',' or '}' after an object member but found ${this.found()}`,
        );
      }
    }
  }

  /**
   * Parses a `[ item, ... ]` array whose `[` is at the cursor. A single
   * trailing comma before `]` is allowed.
   */
  parseArray(): XcprojArray {
    const input = this.input;
    this.pos++; // skip [
    const items: XcprojArray = [];

    this.skipTrivia();
    if (input.charCodeAt(this.pos) === CODE_CLOSE_BRACKET) {
      this.pos++;
      return items;
    }

    for (;;) {
      if (this.pos >= input.length) {
        this.fail("Unterminated array");
      }
      items.push(this.parseValueAtCursor());

      this.skipTrivia();
      const next = input.charCodeAt(this.pos);
      if (next === CODE_COMMA) {
        this.pos++;
        this.skipTrivia();
        if (input.charCodeAt(this.pos) === CODE_CLOSE_BRACKET) {
          this.pos++;
          return items;
        }
      } else if (next === CODE_CLOSE_BRACKET) {
        this.pos++;
        return items;
      } else {
        this.fail(
          this.pos >= input.length
            ? "Unterminated array"
            : `Expected ',' or ']' after an array item but found ${this.found()}`,
        );
      }
    }
  }

  /**
   * Reads an object key, which is a quoted string or an unquoted
   * identifier name.
   */
  readKey(): string {
    const code = this.input.charCodeAt(this.pos);
    if (code === CODE_QUOTE || code === CODE_SINGLE_QUOTE) {
      return this.readString();
    }
    if (this.pos >= this.input.length) {
      this.fail("Unterminated object");
    }
    if (IS_ASCII_IDENTIFIER_PART[code] === 1 ? !isDigit(code) : code === CODE_BACKSLASH || code >= 0x80) {
      return this.readIdentifier();
    }
    this.fail(`Expected a key but found ${this.found()}`);
  }

  /**
   * Reads an unquoted key under the ECMAScript 5.1 identifier grammar
   * JSON5 adopts, `\uXXXX` escapes included.
   */
  readIdentifier(): string {
    const input = this.input;
    const length = input.length;
    const start = this.pos;
    let pos = start;
    let result = "";
    let chunkStart = pos;

    while (pos < length) {
      const code = input.charCodeAt(pos);
      if (code < 0x80) {
        if (IS_ASCII_IDENTIFIER_PART[code] === 1 && (pos > start || !isDigit(code))) {
          pos++;
          continue;
        }
        if (code !== CODE_BACKSLASH) {
          break;
        }
        if (input.charCodeAt(pos + 1) !== CODE_LOWER_U) {
          this.fail("Invalid escape sequence in an unquoted key", pos);
        }
        const unit = this.readHexUnits(pos + 2, 4);
        const character = String.fromCharCode(unit);
        if (!(pos === start ? IDENTIFIER_START : IDENTIFIER_PART).test(character)) {
          this.fail("Escaped character is not allowed in an unquoted key", pos);
        }
        result += input.slice(chunkStart, pos) + character;
        pos += 6;
        chunkStart = pos;
        continue;
      }
      const codePoint = input.codePointAt(pos)!;
      const character = String.fromCodePoint(codePoint);
      if (!(pos === start ? IDENTIFIER_START : IDENTIFIER_PART).test(character)) {
        break;
      }
      pos += character.length;
    }

    if (pos === start) {
      this.fail(`Expected a key but found ${this.found()}`);
    }
    this.pos = pos;
    return result + input.slice(chunkStart, pos);
  }

  /**
   * Reads a quoted string whose opening quote is at the cursor.
   *
   * The common string has no escapes and no line breaks, so the closing
   * quote is located with `indexOf` and the forward-only cursors confirm
   * that no backslash or line break precedes it. Such strings return as a
   * direct slice, and everything else takes {@link readEscapedString}.
   */
  readString(): string {
    const input = this.input;
    const quote = input.charCodeAt(this.pos);
    const start = this.pos + 1;
    const end = input.indexOf(quote === CODE_QUOTE ? '"' : "'", start);
    if (
      end !== -1 &&
      this.nextBackslash(start) > end &&
      this.nextLineFeed(start) > end &&
      this.nextCarriageReturn(start) > end
    ) {
      this.pos = end + 1;
      return input.slice(start, end);
    }
    return this.readEscapedString(quote, start);
  }

  /**
   * Returns the offset of the first backslash at or after `from`.
   */
  private nextBackslash(from: number): number {
    if (this.backslashAt < from) {
      const found = this.input.indexOf("\\", from);
      this.backslashAt = found === -1 ? this.input.length : found;
    }
    return this.backslashAt;
  }

  /**
   * Returns the offset of the first line feed at or after `from`.
   */
  private nextLineFeed(from: number): number {
    if (this.lineFeedAt < from) {
      const found = this.input.indexOf("\n", from);
      this.lineFeedAt = found === -1 ? this.input.length : found;
    }
    return this.lineFeedAt;
  }

  /**
   * Returns the offset of the first carriage return at or after `from`.
   */
  private nextCarriageReturn(from: number): number {
    if (this.carriageReturnAt < from) {
      const found = this.input.indexOf("\r", from);
      this.carriageReturnAt = found === -1 ? this.input.length : found;
    }
    return this.carriageReturnAt;
  }

  /**
   * Reads the rest of a string that contains escapes or fails to
   * terminate, character by character.
   *
   * @param quote The code unit of the opening quote.
   * @param start Offset just after the opening quote.
   */
  private readEscapedString(quote: number, start: number): string {
    const input = this.input;
    const length = input.length;
    let pos = start;
    let chunkStart = start;
    let result = "";

    for (;;) {
      if (pos >= length) {
        this.fail("Unterminated string", start - 1);
      }
      const code = input.charCodeAt(pos);
      if (code === quote) {
        this.pos = pos + 1;
        return result + input.slice(chunkStart, pos);
      }
      if (code === CODE_LINE_FEED || code === CODE_CARRIAGE_RETURN) {
        this.fail("Unescaped line break in a string", pos);
      }
      if (code !== CODE_BACKSLASH) {
        pos++;
        continue;
      }

      result += input.slice(chunkStart, pos);
      const escaped = input.charCodeAt(pos + 1);
      if (Number.isNaN(escaped)) {
        this.fail("Unterminated string", start - 1);
      }
      pos += 2;
      switch (escaped) {
        case CODE_LOWER_B:
          result += "\b";
          break;
        case CODE_LOWER_F:
          result += "\f";
          break;
        case CODE_LOWER_N:
          result += "\n";
          break;
        case CODE_LOWER_R:
          result += "\r";
          break;
        case CODE_LOWER_T:
          result += "\t";
          break;
        case CODE_LOWER_V:
          result += "\v";
          break;
        case CODE_ZERO:
          if (isDigit(input.charCodeAt(pos))) {
            this.fail("Invalid escape sequence in a string", pos - 2);
          }
          result += "\0";
          break;
        case CODE_LOWER_X:
          result += String.fromCharCode(this.readHexUnits(pos, 2));
          pos += 2;
          break;
        case CODE_LOWER_U:
          result += this.readUnicodeEscape(pos);
          pos = this.escapeEnd;
          break;
        case CODE_CARRIAGE_RETURN:
          // A line continuation contributes nothing, and CR LF counts as
          // one terminator.
          if (input.charCodeAt(pos) === CODE_LINE_FEED) {
            pos++;
          }
          break;
        case CODE_LINE_FEED:
        case CODE_LINE_SEPARATOR:
        case CODE_PARAGRAPH_SEPARATOR:
          break;
        default:
          if (escaped >= 0x31 && escaped <= CODE_NINE) {
            this.fail("Invalid escape sequence in a string", pos - 2);
          }
          // Any other escaped character stands for itself, so `\'` and
          // `\/` read as the plain characters. The next chunk starts at
          // that character, and the cursor already sits past it, so an
          // escaped quote never reads as the closing one.
          chunkStart = pos - 1;
          continue;
      }
      chunkStart = pos;
    }
  }

  /**
   * Offset just past the last escape {@link readUnicodeEscape} decoded.
   */
  private escapeEnd = 0;

  /**
   * Decodes the `\uXXXX` escape whose hex digits start at `pos`, leaving
   * the offset after it in {@link escapeEnd}. A high surrogate must be
   * followed by an escaped low surrogate, because a lone half has no UTF-8
   * encoding and would corrupt the file Xcode reads.
   */
  private readUnicodeEscape(pos: number): string {
    const input = this.input;
    const unit = this.readHexUnits(pos, 4);
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      this.fail("Unpaired surrogate escape in a string", pos - 2);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (input.charCodeAt(pos + 4) !== CODE_BACKSLASH || input.charCodeAt(pos + 5) !== CODE_LOWER_U) {
        this.fail("Unpaired surrogate escape in a string", pos - 2);
      }
      const low = this.readHexUnits(pos + 6, 4);
      if (low < 0xdc00 || low > 0xdfff) {
        this.fail("Unpaired surrogate escape in a string", pos - 2);
      }
      this.escapeEnd = pos + 10;
      return String.fromCharCode(unit, low);
    }
    this.escapeEnd = pos + 4;
    return String.fromCharCode(unit);
  }

  /**
   * Reads `count` hexadecimal digits starting at `pos` as one number.
   */
  private readHexUnits(pos: number, count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const digit = hexValue(this.input.charCodeAt(pos + i));
      if (digit === -1) {
        this.fail("Invalid hexadecimal escape", pos - 2);
      }
      value = value * 16 + digit;
    }
    return value;
  }

  /**
   * Reads `true`, `false`, or `null` at the cursor.
   */
  readKeyword<T extends XcprojValue>(word: string, value: T): T {
    if (!this.input.startsWith(word, this.pos)) {
      this.fail(`Expected a value but found ${this.found()}`);
    }
    this.pos += word.length;
    return value;
  }

  /**
   * Reads a JSON5 number at the cursor. That covers an optional sign,
   * decimal literals with optional leading or trailing dots and an
   * exponent, hexadecimal literals, `Infinity`, and `NaN`.
   */
  readNumber(): number {
    const input = this.input;
    const start = this.pos;
    let pos = start;
    let sign = 1;
    const first = input.charCodeAt(pos);
    if (first === CODE_MINUS || first === CODE_PLUS) {
      sign = first === CODE_MINUS ? -1 : 1;
      pos++;
    }

    const lead = input.charCodeAt(pos);
    if (lead === CODE_UPPER_I || lead === CODE_UPPER_N) {
      const word = lead === CODE_UPPER_I ? "Infinity" : "NaN";
      if (!input.startsWith(word, pos)) {
        this.fail(`Expected a value but found ${this.found()}`);
      }
      this.pos = pos + word.length;
      return lead === CODE_UPPER_I ? sign * Infinity : Number.NaN;
    }

    const next = input.charCodeAt(pos + 1);
    if (lead === CODE_ZERO && (next === CODE_LOWER_X || next === CODE_UPPER_X)) {
      const digitsStart = pos + 2;
      let end = digitsStart;
      while (hexValue(input.charCodeAt(end)) !== -1) {
        end++;
      }
      if (end === digitsStart) {
        this.fail("Invalid hexadecimal number", start);
      }
      this.pos = end;
      return sign * Number.parseInt(input.slice(digitsStart, end), 16);
    }

    const digitsStart = pos;
    let digits = 0;
    if (lead === CODE_ZERO) {
      pos++;
      digits++;
      if (isDigit(input.charCodeAt(pos))) {
        this.fail("Numbers cannot have leading zeros", start);
      }
    } else {
      while (isDigit(input.charCodeAt(pos))) {
        pos++;
        digits++;
      }
    }
    if (input.charCodeAt(pos) === CODE_DOT) {
      pos++;
      while (isDigit(input.charCodeAt(pos))) {
        pos++;
        digits++;
      }
    }
    if (digits === 0) {
      this.fail(`Expected a value but found ${this.found()}`);
    }
    const exponent = input.charCodeAt(pos);
    if (exponent === CODE_LOWER_E || exponent === CODE_UPPER_E) {
      pos++;
      const exponentSign = input.charCodeAt(pos);
      if (exponentSign === CODE_PLUS || exponentSign === CODE_MINUS) {
        pos++;
      }
      if (!isDigit(input.charCodeAt(pos))) {
        this.fail("Invalid number exponent", start);
      }
      while (isDigit(input.charCodeAt(pos))) {
        pos++;
      }
    }

    this.pos = pos;
    return sign * Number(input.slice(digitsStart, pos));
  }
}

/**
 * Parses a `project.xcproj` document into JavaScript values.
 *
 * Accepts any JSON5 document. Comments are trivia and are not preserved.
 * See the module documentation of `types.ts` for how source shapes map to
 * JavaScript values.
 *
 * @param text Source text of the document.
 * @returns The document's root value. For real project files this is the
 *   project dictionary with `files`, `targets`, and `build-settings`.
 * @throws XcprojParseError when the document is malformed. The error
 *   carries the line and column of the failure.
 */
export function parseXcproj(text: string): XcprojValue {
  return new Parser(text).parseDocument();
}
