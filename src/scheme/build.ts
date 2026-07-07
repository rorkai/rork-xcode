/**
 * Serializer for the `.xcscheme` XML dialect.
 *
 * The output reproduces Xcode's own layout byte for byte. Xcode writes
 * the UTF-8 declaration, indents with three spaces, puts each attribute
 * on its own line with spaces around the equals sign, glues the closing
 * angle bracket to the last attribute, and closes every element with an
 * explicit close tag. Parsing an Xcode-written scheme and building it
 * back therefore yields the identical file, and any other input reaches
 * that canonical form in one build.
 *
 * @module
 */

import { XcschemeBuildError } from "../errors";
import { isXcschemeElement } from "./types";

import type { XcschemeDocument, XcschemeElement, XcschemeNode } from "./types";

/** The declaration line Xcode writes at the top of every scheme file. */
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** One indentation step of Xcode's scheme writer. */
const INDENT = "   ";

/**
 * Matches valid XML names. A stray non-name, such as an empty string or
 * one carrying spaces or XML syntax, must fail rather than produce a
 * document no parser accepts.
 */
const NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/u;

/**
 * Matches characters that cannot appear in an attribute value. XML 1.0
 * has no representation for control characters other than tab, line
 * feed, and carriage return.
 */
// oxlint-disable-next-line no-control-regex -- rejecting control characters is the point of this pattern
const UNENCODABLE_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;

/**
 * Serializes a scheme document to the text of a `.xcscheme` file.
 *
 * @throws XcschemeBuildError for element or attribute names that are not
 *   XML names and for attribute values carrying unencodable control
 *   characters, with the path of the offending node.
 */
export function buildXcscheme(document: XcschemeDocument): string {
  let output = XML_DECLARATION;
  for (const comment of document.leading) {
    output += `<!--${comment.comment}-->\n`;
  }
  output += renderElement(document.root, 0, document.root.name);
  for (const comment of document.trailing) {
    output += `<!--${comment.comment}-->\n`;
  }
  return output;
}

/**
 * Renders one element with Xcode's layout. Attributes go each on their
 * own line indented one step past the tag, the `>` glues to the last
 * attribute, children indent one step, and the close tag is always
 * explicit.
 */
function renderElement(element: XcschemeElement, depth: number, path: string): string {
  if (!NAME_PATTERN.test(element.name)) {
    throw new XcschemeBuildError(`Element name ${JSON.stringify(element.name)} is not a valid XML name`, path);
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
        throw new XcschemeBuildError(`Attribute name ${JSON.stringify(name)} is not a valid XML name`, path);
      }
      const value = escapeAttribute(element.attributes[name]!, path, name);
      const terminator = i === names.length - 1 ? ">" : "";
      output += `${attributeIndent}${name} = "${value}"${terminator}\n`;
    }
  }

  output += renderChildren(element.children, depth + 1, path);
  output += `${indent}</${element.name}>\n`;
  return output;
}

/**
 * Renders an element's children in document order, numbering repeated
 * element names in the error path so a failure points at one node.
 */
function renderChildren(children: XcschemeNode[], depth: number, path: string): string {
  let output = "";
  const seen = new Map<string, number>();
  for (const child of children) {
    if (isXcschemeElement(child)) {
      const index = seen.get(child.name) ?? 0;
      seen.set(child.name, index + 1);
      output += renderElement(child, depth, `${path}.${child.name}[${index}]`);
    } else {
      output += `${INDENT.repeat(depth)}<!--${child.comment}-->\n`;
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
function escapeAttribute(value: string, path: string, attributeName: string): string {
  const unencodable = UNENCODABLE_PATTERN.exec(value);
  if (unencodable != null) {
    throw new XcschemeBuildError(
      `Attribute ${attributeName} contains the control character U+${unencodable[0].charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}, which XML cannot encode`,
      path,
    );
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
