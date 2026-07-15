/**
 * The node model of a scheme document. Scheme files share Xcode's XML
 * dialect with workspace data files, so the shapes here are the shared
 * XML node types under their scheme names.
 *
 * A parsed `.xcscheme` is a tree of plain objects. Elements carry ordered
 * attributes and child nodes, and comments survive as their own nodes.
 * All state lives in this tree. There is no wrapper to keep in sync, so
 * callers mutate nodes directly and serialize whatever the tree currently
 * says.
 *
 * @module
 */

import { isXmlElement } from "../xml/types";

import type { XmlComment, XmlDocument, XmlElement, XmlNode } from "../xml/types";

/**
 * An XML element of a scheme document.
 *
 * Attribute order is preserved and meaningful. The writer emits
 * attributes in insertion order, which is how Xcode-written files
 * round-trip byte-identically. Assigning an existing key keeps its
 * position, and adding a new key appends it.
 */
export type XcschemeElement = XmlElement;

/**
 * A comment inside a scheme document. Xcode never writes comments, but
 * hand-edited and tool-generated schemes can carry them, and dropping
 * them would make round-trips lossy.
 */
export type XcschemeComment = XmlComment;

/**
 * Any node a scheme element can contain.
 */
export type XcschemeNode = XmlNode;

/**
 * A parsed scheme file, made of its root element plus any comments
 * sitting outside it. Xcode writes only the root, so the comment lists
 * are almost always empty, but files that carry them round-trip without
 * loss.
 */
export type XcschemeDocument = XmlDocument;

/**
 * Whether a node is an element rather than a comment.
 */
export function isXcschemeElement(node: XcschemeNode): node is XcschemeElement {
  return isXmlElement(node);
}
