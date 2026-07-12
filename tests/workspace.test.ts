import { readFileSync } from "node:fs";

import { XcworkspaceBuildError, XcworkspaceParseError } from "../src/errors";
import { buildXcworkspace } from "../src/workspace/build";
import { parseWorkspaceLocation, WorkspaceFileRef, Xcworkspace } from "../src/workspace/model";
import { parseXcworkspace } from "../src/workspace/parse";

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");
}

/**
 * Wraps a value into a minimal workspace document's attribute, so
 * reference and character validation tests stay on one line each.
 */
function attributeDocument(value: string): string {
  return `<Workspace v = "${value}">\n</Workspace>`;
}

// One fixture is the flat CocoaPods-style shape, and one exercises
// nested groups, every location kind, and a non-project reference.
const FIXTURES = ["workspace-app.xcworkspacedata", "workspace-groups.xcworkspacedata"];

describe("round-trip", () => {
  it.each(FIXTURES)("rebuilds %s byte-identically", (name) => {
    const text = fixture(name);
    expect(buildXcworkspace(parseXcworkspace(text))).toBe(text);
  });

  it("canonicalizes foreign formatting to a fixed point", () => {
    const foreign = [
      `<?xml version='1.0' encoding='UTF-8'?>`,
      `<Workspace version = '1.0'>`,
      `  <FileRef location = "group:App.xcodeproj"/>`,
      `</Workspace>`,
    ].join("\n");

    const canonical = buildXcworkspace(parseXcworkspace(foreign));
    expect(canonical).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(canonical).toContain('   <FileRef\n      location = "group:App.xcodeproj">\n   </FileRef>');
    expect(buildXcworkspace(parseXcworkspace(canonical))).toBe(canonical);
  });
});

describe("failure modes", () => {
  it("fails parsing with the workspace error type and a position", () => {
    expect(() => parseXcworkspace("<Workspace><FileRef></Workspace>")).toThrow(XcworkspaceParseError);
    try {
      parseXcworkspace("not xml at all");
      assert.fail("expected a parse error");
    } catch (error) {
      assert(error instanceof XcworkspaceParseError);
      expect(error.position.line).toBe(1);
    }
  });

  it("fails building invalid names with the workspace error type", () => {
    const workspace = Xcworkspace.create();
    workspace.root.children.push({ name: "bad name", attributes: {}, children: [] });
    expect(() => workspace.build()).toThrow(XcworkspaceBuildError);
  });

  it("rejects processing instructions other than the XML declaration", () => {
    expect(() => parseXcworkspace('<?custom?>\n<Workspace version = "1.0">\n</Workspace>')).toThrow(
      "Unsupported processing instruction",
    );
    expect(() => parseXcworkspace('<?xml-stylesheet href="a.css"?>\n<Workspace>\n</Workspace>')).toThrow(
      "Unsupported processing instruction",
    );
  });

  it("rejects malformed and forbidden character references", () => {
    expect(() => parseXcworkspace(attributeDocument("&#65junk;"))).toThrow("Invalid character reference");
    expect(() => parseXcworkspace(attributeDocument("&#0;"))).toThrow("not an XML character");
    expect(() => parseXcworkspace(attributeDocument("&#xD800;"))).toThrow("not an XML character");
    expect(() => parseXcworkspace(attributeDocument("&#xFFFF;"))).toThrow("not an XML character");
    expect(parseXcworkspace(attributeDocument("&#65;")).root.attributes["v"]).toBe("A");
  });

  it("rejects raw characters XML cannot carry in attribute values", () => {
    expect(() => parseXcworkspace('<Workspace v = "a\u0001b">\n</Workspace>')).toThrow("raw control character");
    expect(() => parseXcworkspace('<Workspace v = "a\uFFFFb">\n</Workspace>')).toThrow("noncharacter");
    expect(() => parseXcworkspace('<Workspace v = "a\uD800b">\n</Workspace>')).toThrow("unpaired surrogate");
    expect(parseXcworkspace('<Workspace v = "a\u{1F600}b">\n</Workspace>').root.attributes["v"]).toBe("a\u{1F600}b");
  });

  it("rejects comment text the comment grammar cannot hold", () => {
    expect(() => parseXcworkspace("<!-- a -- b -->\n<Workspace>\n</Workspace>")).toThrow(
      "Comments cannot contain -- or end with -",
    );

    const workspace = Xcworkspace.create();
    workspace.document.leading.push({ comment: " trailing dash -" });
    expect(() => workspace.build()).toThrow(XcworkspaceBuildError);
  });

  it("rejects building attribute values XML cannot carry", () => {
    const workspace = Xcworkspace.create();
    workspace.root.attributes["v"] = "a\uFFFEb";
    expect(() => workspace.build()).toThrow("code point XML cannot carry");
  });
});

describe("locations", () => {
  it("splits kind and path at the first colon", () => {
    expect(parseWorkspaceLocation("group:Pods/Pods.xcodeproj")).toEqual({ kind: "group", path: "Pods/Pods.xcodeproj" });
    expect(parseWorkspaceLocation("absolute:/opt/x:y")).toEqual({ kind: "absolute", path: "/opt/x:y" });
    expect(parseWorkspaceLocation("self:")).toEqual({ kind: "self", path: "" });
  });

  it("treats a bare path as group-relative", () => {
    expect(parseWorkspaceLocation("App.xcodeproj")).toEqual({ kind: "group", path: "App.xcodeproj" });
  });
});

describe("model", () => {
  it("lists file references anywhere in the document", () => {
    const workspace = Xcworkspace.parse(fixture("workspace-groups.xcworkspacedata"));

    expect(workspace.fileRefs().map((reference) => reference.location)).toEqual([
      "self:",
      "group:Core/Core.xcodeproj",
      "group:Deep.xcodeproj",
      "container:Anchored/Anchored.xcodeproj",
      "absolute:/opt/shared/Shared.xcodeproj",
      "group:Docs/README.md",
    ]);
  });

  it("resolves referenced project paths through nested groups", () => {
    const workspace = Xcworkspace.parse(fixture("workspace-groups.xcworkspacedata"));

    // Group locations compose, container locations anchor at the
    // workspace's directory, absolute paths pass through, and the
    // self reference and the non-project file stay out.
    expect(workspace.projectFilePaths()).toEqual([
      "Modules/Core/Core.xcodeproj",
      "Modules/Nested/Deep.xcodeproj",
      "Anchored/Anchored.xcodeproj",
      "/opt/shared/Shared.xcodeproj",
    ]);
  });

  it("resolves the flat CocoaPods-style shape", () => {
    const workspace = Xcworkspace.parse(fixture("workspace-app.xcworkspacedata"));
    expect(workspace.projectFilePaths()).toEqual(["DemoApp.xcodeproj", "Pods/Pods.xcodeproj"]);
  });

  it("adds and removes file references", () => {
    const workspace = Xcworkspace.parse(fixture("workspace-app.xcworkspacedata"));

    const added = workspace.addFileRef("group:Vendor/Vendor.xcodeproj");
    expect(workspace.projectFilePaths()).toContain("Vendor/Vendor.xcodeproj");

    expect(workspace.removeFileRef(added)).toBe(true);
    expect(workspace.removeFileRef(added)).toBe(false);
    expect(workspace.build()).toBe(fixture("workspace-app.xcworkspacedata"));
  });

  it("removes references nested inside groups", () => {
    const workspace = Xcworkspace.parse(fixture("workspace-groups.xcworkspacedata"));
    const nested = workspace.fileRefs().find((reference) => reference.location === "group:Deep.xcodeproj");
    assert(nested != null);

    expect(workspace.removeFileRef(nested)).toBe(true);
    expect(workspace.projectFilePaths()).not.toContain("Modules/Nested/Deep.xcodeproj");
  });

  it("creates the workspace Xcode writes for given locations", () => {
    const workspace = Xcworkspace.create({ locations: ["group:DemoApp.xcodeproj", "group:Pods/Pods.xcodeproj"] });

    expect(workspace.build()).toBe(fixture("workspace-app.xcworkspacedata"));
    expect(Xcworkspace.create().fileRefs()).toEqual([]);
  });

  it("edits locations through the typed view", () => {
    const workspace = Xcworkspace.parse(fixture("workspace-app.xcworkspacedata"));
    const [first] = workspace.fileRefs();
    assert(first instanceof WorkspaceFileRef);

    first.location = "group:Renamed.xcodeproj";
    expect(workspace.build()).toContain('location = "group:Renamed.xcodeproj"');
  });
});
