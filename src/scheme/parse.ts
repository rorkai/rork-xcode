/**
 * Parser for the `.xcscheme` XML dialect.
 *
 * Scheme files are XML with a narrow shape. Elements carry attributes and
 * child elements, and there is no text content, no namespace, and no
 * DOCTYPE. The parser accepts that shape from any writer, since attribute
 * order, quoting style, and whitespace vary across tools. Character and
 * entity references in attribute values resolve to their characters, and
 * comments are preserved. Anything outside the shape fails loudly with a
 * position, in line with the pbxproj parser.
 *
 * @module
 */

import { XcschemeParseError } from "../errors";

import type { XcschemeComment, XcschemeDocument, XcschemeElement, XcschemeNode } from "./types";

// UTF-16 code units of the characters the scanner dispatches on.
const CODE_TAB = 0x09;
const CODE_LINE_FEED = 0x0a;
const CODE_CARRIAGE_RETURN = 0x0d;
const CODE_SPACE = 0x20;
const CODE_BANG = 0x21;
const CODE_QUOTE = 0x22;
const CODE_AMPERSAND = 0x26;
const CODE_APOSTROPHE = 0x27;
const CODE_HYPHEN = 0x2d;
const CODE_SLASH = 0x2f;
const CODE_LESS_THAN = 0x3c;
const CODE_EQUALS = 0x3d;
const CODE_GREATER_THAN = 0x3e;
const CODE_QUESTION = 0x3f;
const CODE_HASH = 0x23;
const CODE_BOM = 0xfeff;

/**
 * Whether a code unit is XML whitespace (space, tab, line feed, or
 * carriage return).
 */
function isWhitespace(code: number): boolean {
  return code === CODE_SPACE || code === CODE_TAB || code === CODE_LINE_FEED || code === CODE_CARRIAGE_RETURN;
}

/**
 * Whether a code unit can start an XML name. The scheme vocabulary is
 * ASCII, so the accepted alphabet is letters, underscore, and colon.
 */
function isNameStart(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f /* _ */ || code === 0x3a /* : */
  );
}

/**
 * Whether a code unit can continue an XML name.
 */
function isNameChar(code: number): boolean {
  return isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === CODE_HYPHEN || code === 0x2e /* . */;
}

/** The named character entities XML 1.0 predefines. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

/**
 * Parses the text of a `.xcscheme` file into its node tree.
 *
 * @throws XcschemeParseError when the text is not a well-formed scheme
 *   document, with the line and column of the failure.
 */
export function parseXcscheme(text: string): XcschemeDocument {
  return new Parser(text).parseDocument();
}

/**
 * Single-pass recursive-descent parser over the source text. One instance
 * parses one document and is discarded.
 */
class Parser {
  /** The full source text of the scheme file. */
  private readonly input: string;

  /** Cursor into {@link input}, in UTF-16 code units. */
  private pos = 0;

  constructor(input: string) {
    this.input = input;
    // Xcode writes UTF-8 without a byte order mark, but files that passed
    // through other editors can carry one, and it is not content.
    if (input.charCodeAt(0) === CODE_BOM) {
      this.pos = 1;
    }
  }

  /**
   * Parses the whole document. The XML declaration is skipped, comments
   * around the root element are collected, and anything left after the
   * root fails.
   */
  parseDocument(): XcschemeDocument {
    this.skipWhitespace();
    this.skipDeclaration();

    const leading: XcschemeComment[] = [];
    const trailing: XcschemeComment[] = [];

    this.skipWhitespace();
    while (this.peekIsCommentStart()) {
      leading.push(this.parseComment());
      this.skipWhitespace();
    }

    const root = this.parseElement();

    this.skipWhitespace();
    while (this.peekIsCommentStart()) {
      trailing.push(this.parseComment());
      this.skipWhitespace();
    }

    if (this.pos < this.input.length) {
      this.fail("Expected end of document after the root element");
    }
    return { leading, root, trailing };
  }

  /**
   * Skips the `<?xml ... ?>` declaration when present. Its attributes are
   * not retained, since the writer always emits the canonical UTF-8
   * declaration.
   */
  private skipDeclaration(): void {
    if (this.input.charCodeAt(this.pos) !== CODE_LESS_THAN || this.input.charCodeAt(this.pos + 1) !== CODE_QUESTION) {
      return;
    }
    const end = this.input.indexOf("?>", this.pos + 2);
    if (end === -1) {
      this.fail("Unterminated XML declaration");
    }
    this.pos = end + 2;
  }

  /**
   * Parses one element with the cursor on its opening `<`, including its
   * attributes and children, through to the matching close tag. Xcode
   * never writes self-closing tags, but other generators do, so both
   * forms are accepted.
   */
  private parseElement(): XcschemeElement {
    if (this.input.charCodeAt(this.pos) !== CODE_LESS_THAN) {
      this.fail("Expected an element");
    }
    this.pos++;
    const name = this.parseName("element name");

    // Null-prototype storage keeps attribute names off the Object
    // prototype: `toString` is not a false duplicate, and `__proto__`
    // stores as a plain own property instead of mutating the prototype.
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
    for (;;) {
      const hadWhitespace = this.skipWhitespace();
      const code = this.input.charCodeAt(this.pos);

      if (code === CODE_GREATER_THAN) {
        this.pos++;
        break;
      }
      if (code === CODE_SLASH && this.input.charCodeAt(this.pos + 1) === CODE_GREATER_THAN) {
        this.pos += 2;
        return { name, attributes, children: [] };
      }
      if (Number.isNaN(code)) {
        this.fail(`Unterminated <${name}> tag`);
      }
      if (!hadWhitespace) {
        this.fail("Expected whitespace before an attribute");
      }

      const attributeName = this.parseName("attribute name");
      this.skipWhitespace();
      if (this.input.charCodeAt(this.pos) !== CODE_EQUALS) {
        this.fail(`Expected = after attribute ${attributeName}`);
      }
      this.pos++;
      this.skipWhitespace();
      if (attributeName in attributes) {
        this.fail(`Duplicate attribute ${attributeName} on <${name}>`);
      }
      attributes[attributeName] = this.parseAttributeValue();
    }

    const children: XcschemeNode[] = [];
    for (;;) {
      this.skipWhitespace();
      const code = this.input.charCodeAt(this.pos);

      if (Number.isNaN(code)) {
        this.fail(`Missing </${name}> close tag`);
      }
      if (code !== CODE_LESS_THAN) {
        // Scheme elements never carry text content, and a writer would
        // have nowhere canonical to put it back.
        this.fail("Unexpected text content inside an element");
      }

      if (this.input.charCodeAt(this.pos + 1) === CODE_SLASH) {
        this.pos += 2;
        const closeName = this.parseName("close tag name");
        if (closeName !== name) {
          this.fail(`Expected </${name}> but found </${closeName}>`);
        }
        this.skipWhitespace();
        if (this.input.charCodeAt(this.pos) !== CODE_GREATER_THAN) {
          this.fail(`Malformed </${closeName}> close tag`);
        }
        this.pos++;
        return { name, attributes, children };
      }

      if (this.peekIsCommentStart()) {
        children.push(this.parseComment());
      } else {
        children.push(this.parseElement());
      }
    }
  }

  /**
   * Whether the cursor sits on a `<!--` comment opener.
   */
  private peekIsCommentStart(): boolean {
    return (
      this.input.charCodeAt(this.pos) === CODE_LESS_THAN &&
      this.input.charCodeAt(this.pos + 1) === CODE_BANG &&
      this.input.charCodeAt(this.pos + 2) === CODE_HYPHEN &&
      this.input.charCodeAt(this.pos + 3) === CODE_HYPHEN
    );
  }

  /**
   * Parses one comment with the cursor on its `<!--` opener. The text
   * between the markers is kept verbatim.
   */
  private parseComment(): XcschemeComment {
    const end = this.input.indexOf("-->", this.pos + 4);
    if (end === -1) {
      this.fail("Unterminated comment");
    }
    const comment = this.input.slice(this.pos + 4, end);
    this.pos = end + 3;
    return { comment };
  }

  /**
   * Parses an XML name at the cursor. The `what` label names the
   * expectation in the error when no name starts here.
   */
  private parseName(what: string): string {
    const start = this.pos;
    if (!isNameStart(this.input.charCodeAt(this.pos))) {
      this.fail(`Expected ${what}`);
    }
    this.pos++;
    while (isNameChar(this.input.charCodeAt(this.pos))) {
      this.pos++;
    }
    return this.input.slice(start, this.pos);
  }

  /**
   * Parses a quoted attribute value with the cursor on the opening quote,
   * resolving character and entity references along the way. Both quote
   * styles are accepted, and a raw `<` inside the value fails as XML
   * requires.
   */
  private parseAttributeValue(): string {
    const quote = this.input.charCodeAt(this.pos);
    if (quote !== CODE_QUOTE && quote !== CODE_APOSTROPHE) {
      this.fail("Expected a quoted attribute value");
    }
    this.pos++;

    let value = "";
    let runStart = this.pos;
    for (;;) {
      const code = this.input.charCodeAt(this.pos);
      if (Number.isNaN(code)) {
        this.fail("Unterminated attribute value");
      }
      if (code === quote) {
        value += this.input.slice(runStart, this.pos);
        this.pos++;
        return value;
      }
      if (code === CODE_LESS_THAN) {
        this.fail("Attribute values cannot contain a raw <");
      }
      if (code === CODE_AMPERSAND) {
        value += this.input.slice(runStart, this.pos);
        value += this.parseReference();
        runStart = this.pos;
      } else {
        this.pos++;
      }
    }
  }

  /**
   * Resolves one `&...;` reference with the cursor on the ampersand. The
   * accepted forms are the five XML named entities and decimal or hex
   * character references, which covers everything observed in
   * Xcode-written schemes (`&quot;`, `&amp;`, `&apos;`, `&lt;`, `&gt;`,
   * and `&#10;`-style whitespace).
   */
  private parseReference(): string {
    const start = this.pos;
    const end = this.input.indexOf(";", start + 1);
    if (end === -1 || end - start > 12) {
      this.fail("Unterminated character reference");
    }
    const body = this.input.slice(start + 1, end);
    this.pos = end + 1;

    if (body.charCodeAt(0) === CODE_HASH) {
      const isHex = body.charCodeAt(1) === 0x78 /* x */ || body.charCodeAt(1) === 0x58; /* X */
      const digits = body.slice(isHex ? 2 : 1);
      const radix = isHex ? 16 : 10;
      const codePoint = Number.parseInt(digits, radix);
      if (digits.length === 0 || Number.isNaN(codePoint) || codePoint > 0x10ffff) {
        this.failAt(`Invalid character reference &${body};`, start);
      }
      return String.fromCodePoint(codePoint);
    }

    // An own-key check keeps prototype members like `constructor` from
    // resolving as entities.
    const named = Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : undefined;
    if (named == null) {
      this.failAt(`Unknown entity &${body};`, start);
    }
    return named;
  }

  /**
   * Skips whitespace and reports whether any was consumed, which attribute
   * parsing uses to require separation between attributes.
   */
  private skipWhitespace(): boolean {
    const start = this.pos;
    while (isWhitespace(this.input.charCodeAt(this.pos))) {
      this.pos++;
    }
    return this.pos > start;
  }

  /**
   * Throws a parse error at the cursor.
   */
  private fail(message: string): never {
    this.failAt(message, this.pos);
  }

  /**
   * Throws a parse error at an explicit offset, which reference parsing
   * uses to point at the start of a bad reference rather than its end.
   */
  private failAt(message: string, offset: number): never {
    throw new XcschemeParseError(message, this.input, offset);
  }
}
