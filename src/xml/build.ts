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

import type { XmlDocument, XmlElement, XmlNode } from "./types";

/**
 * Constructs the format's build error. The core reports failures through
 * this factory, so scheme building throws scheme errors and workspace
 * building throws workspace errors from the same code.
 */
export type XmlBuildErrorFactory = (message: string, path: string) => Error;

/** The declaration line Xcode writes at the top of every file. */
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** One indentation step of Xcode's writer. */
const INDENT = "   ";

/**
 * Matches valid XML names. A stray non-name, such as an empty string or
 * one carrying spaces or XML syntax, must fail rather than produce a
 * document no parser accepts.
 */
const NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/u;

/**
 * Matches everything an attribute value cannot carry, in one scan. The
 * alternatives are the control characters XML 1.0 cannot represent
 * (everything below space except tab, line feed, and carriage return),
 * unpaired surrogate halves, and the two noncharacters at the end of
 * the basic plane. Escaping cannot help any of these, so they fail
 * rather than serialize into a file no parser accepts.
 */
/* oxlint-disable no-control-regex -- control characters are these patterns' subject, rejected by the first and escaped by the second */
const INVALID_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uFFFE\uFFFF]/u;

/**
 * Matches the characters the writer escapes. Most attribute values carry
 * none, and the single test lets them skip the escape chain entirely.
 */
const ESCAPABLE_PATTERN = /[&<>"'\t\n\r]/u;
/* oxlint-enable no-control-regex */

/**
 * Serializes a document to text in Xcode's canonical layout, reporting
 * failures through the given error factory.
 */
export function buildXmlDocument(document: XmlDocument, makeError: XmlBuildErrorFactory): string {
  let output = XML_DECLARATION;
  for (const comment of document.leading) {
    output += renderComment(comment.comment, 0, "document", makeError);
  }
  output += renderElement(document.root, 0, document.root.name, makeError);
  for (const comment of document.trailing) {
    output += renderComment(comment.comment, 0, "document", makeError);
  }
  return output;
}

/**
 * Renders one comment, failing on text the comment grammar cannot hold.
 * A `--` inside the text or a `-` against the closing marker would
 * reparse at a different terminator, so emitting it would corrupt the
 * document.
 */
function renderComment(comment: string, depth: number, path: string, makeError: XmlBuildErrorFactory): string {
  if (comment.includes("--") || comment.endsWith("-")) {
    throw makeError("Comments cannot contain -- or end with -", path);
  }
  return `${INDENT.repeat(depth)}<!--${comment}-->\n`;
}

/**
 * Renders one element with Xcode's layout. Attributes go each on their
 * own line indented one step past the tag, the `>` glues to the last
 * attribute, children indent one step, and the close tag is always
 * explicit.
 */
function renderElement(element: XmlElement, depth: number, path: string, makeError: XmlBuildErrorFactory): string {
  if (!NAME_PATTERN.test(element.name)) {
    throw makeError(`Element name ${JSON.stringify(element.name)} is not a valid XML name`, path);
  }

  const indent = INDENT.repeat(depth);
  const names = Object.keys(element.attributes);

  let output: string;
  if (names.length === 0) {
    output = `${indent}<${element.name}>\n`;
  } else {
    output = `${indent}<${element.name}\n`;
    const attributeIndent = indent + INDENT;
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      if (!NAME_PATTERN.test(name)) {
        throw makeError(`Attribute name ${JSON.stringify(name)} is not a valid XML name`, path);
      }
      const value = escapeAttribute(element.attributes[name]!, path, name, makeError);
      const terminator = i === names.length - 1 ? ">" : "";
      output += `${attributeIndent}${name} = "${value}"${terminator}\n`;
    }
  }

  output += renderChildren(element.children, depth + 1, path, makeError);
  output += `${indent}</${element.name}>\n`;
  return output;
}

/**
 * Renders an element's children in document order, numbering repeated
 * element names in the error path so a failure points at one node.
 */
function renderChildren(children: XmlNode[], depth: number, path: string, makeError: XmlBuildErrorFactory): string {
  let output = "";
  const seen = new Map<string, number>();
  for (const child of children) {
    if (isXmlElement(child)) {
      const index = seen.get(child.name) ?? 0;
      seen.set(child.name, index + 1);
      output += renderElement(child, depth, `${path}.${child.name}[${index}]`, makeError);
    } else {
      output += renderComment(child.comment, depth, path, makeError);
    }
  }
  return output;
}

/**
 * Escapes an attribute value the way Xcode's writer does. XML syntax
 * characters become the five named entities, and tab, line feed, and
 * carriage return become character references so they survive
 * attribute-value normalization on the next parse.
 */
function escapeAttribute(value: string, path: string, attributeName: string, makeError: XmlBuildErrorFactory): string {
  const invalid = INVALID_PATTERN.exec(value);
  if (invalid != null) {
    const code = invalid[0].charCodeAt(0);
    const codePoint = `U+${code.toString(16).padStart(4, "0").toUpperCase()}`;
    const message =
      code < 0x20
        ? `Attribute ${attributeName} contains the control character ${codePoint}, which XML cannot encode`
        : `Attribute ${attributeName} contains a code point XML cannot carry (${codePoint})`;
    throw makeError(message, path);
  }

  if (!ESCAPABLE_PATTERN.test(value)) {
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
