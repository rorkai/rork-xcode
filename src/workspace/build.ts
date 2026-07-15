/**
 * Serializer entry point for the `contents.xcworkspacedata` dialect. The
 * layout rules live in the shared XML core, and this wrapper binds them
 * to the workspace error type.
 *
 * @module
 */

import { XcworkspaceBuildError } from "../errors";
import { buildXmlDocument } from "../xml/build";

import type { XmlDocument } from "../xml/types";

/**
 * Serializes a workspace document to the text of a
 * `contents.xcworkspacedata` file in Xcode's canonical layout.
 *
 * @throws XcworkspaceBuildError for element or attribute names that are
 *   not XML names and for attribute values carrying unencodable control
 *   characters, with the path of the offending node.
 */
export function buildXcworkspace(document: XmlDocument): string {
  return buildXmlDocument(document, (message, path) => new XcworkspaceBuildError(message, path));
}
