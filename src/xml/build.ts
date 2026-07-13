/**
 * Serializer for Xcode's XML dialect, shared by scheme and workspace
 * files.
 *
 * The output reproduces Xcode's own layout byte for byte. Xcode writes
 * the UTF-8 declaration, indents with three spaces, puts each attribute
 * on its own line with spaces around the equals sign, glues the closing
 * angle bracket to the last attribute, and closes every element with an
 * explicit close tag. Parsing an Xcode-written file and building it
 * back therefore yields the identical file, and any other input reaches
 * that canonical form in one build.
 *
 * Each file format wraps this core with its own error type, so a caller
 * always sees the error class of the format it asked for.
 *
 * @module
 */

import { isXmlElement } from "./types";

import type { XmlComment, XmlDocument, XmlElement, XmlNode } from "./types";

/**
 * Constructs the format's build error. The core reports failures through
 * this factory, so scheme building throws scheme errors and workspace
 * building throws workspace errors from the same code.
 */
export type XmlBuildErrorFactory = (message: string, path: string) => Error;

/**
 * The internal failure the renderers throw. It carries the offending
 * node instead of a path, and {@link buildXmlDocument} resolves the path
 * by searching the tree only when a failure actually happens, so the
 * happy path never pays for path bookkeeping.
 */
class XmlBuildFailure extends Error {
  /** The element or comment node the failure points at. */
  readonly node: XmlNode | null;

  constructor(message: string, node: XmlNode | null) {
    super(message);
    this.name = "XmlBuildFailure";
    this.node = node;
  }
}

/** The declaration line Xcode writes at the top of every file. */
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** One indentation step of Xcode's writer. */
const INDENT = "   ";

/**
 * Indentation strings by depth, extended on demand. Documents nest a
 * handful of levels, and reusing the strings keeps the writer from
 * re-allocating the same prefixes for every node.
 */
const INDENTS: string[] = [""];

/**
 * The indentation prefix for a nesting depth.
 */
function indentAt(depth: number): string {
  for (let known = INDENTS.length; known <= depth; known++) {
    INDENTS.push(INDENTS[known - 1]! + INDENT);
  }
  return INDENTS[depth]!;
}

/**
 * Matches valid XML names. A stray non-name, such as an empty string or
 * one carrying spaces or XML syntax, must fail rather than produce a
 * document no parser accepts.
 */
const NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/u;

/**
 * Names that already passed {@link NAME_PATTERN}, capped so hostile
 * documents cannot grow the set without bound. Element and attribute
 * vocabularies repeat heavily, so nearly every check after the first is
 * a set lookup instead of a regex test.
 */
const VALID_NAMES = new Set<string>();

/**
 * Whether a name is a valid XML name, memoized across documents.
 */
function isValidName(name: string): boolean {
  if (VALID_NAMES.has(name)) {
    return true;
  }
  if (!NAME_PATTERN.test(name)) {
    return false;
  }
  if (VALID_NAMES.size < 512) {
    VALID_NAMES.add(name);
  }
  return true;
}

/**
 * Serializes a document to text in Xcode's canonical layout, reporting
 * failures through the given error factory.
 */
export function buildXmlDocument(document: XmlDocument, makeError: XmlBuildErrorFactory): string {
  try {
    let output = XML_DECLARATION;
    for (const comment of document.leading) {
      output += renderComment(comment, 0);
    }
    output += renderElement(document.root, 0);
    for (const comment of document.trailing) {
      output += renderComment(comment, 0);
    }
    return output;
  } catch (error) {
    if (error instanceof XmlBuildFailure) {
      throw makeError(error.message, pathOf(document, error.node));
    }
    throw error;
  }
}

/**
 * Resolves the path of a node for an error message, in the
 * `Scheme.BuildAction[0]` form, by walking the tree. This runs only when
 * a build actually fails.
 */
function pathOf(document: XmlDocument, node: XmlNode | null): string {
  if (node == null || document.leading.includes(node as XmlComment) || document.trailing.includes(node as XmlComment)) {
    return "document";
  }
  const search = (element: XmlElement, path: string): string | undefined => {
    if (element === node) {
      return path;
    }
    const seen = new Map<string, number>();
    for (const child of element.children) {
      if (!isXmlElement(child)) {
        if (child === node) {
          return path;
        }
        continue;
      }
      const index = seen.get(child.name) ?? 0;
      seen.set(child.name, index + 1);
      const found = search(child, `${path}.${child.name}[${index}]`);
      if (found != null) {
        return found;
      }
    }
    return undefined;
  };
  return search(document.root, document.root.name) ?? document.root.name;
}

/**
 * Renders one comment, failing on text the comment grammar cannot hold.
 * A `--` inside the text or a `-` against the closing marker would
 * reparse at a different terminator, so emitting it would corrupt the
 * document.
 */
function renderComment(node: XmlComment, depth: number): string {
  const comment = node.comment;
  if (comment.includes("--") || comment.endsWith("-")) {
    throw new XmlBuildFailure("Comments cannot contain -- or end with -", node);
  }
  return `${indentAt(depth)}<!--${comment}-->\n`;
}

/**
 * Renders one element with Xcode's layout. Attributes go each on their
 * own line indented one step past the tag, the `>` glues to the last
 * attribute, children indent one step, and the close tag is always
 * explicit.
 */
function renderElement(element: XmlElement, depth: number): string {
  if (!isValidName(element.name)) {
    throw new XmlBuildFailure(`Element name ${JSON.stringify(element.name)} is not a valid XML name`, element);
  }

  const indent = indentAt(depth);
  const names = Object.keys(element.attributes);

  let output: string;
  if (names.length === 0) {
    output = `${indent}<${element.name}>\n`;
  } else {
    output = `${indent}<${element.name}\n`;
    const attributeIndent = indentAt(depth + 1);
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      if (!isValidName(name)) {
        throw new XmlBuildFailure(`Attribute name ${JSON.stringify(name)} is not a valid XML name`, element);
      }
      const value = escapeAttribute(element.attributes[name]!, element, name);
      const terminator = i === names.length - 1 ? ">" : "";
      output += `${attributeIndent}${name} = "${value}"${terminator}\n`;
    }
  }

  const children = element.children;
  const childDepth = depth + 1;
  for (const child of children) {
    output += isXmlElement(child) ? renderElement(child, childDepth) : renderComment(child, childDepth);
  }
  output += `${indent}</${element.name}>\n`;
  return output;
}

// UTF-16 code units the value scanner dispatches on.
const CODE_TAB = 0x09;
const CODE_LINE_FEED = 0x0a;
const CODE_CARRIAGE_RETURN = 0x0d;
const CODE_QUOTE = 0x22;
const CODE_AMPERSAND = 0x26;
const CODE_APOSTROPHE = 0x27;
const CODE_LESS_THAN = 0x3c;
const CODE_GREATER_THAN = 0x3e;

/**
 * Matches every code unit the writer must escape, validate, or reject.
 * Nearly all attribute values contain none of them, and the single
 * regex test is the cheapest full-string scan the engine offers, so a
 * miss returns the value with no further work.
 */
// oxlint-disable-next-line no-control-regex -- the control characters are part of the scanned-for set
const NEEDS_WORK_PATTERN = /[\u0000-\u001F&<>"'\uD800-\uDFFF\uFFFE\uFFFF]/;

/**
 * Escapes an attribute value the way Xcode's writer does. XML syntax
 * characters become the five named entities, and tab, line feed, and
 * carriage return become character references so they survive
 * attribute-value normalization on the next parse.
 *
 * The common value with nothing to escape returns as-is after one regex
 * scan. Only values carrying an interesting code unit take the
 * classifying pass, which escapes what has an escape and rejects what
 * no XML document can carry, meaning the control characters XML cannot
 * represent, unpaired surrogate halves, and the two noncharacters at
 * the end of the basic plane.
 */
function escapeAttribute(value: string, element: XmlElement, attributeName: string): string {
  if (!NEEDS_WORK_PATTERN.test(value)) {
    return value;
  }

  let needsEscaping = false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20) {
      if (code === CODE_TAB || code === CODE_LINE_FEED || code === CODE_CARRIAGE_RETURN) {
        needsEscaping = true;
        continue;
      }
      throw new XmlBuildFailure(
        `Attribute ${attributeName} contains the control character U+${code.toString(16).padStart(4, "0").toUpperCase()}, which XML cannot encode`,
        element,
      );
    }
    if (
      code === CODE_AMPERSAND ||
      code === CODE_LESS_THAN ||
      code === CODE_GREATER_THAN ||
      code === CODE_QUOTE ||
      code === CODE_APOSTROPHE
    ) {
      needsEscaping = true;
      continue;
    }
    if (code >= 0xd800) {
      if (code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          i++;
          continue;
        }
      }
      if (code <= 0xdfff || code === 0xfffe || code === 0xffff) {
        throw new XmlBuildFailure(
          `Attribute ${attributeName} contains a code point XML cannot carry (U+${code.toString(16).padStart(4, "0").toUpperCase()})`,
          element,
        );
      }
    }
  }

  if (!needsEscaping) {
    return value;
  }
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;");
}
