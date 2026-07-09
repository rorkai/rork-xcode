import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AggregateTarget,
  BuildConfiguration,
  BuildFile,
  BuildFileExceptionSet,
  BuildPhase,
  BuildPhaseMembershipExceptionSet,
  BuildRule,
  ConfigurationList,
  ContainerItemProxy,
  CopyFilesBuildPhase,
  CopyFilesDestination,
  ExceptionSet,
  FileReference,
  Group,
  Isa,
  LegacyTarget,
  NativeTarget,
  parseApplePlatform,
  ProductType,
  ReferenceProxy,
  RemoteSwiftPackageReference,
  ShellScriptBuildPhase,
  SourcesBuildPhase,
  SwiftPackageProductDependency,
  SwiftPackageReference,
  TargetDependency,
  VersionGroup,
  Xcconfig,
  XcodeModelError,
  XcodeProject,
  type PbxprojObject,
  type SyncRootGroup,
  type ViewByIsa,
  type XcodeObject,
} from "../src/index";

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");
}

/**
 * Appends an id to an object's list property, creating the list when
 * missing. Tests register hand-built objects (aggregate targets, build
 * rules) the way the model's own mutations do.
 */
function ensurePush(container: PbxprojObject, key: string, id: string): void {
  const list = (container[key] ??= []);
  assert(Array.isArray(list));
  list.push(id);
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

    // Re-adding merges into the target's set instead of creating another.
    expect(syncGroup.addMembershipExceptions(widget, ["Info.plist", "Secrets.plist"])).toBe(exceptionSet);
    expect(exceptionSet.properties["membershipExceptions"]).toEqual(["Info.plist", "Secrets.plist"]);
    expect(syncGroup.properties["exceptions"]).toHaveLength(1);

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
    expect(phase.dstSubfolderSpec).toBe(CopyFilesDestination.productsDirectory);
    expect(phase.dstPath).toBe("$(CONTENTS_FOLDER_PATH)/Watch");
  });

  it("reads embedded targets back through the copy-files phases", () => {
    const project = openApp();
    const host = project.findMainAppTarget("ios");
    assert(host);
    expect(host.embeddedTargets()).toEqual([]);

    const widget = project.addNativeTarget({ name: "DemoWidget", productType: ProductType.appExtension });
    const clip = project.addNativeTarget({
      name: "DemoClip",
      productType: ProductType.onDemandInstallCapableApplication,
    });
    host.embed(widget);
    host.embed(clip);
    // Embedding twice must not duplicate the target in the read-back.
    host.embed(widget);

    // Phase order is creation order, so the widget's embed phase walks first.
    expect(host.embeddedTargets()).toEqual([widget, clip]);
    expect(widget.embeddedTargets()).toEqual([]);
    expect(project.validate()).toEqual([]);
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
    // Re-adding the same repository returns the existing reference.
    expect(
      project.addSwiftPackage({
        repositoryURL: "https://github.com/example/example-kit",
        requirement: { kind: "upToNextMajorVersion", minimumVersion: "9.9.9" },
      }),
    ).toBe(reference);

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

    const reference = app.addSystemFramework("Messages");
    expect(app.addSystemFramework("Messages")).toBe(reference);
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

describe("typed properties", () => {
  it("autocompletes known keys while keeping the shape open", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    // Known keys read with their declared types. The annotations are
    // compile-time assertions as much as runtime ones.
    const name: string | undefined = app.properties.name;
    expect(name).toBe("SampleApp");
    const phases: string[] | undefined = app.properties.buildPhases;
    expect(Array.isArray(phases)).toBe(true);

    // Unknown keys stay first-class through the index signature.
    app.properties["INFOPLIST_KEY_CustomProbe"] = "YES";
    expect(app.getString("INFOPLIST_KEY_CustomProbe")).toBe("YES");

    const mainGroup = project.rootProject.mainGroup();
    assert(mainGroup);
    const children: string[] | undefined = mainGroup.properties.children;
    expect(children).toEqual(mainGroup.childIds);
  });
});

describe("typed reference accessors", () => {
  it("exposes dependencies, package products, sync groups, and children as views", () => {
    const project = openApp();
    const { host, widget, syncGroup } = scaffoldWidget(project);

    const [dependency] = host.dependencies().slice(-1);
    assert(dependency);
    expect(dependency.getString("target")).toBe(widget.id);

    expect(widget.syncGroups()).toEqual([syncGroup]);

    const pkg = project.addSwiftPackage({
      repositoryURL: "https://github.com/example/example-kit",
      requirement: { kind: "upToNextMajorVersion", minimumVersion: "1.0.0" },
    });
    const product = widget.addSwiftPackageProduct({ productName: "ExampleKit", packageReference: pkg });
    expect(widget.packageProductDependencies()).toEqual([product]);
    expect(project.rootProject.packageReferences()).toEqual([pkg]);

    const mainGroup = project.rootProject.mainGroup();
    assert(mainGroup);
    expect(mainGroup.children().map((child) => child.id)).toEqual(mainGroup.childIds);
  });
});

describe("nested groups", () => {
  it("creates intermediate groups once and reuses them", () => {
    const project = openApp();
    const mainGroup = project.rootProject.mainGroup();
    assert(mainGroup);

    const generated = mainGroup.ensureGroup("Sources/Generated");
    expect(generated.getString("path")).toBe("Generated");
    expect(mainGroup.ensureGroup("Sources/Generated")).toBe(generated);
    expect(mainGroup.ensureGroup("")).toBe(mainGroup);

    const file = generated.createFile("Config.swift");
    expect(project.findFileReference("Sources/Generated/Config.swift")).toBe(file);
  });
});

describe("local Swift packages", () => {
  it("adds a path-based package and links its products", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    expect(project.findLocalSwiftPackage("Packages/DesignSystem")).toBeUndefined();
    const reference = project.addLocalSwiftPackage("Packages/DesignSystem");
    expect(project.findLocalSwiftPackage("Packages/DesignSystem")).toBe(reference);
    expect(project.addLocalSwiftPackage("Packages/DesignSystem")).toBe(reference);

    app.addSwiftPackageProduct({ productName: "DesignSystem", packageReference: reference });
    const text = project.build();
    expect(text).toContain('XCLocalSwiftPackageReference "Packages/DesignSystem"');
    expect(XcodeProject.parse(text).build()).toBe(text);
  });
});

describe("shell-script phases", () => {
  it("creates a named script phase with defaults and matches it on re-ensure", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const phase = app.ensureShellScriptPhase("Lint", { shellScript: "lint\n" });
    expect(phase.getString("shellPath")).toBe("/bin/sh");
    expect(phase.getString("shellScript")).toBe("lint\n");
    expect(app.ensureShellScriptPhase("Lint")).toBe(phase);

    const text = project.build();
    expect(text).toContain("/* Lint */");
    expect(XcodeProject.parse(text).build()).toBe(text);
  });
});

describe("removal", () => {
  it("finds referrers across property shapes", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const referrerIsas = project.referrersOf(app.id).map((referrer) => referrer.isa);
    // The root project references the target twice: the targets list and
    // the TargetAttributes dictionary keyed by target id.
    expect(referrerIsas).toContain(Isa.project);
  });

  it("rejects targets that belong to another project", () => {
    const project = openApp();
    const other = openApp();
    const foreign = other.findMainAppTarget("ios");
    assert(foreign);
    expect(() => project.removeTarget(foreign)).toThrow(XcodeModelError);
  });

  it("removes the target's own dependencies and their proxies", () => {
    const project = openApp();
    const dependencyCount = () => [...project.objects()].filter(([, view]) => view.isa === Isa.targetDependency).length;
    const proxyCount = () => [...project.objects()].filter(([, view]) => view.isa === Isa.containerItemProxy).length;

    // The fixture's test targets already depend on the app; measure from
    // that baseline.
    const baselineDependencies = dependencyCount();
    const baselineProxies = proxyCount();

    // Wire two pairs around the widget: the host depends on it, and it
    // depends on a helper extension.
    const { widget } = scaffoldWidget(project);
    const helper = project.addNativeTarget({ name: "HelperExt", productType: ProductType.appExtension });
    widget.addDependency(helper);
    expect(dependencyCount()).toBe(baselineDependencies + 2);
    expect(proxyCount()).toBe(baselineProxies + 2);

    // Removing the widget tears down both directions; nothing dangles.
    project.removeTarget(widget);
    expect(dependencyCount()).toBe(baselineDependencies);
    expect(proxyCount()).toBe(baselineProxies);
    expect(project.findTarget("HelperExt")).toBeDefined();
  });

  it("strips references nested inside array elements", () => {
    const project = XcodeProject.fromDocument({
      objects: {
        A1: { isa: "PBXFileReference", path: "App.swift", sourceTree: "<group>" },
        B1: {
          isa: "XCBuildConfiguration",
          buildSettings: {
            // A dictionary inside an array inside the settings dictionary;
            // reference lists are normally flat, but the scrub must reach
            // any depth the value model allows.
            CUSTOM: [{ ref: "A1" }, "A1", "keep"],
          },
          name: "Debug",
        },
      },
      rootObject: "P1",
    });

    project.removeObject("A1");
    const configuration = project.get("B1");
    assert(configuration);
    const settings = configuration.properties["buildSettings"] as Record<string, unknown>;
    expect(settings["CUSTOM"]).toEqual([{}, "keep"]);
  });

  it("removeObject strips references everywhere", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);
    const id = app.id;

    project.removeObject(id);
    expect(project.get(id)).toBeUndefined();
    expect(project.rootProject.targetIds()).not.toContain(id);
    for (const [, view] of project.objects()) {
      expect(JSON.stringify(view.properties)).not.toContain(id);
    }
    // Removing again is a no-op.
    project.removeObject(id);
  });

  it("removeTarget tears down everything the target owns", () => {
    const project = openApp();
    const { host, widget } = scaffoldWidget(project);
    const before = XcodeProject.parse(fixture("app-xcode16.pbxproj"));

    project.removeTarget(widget);

    // No dangling widget artifacts: no build phases, configurations,
    // product references, dependencies, proxies, exception sets, or sync
    // groups mentioning the removed target survive.
    const dump = project.build();
    expect(dump).not.toContain("DemoWidget");
    expect(host.dependencies()).toHaveLength(before.findMainAppTarget("ios")?.dependencies().length ?? 0);

    // The document still parses, reserializes stably, and keeps the
    // original targets.
    expect(
      XcodeProject.parse(dump)
        .nativeTargets()
        .map((target) => target.name),
    ).toEqual(["SampleApp", "SampleAppTests", "SampleAppUITests"]);
    expect(XcodeProject.parse(dump).build()).toBe(dump);
  });

  it("keeps synchronized folders another target still links", () => {
    const project = openApp();
    const { widget } = scaffoldWidget(project);
    const second = project.addNativeTarget({ name: "SecondWidget", productType: ProductType.appExtension });

    // Link the same folder to a second target, then remove the first.
    const [group] = widget.syncGroups();
    assert(group);
    second.properties["fileSystemSynchronizedGroups"] = [group.id];

    project.removeTarget(widget);
    expect(project.get(group.id)).toBeDefined();
    expect(second.syncGroupPaths()).toEqual(["DemoWidget"]);
  });
});

describe("target rename", () => {
  it("renames the app target everywhere the document names it", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    project.renameTarget(app, "Rocket");

    expect(app.name).toBe("Rocket");
    expect(app.getString("productName")).toBe("Rocket");
    expect(app.productReference?.path).toBe("Rocket.app");

    // Test bundles keep working against the renamed host: the unit test
    // host path renames per segment, the UI test target name renames
    // whole, and the dependency proxies' display names follow.
    const tests = project.findTarget("SampleAppTests");
    const uiTests = project.findTarget("SampleAppUITests");
    assert(tests && uiTests);
    expect(tests.getBuildSetting("TEST_HOST")).toBe(
      "$(BUILT_PRODUCTS_DIR)/Rocket.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/Rocket",
    );
    expect(uiTests.getBuildSetting("TEST_TARGET_NAME")).toBe("Rocket");
    expect(tests.dependencies()[0]?.targetProxy()?.remoteInfo).toBe("Rocket");

    // Sibling products own their names; the stem match must not treat
    // SampleAppTests.xctest as the renamed target's product.
    expect(tests.productReference?.path).toBe("SampleAppTests.xctest");

    // PRODUCT_NAME stays $(TARGET_NAME) and follows by itself.
    expect(app.buildConfigurations()[0]?.buildSettings?.PRODUCT_NAME).toBe("$(TARGET_NAME)");

    // Comments regenerate from the new names, and the result is a stable
    // canonical document.
    const text = project.build();
    expect(text).toContain("/* Rocket.app */");
    expect(text).not.toContain("SampleApp.app");
    expect(XcodeProject.parse(text).build()).toBe(text);
  });

  it("renames a test target without touching its host", () => {
    const project = openApp();
    const tests = project.findTarget("SampleAppTests");
    assert(tests);

    project.renameTarget(tests, "RocketTests");

    expect(tests.name).toBe("RocketTests");
    expect(tests.productReference?.path).toBe("RocketTests.xctest");

    // The app target and the settings naming it stay as they were, and
    // the indirection through $(TEST_HOST) is not mistaken for a path.
    const app = project.findMainAppTarget("ios");
    assert(app);
    expect(app.name).toBe("SampleApp");
    expect(tests.getBuildSetting("TEST_HOST")).toBe(
      "$(BUILT_PRODUCTS_DIR)/SampleApp.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/SampleApp",
    );
    expect(tests.getBuildSetting("BUNDLE_LOADER")).toBe("$(TEST_HOST)");
  });

  it("leaves the document byte-identical when the name is unchanged", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);
    const before = project.build();

    project.renameTarget(app, "SampleApp");
    expect(project.build()).toBe(before);
  });

  it("rejects targets that belong to another project", () => {
    const project = openApp();
    const foreign = openApp().findMainAppTarget("ios");
    assert(foreign);
    expect(() => project.renameTarget(foreign, "Rocket")).toThrow(XcodeModelError);
  });
});

describe("aggregate targets, legacy targets, and exotic references", () => {
  it("types aggregate targets and gives them the shared target surface", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const aggregate = project.add(Isa.aggregateTarget, { buildPhases: [], dependencies: [], name: "All" });
    ensurePush(project.rootProject.properties, "targets", aggregate.id);
    assert(aggregate instanceof AggregateTarget);

    aggregate.addDependency(app);
    aggregate.addDependency(app);
    expect(aggregate.dependencies()).toHaveLength(1);

    const script = aggregate.ensureShellScriptPhase("Run Checks", { shellScript: "true" });
    expect(aggregate.buildPhases().map((phase) => phase.id)).toEqual([script.id]);
    expect(project.targets().map((target) => target.name)).toContain("All");
    expect(project.nativeTargets().map((target) => target.name)).not.toContain("All");
    expect(project.validate()).toEqual([]);

    // The cascading teardown handles non-native targets too.
    const dependencyIds = aggregate.dependencies().map((dependency) => dependency.id);
    project.removeTarget(aggregate);
    expect(project.get(aggregate.id)).toBeUndefined();
    for (const id of dependencyIds) {
      expect(project.get(id)).toBeUndefined();
    }
    expect(project.validate()).toEqual([]);
  });

  it("types legacy targets with their build-tool properties", () => {
    const project = openApp();
    const legacy = project.add(Isa.legacyTarget, {
      buildArgumentsString: "$(ACTION)",
      buildToolPath: "/usr/bin/make",
      buildWorkingDirectory: "vendor",
      name: "Makefile",
    });
    ensurePush(project.rootProject.properties, "targets", legacy.id);

    assert(legacy instanceof LegacyTarget);
    expect(legacy.buildToolPath).toBe("/usr/bin/make");
    expect(legacy.buildArgumentsString).toBe("$(ACTION)");
    expect(legacy.buildWorkingDirectory).toBe("vendor");
    expect(project.targets().map((target) => target.name)).toContain("Makefile");
    expect(project.validate()).toEqual([]);
  });

  it("types build rules and lists them from their target", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const rule = project.add(Isa.buildRule, {
      compilerSpec: "com.apple.compilers.proxy.script",
      filePatterns: "*.gen",
      fileType: "pattern.proxy",
      inputFiles: [],
      isEditable: 1,
      outputFiles: ["$(DERIVED_FILE_DIR)/$(INPUT_FILE_BASE).swift"],
      script: "generate\n",
    });
    ensurePush(app.properties, "buildRules", rule.id);

    const [typed] = app.buildRules();
    assert(typed instanceof BuildRule);
    expect(typed.script).toBe("generate\n");
    expect(project.validate()).toEqual([]);
  });

  it("types version groups and switches the active Core Data model", () => {
    const project = openApp();
    const mainGroup = project.rootProject.mainGroup();
    assert(mainGroup);

    const v1 = project.add(Isa.fileReference, { path: "Model.xcdatamodel", sourceTree: "<group>" });
    const v2 = project.add(Isa.fileReference, { path: "Model 2.xcdatamodel", sourceTree: "<group>" });
    const group = project.add(Isa.versionGroup, {
      children: [v1.id],
      currentVersion: v1.id,
      path: "Model.xcdatamodeld",
      sourceTree: "<group>",
      versionGroupType: "wrapper.xcdatamodel",
    });
    mainGroup.addChild(group);

    assert(group instanceof VersionGroup);
    expect(group.currentVersion()?.id).toBe(v1.id);

    group.setCurrentVersion(v2);
    expect(group.currentVersion()?.id).toBe(v2.id);
    expect(group.childIds).toEqual([v1.id, v2.id]);
    expect(project.validate()).toEqual([]);
  });

  it("types reference proxies and resolves their remote reference", () => {
    const project = openApp();
    const mainGroup = project.rootProject.mainGroup();
    assert(mainGroup);

    const remote = project.add(Isa.containerItemProxy, {
      containerPortal: project.rootProject.id,
      proxyType: 2,
      remoteGlobalIDString: "0123456789ABCDEF01234567",
      remoteInfo: "OtherLib",
    });
    const proxy = project.add(Isa.referenceProxy, {
      fileType: "archive.ar",
      path: "libOther.a",
      remoteRef: remote.id,
      sourceTree: "BUILT_PRODUCTS_DIR",
    });
    mainGroup.addChild(proxy);

    assert(proxy instanceof ReferenceProxy);
    expect(proxy.path).toBe("libOther.a");
    expect(proxy.remoteReference()?.id).toBe(remote.id);
    expect(project.validate()).toEqual([]);
  });
});

describe("xcconfig layering", () => {
  it("resolves build settings through registered xcconfig files in Xcode's order", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const targetReference = project.add(
      Isa.fileReference,
      { lastKnownFileType: "text.xcconfig", path: "Config/Target.xcconfig", sourceTree: "<group>" },
      "target xcconfig",
    );
    const projectReference = project.add(
      Isa.fileReference,
      { lastKnownFileType: "text.xcconfig", path: "Config/Project.xcconfig", sourceTree: "<group>" },
      "project xcconfig",
    );

    for (const configuration of app.buildConfigurations()) {
      configuration.set("baseConfigurationReference", targetReference.id);
    }
    const projectList = project.get(project.rootProject.getString("buildConfigurationList"));
    assert(ConfigurationList.is(projectList));
    for (const configuration of projectList.configurations()) {
      configuration.set("baseConfigurationReference", projectReference.id);
    }
    expect(app.buildConfigurations()[0]?.baseConfigurationReference()).toBe(targetReference);

    // Unregistered files contribute nothing, preserving prior behavior.
    expect(app.getBuildSetting("XCCONFIG_ONLY")).toBeUndefined();

    project.registerXcconfig(
      targetReference,
      Xcconfig.parse("XCCONFIG_ONLY = from-target-xcconfig\nSWIFT_VERSION = 6.0\nFROM_INCLUDE = direct\n"),
    );
    project.registerXcconfig(
      projectReference,
      Xcconfig.parse("PROJECT_XCCONFIG_ONLY = from-project-xcconfig\nXCCONFIG_ONLY = from-project-xcconfig\n"),
    );

    // A key only the xcconfig files carry resolves through them, with the
    // target's file shadowing the project's.
    expect(app.getBuildSetting("XCCONFIG_ONLY")).toBe("from-target-xcconfig");
    expect(app.getBuildSetting("PROJECT_XCCONFIG_ONLY")).toBe("from-project-xcconfig");

    // Explicit configuration settings still win over the xcconfig layer.
    app.setBuildSetting("SWIFT_VERSION", "5.10");
    expect(app.getBuildSetting("SWIFT_VERSION")).toBe("5.10");

    // Project-level pbxproj settings sit above the project xcconfig; the
    // fixture defines SDKROOT there, so a project xcconfig cannot mask it.
    project.registerXcconfig(projectReference, Xcconfig.parse("SDKROOT = appletvos\n"));
    expect(app.getBuildSetting("SDKROOT")).toBe("iphoneos");
  });

  it("registers includes through the resolver", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const reference = project.add(
      Isa.fileReference,
      { lastKnownFileType: "text.xcconfig", path: "Config/App.xcconfig", sourceTree: "<group>" },
      "including xcconfig",
    );
    for (const configuration of app.buildConfigurations()) {
      configuration.set("baseConfigurationReference", reference.id);
    }

    const shared = Xcconfig.parse("FROM_SHARED = yes\n");
    project.registerXcconfig(reference, Xcconfig.parse('#include "shared.xcconfig"\nOWN = yes\n'), {
      resolveInclude: (path) => (path === "shared.xcconfig" ? shared : undefined),
    });

    expect(app.getBuildSetting("FROM_SHARED")).toBe("yes");
    expect(app.getBuildSetting("OWN")).toBe("yes");
  });
});

describe("parseApplePlatform", () => {
  it("normalizes casing, separators, and SDK names to platforms", () => {
    expect(parseApplePlatform("ios")).toBe("ios");
    expect(parseApplePlatform("tvOS")).toBe("tvos");
    expect(parseApplePlatform("TV_OS")).toBe("tvos");
    expect(parseApplePlatform("VISION_OS")).toBe("visionos");
    expect(parseApplePlatform("appletvos")).toBe("tvos");
    expect(parseApplePlatform("appletvsimulator")).toBe("tvos");
    expect(parseApplePlatform("iphoneos")).toBe("ios");
    expect(parseApplePlatform("xros")).toBe("visionos");
    expect(parseApplePlatform("MACOSX")).toBe("macos");
    expect(parseApplePlatform("watchOS")).toBe("watchos");
    expect(parseApplePlatform("android")).toBeUndefined();
    expect(parseApplePlatform("")).toBeUndefined();
  });

  it("feeds main-app-target lookups directly", () => {
    const project = openApp();
    const platform = parseApplePlatform("IOS") ?? "ios";
    expect(project.findMainAppTarget(platform)?.name).toBe("SampleApp");
  });
});

describe("typed views and narrowing", () => {
  it("covers every Isa value with a view class that declares it", () => {
    const project = XcodeProject.fromDocument({ objects: {}, rootObject: "XXROOT000000000000000000" });
    for (const isa of Object.values(Isa)) {
      const view = project.add(isa, {});
      // A base XcodeObject marks a kind outside the vocabulary; every
      // listed isa must map to a view class declaring exactly that isa.
      expect((view.constructor as typeof XcodeObject).isa, isa).toBe(isa);
    }
    // The ViewByIsa type map must mirror the Isa vocabulary exactly, or
    // typed creation helpers would fall back to base classes silently.
    expectTypeOf<keyof ViewByIsa>().toEqualTypeOf<(typeof Isa)[keyof typeof Isa]>();
  });

  it("types creation and lookup returns by the isa literal", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const reference = project.add(Isa.fileReference, { path: "Extra.swift", sourceTree: "<group>" });
    expectTypeOf(reference).toEqualTypeOf<FileReference>();
    expect(reference).toBeInstanceOf(FileReference);

    const embedPhase = app.ensureBuildPhase(Isa.copyFilesBuildPhase, { name: "Embed Extras" });
    expectTypeOf(embedPhase).toEqualTypeOf<CopyFilesBuildPhase>();
    expect(embedPhase).toBeInstanceOf(CopyFilesBuildPhase);
    expect(embedPhase.dstPath).toBeUndefined();

    const found = app.findBuildPhase(Isa.copyFilesBuildPhase, "Embed Extras");
    expectTypeOf(found).toEqualTypeOf<CopyFilesBuildPhase | undefined>();
    expect(found).toBe(embedPhase);

    // A non-literal isa falls back to the generic types.
    const dynamicIsa: string = Isa.sourcesBuildPhase;
    expectTypeOf(project.add(dynamicIsa, {})).toEqualTypeOf<XcodeObject>();
    expectTypeOf(app.findBuildPhase(dynamicIsa)).toEqualTypeOf<BuildPhase | undefined>();
  });

  it("resolves typed relationships across the graph", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const list = app.configurationList();
    assert(ConfigurationList.is(list));
    expect(list.defaultConfigurationName).toBe("Release");
    expect(list.configurations().map((configuration) => configuration.name)).toEqual(["Debug", "Release"]);

    const widget = project.addNativeTarget({ name: "Widget", productType: ProductType.appExtension });
    const dependency = app.addDependency(widget);
    assert(TargetDependency.is(dependency));
    expect(dependency.target()).toBe(widget);
    expect(dependency.targetProxy()?.remoteInfo).toBe("Widget");

    const packageReference = project.addSwiftPackage({
      repositoryURL: "https://github.com/example/demo-kit.git",
      requirement: { kind: "upToNextMajorVersion", minimumVersion: "1.0.0" },
    });
    assert(RemoteSwiftPackageReference.is(packageReference));
    expect(SwiftPackageReference.is(packageReference)).toBe(true);
    expect(packageReference.repositoryURL).toBe("https://github.com/example/demo-kit.git");

    const product = app.addSwiftPackageProduct({ productName: "DemoKit", packageReference });
    assert(SwiftPackageProductDependency.is(product));
    expect(product.productName).toBe("DemoKit");
    expect(product.packageReference()).toBe(packageReference);

    const [buildFile] = project.buildFilesReferencing(product);
    assert(BuildFile.is(buildFile));
    expect(buildFile.productDependency()).toBe(product);

    const syncGroup = widget.addSyncGroup("Widget");
    const exceptionSet = syncGroup.addMembershipExceptions(widget, ["Info.plist"]);
    assert(BuildFileExceptionSet.is(exceptionSet));
    expect(ExceptionSet.is(exceptionSet)).toBe(true);
    expect(exceptionSet.membershipExceptions).toEqual(["Info.plist"]);
    expect(exceptionSet.target()).toBe(widget);

    const sources = app.ensureSourcesPhase();
    expect(SourcesBuildPhase.is(sources)).toBe(true);

    const script = app.ensureShellScriptPhase("Lint", { shellScript: "swiftlint\n" });
    expect(ShellScriptBuildPhase.is(script)).toBe(true);
    expect(script.shellScript).toBe("swiftlint\n");
    expect(script.shellPath).toBe("/bin/sh");

    const embedPhase = app.embed(widget);
    assert(CopyFilesBuildPhase.is(embedPhase));
    expect(embedPhase.dstPath).toBe("");

    const membership = project.add(Isa.fileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet, {
      buildPhase: sources.id,
      membershipExceptions: ["Shared.swift"],
      target: app.id,
    });
    assert(BuildPhaseMembershipExceptionSet.is(membership));
    expect(membership.buildPhase()).toBe(sources);
    project.removeObject(membership.id);
  });

  it("narrows mixed objects with the is() helper", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    expect(NativeTarget.is(app)).toBe(true);
    expect(Group.is(app)).toBe(false);
    expect(NativeTarget.is(undefined)).toBe(false);
    expect(NativeTarget.is("XX0000000000000000000000")).toBe(false);

    // Subclasses match their parent class, the way instanceof does.
    const versionGroup = project.add(Isa.versionGroup, { children: [], path: "Model.xcdatamodeld" });
    expect(VersionGroup.is(versionGroup)).toBe(true);
    expect(Group.is(versionGroup)).toBe(true);

    const kinds = { configurations: 0, fileReferences: 0, proxies: 0 };
    for (const [, object] of project.objects()) {
      if (BuildConfiguration.is(object)) kinds.configurations += 1;
      if (FileReference.is(object)) kinds.fileReferences += 1;
      if (ContainerItemProxy.is(object)) kinds.proxies += 1;
    }
    expect(kinds.configurations).toBeGreaterThan(0);
    expect(kinds.fileReferences).toBeGreaterThan(0);
  });

  it("gives build configurations a typed live settings dictionary", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const [configuration] = app.buildConfigurations();
    assert(BuildConfiguration.is(configuration));
    expect(configuration.name).toMatch(/Debug|Release/u);

    const settings = configuration.buildSettings;
    assert(settings);
    expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe("com.example.sample");

    // The dictionary is live, so writes land in the built document.
    settings.TEST_TARGET_NAME = "SampleTests";
    expect(project.build()).toContain("TEST_TARGET_NAME = SampleTests;");
  });

  it("types file references and container proxies from the factory", () => {
    const project = openApp();
    const app = project.findMainAppTarget("ios");
    assert(app);

    const product = app.productReference;
    assert(FileReference.is(product));
    expect(product.path).toMatch(/\.app$/u);

    const widget = project.addNativeTarget({ name: "Widget", productType: ProductType.appExtension });
    app.addDependency(widget);
    const [dependency] = app.dependencies();
    const proxy = project.get(dependency?.getString("targetProxy"));
    assert(ContainerItemProxy.is(proxy));
    expect(proxy.remoteInfo).toBe("Widget");
    proxy.properties.remoteInfo = "RenamedWidget";
    expect(proxy.remoteInfo).toBe("RenamedWidget");
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
