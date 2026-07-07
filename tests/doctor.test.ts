import { readdirSync, readFileSync } from "node:fs";

import { Isa, ProductType, XcodeProject, type PbxprojObject, type ProjectIssue } from "../src/index";

function kindCounts(issues: ProjectIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
  }
  return counts;
}

/**
 * A minimal well-formed document to damage in specific ways per test.
 */
function healthyDocument(): PbxprojObject {
  return {
    archiveVersion: 1,
    classes: {},
    objectVersion: 77,
    objects: {
      C1: { isa: Isa.buildConfiguration, buildSettings: {}, name: "Release" },
      L1: {
        isa: Isa.configurationList,
        buildConfigurations: ["C1"],
        defaultConfigurationIsVisible: 0,
        defaultConfigurationName: "Release",
      },
      G1: { isa: Isa.group, children: [], sourceTree: "<group>" },
      P1: {
        isa: Isa.project,
        buildConfigurationList: "L1",
        mainGroup: "G1",
        targets: [],
      },
    },
    rootObject: "P1",
  };
}

describe("validate", () => {
  it("reports a clean graph for every committed fixture", () => {
    const directory = new URL("fixtures/", import.meta.url);
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".pbxproj"))) {
      const project = XcodeProject.parse(readFileSync(new URL(name, directory), "utf-8"));
      expect(project.validate(), name).toEqual([]);
    }
  });

  it("stays clean through a scaffold and teardown", () => {
    const project = XcodeProject.parse(readFileSync(new URL("fixtures/app-xcode16.pbxproj", import.meta.url), "utf-8"));
    const host = project.findMainAppTarget("ios");
    assert(host);
    const widget = project.addNativeTarget({ name: "DemoWidget", productType: ProductType.appExtension });
    host.addDependency(widget);
    host.embed(widget);
    expect(project.validate()).toEqual([]);

    project.removeTarget(widget);
    expect(project.validate()).toEqual([]);
  });

  it("reports a missing or dangling root", () => {
    const document = healthyDocument();
    document["rootObject"] = "MISSING";
    expect(kindCounts(XcodeProject.fromDocument(document).validate())).toMatchObject({ "dangling-root": 1 });

    const rootless = healthyDocument();
    delete rootless["rootObject"];
    const issues = XcodeProject.fromDocument(rootless).validate();
    expect(kindCounts(issues)).toMatchObject({ "dangling-root": 1 });
  });

  it("reports objects without a kind", () => {
    const document = healthyDocument();
    (document["objects"] as PbxprojObject)["XX1"] = { name: "kindless" };
    // The object is also unreachable, which reports separately.
    const issues = XcodeProject.fromDocument(document).validate();
    expect(kindCounts(issues)).toEqual({ "missing-isa": 1, "unreachable-object": 1 });
  });

  it("reports dangling references in scalar and list properties", () => {
    const document = healthyDocument();
    const objects = document["objects"] as PbxprojObject;
    (objects["P1"] as PbxprojObject)["targets"] = ["GONE1"];
    (objects["P1"] as PbxprojObject)["productRefGroup"] = "GONE2";

    const issues = XcodeProject.fromDocument(document).validate();
    expect(kindCounts(issues)).toEqual({ "dangling-reference": 2 });
    const messages = issues.map((issue) => issue.message).join("\n");
    expect(messages).toContain("P1.targets references GONE1");
    expect(messages).toContain("P1.productRefGroup references GONE2");
  });

  it("reports objects unreachable from the root", () => {
    const document = healthyDocument();
    (document["objects"] as PbxprojObject)["XXORPHAN1"] = {
      isa: Isa.fileReference,
      path: "Lost.swift",
      sourceTree: "<group>",
    };

    const issues = XcodeProject.fromDocument(document).validate();
    expect(issues).toEqual([
      {
        kind: "unreachable-object",
        message: "XXORPHAN1 is unreachable from the root object",
        objectId: "XXORPHAN1",
      },
    ]);
  });

  it("treats ids inside nested attribute dictionaries as reachable", () => {
    const document = healthyDocument();
    const objects = document["objects"] as PbxprojObject;
    // Mimics TargetAttributes, where the orphan candidate is referenced
    // only as a nested dictionary key.
    (objects["P1"] as PbxprojObject)["attributes"] = {
      TargetAttributes: { XXKEPT1: { CreatedOnToolsVersion: "17.0" } },
    };
    objects["XXKEPT1"] = { isa: Isa.nativeTarget, name: "Kept" };

    expect(XcodeProject.fromDocument(document).validate()).toEqual([]);
  });
});

describe("pruneOrphans", () => {
  it("removes unreachable objects and returns their ids", () => {
    const document = healthyDocument();
    const objects = document["objects"] as PbxprojObject;
    objects["XXORPHAN1"] = { isa: Isa.fileReference, path: "Lost.swift", sourceTree: "<group>" };
    objects["XXORPHAN2"] = { isa: Isa.buildFile, fileRef: "XXORPHAN1" };

    const project = XcodeProject.fromDocument(document);
    const removed = project.pruneOrphans();
    expect(removed.toSorted()).toEqual(["XXORPHAN1", "XXORPHAN2"]);
    expect(project.get("XXORPHAN1")).toBeUndefined();
    expect(project.validate()).toEqual([]);

    // A healthy document prunes nothing.
    expect(project.pruneOrphans()).toEqual([]);
  });

  it("prunes nothing when the root is missing", () => {
    const document = healthyDocument();
    document["rootObject"] = "MISSING";
    expect(XcodeProject.fromDocument(document).pruneOrphans()).toEqual([]);
  });
});
