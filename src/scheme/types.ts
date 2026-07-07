/**
 * The node model of a scheme document.
 *
 * A parsed `.xcscheme` is a tree of plain objects: elements with ordered
 * attributes and child nodes, plus the occasional comment. All state lives
 * in this tree. There is no wrapper class to keep in sync, so callers
 * mutate nodes directly and serialize whatever the tree currently says.
 *
 * @module
 */

/**
 * An XML element of a scheme document.
 *
 * Attribute order is preserved and meaningful: the writer emits attributes
 * in insertion order, which is how byte-identical round-trips of
 * Xcode-written files fall out. Assigning an existing key keeps its
 * position, and adding a new key appends it.
 */
export interface XcschemeElement {
  /** Tag name, for example `Scheme` or `BuildableReference`. */
  name: string;

  /** Attribute values by name, in document order. */
  attributes: Record<string, string>;

  /** Child elements and comments, in document order. */
  children: XcschemeNode[];
}

/**
 * A comment inside a scheme document. Xcode never writes comments, but
 * hand-edited and tool-generated schemes can carry them, and dropping
 * them would make round-trips lossy.
 */
export interface XcschemeComment {
  /** The comment text between `<!--` and `-->`, verbatim. */
  comment: string;
}

/**
 * Any node a scheme element can contain.
 */
export type XcschemeNode = XcschemeElement | XcschemeComment;

/**
 * A parsed scheme file: its root element plus any comments sitting
 * outside it. Xcode writes only the root, so the comment lists are almost
 * always empty, but files that carry them round-trip without loss.
 */
export interface XcschemeDocument {
  /** Comments before the root element. */
  leading: XcschemeComment[];

  /** The `Scheme` element. */
  root: XcschemeElement;

  /** Comments after the root element. */
  trailing: XcschemeComment[];
}

/**
 * Whether a node is an element rather than a comment.
 */
export function isXcschemeElement(node: XcschemeNode): node is XcschemeElement {
  return "name" in node;
}
