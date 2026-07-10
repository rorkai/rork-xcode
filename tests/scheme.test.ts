import { readFileSync } from "node:fs";

import { XcschemeBuildError, XcschemeParseError } from "../src/errors";
import { buildXcscheme } from "../src/scheme/build";
import { createXcscheme, Xcscheme, xcschemeElements } from "../src/scheme/model";
import { parseXcscheme } from "../src/scheme/parse";

import type { XcschemeElement } from "../src/scheme/types";

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");
}

// Each fixture mirrors an Xcode-written scheme shape. One is a current
// app scheme with tests, one is heavy on pre/post actions and references,
// and one carries remote runnables, entities in scripts, and a reference
// without a blueprint identifier.
const FIXTURES = ["scheme-app.xcscheme", "scheme-actions.xcscheme", "scheme-remote.xcscheme"];

describe("round-trip", () => {
  it.each(FIXTURES)("rebuilds %s byte-identically", (name) => {
    const text = fixture(name);
    expect(buildXcscheme(parseXcscheme(text))).toBe(text);
  });

  it("canonicalizes foreign formatting to a fixed point", () => {
    // Two-space indentation, inline attributes, self-closing tags, single
    // quotes, and an attribute-order quirk, like other generators emit.
    const foreign = [
      `<?xml version='1.0' encoding='UTF-8'?>`,
      `<Scheme version = '1.3' LastUpgradeVersion = '9999'>`,
      `  <BuildAction parallelizeBuildables = "YES">`,
      `    <BuildActionEntries>`,
      `      <BuildActionEntry buildForRunning = "NO" buildForTesting = "YES">`,
      `        <BuildableReference BuildableIdentifier = "primary" BlueprintName = "Kit"`,
      `          ReferencedContainer = "container:Kit.xcodeproj"/>`,
      `      </BuildActionEntry>`,
      `    </BuildActionEntries>`,
      `  </BuildAction>`,
      `</Scheme>`,
    ].join("\n");

    const once = buildXcscheme(parseXcscheme(foreign));
    expect(buildXcscheme(parseXcscheme(once))).toBe(once);
    expect(once).toContain('<Scheme\n   version = "1.3"\n   LastUpgradeVersion = "9999">');
    expect(once).toContain('buildForRunning = "NO"');
  });

  it("resolves and re-emits the escapes Xcode writes in script text", () => {
    const document = parseXcscheme(fixture("scheme-remote.xcscheme"));
    const [action] = xcschemeElements(document.root, "ActionContent");
    assert(action);

    const script = action.attributes["scriptText"];
    expect(script).toContain('exec > "/tmp/build.log" 2>&1\n');
    expect(script).toContain("grep '^commit'");
    expect(script).toContain('echo "version <$VERSION>"');

    expect(buildXcscheme(document)).toBe(fixture("scheme-remote.xcscheme"));
  });

  it("preserves comments", () => {
    const text = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!-- managed by tooling -->`,
      `<Scheme version = "1.3">`,
      `  <!-- keep -->`,
      `  <BuildAction>`,
      `  </BuildAction>`,
      `</Scheme>`,
    ].join("\n");

    const document = parseXcscheme(text);
    expect(document.leading).toEqual([{ comment: " managed by tooling " }]);

    const built = buildXcscheme(document);
    expect(built).toContain("<!-- managed by tooling -->");
    expect(built).toContain("   <!-- keep -->");
    expect(buildXcscheme(parseXcscheme(built))).toBe(built);
  });
});

describe("parse failures", () => {
  it.each([
    ["text content", "<Scheme>hello</Scheme>"],
    ["mismatched close tag", "<Scheme><BuildAction></Scheme></Scheme>"],
    ["missing close tag", "<Scheme>"],
    ["unquoted attribute", "<Scheme version = 1.3></Scheme>"],
    ["duplicate attribute", '<Scheme version = "1" version = "2"></Scheme>'],
    ["unknown entity", '<Scheme version = "&version;"></Scheme>'],
    ["unterminated comment", "<Scheme><!-- </Scheme>"],
    ["content after the root", "<Scheme></Scheme><Scheme></Scheme>"],
  ])("rejects %s with a position", (_case, text) => {
    expect(() => parseXcscheme(text)).toThrow(XcschemeParseError);
    try {
      parseXcscheme(text);
    } catch (error) {
      assert(error instanceof XcschemeParseError);
      expect(error.message).toMatch(/line \d+, column \d+/u);
    }
  });

  it("reads character references and a leading byte order mark", () => {
    const document = parseXcscheme('\uFEFF<Scheme note = "a&#10;b&#x41;"></Scheme>');
    expect(document.root.attributes["note"]).toBe("a\nbA");
  });

  it("does not resolve entities or attributes through the Object prototype", () => {
    // `constructor` exists on Object.prototype. As an entity it must still
    // be unknown, and as an attribute name it must not read as duplicate.
    expect(() => parseXcscheme('<Scheme a = "&constructor;"></Scheme>')).toThrow(/Unknown entity/u);

    const document = parseXcscheme('<Scheme toString = "a" __proto__ = "b"></Scheme>');
    expect(document.root.attributes["toString"]).toBe("a");
    expect(document.root.attributes["__proto__"]).toBe("b");
    expect(Object.getPrototypeOf(document.root.attributes)).toBeNull();
    expect(buildXcscheme(document)).toContain('toString = "a"');
  });
});

describe("build failures", () => {
  it("rejects names that are not XML names", () => {
    const root: XcschemeElement = { name: "Bad Name", attributes: {}, children: [] };
    expect(() => buildXcscheme({ leading: [], root, trailing: [] })).toThrow(XcschemeBuildError);
  });

  it("rejects unencodable control characters with the element path", () => {
    const root: XcschemeElement = {
      name: "Scheme",
      attributes: {},
      children: [{ name: "BuildAction", attributes: { title: "a\u0000b" }, children: [] }],
    };
    try {
      buildXcscheme({ leading: [], root, trailing: [] });
      assert.fail("expected a build error");
    } catch (error) {
      assert(error instanceof XcschemeBuildError);
      expect(error.path).toBe("Scheme.BuildAction[0]");
      expect(error.message).toContain("U+0000");
    }
  });
});

describe("editing", () => {
  it("renames buildable references through the typed model", () => {
    const scheme = Xcscheme.parse(fixture("scheme-app.xcscheme"));

    const references = scheme.buildableReferences();
    expect(references.map((reference) => reference.blueprintName)).toEqual([
      "DemoApp",
      "DemoAppTests",
      "DemoApp",
      "DemoApp",
    ]);

    for (const reference of references) {
      reference.blueprintName = reference.blueprintName!.replace("DemoApp", "NewApp");
      reference.buildableName = reference.buildableName!.replace("DemoApp", "NewApp");
      reference.referencedContainer = "container:NewApp.xcodeproj";
    }

    const built = scheme.build();
    expect(built).not.toContain("DemoApp");
    expect(built).toContain('BlueprintName = "NewApp"');
    expect(built).toContain('BuildableName = "NewAppTests.xctest"');
    // Reads reflect writes immediately, since views sit on the tree.
    expect(scheme.buildableReferences()[0]?.blueprintIdentifier).toBe("A10000000000000000000001");
  });

  it("creates the default app scheme through the model", () => {
    const scheme = Xcscheme.create({ appName: "DemoApp", blueprintIdentifier: "A10000000000000000000001" });

    expect(scheme.root.name).toBe("Scheme");
    expect(scheme.elements("BuildAction")).toHaveLength(1);
    const [reference] = scheme.buildableReferences();
    assert(reference);
    expect(reference.blueprintIdentifier).toBe("A10000000000000000000001");
    expect(reference.referencedContainer).toBe("container:DemoApp.xcodeproj");
    expect(buildXcscheme(parseXcscheme(scheme.build()))).toBe(scheme.build());
  });

  it("renames buildable references through the element query", () => {
    const document = parseXcscheme(fixture("scheme-app.xcscheme"));

    for (const reference of xcschemeElements(document.root, "BuildableReference")) {
      const attributes = reference.attributes;
      attributes["BlueprintName"] = attributes["BlueprintName"]!.replace("DemoApp", "NewApp");
      attributes["BuildableName"] = attributes["BuildableName"]!.replace("DemoApp", "NewApp");
      attributes["ReferencedContainer"] = "container:NewApp.xcodeproj";
    }

    const built = buildXcscheme(document);
    expect(built).not.toContain("DemoApp");
    expect(built).toContain('BlueprintName = "NewApp"');
    expect(built).toContain('BuildableName = "NewAppTests.xctest"');
    // Attribute order and layout are untouched by attribute writes.
    expect(built).toContain('   LastUpgradeVersion = "1600"\n   version = "1.7">');
  });

  it("creates the default app scheme Xcode writes", () => {
    const document = createXcscheme({ appName: "DemoApp", blueprintIdentifier: "A10000000000000000000001" });
    const built = buildXcscheme(document);

    expect(built).toContain('<Scheme\n   version = "1.7">');
    for (const action of ["BuildAction", "LaunchAction", "ProfileAction", "AnalyzeAction", "ArchiveAction"]) {
      expect(built).toContain(`<${action}`);
    }
    expect(built).toContain('ReferencedContainer = "container:DemoApp.xcodeproj"');

    // The output is already canonical, and every reference is independent:
    // editing the launch action's reference leaves the build entry alone.
    expect(buildXcscheme(parseXcscheme(built))).toBe(built);
    const [buildRef, launchRef] = xcschemeElements(document.root, "BuildableReference");
    assert(buildRef && launchRef);
    launchRef.attributes["BlueprintName"] = "Other";
    expect(buildRef.attributes["BlueprintName"]).toBe("DemoApp");
  });
});

describe("target rename", () => {
  it("renames one target's references and leaves siblings alone", () => {
    const scheme = Xcscheme.parse(fixture("scheme-app.xcscheme"));

    expect(scheme.renameTarget("DemoApp", "Rocket")).toBe(true);

    const built = scheme.build();
    expect(built).toContain('BlueprintName = "Rocket"');
    expect(built).toContain('BuildableName = "Rocket.app"');
    expect(built).not.toContain('BlueprintName = "DemoApp"');
    // The test bundle is a different target, so its stem must not rename.
    expect(built).toContain('BlueprintName = "DemoAppTests"');
    expect(built).toContain('BuildableName = "DemoAppTests.xctest"');
    // Containers name the .xcodeproj directory, not the target.
    expect(built).toContain('ReferencedContainer = "container:DemoApp.xcodeproj"');
  });

  it("reports when no reference matched", () => {
    const scheme = Xcscheme.parse(fixture("scheme-app.xcscheme"));
    const before = scheme.build();

    expect(scheme.renameTarget("Absent", "Rocket")).toBe(false);
    expect(scheme.build()).toBe(before);
  });

  it("rewrites containers after the project directory renames", () => {
    const scheme = Xcscheme.parse(fixture("scheme-app.xcscheme"));

    expect(scheme.renameContainer("DemoApp", "Rocket")).toBe(true);
    expect(scheme.renameContainer("DemoApp", "Rocket")).toBe(false);

    const built = scheme.build();
    expect(built).toContain('ReferencedContainer = "container:Rocket.xcodeproj"');
    expect(built).not.toContain("container:DemoApp.xcodeproj");
    // Target names stay, because renaming the container is a separate move.
    expect(built).toContain('BlueprintName = "DemoApp"');
  });
});
