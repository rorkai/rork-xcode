/**
 * Views of the project's targets. The behavior all target kinds share
 * lives on the {@link Target} base class, and {@link NativeTarget}
 * extends it with products, embedding, synchronized folders, Swift
 * packages, and system frameworks.
 *
 * Reads are deliberately soft: user-generated projects can be malformed,
 * so lookups return `undefined` instead of throwing wherever a document
 * could legally or illegally omit something. Mutations create any missing
 * structure they need.
 *
 * @module
 */

import { embedDestinationFor, Isa, ProductType } from "./isa";
import { XcodeObject } from "./object";
import {
  BuildPhase,
  BuildRule,
  ConfigurationList,
  FileReference,
  SwiftPackageProductDependency,
  SyncRootGroup,
  TargetDependency,
  type CopyFilesBuildPhase,
  type FrameworksBuildPhase,
  type ResourcesBuildPhase,
  type ShellScriptBuildPhase,
  type SourcesBuildPhase,
} from "./objects";
import { configurationsOf, defaultConfigurationSettingsOf } from "./settings";
import { asString, ensureArray, stringItems } from "./values";

import type { PbxprojObject } from "../types";
import type { BuildPhaseIsa } from "./isa";
import type { BuildConfiguration } from "./objects";
import type { BuildPhaseOf } from "./project";
import type { LegacyTargetProperties, NativeTargetProperties, TargetProperties } from "./properties";

/**
 * The behavior every target kind shares. A target of any kind carries
 * build configurations and settings, build phases, and dependencies, and
 * this class holds their accessors and mutations. `PBXNativeTarget`,
 * `PBXAggregateTarget`, and `PBXLegacyTarget` all extend it, so code that
 * walks or rewires targets can accept any of them.
 */
export class Target<Properties extends TargetProperties = TargetProperties> extends XcodeObject<Properties> {
  /**
   * The target's name, when present.
   */
  get name(): string | undefined {
    return this.getString("name");
  }

  /**
   * The view of the target's configuration list, when the reference
   * resolves.
   */
  configurationList(): ConfigurationList | undefined {
    const view = this.project.get(this.getString("buildConfigurationList"));
    return ConfigurationList.is(view) ? view : undefined;
  }

  /**
   * The views of the target's build configurations, in list order.
   */
  buildConfigurations(): BuildConfiguration[] {
    return configurationsOf(this.project, this.getString("buildConfigurationList"));
  }

  /**
   * The settings dictionary of the target's default configuration, which
   * is the one named by the list's `defaultConfigurationName`, falling
   * back to the first configuration. Returns `undefined` when the target
   * has no configurations or the default carries no settings dictionary.
   */
  defaultConfigurationSettings(): PbxprojObject | undefined {
    return defaultConfigurationSettingsOf(this.project, this.getString("buildConfigurationList"));
  }

  /**
   * Reads a build setting from the target's default configuration,
   * inheriting from the project-level configuration when the target omits
   * the key. This mirrors how Xcode resolves settings hierarchically;
   * generated app templates set values like `SDKROOT` only at the project
   * level.
   *
   * Only string values are returned; a list- or number-valued setting reads
   * as `undefined`.
   */
  getBuildSetting(key: string): string | undefined {
    const targetSettings = this.defaultConfigurationSettings();
    if (targetSettings != null && key in targetSettings) {
      return asString(targetSettings[key]);
    }
    return asString(this.project.rootProject.defaultConfigurationSettings()?.[key]);
  }

  /**
   * Writes a build setting on every configuration of the target, so Debug
   * and Release stay consistent.
   */
  setBuildSetting(key: string, value: string): void {
    for (const configuration of this.buildConfigurations()) {
      const settings = configuration.buildSettings;
      if (settings == null) {
        configuration.properties.buildSettings = { [key]: value };
      } else {
        settings[key] = value;
      }
    }
  }

  /**
   * Removes a build setting from every configuration of the target.
   */
  removeBuildSetting(key: string): void {
    for (const configuration of this.buildConfigurations()) {
      const settings = configuration.buildSettings;
      if (settings != null) {
        delete settings[key];
      }
    }
  }

  /**
   * The views of the target's dependencies, in declaration order. Resolve
   * a dependency's target through {@link TargetDependency.target}.
   */
  dependencies(): TargetDependency[] {
    return this.referencedViews("dependencies").filter((view) => TargetDependency.is(view));
  }

  /**
   * The views of the target's build phases, in build order.
   */
  buildPhases(): BuildPhase[] {
    const phases: BuildPhase[] = [];
    for (const id of stringItems(this.properties["buildPhases"])) {
      const phase = this.project.get(id);
      if (phase instanceof BuildPhase) {
        phases.push(phase);
      }
    }
    return phases;
  }

  /**
   * Finds the target's first build phase with the given isa, and, when
   * `name` is provided, the given display name. An isa literal of the
   * vocabulary types the result, so `findBuildPhase(Isa.copyFilesBuildPhase)`
   * gives a `CopyFilesBuildPhase | undefined`.
   */
  findBuildPhase<I extends string>(isa: I, name?: string): BuildPhaseOf<I> | undefined {
    const found = this.buildPhases().find((phase) => phase.isa === isa && (name == null || phase.name === name));
    // The cast holds because the view factory created each phase from the
    // same isa the find just matched, and BuildPhaseOf names the class the
    // factory picks for it. The compiler alone cannot make that connection.
    return found as BuildPhaseOf<I> | undefined;
  }

  /**
   * Returns the target's build phase with the given isa and properties,
   * creating and appending it when missing. The properties apply only on
   * creation. An existing phase is returned as is, already typed as the
   * phase class the isa names.
   *
   * The match key is the isa plus the `name` property when one is given,
   * so differently named copy-files phases coexist.
   */
  ensureBuildPhase<I extends BuildPhaseIsa>(isa: I, properties: PbxprojObject = {}): BuildPhaseOf<I> {
    const name = asString(properties["name"]);
    const existing = this.findBuildPhase(isa, name);
    if (existing != null) {
      return existing;
    }

    const phase = this.project.add(
      isa,
      {
        isa,
        buildActionMask: 2147483647,
        files: [],
        runOnlyForDeploymentPostprocessing: 0,
        ...properties,
      },
      `${isa} ${this.id} ${name ?? ""}`,
    );
    ensureArray(this.properties, "buildPhases").push(phase.id);
    // ViewOf and BuildPhaseOf agree on every phase isa, but while the isa
    // stays generic the compiler keeps both conditionals unresolved and
    // cannot equate them.
    return phase as BuildPhaseOf<I>;
  }

  /**
   * The target's shell-script phase with the given name, created with the
   * usual defaults (`/bin/sh`, empty input and output lists) when missing.
   * The script and other properties apply only on creation.
   *
   * @param name Display name of the phase, which is also its match key.
   * @param properties Phase properties, most usefully `shellScript`.
   */
  ensureShellScriptPhase(name: string, properties: PbxprojObject = {}): ShellScriptBuildPhase {
    return this.ensureBuildPhase(Isa.shellScriptBuildPhase, {
      inputFileListPaths: [],
      inputPaths: [],
      name,
      outputFileListPaths: [],
      outputPaths: [],
      shellPath: "/bin/sh",
      shellScript: "",
      ...properties,
    });
  }

  /**
   * Adds a dependency on another target of the same project, wiring the
   * `PBXContainerItemProxy` and `PBXTargetDependency` pair Xcode uses to
   * express it. Adding an existing dependency is a no-op.
   *
   * @returns The view of the target dependency object.
   */
  addDependency(dependency: Target): TargetDependency {
    for (const dependencyView of this.dependencies()) {
      if (dependencyView.getString("target") === dependency.id) {
        return dependencyView;
      }
    }

    const proxy = this.project.add(
      Isa.containerItemProxy,
      {
        containerPortal: this.project.rootProject.id,
        proxyType: 1,
        remoteGlobalIDString: dependency.id,
        remoteInfo: dependency.name ?? dependency.id,
      },
      `${Isa.containerItemProxy} ${this.id} ${dependency.id}`,
    );
    const targetDependency = this.project.add(
      Isa.targetDependency,
      {
        target: dependency.id,
        targetProxy: proxy.id,
      },
      `${Isa.targetDependency} ${this.id} ${dependency.id}`,
    );
    ensureArray(this.properties, "dependencies").push(targetDependency.id);
    return targetDependency;
  }
}

/**
 * A `PBXNativeTarget` is a product the project compiles and packages
 * itself, such as an application or an app extension.
 */
export class NativeTarget extends Target<NativeTargetProperties> {
  static readonly isa: string | null = Isa.nativeTarget;

  /**
   * The target's product type identifier, for example
   * `com.apple.product-type.application`.
   */
  get productType(): string | undefined {
    return this.getString("productType");
  }

  /**
   * Rewrites the target's product type. Used by packaging repairs that
   * convert foundation extensions into ExtensionKit extensions.
   */
  set productType(value: string) {
    this.properties["productType"] = value;
  }

  /**
   * The view of the target's product file reference, when the target has
   * one.
   */
  get productReference(): FileReference | undefined {
    const view = this.project.get(this.getString("productReference"));
    return FileReference.is(view) ? view : undefined;
  }

  /**
   * Whether the target builds for watchOS, decided by its product type or
   * its watchOS deployment-target setting.
   */
  isWatchOS(): boolean {
    if (this.productType === ProductType.watchApp) {
      return true;
    }
    const defaultSettings = this.defaultConfigurationSettings();
    return defaultSettings != null && "WATCHOS_DEPLOYMENT_TARGET" in defaultSettings;
  }

  /**
   * The views of the target's Swift package product dependencies, in
   * declaration order.
   */
  packageProductDependencies(): SwiftPackageProductDependency[] {
    return this.referencedViews("packageProductDependencies").filter((view) => SwiftPackageProductDependency.is(view));
  }

  /**
   * The views of the target's file-system-synchronized folders, in
   * declaration order.
   */
  syncGroups(): SyncRootGroup[] {
    return this.referencedViews("fileSystemSynchronizedGroups").filter((view) => SyncRootGroup.is(view));
  }

  /**
   * The views of the target's build rules, in evaluation order. Empty for
   * targets without custom rules, which is nearly all of them.
   */
  buildRules(): BuildRule[] {
    return this.referencedViews("buildRules").filter((view) => BuildRule.is(view));
  }

  /**
   * The target's sources phase, created when missing.
   */
  ensureSourcesPhase(): SourcesBuildPhase {
    return this.ensureBuildPhase(Isa.sourcesBuildPhase);
  }

  /**
   * The target's frameworks phase, created when missing.
   */
  ensureFrameworksPhase(): FrameworksBuildPhase {
    return this.ensureBuildPhase(Isa.frameworksBuildPhase);
  }

  /**
   * The target's resources phase, created when missing.
   */
  ensureResourcesPhase(): ResourcesBuildPhase {
    return this.ensureBuildPhase(Isa.resourcesBuildPhase);
  }

  /**
   * Embeds another target's product into this target through the
   * copy-files phase its product type calls for ("Embed Foundation
   * Extensions", "Embed App Clips", "Embed Watch Content", or "Embed
   * ExtensionKit Extensions").
   *
   * An existing phase with the same name is reused, its destination is
   * repaired to the type's canonical values, and the product's build file
   * is deduplicated, so embedding is idempotent.
   *
   * @returns The view of the embed phase, or `undefined` when the embedded
   *   target has no product reference to embed.
   */
  embed(extension: NativeTarget): CopyFilesBuildPhase | undefined {
    const product = extension.productReference;
    if (product == null) {
      return undefined;
    }

    const destination = embedDestinationFor(extension.isWatchOS() ? ProductType.watchApp : extension.productType);
    const phase = this.ensureBuildPhase(Isa.copyFilesBuildPhase, { name: destination.phaseName });

    // Destination fields are written unconditionally, so a pre-existing
    // phase with the right name but a wrong destination is repaired in
    // passing.
    phase.set("dstPath", destination.dstPath);
    phase.set("dstSubfolderSpec", destination.dstSubfolderSpec);
    phase.ensureBuildFile(product, { settings: { ATTRIBUTES: ["RemoveHeadersOnCopy"] } });
    return phase;
  }

  /**
   * The on-disk folder paths of the file-system-synchronized groups linked
   * to this target. Empty for targets without synchronized folders
   * (projects predating Xcode 16).
   */
  syncGroupPaths(): string[] {
    const paths: string[] = [];
    for (const group of this.syncGroups()) {
      const path = group.path;
      if (path != null) {
        paths.push(path);
      }
    }
    return paths;
  }

  /**
   * Creates a file-system-synchronized folder for an on-disk path, links it
   * to this target, and registers it in the project's main group so Xcode
   * shows it in the navigator. When the target already links a folder with
   * the same path, that folder is returned instead, so re-running a
   * scaffold step cannot duplicate groups.
   *
   * @param path Folder path relative to the project root, for example the
   *   target's name.
   * @returns The view of the target's synchronized folder for the path.
   */
  addSyncGroup(path: string): SyncRootGroup {
    for (const existing of this.syncGroups()) {
      if (existing.path === path) {
        return existing;
      }
    }

    const group = this.project.add(
      Isa.fileSystemSynchronizedRootGroup,
      {
        path,
        sourceTree: "<group>",
      },
      `${Isa.fileSystemSynchronizedRootGroup} ${path}`,
    );
    ensureArray(this.properties, "fileSystemSynchronizedGroups").push(group.id);
    this.project.rootProject.mainGroup()?.addChild(group);
    return group;
  }

  /**
   * Links a Swift package product to this target. It creates the
   * `XCSwiftPackageProductDependency`, registers it on the target, and
   * ensures the frameworks phase carries its build file. Linking an
   * already linked product is a no-op.
   *
   * @param options.productName The product to link, as the package
   *   manifest names it.
   * @param options.packageReference The package reference view returned by
   *   {@link XcodeProject.addSwiftPackage} or
   *   {@link XcodeProject.findSwiftPackage}.
   * @returns The view of the product dependency.
   */
  addSwiftPackageProduct(options: {
    productName: string;
    packageReference: XcodeObject;
  }): SwiftPackageProductDependency {
    for (const existing of this.packageProductDependencies()) {
      if (
        existing.productName === options.productName &&
        existing.getString("package") === options.packageReference.id
      ) {
        return existing;
      }
    }

    const productDependency = this.project.add(
      Isa.swiftPackageProductDependency,
      {
        package: options.packageReference.id,
        productName: options.productName,
      },
      `${Isa.swiftPackageProductDependency} ${this.id} ${options.productName}`,
    );
    ensureArray(this.properties, "packageProductDependencies").push(productDependency.id);
    this.ensureFrameworksPhase().ensureBuildFile(productDependency, { referenceKey: "productRef" });
    return productDependency;
  }

  /**
   * Links a system framework (for example `Messages`) to this target. It
   * reuses or creates the file reference under the SDK's frameworks
   * directory and makes sure the frameworks phase carries its build file.
   * Linking an already linked framework is a no-op.
   *
   * @param name Framework name without the `.framework` suffix.
   * @returns The view of the framework's file reference.
   */
  addSystemFramework(name: string): FileReference {
    const path = `System/Library/Frameworks/${name}.framework`;

    let reference: FileReference | undefined;
    for (const [, view] of this.project.objects()) {
      if (FileReference.is(view) && view.path === path) {
        reference = view;
        break;
      }
    }
    reference ??= this.project.add(
      Isa.fileReference,
      {
        lastKnownFileType: "wrapper.framework",
        name: `${name}.framework`,
        path,
        sourceTree: "SDKROOT",
      },
      `${Isa.fileReference} ${path}`,
    );

    this.ensureFrameworksPhase().ensureBuildFile(reference);
    return reference;
  }
}

/**
 * An aggregate target produces nothing itself. It exists to group other
 * targets through its dependencies and to run script or copy-files
 * phases, and the shared target surface covers everything it carries.
 */
export class AggregateTarget extends Target {
  static readonly isa: string | null = Isa.aggregateTarget;
}

/**
 * A legacy target shells out to an external build tool such as make
 * instead of using Xcode's build system.
 */
export class LegacyTarget extends Target<LegacyTargetProperties> {
  static readonly isa: string | null = Isa.legacyTarget;
  /**
   * The build tool the target invokes, as an absolute path.
   */
  get buildToolPath(): string | undefined {
    return this.getString("buildToolPath");
  }

  /**
   * The arguments passed to the build tool, as one shell-style string.
   */
  get buildArgumentsString(): string | undefined {
    return this.getString("buildArgumentsString");
  }

  /**
   * The working directory the build tool runs in, when the target sets
   * one.
   */
  get buildWorkingDirectory(): string | undefined {
    return this.getString("buildWorkingDirectory");
  }
}
