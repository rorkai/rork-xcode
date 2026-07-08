import { readFileSync } from "node:fs";

import { buildXcconfig, parseXcconfig, Xcconfig, XcconfigParseError } from "../src/index";

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");
}

/**
 * The committed fixtures mirror the file shapes found in real projects:
 * a hand-maintained base with aligned columns and per-platform
 * conditions, a tool-generated file without spacing around the equals
 * signs, and an include chain with an optional local override.
 */
const FIXTURES = [
  "config-app-base.xcconfig",
  "config-generated.xcconfig",
  "config-includes.xcconfig",
  "config-shared.xcconfig",
];

/**
 * A hand-authored file exercising every statement kind and the format's
 * quirks: comments standalone and trailing, conditions, both include
 * forms, a trailing semicolon, setting references, and a value whose
 * `//` starts a comment mid-URL the way Xcode reads it.
 */
const SAMPLE = `// Base configuration for the app target.

#include "shared/common.xcconfig"
#include? "local-overrides.xcconfig"

PRODUCT_BUNDLE_IDENTIFIER = com.example.app
MARKETING_VERSION = 1.2.0;
SDKROOT = iphoneos
IPHONEOS_DEPLOYMENT_TARGET = 17.0
OTHER_LDFLAGS = $(inherited) -ObjC // linker flags
LDFLAGS_EXTRA[sdk=iphoneos*][arch=arm64] = -lfoo
API_BASE = https://api.example.com
`;

describe("parseXcconfig and buildXcconfig", () => {
  it("round-trips a hand-authored file byte for byte", () => {
    expect(buildXcconfig(parseXcconfig(SAMPLE))).toBe(SAMPLE);
  });

  it("round-trips CRLF line endings and a missing final newline", () => {
    const crlf = "A = 1\r\n// note\r\nB = 2";
    expect(buildXcconfig(parseXcconfig(crlf))).toBe(crlf);
  });

  it("round-trips an empty file", () => {
    expect(buildXcconfig(parseXcconfig(""))).toBe("");
  });

  it("parses statement kinds, conditions, and cleaned values", () => {
    const document = parseXcconfig(SAMPLE);
    const kinds = document.statements.map((statement) => statement.kind);
    expect(kinds).toEqual([
      "comment",
      "blank",
      "include",
      "include",
      "blank",
      "assignment",
      "assignment",
      "assignment",
      "assignment",
      "assignment",
      "assignment",
      "assignment",
    ]);

    const config = Xcconfig.parse(SAMPLE);
    // The trailing semicolon and the trailing comment are not part of
    // the values, and the URL stops where its double slash starts a
    // comment, matching Xcode's reading.
    expect(config.get("MARKETING_VERSION")).toBe("1.2.0");
    expect(config.get("OTHER_LDFLAGS")).toBe("$(inherited) -ObjC");
    expect(config.get("API_BASE")).toBe("https:");

    const conditional = config.assignments().find((assignment) => assignment.key === "LDFLAGS_EXTRA");
    expect(conditional?.conditions).toEqual([
      { name: "sdk", value: "iphoneos*" },
      { name: "arch", value: "arm64" },
    ]);
    expect(config.get("LDFLAGS_EXTRA")).toBeUndefined();

    expect(config.includes().map((include) => [include.path, include.optional])).toEqual([
      ["shared/common.xcconfig", false],
      ["local-overrides.xcconfig", true],
    ]);
  });

  it("reports malformed lines with their position", () => {
    expect(() => parseXcconfig("GOOD = 1\nwhat is this line\n")).toThrow(XcconfigParseError);
    try {
      parseXcconfig("GOOD = 1\nwhat is this line\n");
      assert.fail("expected a parse error");
    } catch (error) {
      assert(error instanceof XcconfigParseError);
      expect(error.position.line).toBe(2);
      expect(error.position.column).toBe(1);
    }
  });

  it("reports malformed include directives and conditions", () => {
    expect(() => parseXcconfig("#include no-quotes.xcconfig\n")).toThrow(XcconfigParseError);
    expect(() => parseXcconfig("KEY[sdk] = value\n")).toThrow(XcconfigParseError);
  });
});

describe("xcconfig fixtures", () => {
  it.each(FIXTURES)("%s round-trips byte for byte", (name) => {
    const text = fixture(name);
    expect(buildXcconfig(parseXcconfig(text))).toBe(text);
  });

  it("parses the aligned hand-maintained base with its conditions", () => {
    const config = Xcconfig.parse(fixture("config-app-base.xcconfig"));

    expect(config.get("SWIFT_VERSION")).toBe("6.0");
    expect(config.get("MARKETING_VERSION")).toBe("2.4.1");
    expect(config.get("GCC_PREPROCESSOR_DEFINITIONS")).toBe("$(inherited) API_BASE=1");

    const doubleCondition = config.assignments().find((assignment) => assignment.key === "OTHER_SWIFT_FLAGS");
    expect(doubleCondition?.conditions).toEqual([
      { name: "config", value: "Debug" },
      { name: "arch", value: "arm64" },
    ]);
  });

  it("parses the generated file written without spacing", () => {
    const config = Xcconfig.parse(fixture("config-generated.xcconfig"));

    expect(config.get("TOOL_ROOT")).toBe("/Users/dev/.toolchain");
    expect(config.get("OTHER_LDFLAGS")).toBe(
      '$(inherited) -ObjC -l"c++" -l"sqlite3" -framework "Accelerate" -framework "CoreGraphics"',
    );
    expect(config.get("EXCLUDED_ARCHS")).toBeUndefined();
  });

  it("flattens the include chain across fixture files", () => {
    const config = Xcconfig.parse(fixture("config-includes.xcconfig"));
    const settings = config.settings({
      resolveInclude: (path, optional) => {
        if (path === "config-shared.xcconfig") {
          return Xcconfig.parse(fixture(path));
        }
        // The optional local-overrides file does not exist, matching the
        // #include? contract.
        expect(optional).toBe(true);
        return undefined;
      },
    });

    expect(settings["PRODUCT_BUNDLE_IDENTIFIER"]).toBe("com.example.sample.debug");
    expect(settings["SDKROOT"]).toBe("iphoneos");
    expect(settings["ONLY_ACTIVE_ARCH"]).toBe("YES");
    expect(settings["CURRENT_PROJECT_VERSION"]).toBe("42");
  });
});

describe("Xcconfig", () => {
  it("reads the last unconditional assignment of a repeated key", () => {
    const config = Xcconfig.parse("A = first\nA = second\n");
    expect(config.get("A")).toBe("second");
    expect(config.keys()).toEqual(["A"]);
  });

  it("rewrites the last assignment in place and appends new keys", () => {
    const config = Xcconfig.parse("// keep me\nA = old // trailing note\nB = kept\n");
    config.set("A", "new");
    config.set("C", "added");

    expect(config.build()).toBe("// keep me\nA = new\nB = kept\nC = added\n");
    expect(config.get("A")).toBe("new");
    expect(config.get("C")).toBe("added");
  });

  it("appends onto a file without a trailing newline", () => {
    const config = Xcconfig.parse("A = 1");
    config.set("B", "2");
    expect(config.build()).toBe("A = 1\nB = 2\n");
  });

  it("removes every unconditional assignment of a key", () => {
    const config = Xcconfig.parse("A = 1\nA = 2\nA[sdk=iphoneos*] = 3\nB = 4\n");
    expect(config.remove("A")).toBe(true);
    expect(config.remove("A")).toBe(false);
    expect(config.build()).toBe("A[sdk=iphoneos*] = 3\nB = 4\n");
  });

  it("flattens settings with includes at their position", () => {
    const shared = Xcconfig.parse("SDKROOT = iphoneos\nMARKETING_VERSION = 1.0.0\n");
    const config = Xcconfig.parse(
      'MARKETING_VERSION = 0.9.0\n#include "shared.xcconfig"\nPRODUCT_NAME = App\nSDKROOT = appletvos\n',
    );

    const settings = config.settings({
      resolveInclude: (path) => (path === "shared.xcconfig" ? shared : undefined),
    });

    // The include overrides lines above it and is overridden by lines
    // below it, exactly like textual inclusion.
    expect(settings).toEqual({
      MARKETING_VERSION: "1.0.0",
      PRODUCT_NAME: "App",
      SDKROOT: "appletvos",
    });
  });

  it("ignores unresolved includes and survives include cycles", () => {
    const first = Xcconfig.parse('#include "second.xcconfig"\nA = from-first\n');
    const second = Xcconfig.parse('#include "first.xcconfig"\nB = from-second\n');
    const byPath: Record<string, Xcconfig> = { "first.xcconfig": first, "second.xcconfig": second };

    const settings = first.settings({ resolveInclude: (path) => byPath[path] });
    expect(settings).toEqual({ A: "from-first", B: "from-second" });

    expect(first.settings()).toEqual({ A: "from-first" });
  });
});
