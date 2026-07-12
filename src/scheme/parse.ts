/**
 * Parser entry point for the `.xcscheme` dialect. The grammar lives in
 * the shared XML core, and this wrapper binds it to the scheme error
 * type.
 *
 * @module
 */

import { XcschemeParseError } from "../errors";
import { parseXmlDocument } from "../xml/parse";

import type { XcschemeDocument } from "./types";

/**
 * Parses the text of a `.xcscheme` file into its node tree.
 *
 * @throws XcschemeParseError when the text is not a well-formed scheme
 *   document, with the line and column of the failure.
 */
export function parseXcscheme(text: string): XcschemeDocument {
  return parseXmlDocument(text, (message, source, offset) => new XcschemeParseError(message, source, offset));
}
