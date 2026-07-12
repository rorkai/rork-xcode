/**
 * Parser for Xcode's XML dialect, shared by scheme and workspace files.
 *
 * The dialect is XML with a narrow shape. Elements carry attributes and
 * child elements, and there is no text content, no namespace, and no
 * DOCTYPE. The parser accepts that shape from any writer, since
 * attribute order, quoting style, and whitespace vary across tools.
 * Character and entity references in attribute values resolve to their
 * characters, and comments are preserved. Anything outside the shape
 * fails loudly with a position, in line with the pbxproj parser.
 *
 * Each file format wraps this core with its own error type, so a caller
 * always sees the error class of the format it asked for.
 *
 * @module
 */

import type { XmlComment, XmlDocument, XmlElement, XmlNode } from "./types";

/**
 * Constructs the format's parse error. The core reports failures through
 * this factory, so scheme parsing throws scheme errors and workspace
 * parsing throws workspace errors from the same code.
 */
export type XmlParseErrorFactory = (message: string, source: string, offset: number) => Error;

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
 * Whether a code unit can start an XML name. The dialect's vocabulary is
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
 * Whether a code point is a character XML 1.0 allows in a document.
 * The excluded ranges are the control characters other than tab, line
 * feed, and carriage return, the surrogate halves, and the two
 * noncharacters at the end of the basic plane.
 */
export function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === CODE_TAB ||
    codePoint === CODE_LINE_FEED ||
    codePoint === CODE_CARRIAGE_RETURN ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/**
 * Parses the text of a document in the dialect into its node tree,
 * reporting failures through the given error factory.
 */
export function parseXmlDocument(text: string, makeError: XmlParseErrorFactory): XmlDocument {
  return new Parser(text, makeError).parseDocument();
}

/**
 * Single-pass recursive-descent parser over the source text. One instance
 * parses one document and is discarded.
 */
class Parser {
  /** The full source text of the file. */
  private readonly input: string;

  /** Constructs the format's parse error for a failure. */
  private readonly makeError: XmlParseErrorFactory;

  /** Cursor into {@link input}, in UTF-16 code units. */
  private pos = 0;

  constructor(input: string, makeError: XmlParseErrorFactory) {
    this.input = input;
    this.makeError = makeError;
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
  parseDocument(): XmlDocument {
    this.skipWhitespace();
    this.skipDeclaration();

    const leading: XmlComment[] = [];
    const trailing: XmlComment[] = [];

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
   * declaration. Other processing instructions fail, because the dialect
   * has no place to keep them and dropping one silently would make the
   * round-trip lossy.
   */
  private skipDeclaration(): void {
    if (this.input.charCodeAt(this.pos) !== CODE_LESS_THAN || this.input.charCodeAt(this.pos + 1) !== CODE_QUESTION) {
      return;
    }
    const after = this.input.charCodeAt(this.pos + 5);
    if (this.input.slice(this.pos + 2, this.pos + 5) !== "xml" || (!isWhitespace(after) && after !== CODE_QUESTION)) {
      this.fail("Unsupported processing instruction");
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
  private parseElement(): XmlElement {
    if (this.input.charCodeAt(this.pos) !== CODE_LESS_THAN) {
      this.fail("Expected an element");
    }
    this.pos++;
    const name = this.parseName("element name");

    // Null-prototype storage keeps attribute names off the Object
    // prototype, so `toString` is not a false duplicate and `__proto__`
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

    const children: XmlNode[] = [];
    for (;;) {
      this.skipWhitespace();
      const code = this.input.charCodeAt(this.pos);

      if (Number.isNaN(code)) {
        this.fail(`Missing </${name}> close tag`);
      }
      if (code !== CODE_LESS_THAN) {
        // Elements of the dialect never carry text content, and a writer
        // would have nowhere canonical to put it back.
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
   * between the markers is kept verbatim. A `--` inside the text or a
   * `-` against the closing marker fails the way XML requires, which
   * also keeps every accepted comment rebuildable, since such text would
   * reparse at a different terminator.
   */
  private parseComment(): XmlComment {
    const end = this.input.indexOf("-->", this.pos + 4);
    if (end === -1) {
      this.fail("Unterminated comment");
    }
    const comment = this.input.slice(this.pos + 4, end);
    if (comment.includes("--") || comment.endsWith("-")) {
      this.fail("Comments cannot contain -- or end with -");
    }
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
        continue;
      }
      // Raw characters outside XML's character set fail here, so every
      // value the parser accepts is one the serializer can reproduce.
      if (code < 0x20 && !isWhitespace(code)) {
        this.fail("Attribute values cannot contain a raw control character");
      }
      if (code >= 0xd800) {
        this.validateUpperCharacter(code);
        this.pos += code <= 0xdbff ? 2 : 1;
        continue;
      }
      this.pos++;
    }
  }

  /**
   * Validates a code unit in the surrogate or upper basic-plane range at
   * the cursor. A high surrogate must pair with a low one, a bare low
   * surrogate is not a character, and the two noncharacters at the end
   * of the plane have no XML representation.
   */
  private validateUpperCharacter(code: number): void {
    if (code <= 0xdbff) {
      const next = this.input.charCodeAt(this.pos + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        this.fail("Attribute values cannot contain an unpaired surrogate");
      }
      return;
    }
    if (code <= 0xdfff) {
      this.fail("Attribute values cannot contain an unpaired surrogate");
    }
    if (code === 0xfffe || code === 0xffff) {
      this.fail("Attribute values cannot contain a noncharacter");
    }
  }

  /**
   * Resolves one `&...;` reference with the cursor on the ampersand. The
   * accepted forms are the five XML named entities and decimal or hex
   * character references, which covers everything observed in
   * Xcode-written files (`&quot;`, `&amp;`, `&apos;`, `&lt;`, `&gt;`,
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
      // The whole digit run must parse. Number.parseInt would accept a
      // valid prefix and silently decode &#65junk; as A.
      if (!(isHex ? /^[0-9A-Fa-f]+$/u : /^[0-9]+$/u).test(digits)) {
        this.failAt(`Invalid character reference &${body};`, start);
      }
      const radix = isHex ? 16 : 10;
      const codePoint = Number.parseInt(digits, radix);
      if (!isXmlChar(codePoint)) {
        this.failAt(`Character reference &${body}; is not an XML character`, start);
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
    throw this.makeError(message, this.input, offset);
  }
}
