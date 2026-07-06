import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BuildPhase,
  CopyFilesDestination,
  Isa,
  ProductType,
  XcodeModelError,
  XcodeProject,
  type NativeTarget,
  type SyncRootGroup,
} from "../src/index";

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");
}

function openApp(): XcodeProject {
  return XcodeProject.parse(fixture("app-xcode16.pbxproj"));
}

/**
 * Scaffolds a widget extension into the sample app the way Xcode's own
 * target template does: create the target, configure it, wire the
 * dependency, embed it, and synchronize its folder with an Info.plist
 * membership exception.
 */
function scaffoldWidget(project: XcodeProject): {
  host: NativeTarget;
  widget: NativeTarget;
  syncGroup: SyncRootGroup;
} {
  const host = project.findMainAppTarget("ios");
  assert(host);

  const widget = project.addNativeTarget({
    name: "DemoWidget",
    productType: ProductType.appExtension,
    buildSettings: {
      PRODUCT_BUNDLE_IDENTIFIER: "com.example.sample.demowidget",
      PRODUCT_NAME: "DemoWidget",
      SWIFT_VERSION: "5.0",
    },
  });
  widget.setBuildSetting("SDKROOT", "iphoneos");
  widget.setBuildSetting("IPHONEOS_DEPLOYMENT_TARGET", "18.0");
  widget.setBuildSetting("INFOPLIST_FILE", "DemoWidget/Info.plist");

  host.addDependency(widget);
  host.embed(widget);
  const syncGroup = widget.addSyncGroup("DemoWidget");
  syncGroup.addMembershipExceptions(widget, ["Info.plist"]);

  return { host, widget, syncGroup };
}

describe("reading a real project", () => {
  it("finds the main application target by platform", () => {
    const project = openApp();
    const target = project.findMainAppTarget("ios");
    expect(target?.name).toBe("SampleApp");
    expect(target?.productType).toBe(ProductType.application);

    // The fixture has no visionOS deployment settings, so the lookup falls
    // back to the first application target in project order.
    expect(project.findMainAppTarget("visionos")?.name).toBe("SampleApp");
  });

  it("lists native targets in project order and identity-maps views", () => {
    const project = openApp();
    const names = project.nativeTargets().map((target) => target.name);
    expect(names).toEqual(["SampleApp", "SampleAppTests", "SampleAppUITests"]);

    expect(project.findTarget("SampleApp")).toBe(project.findMainAppTarget("ios"));
    const [first] = project.nativeTargets();
    assert(first);
    expect(project.get(first.id)).toBe(first);
  });

  it("reads build settings, only as strings", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);
    expect(app.getBuildSetting("PRODUCT_BUNDLE_IDENTIFIER")).toBe("com.example.sample");
    expect(app.getBuildSetting("SDKROOT")).toBe("iphoneos");
    // CURRENT_PROJECT_VERSION parses as a number, so the string read skips it.
    expect(app.getBuildSetting("CURRENT_PROJECT_VERSION")).toBeUndefined();
    expect(app.getBuildSetting("NOT_A_REAL_SETTING")).toBeUndefined();
  });

  it("inherits build settings from the project-level configuration", () => {
    const project = XcodeProject.fromDocument({
      objects: {
        C1: { isa: Isa.buildConfiguration, buildSettings: { SDKROOT: "appletvos" }, name: "Release" },
        L1: {
          isa: Isa.configurationList,
          buildConfigurations: ["C1"],
          defaultConfigurationIsVisible: 0,
          defaultConfigurationName: "Release",
        },
        C2: { isa: Isa.buildConfiguration, buildSettings: {}, name: "Release" },
        L2: {
          isa: Isa.configurationList,
          buildConfigurations: ["C2"],
          defaultConfigurationIsVisible: 0,
          defaultConfigurationName: "Release",
        },
        T1: {
          isa: Isa.nativeTarget,
          buildConfigurationList: "L2",
          buildPhases: [],
          buildRules: [],
          dependencies: [],
          name: "App",
          productType: ProductType.application,
        },
        P1: {
          isa: Isa.project,
          buildConfigurationList: "L1",
          mainGroup: "G1",
          targets: ["T1"],
        },
        G1: { isa: Isa.group, children: [], sourceTree: "<group>" },
      },
      rootObject: "P1",
    });

    const target = project.findMainAppTarget("ios");
    assert(target);
    // The target's own configuration omits SDKROOT; the value resolves from
    // the project configuration, and a target-level write then shadows it.
    expect(target.getBuildSetting("SDKROOT")).toBe("appletvos");
    target.setBuildSetting("SDKROOT", "iphoneos");
    expect(target.getBuildSetting("SDKROOT")).toBe("iphoneos");
  });

  it("writes and removes build settings on every configuration", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    app.setBuildSetting("MARKETING_VERSION", "9.9.9");
    const perConfiguration = app
      .buildConfigurations()
      .map(
        (configuration) => (configuration.properties["buildSettings"] as Record<string, unknown>)["MARKETING_VERSION"],
      );
    expect(perConfiguration).toEqual(["9.9.9", "9.9.9"]);

    app.removeBuildSetting("MARKETING_VERSION");
    expect(app.getBuildSetting("MARKETING_VERSION")).toBeUndefined();
  });

  it("reads synchronized folder paths", () => {
    const project = openApp();
    expect(project.findMainAppTarget("ios")?.syncGroupPaths()).toEqual(["SampleApp"]);
  });

  it("finds file references through the group tree", () => {
    const project = XcodeProject.parse(fixture("legacy-groups.pbxproj"));
    // The Sources group carries a name but no path, so its members resolve
    // at the project root.
    expect(project.findFileReference("Main.m")?.getString("path")).toBe("Main.m");
    expect(project.findFileReference("Missing.m")).toBeUndefined();
  });
});

describe("scaffolding an extension target", () => {
  it("wires the target, dependency, embedding, and synchronized folder", () => {
    const project = openApp();
    const { host, widget } = scaffoldWidget(project);

    expect(widget.name).toBe("DemoWidget");
    expect(widget.productType).toBe(ProductType.appExtension);
    expect(widget.buildPhases().map((phase) => phase.isa)).toEqual([
      Isa.sourcesBuildPhase,
      Isa.frameworksBuildPhase,
      Isa.resourcesBuildPhase,
    ]);
    expect(widget.productReference?.getString("path")).toBe("DemoWidget.appex");

    // The dependency runs through a container proxy anchored at the root
    // project object, exactly as Xcode wires it.
    const dependency = project.get((host.properties["dependencies"] as string[]).at(-1));
    assert(dependency);
    expect(dependency.getString("target")).toBe(widget.id);
    const proxy = project.get(dependency.getString("targetProxy"));
    assert(proxy);
    expect(proxy.getString("containerPortal")).toBe(project.rootProject.id);
    expect(proxy.getString("remoteGlobalIDString")).toBe(widget.id);
    expect(proxy.getString("remoteInfo")).toBe("DemoWidget");

    const embedPhase = host.findBuildPhase(Isa.copyFilesBuildPhase, "Embed Foundation Extensions");
    assert(embedPhase);
    expect(embedPhase.properties["dstSubfolderSpec"]).toBe(CopyFilesDestination.plugins);
    const buildFile = project.get(embedPhase.buildFileIds.at(-1));
    expect(buildFile?.getString("fileRef")).toBe(widget.productReference?.id);
    expect(buildFile?.properties["settings"]).toEqual({ ATTRIBUTES: ["RemoveHeadersOnCopy"] });

    expect(widget.syncGroupPaths()).toEqual(["DemoWidget"]);
  });

  it("links membership exceptions to the synchronized folder", () => {
    const project = openApp();
    const { widget, syncGroup } = scaffoldWidget(project);

    const [exceptionSetId] = syncGroup.properties["exceptions"] as string[];
    const exceptionSet = project.get(exceptionSetId);
    assert(exceptionSet);
    expect(exceptionSet.getString("target")).toBe(widget.id);
    expect(exceptionSet.properties["membershipExceptions"]).toEqual(["Info.plist"]);

    // The main group shows the folder in the navigator.
    expect(project.rootProject.mainGroup()?.childIds).toContain(syncGroup.id);
  });

  it("is idempotent for dependencies, embedding, and synchronized folders", () => {
    const project = openApp();
    const { host, widget, syncGroup } = scaffoldWidget(project);

    const dependencyCount = (host.properties["dependencies"] as string[]).length;
    host.addDependency(widget);
    expect((host.properties["dependencies"] as string[]).length).toBe(dependencyCount);

    const phase = host.embed(widget);
    assert(phase);
    expect(host.embed(widget)).toBe(phase);
    expect(phase.buildFileIds).toHaveLength(1);

    expect(widget.addSyncGroup("DemoWidget")).toBe(syncGroup);
    expect(widget.syncGroupPaths()).toEqual(["DemoWidget"]);
  });

  it("produces deterministic output across identical runs", () => {
    const first = openApp();
    const second = openApp();
    scaffoldWidget(first);
    scaffoldWidget(second);
    expect(first.build()).toBe(second.build());
  });

  it("serializes to a byte-stable document that reparses equal", () => {
    const project = openApp();
    scaffoldWidget(project);
    const text = project.build();

    expect(XcodeProject.parse(text).build()).toBe(text);
    expect(text).toContain('/* Exceptions for "DemoWidget" folder in "DemoWidget" target */');
    expect(text).toContain("/* Begin PBXTargetDependency section */");
    // Generated ids carry the deterministic XX...XX shape and render with
    // derived reference comments.
    expect(text).toMatch(/XX[0-9A-F]{20}XX \/\* DemoWidget\.appex \*\//u);

    const reparsed = XcodeProject.parse(text);
    const widget = reparsed.findTarget("DemoWidget");
    assert(widget);
    expect(widget.getBuildSetting("PRODUCT_BUNDLE_IDENTIFIER")).toBe("com.example.sample.demowidget");
    expect(widget.syncGroupPaths()).toEqual(["DemoWidget"]);
  });

  it("embeds watch applications under the Watch destination", () => {
    const project = openApp();
    const host = project.findMainAppTarget("ios");
    assert(host);

    const watchApp = project.addNativeTarget({
      name: "DemoWatch",
      productType: ProductType.application,
      buildSettings: { WATCHOS_DEPLOYMENT_TARGET: "11.0", SDKROOT: "watchos" },
    });
    expect(watchApp.isWatchOS()).toBe(true);

    const phase = host.embed(watchApp);
    assert(phase);
    expect(phase.name).toBe("Embed Watch Content");
    expect(phase.properties["dstSubfolderSpec"]).toBe(CopyFilesDestination.productsDirectory);
    expect(phase.properties["dstPath"]).toBe("$(CONTENTS_FOLDER_PATH)/Watch");
  });
});

describe("Swift packages", () => {
  it("adds a package once and links products idempotently", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    expect(project.findSwiftPackage("https://github.com/example/example-kit")).toBeUndefined();
    const reference = project.addSwiftPackage({
      repositoryURL: "https://github.com/example/example-kit",
      requirement: { kind: "upToNextMajorVersion", minimumVersion: "2.0.0" },
    });
    expect(project.findSwiftPackage("https://github.com/example/example-kit")).toBe(reference);

    const product = app.addSwiftPackageProduct({ productName: "ExampleKit", packageReference: reference });
    expect(app.addSwiftPackageProduct({ productName: "ExampleKit", packageReference: reference })).toBe(product);

    const frameworks = app.findBuildPhase(Isa.frameworksBuildPhase);
    assert(frameworks);
    const linked = frameworks.buildFileIds.map((id) => project.get(id)?.getString("productRef"));
    expect(linked).toContain(product.id);

    const text = project.build();
    expect(text).toContain('XCRemoteSwiftPackageReference "example-kit"');
    expect(text).toContain("ExampleKit in Frameworks");
    expect(XcodeProject.parse(text).build()).toBe(text);
  });

  it("links system frameworks once", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const reference = app.ensureSystemFramework("Messages");
    expect(app.ensureSystemFramework("Messages")).toBe(reference);
    expect(reference.getString("path")).toBe("System/Library/Frameworks/Messages.framework");
    expect(app.findBuildPhase(Isa.frameworksBuildPhase)?.buildFileIds).toHaveLength(1);
  });
});

describe("build files and phases", () => {
  it("relocates a product between copy phases", () => {
    // Mirrors the ExtensionKit packaging repair: the product's build file
    // must leave every other copy phase and land in the Extensions phase.
    const project = openApp();
    const { host, widget } = scaffoldWidget(project);
    const product = widget.productReference;
    assert(product);

    const [buildFile] = project.buildFilesReferencing(product);
    assert(buildFile);

    widget.productType = ProductType.extensionKitExtension;
    const extensionsPhase = host.ensureBuildPhase(Isa.copyFilesBuildPhase, {
      dstPath: "$(EXTENSIONS_FOLDER_PATH)",
      dstSubfolderSpec: CopyFilesDestination.productsDirectory,
      name: "Embed ExtensionKit Extensions",
    });

    for (const [, view] of project.objects()) {
      if (view instanceof BuildPhase && view.isa === Isa.copyFilesBuildPhase && view !== extensionsPhase) {
        view.removeBuildFile(buildFile.id);
      }
    }
    extensionsPhase.appendBuildFile(buildFile.id);

    const containing = host
      .buildPhases()
      .filter((phase) => phase.isa === Isa.copyFilesBuildPhase && phase.containsBuildFile(buildFile.id));
    expect(containing).toEqual([extensionsPhase]);
  });

  it("adds files to groups and source phases", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const mainGroup = project.rootProject.mainGroup();
    assert(mainGroup);
    const reference = mainGroup.createFile("SampleApp/Config.swift");
    expect(reference.getString("lastKnownFileType")).toBe("sourcecode.swift");

    const sources = app.ensureSourcesPhase();
    const buildFile = sources.ensureBuildFile(reference);
    expect(sources.ensureBuildFile(reference)).toBe(buildFile);

    expect(project.findFileReference("SampleApp/Config.swift")).toBe(reference);
  });
});

describe("failure modes", () => {
  it("rejects documents without model structure", () => {
    expect(() => XcodeProject.parse("( a, b )")).toThrow(XcodeModelError);
    expect(() => XcodeProject.parse("{ a = 1; }")).toThrow(XcodeModelError);
    expect(() => XcodeProject.fromDocument({ objects: {}, rootObject: "MISSING" }).rootProject).toThrow(
      XcodeModelError,
    );
  });

  it("rejects product types it cannot scaffold", () => {
    const project = openApp();
    expect(() =>
      project.addNativeTarget({ name: "Lib", productType: "com.apple.product-type.library.static" }),
    ).toThrow(XcodeModelError);
  });

  it("fails loudly when a view's object was deleted", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);
    delete (project.document["objects"] as Record<string, unknown>)[app.id];
    expect(() => app.properties).toThrow(XcodeModelError);
  });
});

/**
 * Cross-validation against Apple's own parser, mirroring the plutil suite
 * for parser and serializer output: scaffolded documents must be accepted
 * by Apple tooling. Runs only where plutil exists.
 */
describe.skipIf(process.platform !== "darwin")("plutil accepts scaffolded documents", () => {
  it("lints the widget scaffold output", () => {
    const project = openApp();
    scaffoldWidget(project);
    const directory = mkdtempSync(join(tmpdir(), "rork-xcode-model-"));
    try {
      const file = join(directory, "project.pbxproj");
      writeFileSync(file, project.build());
      execFileSync("plutil", ["-lint", file], { stdio: "pipe" });
      execFileSync("plutil", ["-convert", "json", "-o", "/dev/null", file], { stdio: "pipe" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
