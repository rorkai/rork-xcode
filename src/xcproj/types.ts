/**
 * The value model shared by {@link parseXcproj} and {@link buildXcproj}.
 *
 * Xcode 27 stores projects as `project.xcproj`, a JSON5 document next to
 * (or instead of) the classic `project.pbxproj`. The values are plain
 * JSON, so the mapping is the familiar one:
 *
 * - `{ "key": value, ... }` parses to an {@link XcprojObject}, with keys in
 *   document order.
 * - `[ item, ... ]` parses to an {@link XcprojArray}.
 * - Strings, booleans, and `null` parse to their JavaScript counterparts.
 * - Numbers parse to `number`, the way `JSON.parse` reads them.
 *
 * Xcode's schema itself only uses strings, booleans, arrays, and
 * dictionaries. Booleans carry flags like `"index": false`, and build
 * settings stay strings (`"SWIFT_VERSION": "5.0"`), so the precision
 * caveats of JSON numbers never touch a real project.
 *
 * @module
 */

/**
 * A value representable in a `project.xcproj` document.
 */
export type XcprojValue = string | number | boolean | null | XcprojArray | XcprojObject;

/**
 * A `[ ... ]` list, which is a plain JavaScript array. The interface
 * exists only to give the recursive {@link XcprojValue} type a name.
 */
export interface XcprojArray extends Array<XcprojValue> {}

/**
 * A `{ ... }` dictionary, which is a plain object whose keys appear in
 * document order.
 *
 * Duplicate keys in a parsed document resolve to the last occurrence. A
 * literal `__proto__` key is always stored as an own property, so parsing
 * untrusted documents cannot pollute prototypes.
 */
export interface XcprojObject {
  [key: string]: XcprojValue;
}
