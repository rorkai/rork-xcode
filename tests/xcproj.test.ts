import { readFileSync } from "node:fs";

import {
  buildXcproj,
  parseXcproj,
  XcprojBuildError,
  XcprojParseError,
  type XcprojObject,
  type XcprojValue,
} from "../src/index";

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");
}

/**
 * Documents in the layout Xcode 27 writes, so a parse and build cycle must
 * reproduce them byte for byte.
 *
 * Six are the pbxproj fixtures saved by Xcode in its 27.0 project format.
 * The legacy-aggregate-cocoa one was saved with three changes to its
 * source project. Absolute paths are neutralized, a product name loses its
 * `/`, which this format cannot encode, and the target named
 * `C/C++ Library` gains a source file and a dependent, so the array
 * encoding of name paths appears in a real document. The three app-derived
 * documents are Xcode's saves after a target rename, a target removal, and
 * per-configuration settings edits, which the model tests reproduce. The
 * schema-coverage document exercises every record kind and key of the
 * format in Xcode's canonical layout, including sorted sets, every
 * version requirement, and escape-heavy strings.
 */
const FIXTURES = [
  "app.xcproj",
  "app-exceptions.xcproj",
  "app-exceptions-without-widget.xcproj",
  "app-renamed.xcproj",
  "app-settings-edited.xcproj",
  "framework-multiplatform.xcproj",
  "legacy-aggregate-cocoa.xcproj",
  "legacy-groups.xcproj",
  "schema-coverage.xcproj",
  "sync-groups.xcproj",
];

/**
 * Rebuilds a value with the keys of every dictionary in reverse order,
 * which is as far from Xcode's order as a document gets.
 */
function reverseKeys(value: XcprojValue): XcprojValue {
  if (Array.isArray(value)) {
    return value.map((item) => reverseKeys(item));
  }
  if (typeof value === "object" && value !== null) {
    const reversed: XcprojObject = {};
    for (const key of Object.keys(value).toReversed()) {
      reversed[key] = reverseKeys(value[key]!);
    }
    return reversed;
  }
  return value;
}

/**
 * Builds a minimal project document around the given entries.
 */
function project(entries: XcprojObject): XcprojObject {
  return { "default-configuration": "Release", configurations: ["Release"], files: [], ...entries };
}

/**
 * Builds a package product member that links one product into the given
 * build phase.
 */
function packageProductMember(phase: string): XcprojObject {
  return { package: "kit", "product-name": "Kit", "build-phase": { "build-phase": phase } };
}

describe.each(FIXTURES)("%s", (name) => {
  it("round-trips byte-exact", () => {
    const original = fixture(name);
    expect(buildXcproj(parseXcproj(original))).toBe(original);
  });

  it("reaches the same bytes from any key order and layout", () => {
    // Reversing every dictionary and flattening the text to plain JSON
    // leaves only values, so Xcode's key order, sorted dictionaries, and
    // single-line choices must all come from the builder.
    const original = fixture(name);
    const scrambled = JSON.stringify(reverseKeys(parseXcproj(original)));
    expect(buildXcproj(parseXcproj(scrambled))).toBe(original);
  });
});

describe("layout", () => {
  it("writes Xcode's single-line and multi-line containers", () => {
    const text = buildXcproj(
      project({
        files: [
          { path: "One.swift", "target-membership": ["App/compile-sources"] },
          { path: "Two.swift", "target-membership": ["App/compile-sources", "Tests/compile-sources"] },
          { kind: "group", name: "Empty" },
        ],
      }),
    );
    expect(text).toBe(
      [
        "{",
        '  "default-configuration": "Release",',
        '  "configurations": [',
        '    "Release",',
        "  ],",
        '  "files": [',
        '    { "path": "One.swift", "target-membership": [ "App/compile-sources" ] },',
        "    {",
        '      "path": "Two.swift",',
        '      "target-membership": [',
        '        "App/compile-sources",',
        '        "Tests/compile-sources",',
        "      ],",
        "    },",
        '    { "kind": "group", "name": "Empty" },',
        "  ],",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("joins adjacent multi-line containers in an array", () => {
    const text = buildXcproj(project({ targets: [{ name: "A", id: "1" }, { name: "B", id: "2" }, "C"] }));
    expect(text).toContain('  "targets": [\n    {\n      "name": "A",\n      "id": "1",\n    }, {\n');
    expect(text).toContain('      "id": "2",\n    },\n    "C",\n  ],');
  });

  it("writes empty containers the way Xcode does in each mode", () => {
    expect(buildXcproj(project({}))).toContain('  "files": [\n  ],');
    expect(buildXcproj({})).toBe("{\n}\n");
    expect(buildXcproj(project({ files: [{ path: "A", "target-membership": [] }] }))).toContain(
      '{ "path": "A", "target-membership": [] }',
    );
  });

  it("sorts dictionaries keyed by name and sets of names", () => {
    const text = buildXcproj(
      project({
        localizations: { supported: ["fr", "Base", "de"], development: "en" },
        files: [{ kind: "folder", path: "App", "target-membership": ["Widget", "App"] }],
        "build-settings": { ZETA: "1", ALPHA: "1", "ALPHA[config=Debug]": "2" },
      }),
    );
    expect(text).toContain('"supported": [\n      "Base",\n      "de",\n      "fr",\n    ],');
    expect(text).toContain('"target-membership": [ "App", "Widget" ]');
    expect(text).toContain('"ALPHA": "1",\n    "ALPHA[config=Debug]": "2",\n    "ZETA": "1",');
  });

  it("orders package product members like Xcode, with id phases before named ones", () => {
    const members = [packageProductMember("resources"), packageProductMember("id:P1")];
    const text = buildXcproj(project({ targets: [{ name: "App", id: "1", "package-product-members": members }] }));
    expect(text.indexOf('"build-phase": "id:P1"')).toBeLessThan(text.indexOf('"build-phase": "resources"'));
  });

  it("orders sorted keys like Xcode, by code point of the NFC form", () => {
    // A decomposed "á" sorts where the precomposed one does, after "b",
    // and text beyond the Basic Multilingual Plane sorts after U+FFFE.
    const settings = { "\u{1F600}": "", "\uFFFE": "", b: "", "a\u0301": "" };
    const text = buildXcproj(project({ "build-settings": settings }));
    const keys = [...text.matchAll(/^ {4}"(.*)": "",$/gmu)].map((match) => match[1]);
    expect(keys).toEqual(["b", "a\u0301", "\uFFFE", "\u{1F600}"]);
  });

  it("keeps unknown keys after the known ones, in document order", () => {
    const text = buildXcproj({ zebra: 1, "default-configuration": "Release", apple: 2, files: [] });
    expect(text).toBe(
      '{\n  "default-configuration": "Release",\n  "files": [\n  ],\n  "zebra": 1,\n  "apple": 2,\n}\n',
    );
  });

  it("serializes roots that are not projects", () => {
    expect(buildXcproj([1, { b: true, a: null }])).toBe('[\n  1,\n  {\n    "b": true,\n    "a": null,\n  },\n]\n');
    expect(buildXcproj("text")).toBe('"text"\n');
  });

  it("does not modify the document it builds", () => {
    const document = parseXcproj(JSON.stringify(reverseKeys(parseXcproj(fixture("schema-coverage.xcproj")))));
    const snapshot = JSON.stringify(document);
    buildXcproj(document);
    expect(JSON.stringify(document)).toBe(snapshot);
  });
});

describe("scalars", () => {
  it("escapes strings exactly as Xcode's encoder does", () => {
    const value = 'quote " backslash \\ slash / tab \t newline \n return \r bell \u0007 del \u007F';
    const rest = "nbsp \u00A0 separator \u2028 emoji \u{1F600} vertical \u000B formfeed \f backspace \b";
    expect(buildXcproj(value)).toBe(
      '"quote \\" backslash \\\\ slash / tab \\t newline \\n return \\r bell \\u0007 del \u007F"\n',
    );
    expect(buildXcproj(rest)).toBe(
      '"nbsp \u00A0 separator \u2028 emoji \u{1F600} vertical \\u000b formfeed \\f backspace \\b"\n',
    );
  });

  it("formats numbers as Xcode's encoder does", () => {
    const numbers = [0, -1, 42, 1.5, 0.0001, 0.00001, 1.25e-7, 2 ** 53, 2 ** 53 + 2, 1e21, -1e-5];
    expect(buildXcproj(numbers).split("\n").slice(1, -2)).toEqual([
      "  0,",
      "  -1,",
      "  42,",
      "  1.5,",
      "  0.0001,",
      "  1e-05,",
      "  1.25e-07,",
      "  9007199254740992,",
      "  9.007199254740994e+15,",
      "  1e+21,",
      "  -1e-05,",
    ]);
  });

  it("round-trips booleans and null", () => {
    const document = parseXcproj('{ "index": false, "decompress": true, "file": null }');
    expect(document).toEqual({ index: false, decompress: true, file: null });
    expect(buildXcproj(document)).toBe('{\n  "index": false,\n  "decompress": true,\n  "file": null,\n}\n');
  });
});

describe("JSON5 input", () => {
  it("accepts the syntax Xcode reads", () => {
    const text = [
      "\uFEFF// leading comment",
      "{",
      "  /* block */ unquoted: 'single \\' quoted',",
      "  $dollar_1: [1, 2,],",
      "  \u00E9t\u00E9: 0x1F,",
      "  \\u0061scii: +.5,",
      "  trailing: 5.,",
      "  'escapes': '\\x41\\u00e9\\v\\0\\/\\q',",
      '  "continued": "one \\',
      'two",',
      '  "separator": "a\u2028b",',
      "\u00A0\u2003}",
    ].join("\n");
    expect(parseXcproj(text)).toEqual({
      unquoted: "single ' quoted",
      $dollar_1: [1, 2],
      été: 31,
      ascii: 0.5,
      trailing: 5,
      escapes: "A\u00E9\u000B\u0000/q",
      continued: "one two",
      separator: "a\u2028b",
    });
  });

  it("reads Infinity and NaN, which the builder then refuses", () => {
    const document = parseXcproj("[Infinity, -Infinity, NaN, -0x10]") as number[];
    expect(document.slice(0, 2)).toEqual([Infinity, -Infinity]);
    expect(document[2]).toBeNaN();
    expect(document[3]).toBe(-16);
    expect(() => buildXcproj(document)).toThrow(XcprojBuildError);
  });

  it("stores a __proto__ key as an own property and lets later duplicates win", () => {
    const document = parseXcproj('{ "__proto__": { "polluted": true }, "a": 1, "a": 2 }') as XcprojObject;
    expect(Object.keys(document)).toEqual(["__proto__", "a"]);
    expect(document["a"]).toBe(2);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("decodes escaped surrogate pairs", () => {
    expect(parseXcproj('"\\uD83D\\uDE00"')).toBe("\u{1F600}");
  });
});

describe("failure modes", () => {
  it("reports malformed documents with a position", () => {
    try {
      parseXcproj('{\n  "a": 1\n  "b": 2\n}');
      assert.fail("expected a parse error");
    } catch (error) {
      assert(error instanceof XcprojParseError);
      expect(error.message).toBe("Expected ',' or '}' after an object member but found '\"' (line 3, column 3)");
      expect(error.position).toEqual({ offset: 13, line: 3, column: 3 });
    }
  });

  it.each([
    ["", "Empty input"],
    ["{", "Unterminated object"],
    ['{ "a": 1,', "Unterminated object"],
    ["[1, 2", "Unterminated array"],
    ['"open', "Unterminated string"],
    ['"line\nbreak"', "Unescaped line break in a string"],
    ["/* open", "Unterminated block comment"],
    ["{ a 1 }", "Expected ':' after an object key"],
    ["[1,,2]", "Expected a value but found ','"],
    ["{ 1a: 2 }", "Expected a key but found '1'"],
    ["01", "Numbers cannot have leading zeros"],
    ["1e", "Invalid number exponent"],
    ["0x", "Invalid hexadecimal number"],
    ['"\\1"', "Invalid escape sequence in a string"],
    ['"\\x4"', "Invalid hexadecimal escape"],
    ['"\\uD800"', "Unpaired surrogate escape in a string"],
    ['"\\uDC00"', "Unpaired surrogate escape in a string"],
    ["{} {}", "Unexpected '{' after the document value"],
    ["tru", "Expected a value but found 't'"],
    ["/ 1", "Expected a value but found '/'"],
  ])("rejects %j", (text, message) => {
    expect(() => parseXcproj(text)).toThrow(XcprojParseError);
    expect(() => parseXcproj(text)).toThrow(message);
  });

  it.each([
    ["undefined", { targets: [{ name: undefined }] }, "$.targets[0].name"],
    ["a function", { files: [() => 1] }, "$.files[0]"],
    ["a bigint", { "build-settings": { "KEY[config=Debug]": 1n } }, '$.build-settings["KEY[config=Debug]"]'],
    ["a class instance", { files: [new Date(0)] }, "$.files[0]"],
    ["a non-finite number", { index: Number.NaN }, "$.index"],
    ["an unpaired surrogate", { name: "a\uD800b" }, "$.name"],
    ["U+0000, which Xcode cannot read", { name: "a\u0000b" }, "$.name"],
  ])("rejects %s with its path", (_, document, path) => {
    try {
      buildXcproj(document as unknown as XcprojValue);
      assert.fail("expected a build error");
    } catch (error) {
      assert(error instanceof XcprojBuildError);
      expect(error.path).toBe(path);
    }
  });

  it("reports sorted set members at their position in the document", () => {
    const document = project({ localizations: { development: "en", supported: ["zz", "a\uD800"] } });
    expect(() => buildXcproj(document)).toThrow("(at $.localizations.supported[1])");
  });

  it("rejects keys Xcode cannot read", () => {
    expect(() => buildXcproj({ "a\u0000": 1 })).toThrow(XcprojBuildError);
  });
});
