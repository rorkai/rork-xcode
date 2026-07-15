/**
 * The node model of Xcode's XML dialect, shared by scheme files
 * (`.xcscheme`) and workspace data files (`contents.xcworkspacedata`).
 *
 * A parsed document is a tree of plain objects. Elements carry ordered
 * attributes and child nodes, and comments survive as their own nodes.
 * All state lives in this tree. There is no wrapper to keep in sync, so
 * callers mutate nodes directly and serialize whatever the tree
 * currently says.
 *
 * @module
 */

/**
 * An XML element of a document.
 *
 * Attribute order is preserved and meaningful. The writer emits
 * attributes in insertion order, which is how Xcode-written files
 * round-trip byte-identically. Assigning an existing key keeps its
 * position, and adding a new key appends it.
 */
export interface XmlElement {
  /** Tag name, for example `Scheme` or `FileRef`. */
  name: string;

  /** Attribute values by name, in document order. */
  attributes: Record<string, string>;

  /** Child elements and comments, in document order. */
  children: XmlNode[];
}

/**
 * A comment inside a document. Xcode never writes comments, but
 * hand-edited and tool-generated files can carry them, and dropping them
 * would make round-trips lossy.
 */
export interface XmlComment {
  /** The comment text between `<!--` and `-->`, verbatim. */
  comment: string;
}

/**
 * Any node an element can contain.
 */
export type XmlNode = XmlElement | XmlComment;

/**
 * A parsed document, made of its root element plus any comments sitting
 * outside it. Xcode writes only the root, so the comment lists are
 * almost always empty, but files that carry them round-trip without
 * loss.
 */
export interface XmlDocument {
  /** Comments before the root element. */
  leading: XmlComment[];

  /** The root element. */
  root: XmlElement;

  /** Comments after the root element. */
  trailing: XmlComment[];
}

/**
 * Whether a node is an element rather than a comment.
 */
export function isXmlElement(node: XmlNode): node is XmlElement {
  return "name" in node;
}

/**
 * Collects elements of the given name anywhere under a root, in document
 * order, root included. Passing no name collects every element. Scheme
 * and workspace models both build their typed views over this query.
 */
export function xmlElements(root: XmlElement, name?: string): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (element: XmlElement): void => {
    if (name == null || element.name === name) {
      found.push(element);
    }
    for (const child of element.children) {
      if (isXmlElement(child)) {
        visit(child);
      }
    }
  };
  visit(root);
  return found;
}
