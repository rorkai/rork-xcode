/**
 * Writer for Xcode build configuration files (`.xcconfig`).
 *
 * Every statement carries the exact text it was parsed from, so building
 * an untouched document reproduces the input byte for byte. Statements
 * created or modified through the model carry regenerated text in the
 * same field, which is how mutation and fidelity coexist.
 *
 * @module
 */

import type { XcconfigDocument } from "./types";

/**
 * Serializes a document back to `.xcconfig` text.
 */
export function buildXcconfig(document: XcconfigDocument): string {
  let text = "";
  for (const statement of document.statements) {
    text += statement.raw + statement.eol;
  }
  return text;
}
