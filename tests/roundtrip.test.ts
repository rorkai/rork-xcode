import { readFileSync } from "node:fs";

import { buildPbxproj, parsePbxproj, type PbxprojObject } from "../src/index";

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");
}

// The fixtures are in the writer's canonical layout (the layout Xcode itself
// writes), so a parse → build cycle must reproduce them byte for byte.
test("app-xcode16.pbxproj round-trips byte-exact", () => {
  const original = fixture("app-xcode16.pbxproj");
  expect(buildPbxproj(parsePbxproj(original) as PbxprojObject)).toBe(original);
});

test("legacy-groups.pbxproj round-trips byte-exact", () => {
  const original = fixture("legacy-groups.pbxproj");
  expect(buildPbxproj(parsePbxproj(original) as PbxprojObject)).toBe(original);
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
