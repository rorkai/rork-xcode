import { readFileSync } from "node:fs";

import { buildPbxproj, parsePbxproj, type PbxprojObject } from "../src/index";

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");
}

/**
 * Documents already in the writer's canonical layout (the layout current
 * Xcode writes), so a parse → build cycle must reproduce them byte for byte.
 *
 * The app-xcode16 fixture is a real app with file-system-synchronized
 * groups, and legacy-groups is a real app with classic PBXGroup file
 * listings. The app-exceptions fixture is generated in current Xcode's
 * shape, with synchronized folders carrying both exception-set kinds, a
 * target dependency, an embed phase, and a remote Swift package. The
 * framework-multiplatform fixture is a large real-world framework project
 * (~100 KiB, identifiers neutralized) with variant groups and
 * per-platform targets.
 */
const BYTE_EXACT_FIXTURES = [
  "app-xcode16.pbxproj",
  "legacy-groups.pbxproj",
  "app-exceptions.pbxproj",
  "framework-multiplatform.pbxproj",
];

/**
 * Documents written by other generations of tooling whose layout differs
 * from current Xcode's (multi-line empty dictionaries, isa-only exception
 * comments, unsectioned objects). They must normalize into the canonical
 * layout, reaching a byte-stable fixed point with unchanged values, rather
 * than reproduce their original bytes.
 *
 * The legacy-aggregate-cocoa fixture is an ancient real-world project
 * (identifiers neutralized) with aggregate and legacy targets, reference
 * proxies into a subproject, variant groups, and build rules. The
 * sync-groups-xcode16 fixture is a real Xcode 16.0 app (identifiers
 * neutralized) whose exception sets carry the older isa-only comments.
 * The number-fidelity fixture is a scalar torture document (0.0, 1.1,
 * 1.0, "1.0", 1.10, 01) in an unsectioned layout.
 */
const NORMALIZING_FIXTURES = [
  "legacy-aggregate-cocoa.pbxproj",
  "sync-groups-xcode16.pbxproj",
  "number-fidelity.pbxproj",
];

describe.each(BYTE_EXACT_FIXTURES)("%s", (name) => {
  it("round-trips byte-exact", () => {
    const original = fixture(name);
    expect(buildPbxproj(parsePbxproj(original) as PbxprojObject)).toBe(original);
  });
});

describe.each(NORMALIZING_FIXTURES)("%s", (name) => {
  it("normalizes to a fixed point with unchanged values", () => {
    const original = fixture(name);
    const document = parsePbxproj(original);
    const rebuilt = buildPbxproj(document as PbxprojObject);

    // One build reaches the canonical form, and another cycle must not
    // move.
    expect(buildPbxproj(parsePbxproj(rebuilt) as PbxprojObject)).toBe(rebuilt);

    // Normalization changes layout only, and every value survives (toEqual
    // compares dictionaries without regard to key order).
    expect(parsePbxproj(rebuilt)).toEqual(document);
  });
});

test("number-fidelity preserves each scalar's lexical form", () => {
  const document = parsePbxproj(fixture("number-fidelity.pbxproj")) as PbxprojObject;
  const objects = document["objects"] as Record<string, PbxprojObject>;
  const project = objects["123456789123456789012345"];
  assert(project);
  // Trailing-zero decimals and leading-zero runs stay strings, plain
  // decimals become numbers, and quoting always forces a string.
  expect(project["one"]).toBe("0.0");
  expect(project["two"]).toBe(1.1);
  expect(project["three"]).toBe("1.0");
  expect(project["four"]).toBe("1.0");
  expect(project["five"]).toBe("1.10");
  expect(project["six"]).toBe("01");
});

test("older isa-only exception comments upgrade to the current form", () => {
  const rebuilt = buildPbxproj(parsePbxproj(fixture("sync-groups-xcode16.pbxproj")) as PbxprojObject);
  expect(rebuilt).toContain('/* Exceptions for "Views" folder in "ScoreBoard" target */');
  expect(rebuilt).not.toContain("/* PBXFileSystemSynchronizedBuildFileExceptionSet */");
});

test("quoting style differences normalize to a stable document", () => {
  // Over-quoted input (tools may quote more aggressively than Xcode) parses
  // to the same values and re-serializes in canonical quoting.
  const overQuoted = `{ "PRODUCT_BUNDLE_IDENTIFIER" = "com.example.demo"; "name" = "Demo"; }`;
  const text = buildPbxproj(parsePbxproj(overQuoted) as PbxprojObject);
  expect(text).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.example.demo;");
  expect(text).toContain("name = Demo;");

  // A second cycle is a fixed point.
  expect(buildPbxproj(parsePbxproj(text) as PbxprojObject)).toBe(text);
});

test("escape-heavy values survive a parse/build cycle", () => {
  const document: PbxprojObject = {
    objects: {
      S1: {
        isa: "PBXShellScriptBuildPhase",
        buildActionMask: 2147483647,
        files: [],
        name: 'Tricky "Phase"\twith\nescapes',
        runOnlyForDeploymentPostprocessing: 0,
        shellPath: "/bin/sh",
        shellScript: 'if [ "$CONFIGURATION" = "Release" ]; then\n  echo done\nfi\n',
      },
    },
    rootObject: "S1",
  };
  const cycled = parsePbxproj(buildPbxproj(document));
  expect(cycled).toEqual(document);
  expect(buildPbxproj(cycled as PbxprojObject)).toBe(buildPbxproj(document));
});

test("the Xcode 16 fixture exposes sync groups and file exceptions faithfully", () => {
  const parsed = parsePbxproj(fixture("app-xcode16.pbxproj")) as PbxprojObject;
  const objects = parsed["objects"] as Record<string, PbxprojObject>;

  const syncGroups = Object.values(objects).filter((object) => object["isa"] === "PBXFileSystemSynchronizedRootGroup");
  expect(syncGroups.map((group) => group["path"])).toContain("SampleApp");

  const project = objects[parsed["rootObject"] as string];
  assert(project);
  expect(project["isa"]).toBe("PBXProject");
  expect(Array.isArray(project["targets"])).toBe(true);
});
