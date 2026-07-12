/**
 * Serializer entry point for the `.xcscheme` dialect. The layout rules
 * live in the shared XML core, and this wrapper binds them to the scheme
 * error type.
 *
 * @module
 */

import { XcschemeBuildError } from "../errors";
import { buildXmlDocument } from "../xml/build";

import type { XcschemeDocument } from "./types";

/**
 * Serializes a scheme document to the text of a `.xcscheme` file in
 * Xcode's canonical layout.
 *
 * @throws XcschemeBuildError for element or attribute names that are not
 *   XML names and for attribute values carrying unencodable control
 *   characters, with the path of the offending node.
 */
export function buildXcscheme(document: XcschemeDocument): string {
  return buildXmlDocument(document, (message, path) => new XcschemeBuildError(message, path));
}
