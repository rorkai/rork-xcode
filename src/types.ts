/**
 * The value model shared by {@link parsePbxproj} and {@link buildPbxproj}.
 *
 * `project.pbxproj` files are OpenStep-style property lists: dictionaries,
 * arrays, strings, and hexadecimal data runs. The format carries no type
 * markers beyond quoting, so the mapping is driven by lexical shape:
 *
 * - `{ key = value; ... }` parses to a {@link PbxprojObject}.
 * - `( item, item, ... )` parses to a {@link PbxprojArray}.
 * - `<48656c6c6f>` data runs parse to `Uint8Array`.
 * - Unquoted integers and decimals (`46`, `3.14`, `-12`) parse to `number`
 *   under one print-back rule, where the literal converts exactly when the
 *   number formats back to the identical text.
 * - Everything else (quoted text, identifiers, uuids, paths) parses to
 *   `string`.
 *
 * The print-back rule is what keeps round-trips faithful. Any literal the
 * conversion would reshape stays a string, so serializing never changes a
 * scalar's bytes. Leading-zero runs like `0755` would corrupt file modes,
 * trailing-zero decimals like `5.0` would drop the zero that build
 * settings are written with, bare-dot decimals like `.5` would grow a
 * leading zero, and
 * digit runs beyond `Number.MAX_SAFE_INTEGER` would lose precision (a
 * 24-character identifier can be all digits), so all of these parse as
 * strings.
 *
 * @module
 */

/**
 * A value representable in a `project.pbxproj` document.
 *
 * Notably absent are booleans and null. The format has no notation for
 * either, and Xcode models flags as the strings `"YES"` and `"NO"`.
 */
export type PbxprojValue = string | number | Uint8Array | PbxprojArray | PbxprojObject;

/**
 * A `( ... )` list: an ordered array of values.
 *
 * This is a plain JavaScript array. The interface exists only to give the
 * recursive {@link PbxprojValue} type a name.
 */
export interface PbxprojArray extends Array<PbxprojValue> {}

/**
 * A `{ ... }` dictionary: a plain object whose keys appear in document order.
 *
 * Duplicate keys in a parsed document resolve to the last occurrence. A
 * literal `__proto__` key is always stored as an own property, so parsing
 * untrusted documents cannot pollute prototypes.
 */
export interface PbxprojObject {
  [key: string]: PbxprojValue;
}
