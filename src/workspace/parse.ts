/**
 * Parser entry point for the `contents.xcworkspacedata` dialect. The
 * grammar lives in the shared XML core, and this wrapper binds it to the
 * workspace error type.
 *
 * @module
 */

import { XcworkspaceParseError } from "../errors";
import { parseXmlDocument } from "../xml/parse";

import type { XmlDocument } from "../xml/types";

/**
 * Parses the text of a `contents.xcworkspacedata` file into its node
 * tree.
 *
 * @throws XcworkspaceParseError when the text is not a well-formed
 *   workspace document, with the line and column of the failure.
 */
export function parseXcworkspace(text: string): XmlDocument {
  return parseXmlDocument(text, (message, source, offset) => new XcworkspaceParseError(message, source, offset));
}
