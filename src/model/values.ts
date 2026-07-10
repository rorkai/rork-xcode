/**
 * Small value-narrowing helpers shared by the object model.
 *
 * Parsed documents are untrusted input where any field can hold any value
 * type, so every read that expects a particular shape narrows through
 * these helpers instead of asserting.
 *
 * @module
 */

import type { PbxprojObject, PbxprojValue } from "../types";

/**
 * Returns the value when it is a string, and `undefined` otherwise.
 */
export function asString(value: PbxprojValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Returns the value when it is a dictionary, and `undefined` otherwise.
 *
 * Arrays and `Uint8Array` data are objects at runtime too, so a bare
 * `typeof` check is not enough.
 */
export function asDictionary(value: PbxprojValue | undefined): PbxprojObject | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    return value;
  }
  return undefined;
}

/**
 * Returns the value when it is an array, and `undefined` otherwise.
 */
export function asArray(value: PbxprojValue | undefined): PbxprojValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Returns the array under `key`, creating an empty one when the key is
 * absent or holds a non-array value.
 *
 * Mutating methods use this to append into list fields (`children`,
 * `dependencies`, `exceptions`) without separate existence checks at every
 * call site.
 */
export function ensureArray(object: PbxprojObject, key: string): PbxprojValue[] {
  const existing = object[key];
  if (Array.isArray(existing)) {
    return existing;
  }
  const created: PbxprojValue[] = [];
  object[key] = created;
  return created;
}

/**
 * Collects the string items of a possibly absent, possibly mixed array.
 *
 * Reference lists in well-formed documents contain only id strings, but a
 * malformed document can mix in anything. Non-strings are skipped rather
 * than thrown on, matching the library's soft-failure stance on reads.
 */
export function stringItems(value: PbxprojValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      items.push(item);
    }
  }
  return items;
}
