import { readFileSync } from "node:fs";

import {
  ProductType,
  Xcconfig,
  XcodeModelError,
  Xcproj,
  XcprojParseError,
  XcprojReference,
  type XcprojObject,
  type XcprojTarget,
} from "../src/index";

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");
}

function open(name: string): Xcproj {
  return Xcproj.parse(fixture(name));
}

/**
 * Finds a target that must exist in the fixture.
 */
function target(project: Xcproj, name: string): XcprojTarget {
  const found = project.findTarget(name);
  assert(found != null, `missing target ${name}`);
  return found;
}

describe("documents", () => {
  it("rebuilds an untouched project byte for byte", () => {
    expect(open("app.xcproj").build()).toBe(fixture("app.xcproj"));
  });

  it("rejects documents that are not dictionaries", () => {
    expect(() => Xcproj.parse("[]")).toThrow(XcodeModelError);
    expect(() => Xcproj.parse("{")).toThrow(XcprojParseError);
  });

  it("works on a document in place", () => {
    const document: XcprojObject = { "default-configuration": "Debug", configurations: ["Debug"], files: [] };
    Xcproj.fromDocument(document).setBuildSetting("SDKROOT", "macosx");
    expect(document["build-settings"]).toEqual({ SDKROOT: "macosx" });
  });

  it("lists configurations in either encoding", () => {
    const project = open("schema-coverage.xcproj");
    expect(project.configurationNames()).toEqual(["Debug", "Release", "Profile"]);
    expect(project.defaultConfiguration).toBe("Release");
  });
});

describe("targets", () => {
  it("lists targets of every kind with their product types", () => {
    const project = open("schema-coverage.xcproj");
    const kinds = Object.fromEntries(project.targets().map((view) => [view.name, view.kind]));
    expect(kinds).toMatchObject({ App: "native", Everything: "aggregate", Make: "external-build-system" });
    expect(target(project, "App").productType).toBe(ProductType.application);
    expect(target(project, "Custom").productType).toBe("com.example.product-type.custom");
    expect(target(project, "App").id).toBe("AA00000000000000000000A4");
  });

  it("writes product types in the form Xcode uses", () => {
    const project = open("schema-coverage.xcproj");
    const app = target(project, "App");
    app.productType = ProductType.appExtension;
    expect(app.properties["product-type"]).toBe("app-extension");
    app.productType = "com.example.other";
    expect(app.properties["product-type"]).toBeUndefined();
    expect(app.properties["full-product-type"]).toBe("com.example.other");
  });

  it("returns one view per target", () => {
    const project = open("app.xcproj");
    expect(project.findTarget("SampleApp")).toBe(project.targets()[0]);
  });

  it("finds the main application target", () => {
    expect(open("app.xcproj").findMainAppTarget("ios")?.name).toBe("SampleApp");
    expect(open("sync-groups.xcproj").findMainAppTarget()?.name).toBe("ScoreBoard");
    expect(open("framework-multiplatform.xcproj").findMainAppTarget()).toBeUndefined();
  });

  it("resolves dependencies, test hosts, and products", () => {
    const project = open("app.xcproj");
    const tests = target(project, "SampleAppTests");
    expect(tests.dependencyNames()).toEqual(["SampleApp"]);
    expect(tests.dependencies()).toEqual([target(project, "SampleApp")]);
    expect(tests.testHost()).toBe(target(project, "SampleApp"));

    const product = target(project, "SampleApp").productReference();
    assert(product instanceof XcprojReference);
    expect(product.path).toBe("<PRODUCTS>/SampleApp.app");
  });

  it("keeps remote and package dependencies out of the local names", () => {
    const app = target(open("schema-coverage.xcproj"), "App");
    expect(app.dependencyNames()).toEqual(["Widget", "Framework"]);
  });

  it("adds a dependency once", () => {
    const project = open("app.xcproj");
    const app = target(project, "SampleApp");
    const tests = target(project, "SampleAppUITests");
    app.addDependency(tests);
    app.addDependency(tests);
    expect(app.dependencyNames()).toEqual(["SampleAppUITests"]);
    expect(project.build()).toContain(
      '"product-type": "application",\n      "dependencies": [\n        "SampleAppUITests",',
    );
  });
});

describe("build settings", () => {
  it("reads target settings and inherits project settings per configuration", () => {
    const project = open("app.xcproj");
    const app = target(project, "SampleApp");
    expect(app.getBuildSetting("PRODUCT_BUNDLE_IDENTIFIER")).toBe("com.example.sample");
    expect(app.getBuildSetting("SDKROOT")).toBe("iphoneos");

    // The project folds Debug-only values under [config=Debug], and reads
    // without a configuration use the default one, Release.
    expect(app.getBuildSetting("DEBUG_INFORMATION_FORMAT")).toBe("dwarf-with-dsym");
    expect(app.getBuildSetting("DEBUG_INFORMATION_FORMAT", { configuration: "Debug" })).toBe("dwarf");
    expect(app.getBuildSetting("DEBUG_INFORMATION_FORMAT[config=Debug]")).toBe("dwarf");
    expect(app.getBuildSetting("ONLY_ACTIVE_ARCH")).toBeUndefined();
  });

  it("reads list settings as lists", () => {
    const app = target(open("app.xcproj"), "SampleApp");
    expect(app.getBuildSetting("LD_RUNPATH_SEARCH_PATHS")).toEqual(["$(inherited)", "@executable_path/Frameworks"]);
  });

  it("resolves references through the layers", () => {
    const project = open("app.xcproj");
    const app = target(project, "SampleApp");
    expect(app.resolveBuildSetting("PRODUCT_NAME")).toBe("SampleApp");
    expect(app.resolveBuildSetting("LD_RUNPATH_SEARCH_PATHS")).toBe("@executable_path/Frameworks");
    expect(
      target(project, "SampleAppTests").resolveBuildSetting("TEST_HOST", {
        lookup: (name) => (name === "BUILT_PRODUCTS_DIR" ? "/build" : undefined),
      }),
    ).toBe("/build/SampleApp.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/SampleApp");
    expect(project.resolveBuildSetting("GCC_PREPROCESSOR_DEFINITIONS", { configuration: "Debug" })).toBe("DEBUG=1");
  });

  it("writes and removes settings the way Xcode folds them", () => {
    // The fixture is Xcode's own save after the same edits made through
    // the pbxproj model, one configuration at a time.
    const project = open("app.xcproj");
    const app = target(project, "SampleApp");
    app.setBuildSetting("MARKETING_VERSION", "2.0");
    app.setBuildSetting("CODE_SIGN_STYLE", "Manual", { configuration: "Debug" });
    app.setBuildSetting("NEW_DEBUG_ONLY", "1", { configuration: "Debug" });
    expect(app.removeBuildSetting("ENABLE_PREVIEWS")).toBe(true);
    expect(project.build()).toBe(fixture("app-settings-edited.xcproj"));
  });

  it("folds configurations back together once they agree", () => {
    const project = open("app.xcproj");
    const app = target(project, "SampleApp");
    app.setBuildSetting("SWIFT_VERSION", "6.0", { configuration: "Debug" });
    expect(app.buildSettingsFor("Debug")["SWIFT_VERSION"]).toBe("6.0");
    expect(app.buildSettingsFor("Release")["SWIFT_VERSION"]).toBe("5.0");

    app.setBuildSetting("SWIFT_VERSION", "6.0", { configuration: "Release" });
    expect(app.properties["build-settings"]).toMatchObject({ SWIFT_VERSION: "6.0" });
    expect(Object.keys(app.properties["build-settings"] as XcprojObject)).not.toContain("SWIFT_VERSION[config=Debug]");
  });

  it("removes a setting from one configuration", () => {
    const project = open("app.xcproj");
    const app = target(project, "SampleApp");
    expect(app.removeBuildSetting("SWIFT_VERSION", { configuration: "Debug" })).toBe(true);
    expect(app.removeBuildSetting("SWIFT_VERSION", { configuration: "Debug" })).toBe(false);
    expect(app.getBuildSetting("SWIFT_VERSION", { configuration: "Debug" })).toBeUndefined();
    expect(app.getBuildSetting("SWIFT_VERSION", { configuration: "Release" })).toBe("5.0");
    expect(project.build()).toContain('"SWIFT_VERSION[config=Release]": "5.0",');
  });

  it("drops an emptied settings dictionary", () => {
    const project = open("schema-coverage.xcproj");
    const make = target(project, "Make");
    expect(make.removeBuildSetting("OTHER")).toBe(true);
    expect(make.properties["build-settings"]).toBeUndefined();
    expect(make.removeBuildSetting("OTHER")).toBe(false);
  });

  it("keeps sdk and arch conditions when folding", () => {
    const project = open("app.xcproj");
    const app = target(project, "SampleApp");
    app.setBuildSetting("OTHER_LDFLAGS[sdk=iphoneos*]", "-ObjC", { configuration: "Debug" });
    expect(app.properties["build-settings"]).toMatchObject({ "OTHER_LDFLAGS[config=Debug][sdk=iphoneos*]": "-ObjC" });
    expect(app.getBuildSetting("OTHER_LDFLAGS[sdk=iphoneos*]", { configuration: "Debug" })).toBe("-ObjC");
  });

  it("reads and writes project-level settings", () => {
    const project = open("app.xcproj");
    expect(project.getBuildSetting("ONLY_ACTIVE_ARCH", { configuration: "Debug" })).toBe("YES");
    project.setBuildSetting("IPHONEOS_DEPLOYMENT_TARGET", "26.0");
    expect(target(project, "SampleAppUITests").getBuildSetting("IPHONEOS_DEPLOYMENT_TARGET")).toBe("26.0");
    expect(project.buildSettingsFor("Debug")["ONLY_ACTIVE_ARCH"]).toBe("YES");
    expect(project.removeBuildSetting("ONLY_ACTIVE_ARCH")).toBe(true);
    expect(project.buildSettingsFor("Debug")["ONLY_ACTIVE_ARCH"]).toBeUndefined();
  });

  it("layers registered xcconfig files below the settings that use them", () => {
    const project = open("schema-coverage.xcproj");
    const app = target(project, "App");
    project.registerXcconfig("Configs/Debug.xcconfig", Xcconfig.parse("FROM_PROJECT = project\nSHARED = project\n"));
    project.registerXcconfig("Configs/App-Debug.xcconfig", Xcconfig.parse("FROM_TARGET = target\nSHARED = target\n"));
    project.registerXcconfig("Configs/Shared/Release.xcconfig", Xcconfig.parse("FROM_PROJECT = release\n"));

    expect(app.getBuildSetting("FROM_TARGET", { configuration: "Debug" })).toBe("target");
    expect(app.getBuildSetting("FROM_PROJECT", { configuration: "Debug" })).toBe("project");
    expect(app.getBuildSetting("SHARED", { configuration: "Debug" })).toBe("target");
    expect(app.getBuildSetting("ALPHA", { configuration: "Debug" })).toBe("first");
    expect(project.getBuildSetting("FROM_PROJECT")).toBe("release");
  });
});

describe("file tree", () => {
  it("walks references and derives their names", () => {
    const project = open("legacy-aggregate-cocoa.xcproj");
    const names = project.files().map((reference) => reference.name);
    expect(names.slice(0, 3)).toEqual(["ReferencedProject.xcodeproj", "sample.xcconfig", "CPDocument.xcdatamodeld"]);
    expect(project.references().length).toBeGreaterThan(project.files().length);
    expect(project.findReference("Localized")?.kind).toBe("variant-group");
  });

  it("finds references by name path, including names with slashes", () => {
    const project = open("schema-coverage.xcproj");
    expect(project.findReference("Sources Group/Nested.swift")?.path).toBe("Nested.swift");
    expect(project.findReference(["Built/Products", "App.app"])?.path).toBe("<PRODUCTS>/App.app");
    expect(target(project, "App").productReference()?.path).toBe("<PRODUCTS>/App.app");
    expect(project.findReference("Missing/Nothing")).toBeUndefined();
  });

  it("lists the targets a reference is a member of", () => {
    const project = open("schema-coverage.xcproj");
    expect(project.findReference("AppFolder")?.targetNames()).toEqual(["App", "Tests"]);
    expect(project.findReference("Shared.h")?.targetNames()).toEqual(["App", "Framework"]);
    // An id reference resolves through the build phase that carries the id.
    expect(project.findReference("Generated.swift")?.targetNames()).toEqual(["App"]);
    expect(
      project
        .findReference("Model")
        ?.children()
        .map((child) => child.name),
    ).toEqual(["Model 2.xcdatamodel", "Model.xcdatamodel"]);
  });

  it("returns one view per reference", () => {
    const project = open("app.xcproj");
    expect(project.findReference("SampleApp")).toBe(project.files()[0]);
  });
});

describe("renaming", () => {
  it("renames a target everywhere Xcode does", () => {
    // The fixture is Xcode's own save of the same rename made through the
    // pbxproj model.
    const project = open("app.xcproj");
    project.renameTarget(target(project, "SampleApp"), "RenamedApp");
    expect(project.build()).toBe(fixture("app-renamed.xcproj"));
  });

  it("switches name path encodings as names gain or lose slashes", () => {
    const project = open("legacy-aggregate-cocoa.xcproj");
    project.renameTarget(target(project, "C/C++ Library"), "Cxx Library");
    const text = project.build();
    // The object form was only needed for the slash, so the renamed entry
    // collapses to the string form.
    expect(text).toContain(
      '"path": "main.m",\n              "target-membership": [\n                "Cocoa Application/compile-sources",\n                "Cxx Library/compile-sources",\n',
    );
    expect(text).not.toContain("C/C++ Library");

    project.renameTarget(target(project, "Cxx Library"), "C/C++ Core");
    expect(project.build()).toContain('{ "build-phase": [ { "name": "C/C++ Core" }, "compile-sources" ] }');
  });

  it("renames folder memberships, exception sets, and embedded products", () => {
    const project = open("app-exceptions.xcproj");
    project.renameTarget(target(project, "Demo"), "Showcase");
    const text = project.build();
    expect(text).toContain('"target": "Showcase",');
    expect(text).toContain('"build-phase": "Showcase/copy/Embed Foundation Extensions",');
    expect(text).toContain('"target-membership": [ { "build-phase": "Showcase/copy/Embed Foundation Extensions"');
    expect(text).toContain('"product": "Products/Showcase.app",');
    // The folder keeps its path. Only the target membership names change.
    expect(text).toContain('"path": "Demo",\n      "target-membership": [\n        "Showcase",');
  });

  it("refuses renames the format cannot represent, without changing anything", () => {
    const project = open("app.xcproj");
    const app = target(project, "SampleApp");
    expect(() => project.renameTarget(app, "SampleAppTests")).toThrow(XcodeModelError);
    expect(() => project.renameTarget(app, "Sample/App")).toThrow('product names cannot contain "/"');
    expect(project.build()).toBe(fixture("app.xcproj"));

    project.renameTarget(app, "SampleApp");
    expect(project.build()).toBe(fixture("app.xcproj"));
  });

  it("refuses targets of other projects", () => {
    const project = open("app.xcproj");
    const other = target(open("app.xcproj"), "SampleApp");
    expect(() => project.renameTarget(other, "Renamed")).toThrow(XcodeModelError);
    expect(() => project.removeTarget(other)).toThrow(XcodeModelError);
  });
});

describe("removal", () => {
  it("removes a target and everything that refers to it, as Xcode does", () => {
    // The fixture is Xcode's own save of the same removal made through the
    // pbxproj model. The widget's product and its embedding go, the app's
    // dependency goes, and the folder only the widget used goes.
    const project = open("app-exceptions.xcproj");
    project.removeTarget(target(project, "DemoWidget"));
    expect(project.build()).toBe(fixture("app-exceptions-without-widget.xcproj"));
  });

  it("removes memberships by name and by phase id", () => {
    const project = open("schema-coverage.xcproj");
    project.removeTarget(target(project, "App"));
    const text = project.build();
    expect(project.findReference("Generated.swift")?.properties["target-membership"]).toBeUndefined();
    expect(project.findReference("Shared.h")?.targetNames()).toEqual(["Framework"]);
    expect(project.findReference("AppFolder")?.targetNames()).toEqual(["Tests"]);
    expect(project.findReference(["Built/Products", "App.app"])).toBeUndefined();
    expect(target(project, "Tests").testHost()).toBeUndefined();
    expect(target(project, "Everything").dependencyNames()).toEqual(["Custom"]);
    // Imported products always carry their membership list, even empty.
    expect(text).toContain(
      '"product-id": "AA0000000000000000000010",\n      "type": "wrapper.framework",\n      "target-membership": [\n      ],',
    );
  });
});
