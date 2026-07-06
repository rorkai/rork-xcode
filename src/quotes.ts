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
 * The writer's unquoted-safe alphabet, `[A-Za-z0-9_$/:.]`, as a 256-entry
 * table. Quoting decisions scan every string value a document carries, so
 * classification is one array read per character; non-ASCII code units
 * index past the table and read `undefined`, which is correctly falsy.
 */
const IS_UNQUOTED_SAFE: Uint8Array = (() => {
  const table = new Uint8Array(256);
  for (let i = 0x61; i <= 0x7a; i++) table[i] = 1; // a-z
  for (let i = 0x41; i <= 0x5a; i++) table[i] = 1; // A-Z
  for (let i = 0x30; i <= 0x39; i++) table[i] = 1; // 0-9
  for (const ch of "_$/:.") table[ch.charCodeAt(0)] = 1;
  return table;
})();

/**
 * Whether every character is in the writer's unquoted-safe alphabet:
 * `[A-Za-z0-9_$/:.]`.
 *
 * The empty string is not safe; it must render as `""`.
 */
export function isSafeUnquoted(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    if (IS_UNQUOTED_SAFE[value.charCodeAt(i)] !== 1) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the string contains characters that require escape sequences
 * inside a quoted string: control characters, `"`, `\`, or DEL.
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
 * Renders binary data as an uppercase hex run: `<DEADBEEF>`.
 */
export function formatData(data: Uint8Array): string {
  let hex = "";
  for (const byte of data) {
    hex += byte.toString(16).padStart(2, "0").toUpperCase();
  }
  return `<${hex}>`;
}
