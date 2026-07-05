/**
 * The value model shared by {@link parsePbxproj} and {@link buildPbxproj}.
 *
 * `project.pbxproj` files are OpenStep-style property lists: dictionaries,
 * arrays, strings, and hexadecimal data runs. The format carries no type
 * markers beyond quoting, so the mapping is driven by lexical shape:
 *
 * | Source shape                                | JavaScript value        |
 * | ------------------------------------------- | ----------------------- |
 * | `{ key = value; ... }`                      | {@link PbxprojObject}   |
 * | `( item, item, ... )`                       | {@link PbxprojArray}    |
 * | unquoted digit run (`46`)                   | `number`                |
 * | unquoted decimal not ending in `0` (`3.14`) | `number`                |
 * | `<48656c6c6f>`                              | `Uint8Array`            |
 * | everything else                             | `string`                |
 *
 * Three deliberate string preservations keep round-trips faithful:
 *
 * - Digit runs with a leading zero (`0755`) stay strings — collapsing them
 *   to numbers would corrupt file modes and zero-padded identifiers.
 * - Decimals ending in `0` (`5.0`, `18.0`) stay strings — number conversion
 *   would drop the trailing zero that build settings like deployment targets
 *   are written with.
 * - Integers beyond `Number.MAX_SAFE_INTEGER` stay strings so 24-character
 *   hex identifiers that happen to be all digits never lose precision.
 *
 * @module
 */

/** A value representable in a `project.pbxproj` document. */
export type PbxprojValue = string | number | Uint8Array | PbxprojArray | PbxprojObject;

/**
 * A `( ... )` list: an ordered array of values.
 *
 * This is a plain JavaScript array; the interface exists only to give the
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
