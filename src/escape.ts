/**
 * Escape handling for quoted strings.
 *
 * OpenStep-style property lists inherit their escape syntax from NeXTSTEP:
 * C-style character escapes, `\Uxxxx` Unicode escapes, and octal escapes
 * whose values above 0x7F select characters from the NeXTSTEP character set
 * rather than Latin-1.
 *
 * @module
 */

/**
 * NeXTSTEP character set for byte values 0x80-0xFF, indexed by `byte - 0x80`.
 *
 * Octal escapes are how pre-Unicode NeXTSTEP text encoded non-ASCII
 * characters; mapping them through this table is what makes `\341` decode to
 * `Æ` instead of the Latin-1 `á`. Values are Unicode code points, per the
 * published NEXTSTEP.TXT vendor mapping in the Unicode Character Database.
 */
// prettier-ignore
const NEXT_STEP_MAPPINGS: readonly number[] = [
  0x00a0, 0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00c4, 0x00c5, 0x00c7,
  0x00c8, 0x00c9, 0x00ca, 0x00cb, 0x00cc, 0x00cd, 0x00ce, 0x00cf,
  0x00d0, 0x00d1, 0x00d2, 0x00d3, 0x00d4, 0x00d5, 0x00d6, 0x00d9,
  0x00da, 0x00db, 0x00dc, 0x00dd, 0x00de, 0x00b5, 0x00d7, 0x00f7,
  0x00a9, 0x00a1, 0x00a2, 0x00a3, 0x2044, 0x00a5, 0x0192, 0x00a7,
  0x00a4, 0x2019, 0x201c, 0x00ab, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x00ae, 0x2013, 0x2020, 0x2021, 0x00b7, 0x00a6, 0x00b6, 0x2022,
  0x201a, 0x201e, 0x201d, 0x00bb, 0x2026, 0x2030, 0x00ac, 0x00bf,
  0x00b9, 0x02cb, 0x00b4, 0x02c6, 0x02dc, 0x00af, 0x02d8, 0x02d9,
  0x00a8, 0x00b2, 0x02da, 0x00b8, 0x00b3, 0x02dd, 0x02db, 0x02c7,
  0x2014, 0x00b1, 0x00bc, 0x00bd, 0x00be, 0x00e0, 0x00e1, 0x00e2,
  0x00e3, 0x00e4, 0x00e5, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb,
  0x00ec, 0x00c6, 0x00ed, 0x00aa, 0x00ee, 0x00ef, 0x00f0, 0x00f1,
  0x0141, 0x00d8, 0x0152, 0x00ba, 0x00f2, 0x00f3, 0x00f4, 0x00f5,
  0x00f6, 0x00e6, 0x00f9, 0x00fa, 0x00fb, 0x0131, 0x00fc, 0x00fd,
  0x0142, 0x00f8, 0x0153, 0x00df, 0x00fe, 0x00ff, 0xfffd, 0xfffd,
];

/**
 * Maps an octal escape value to its Unicode code point.
 *
 * Values below 0x80 are ASCII and pass through; values in 0x80-0xFF select
 * from the NeXTSTEP character set.
 */
function nextStepToUnicode(code: number): number {
  if (code < 0x80 || code > 0xff) {
    return code;
  }
  return NEXT_STEP_MAPPINGS[code - 0x80] ?? code;
}

// UTF-16 code units the escape scanner dispatches on.
const CODE_ZERO = 0x30;
const CODE_SEVEN = 0x37;
const CODE_BACKSLASH = 0x5c;

/**
 * Whether the code unit is an ASCII hexadecimal digit (`0-9A-Fa-f`).
 */
export function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x46) || // A-F
    (code >= 0x61 && code <= 0x66) // a-f
  );
}

/**
 * Single-character escapes and their decoded text. An escaped line break
 * decodes to a newline, like the C escape it mirrors.
 */
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "'": "'",
  "\\": "\\",
  "\n": "\n",
};

/**
 * Decodes a `\Uxxxx` escape whose backslash sits at `index`. Returns the
 * decoded text and the index after the escape, or `undefined` when the
 * sequence is not exactly four hex digits.
 */
function readUnicodeEscape(input: string, index: number): [text: string, next: number] | undefined {
  const hex = input.slice(index + 2, index + 6);
  if (hex.length !== 4) {
    return undefined;
  }
  for (let i = 0; i < 4; i++) {
    if (!isHexDigit(hex.charCodeAt(i))) {
      return undefined;
    }
  }
  const code = Number.parseInt(hex, 16);
  // A lone surrogate is not a character; drop it rather than emit an
  // unpaired UTF-16 unit that would poison later encoding.
  return [code < 0xd800 || code > 0xdfff ? String.fromCharCode(code) : "", index + 6];
}

/**
 * Decodes a `\NNN` octal escape (1-3 digits) whose backslash sits at
 * `index`, mapping values at or above 0x80 through the NeXTSTEP character
 * set. Returns the decoded text and the index after the escape.
 */
function readOctalEscape(input: string, index: number): [text: string, next: number] {
  let end = index + 1;
  while (end < input.length && end < index + 4) {
    const code = input.charCodeAt(end);
    if (code < CODE_ZERO || code > CODE_SEVEN) {
      break;
    }
    end++;
  }
  const octal = Number.parseInt(input.slice(index + 1, end), 8);
  return [String.fromCharCode(nextStepToUnicode(octal)), end];
}

/**
 * Decodes one escape sequence whose backslash sits at `index`. Returns the
 * decoded text and the index after the sequence. Unknown escapes preserve
 * both characters — the lenient behavior needed to read files written by
 * tools with sloppier escaping than Xcode's.
 */
function decodeEscape(input: string, index: number): [text: string, next: number] {
  const next = input[index + 1] as string;
  const simple = SIMPLE_ESCAPES[next];
  if (simple != null) {
    return [simple, index + 2];
  }
  if (next === "U") {
    return readUnicodeEscape(input, index) ?? ["\\", index + 1];
  }
  const code = next.charCodeAt(0);
  if (code >= CODE_ZERO && code <= CODE_SEVEN) {
    return readOctalEscape(input, index);
  }
  return [`\\${next}`, index + 2];
}

/**
 * Processes escape sequences in a quoted string (quotes already stripped).
 *
 * Handles the standard escapes (`\a \b \f \n \r \t \v \" \' \\` and an
 * escaped line break), `\Uxxxx` Unicode escapes (exactly 4 hex digits), and
 * `\NNN` octal escapes (1-3 digits, values at or above 0x80 mapped through
 * the NeXTSTEP character set).
 */
export function unescapeString(input: string): string {
  const length = input.length;
  let result = "";
  let i = 0;

  while (i < length) {
    if (input.charCodeAt(i) === CODE_BACKSLASH && i + 1 < length) {
      const [text, next] = decodeEscape(input, i);
      result += text;
      i = next;
    } else {
      result += input[i];
      i += 1;
    }
  }

  return result;
}
