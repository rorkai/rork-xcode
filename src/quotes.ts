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
 * True when every character is in the writer's unquoted-safe alphabet:
 * `[A-Za-z0-9_$/:.]`. The empty string is not safe — it must render as `""`.
 */
export function isSafeUnquoted(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const safe =
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x30 && code <= 0x39) || // 0-9
      code === 0x5f || // _
      code === 0x24 || // $
      code === 0x2f || // /
      code === 0x3a || // :
      code === 0x2e; // .
    if (!safe) {
      return false;
    }
  }
  return true;
}

/** True when the string contains characters that require escape sequences. */
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
 * Escapes special characters for a quoted string: the named C-style escapes
 * plus `\Uxxxx` for remaining control characters.
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
        const code = ch.charCodeAt(0);
        if (code < 0x20) {
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
 * Renders a string value with quotes exactly when required: safe literals
 * stay bare, everything else is wrapped in double quotes, and escape
 * processing runs only when an escapable character is present.
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

/** Renders binary data as an uppercase hex run: `<DEADBEEF>`. */
export function formatData(data: Uint8Array): string {
  let hex = "";
  for (const byte of data) {
    hex += byte.toString(16).padStart(2, "0").toUpperCase();
  }
  return `<${hex}>`;
}
