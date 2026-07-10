/**
 * Quoting and escaping rules for `project.pbxproj` output.
 *
 * The unquoted-safe alphabet is deliberately narrower than what the parser
 * accepts: Xcode itself quotes values containing `-`, so emitting them
 * unquoted would produce documents Xcode rewrites on next save.
 *
 * @module
 */

/**
 * The writer's unquoted-safe alphabet. The `+` also rejects the empty
 * string, which must render as `""`.
 */
const UNQUOTED_SAFE_PATTERN = /^[A-Za-z0-9_$/:.]+$/u;

/**
 * Whether the value can render without quotes, meaning every character is
 * in the unquoted-safe alphabet and the string is not empty.
 *
 * Quoting decisions scan every string a document carries, and many of those
 * strings are substring slices of the source text. The regex engine flattens
 * and scans them in bulk, which measures faster here than a per-character
 * `charCodeAt` loop.
 */
export function isSafeUnquoted(value: string): boolean {
  return UNQUOTED_SAFE_PATTERN.test(value);
}

/**
 * Whether the string contains characters that require escape sequences
 * inside a quoted string, meaning control characters, `"`, `\`, or DEL.
 */
export function needsEscaping(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x22 || code === 0x5c || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Escapes special characters for a quoted string, using the named C-style
 * escapes plus `\Uxxxx` for remaining control characters.
 */
export function escapeString(value: string): string {
  let result = "";
  for (const ch of value) {
    switch (ch) {
      case "\u0007":
        result += "\\a";
        break;
      case "\b":
        result += "\\b";
        break;
      case "\f":
        result += "\\f";
        break;
      case "\r":
        result += "\\r";
        break;
      case "\t":
        result += "\\t";
        break;
      case "\v":
        result += "\\v";
        break;
      case "\n":
        result += "\\n";
        break;
      case '"':
        result += '\\"';
        break;
      case "\\":
        result += "\\\\";
        break;
      default: {
        // DEL joins the control characters here so every character
        // needsEscaping reports actually receives an escape sequence.
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) {
          result += `\\U${code.toString(16).padStart(4, "0")}`;
        } else {
          result += ch;
        }
      }
    }
  }
  return result;
}

/**
 * Renders a string value with quotes exactly when required.
 *
 * Safe literals stay bare, everything else is wrapped in double quotes, and
 * escape processing runs only when an escapable character is present.
 */
export function ensureQuotes(value: string): string {
  if (isSafeUnquoted(value)) {
    return value;
  }
  if (!needsEscaping(value)) {
    return `"${value}"`;
  }
  return `"${escapeString(value)}"`;
}

/**
 * Renders binary data as an uppercase hex run, for example `<DEADBEEF>`.
 */
export function formatData(data: Uint8Array): string {
  let hex = "";
  for (const byte of data) {
    hex += byte.toString(16).padStart(2, "0").toUpperCase();
  }
  return `<${hex}>`;
}
