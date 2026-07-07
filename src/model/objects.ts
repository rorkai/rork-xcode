/**
 * Typed views over the document object kinds that are not targets, from
 * groups and build phases to version groups and reference proxies.
 *
 * Each class adds the accessors and mutations its kind supports; everything
 * ultimately reads and writes the raw dictionaries through the base class,
 * so mixing model calls with direct property access stays safe.
 *
 * @module
 */

import { FILE_TYPE_BY_EXTENSION, Isa } from "./isa";
import { XcodeObject } from "./object";
import { asDictionary, ensureArray, stringItems } from "./values";

import type {
  BuildConfigurationProperties,
  BuildFileProperties,
  BuildPhaseMembershipExceptionSetProperties,
  BuildPhaseProperties,
  BuildRuleProperties,
  BuildSettings,
  BuildStyleProperties,
  ConfigurationListProperties,
  ContainerItemProxyProperties,
  CopyFilesBuildPhaseProperties,
  ExceptionSetProperties,
  FileReferenceProperties,
  GroupProperties,
  LocalSwiftPackageReferenceProperties,
  ReferenceProxyProperties,
  RemoteSwiftPackageReferenceProperties,
  ShellScriptBuildPhaseProperties,
  SwiftPackageProductDependencyProperties,
  SwiftPackageReferenceProperties,
  SyncRootGroupProperties,
  TargetDependencyProperties,
  VersionGroupProperties,
} from "./properties";
import type { NativeTarget } from "./target";

/**
 * A `PBXGroup` is a folder in Xcode's navigator, holding references to
 * files and other groups. The type parameter lets subclasses carry a more
 * specific property shape.
 */
export class Group<Properties extends GroupProperties = GroupProperties> extends XcodeObject<Properties> {
  static readonly isa: string | null = Isa.group;
  /**
   * Ids of the group's children, in navigator order. Non-string entries of
   * a malformed document are skipped.
   */
  get childIds(): string[] {
    return stringItems(this.properties["children"]);
  }

  /**
   * The views of the group's children, in navigator order.
   */
  children(): XcodeObject[] {
    return this.referencedViews("children");
  }

  /**
   * Adds an existing object (a file reference or another group) to the end
   * of the group's children. Adding a child the group already lists is a
   * no-op.
   */
  addChild(child: XcodeObject): void {
    const children = ensureArray(this.properties, "children");
    if (!children.includes(child.id)) {
      children.push(child.id);
    }
  }

  /**
   * Returns the descendant group for a `/`-separated path, creating any
   * missing groups along the way. Each component matches a child group by
   * its `path`, falling back to its `name`; created groups carry the
   * component as their `path` so they mirror folders on disk.
   *
   * ```ts
   * const generated = mainGroup.ensureGroup("Sources/Generated");
   * generated.createFile("Config.swift");
   * ```
   */
  ensureGroup(path: string): Group {
    const components = path.split("/").filter((component) => component !== "");
    return components.reduce<Group>((parent, component) => {
      const existing = parent
        .children()
        .find(
          (child): child is Group =>
            child instanceof Group && (child.getString("path") ?? child.getString("name")) === component,
        );
      if (existing != null) {
        return existing;
      }
      const created = this.project.add(
        Isa.group,
        { children: [], path: component, sourceTree: "<group>" },
        `${Isa.group} ${parent.id} ${component}`,
      );
      parent.addChild(created);
      return created;
    }, this);
  }

  /**
   * Creates a `PBXFileReference` for a path relative to this group and adds
   * it to the group's children.
   *
   * The reference's `lastKnownFileType` derives from the file extension
   * when it is a known kind; otherwise the reference carries no type and
   * Xcode re-derives one on open.
   *
   * @param path File path relative to the group, for example
   *   `Demo/Config.swift`.
   * @returns The view of the created file reference.
   */
  createFile(path: string): XcodeObject {
    const extensionStart = path.lastIndexOf(".");
    const fileType = extensionStart === -1 ? undefined : FILE_TYPE_BY_EXTENSION[path.slice(extensionStart)];

    const reference = this.project.add(
      Isa.fileReference,
      {
        ...(fileType == null ? {} : { lastKnownFileType: fileType }),
        path,
        sourceTree: "<group>",
      },
      `${Isa.fileReference} ${path}`,
    );
    this.addChild(reference);
    return reference;
  }
}

/**
 * A `PBXVariantGroup` holds the localized variants of one file, one child
 * per language. Everything else behaves like a plain group.
 */
export class VariantGroup extends Group {
  static readonly isa: string | null = Isa.variantGroup;
}

/**
 * A build phase is an ordered list of build files processed by one step
 * of a target's build. Every `PBX*BuildPhase` kind extends this view, and
 * kinds without a class of their own still map here through the factory's
 * suffix fallback. The type parameter lets subclasses carry a more
 * specific property shape.
 */
export class BuildPhase<
  Properties extends BuildPhaseProperties = BuildPhaseProperties,
> extends XcodeObject<Properties> {
  /**
   * The phase's display name, when it carries an explicit one. Xcode names
   * copy-files and shell-script phases; the standard phases derive their
   * names from their isa.
   */
  get name(): string | undefined {
    return this.getString("name");
  }

  /**
   * Ids of the phase's `PBXBuildFile` entries, in build order.
   */
  get buildFileIds(): string[] {
    return stringItems(this.properties["files"]);
  }

  /**
   * Whether the phase already lists the build file.
   */
  containsBuildFile(buildFileId: string): boolean {
    return this.buildFileIds.includes(buildFileId);
  }

  /**
   * Appends an existing build file to the phase unless it is already
   * listed.
   */
  appendBuildFile(buildFileId: string): void {
    const files = ensureArray(this.properties, "files");
    if (!files.includes(buildFileId)) {
      files.push(buildFileId);
    }
  }

  /**
   * Removes a build file from the phase. Removing an id the phase does not
   * list is a no-op.
   */
  removeBuildFile(buildFileId: string): void {
    const files = this.properties["files"];
    if (Array.isArray(files)) {
      this.properties["files"] = files.filter((file) => file !== buildFileId);
    }
  }

  /**
   * Ensures the phase carries a `PBXBuildFile` for the referenced object,
   * creating one when no existing build file in this phase points at it.
   *
   * @param reference The file reference or package product the build file
   *   should point at.
   * @param options.referenceKey Which build-file field carries the
   *   reference: `fileRef` for file references (the default) or
   *   `productRef` for Swift package products.
   * @param options.settings Optional per-file settings, for example
   *   `{ ATTRIBUTES: ["RemoveHeadersOnCopy"] }`.
   * @returns The view of the phase's build file for the reference.
   */
  ensureBuildFile(
    reference: XcodeObject,
    options: { referenceKey?: "fileRef" | "productRef"; settings?: Record<string, string[] | string> } = {},
  ): BuildFile {
    const referenceKey = options.referenceKey ?? "fileRef";

    for (const buildFileId of this.buildFileIds) {
      const existing = this.project.get(buildFileId);
      if (BuildFile.is(existing) && existing.getString(referenceKey) === reference.id) {
        return existing;
      }
    }

    const buildFile = this.project.add(
      Isa.buildFile,
      {
        [referenceKey]: reference.id,
        ...(options.settings == null ? {} : { settings: options.settings }),
      },
      `${Isa.buildFile} ${this.id} ${reference.id}`,
    );
    this.appendBuildFile(buildFile.id);
    return buildFile;
  }
}

/**
 * A `PBXSourcesBuildPhase` compiles the target's source files.
 */
export class SourcesBuildPhase extends BuildPhase {
  static readonly isa: string | null = Isa.sourcesBuildPhase;
}

/**
 * A `PBXFrameworksBuildPhase` links the target against frameworks,
 * libraries, and Swift package products.
 */
export class FrameworksBuildPhase extends BuildPhase {
  static readonly isa: string | null = Isa.frameworksBuildPhase;
}

/**
 * A `PBXResourcesBuildPhase` copies the target's resources into the
 * built product.
 */
export class ResourcesBuildPhase extends BuildPhase {
  static readonly isa: string | null = Isa.resourcesBuildPhase;
}

/**
 * A `PBXHeadersBuildPhase` installs a framework target's headers with
 * their public, private, or project visibility.
 */
export class HeadersBuildPhase extends BuildPhase {
  static readonly isa: string | null = Isa.headersBuildPhase;
}

/**
 * A `PBXCopyFilesBuildPhase` copies its build files to a destination
 * inside the built product, which is how extensions and watch apps embed.
 */
export class CopyFilesBuildPhase extends BuildPhase<CopyFilesBuildPhaseProperties> {
  static readonly isa: string | null = Isa.copyFilesBuildPhase;

  /**
   * The destination path inside the folder `dstSubfolderSpec` selects,
   * when present.
   */
  get dstPath(): string | undefined {
    return this.getString("dstPath");
  }
}

/**
 * A `PBXShellScriptBuildPhase` runs a script during the build.
 */
export class ShellScriptBuildPhase extends BuildPhase<ShellScriptBuildPhaseProperties> {
  static readonly isa: string | null = Isa.shellScriptBuildPhase;

  /**
   * The script's source text, when present.
   */
  get shellScript(): string | undefined {
    return this.getString("shellScript");
  }

  /**
   * The interpreter the script runs under, when present. Xcode's default
   * is `/bin/sh`.
   */
  get shellPath(): string | undefined {
    return this.getString("shellPath");
  }
}

/**
 * A `PBXRezBuildPhase` runs Rez, the classic Mac OS resource compiler,
 * over `.r` files. Xcode's UI called it "Build Carbon Resources".
 * Current Xcode no longer creates these phases, but old documents still
 * carry them.
 */
export class RezBuildPhase extends BuildPhase {
  static readonly isa: string | null = Isa.rezBuildPhase;
}

/**
 * A `PBXAppleScriptBuildPhase` compiles AppleScript sources. Current
 * Xcode no longer creates these, but old documents still carry them.
 */
export class AppleScriptBuildPhase extends BuildPhase {
  static readonly isa: string | null = Isa.appleScriptBuildPhase;
}

/**
 * A `PBXBuildFile` places one file reference or package product inside
 * one build phase, optionally with per-file settings.
 */
export class BuildFile extends XcodeObject<BuildFileProperties> {
  static readonly isa: string | null = Isa.buildFile;

  /**
   * The view of the file reference the build file points at, when it
   * points at one. Build files for Swift package products carry a
   * `productRef` instead; see {@link productDependency}.
   */
  fileReference(): XcodeObject | undefined {
    return this.project.get(this.getString("fileRef"));
  }

  /**
   * The view of the Swift package product dependency the build file
   * points at, when it points at one.
   */
  productDependency(): SwiftPackageProductDependency | undefined {
    const view = this.project.get(this.getString("productRef"));
    return SwiftPackageProductDependency.is(view) ? view : undefined;
  }
}

/**
 * A `PBXFileSystemSynchronizedRootGroup` is an Xcode 16 folder whose
 * members are synchronized from disk instead of listed individually.
 */
export class SyncRootGroup extends XcodeObject<SyncRootGroupProperties> {
  static readonly isa: string | null = Isa.fileSystemSynchronizedRootGroup;

  /**
   * The group's on-disk folder path, when present.
   */
  get path(): string | undefined {
    return this.getString("path");
  }

  /**
   * Excludes files from a target's membership in this synchronized folder
   * through a `PBXFileSystemSynchronizedBuildFileExceptionSet` linked into
   * the group's exceptions.
   *
   * Xcode keeps one exception set per target and folder, so when this
   * group already carries a set for the target, the file names merge into
   * it instead of creating a second set; names already excluded are not
   * duplicated.
   *
   * The standard use is keeping a scaffolded `Info.plist` from being
   * double-copied: the build already processes it through the target's
   * `INFOPLIST_FILE` setting.
   *
   * @param target The target whose membership the exceptions restrict.
   * @param membershipExceptions File names inside the folder to exclude.
   * @returns The view of the target's exception set for this folder.
   */
  addMembershipExceptions(target: NativeTarget, membershipExceptions: string[]): BuildFileExceptionSet {
    for (const id of stringItems(this.properties["exceptions"])) {
      const existing = this.project.get(id);
      if (BuildFileExceptionSet.is(existing) && existing.getString("target") === target.id) {
        const names = ensureArray(existing.properties, "membershipExceptions");
        for (const name of membershipExceptions) {
          if (!names.includes(name)) {
            names.push(name);
          }
        }
        return existing;
      }
    }

    const exceptionSet = this.project.add(
      Isa.fileSystemSynchronizedBuildFileExceptionSet,
      {
        membershipExceptions,
        target: target.id,
      },
      `${Isa.fileSystemSynchronizedBuildFileExceptionSet} ${this.id} ${target.id}`,
    );
    ensureArray(this.properties, "exceptions").push(exceptionSet.id);
    return exceptionSet;
  }
}

/**
 * Behavior shared by the synchronized-folder exception set kinds, which
 * carve files out of a folder's automatic membership for one target. The
 * type parameter lets subclasses carry a more specific property shape.
 */
export class ExceptionSet<
  Properties extends ExceptionSetProperties = ExceptionSetProperties,
> extends XcodeObject<Properties> {
  /**
   * The file names the set excludes, in declaration order. Non-string
   * entries of a malformed document are skipped.
   */
  get membershipExceptions(): string[] {
    return stringItems(this.properties["membershipExceptions"]);
  }

  /**
   * The view of the target whose membership the set restricts, when the
   * reference resolves.
   */
  target(): XcodeObject | undefined {
    return this.project.get(this.getString("target"));
  }
}

/**
 * A `PBXFileSystemSynchronizedBuildFileExceptionSet` excludes files from
 * a synchronized folder's automatic target membership.
 */
export class BuildFileExceptionSet extends ExceptionSet {
  static readonly isa: string | null = Isa.fileSystemSynchronizedBuildFileExceptionSet;
}

/**
 * A `PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet`
 * assigns some of a synchronized folder's files to a different build
 * phase than the automatic one.
 */
export class BuildPhaseMembershipExceptionSet extends ExceptionSet<BuildPhaseMembershipExceptionSetProperties> {
  static readonly isa: string | null = Isa.fileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet;

  /**
   * The view of the build phase the listed files belong to, when the
   * reference resolves.
   */
  buildPhase(): BuildPhase | undefined {
    const view = this.project.get(this.getString("buildPhase"));
    return BuildPhase.is(view) ? view : undefined;
  }
}

/**
 * A `PBXBuildRule` tells a target which compiler or script processes a
 * kind of file.
 */
export class BuildRule extends XcodeObject<BuildRuleProperties> {
  static readonly isa: string | null = Isa.buildRule;
  /**
   * The rule's script, when it is a script rule rather than a reference
   * to a compiler specification.
   */
  get script(): string | undefined {
    return this.getString("script");
  }
}

/**
 * An `XCVersionGroup` contains a versioned Core Data model
 * (`.xcdatamodeld`). Its children are the model versions and
 * `currentVersion` names the active one.
 */
export class VersionGroup extends Group<VersionGroupProperties> {
  static readonly isa: string | null = Isa.versionGroup;

  /**
   * The view of the active model version's file reference, when the group
   * names one.
   */
  currentVersion(): XcodeObject | undefined {
    const id = this.getString("currentVersion");
    return id == null ? undefined : this.project.get(id);
  }

  /**
   * Makes a model version the active one, adding it to the group's
   * children when it is not listed yet.
   */
  setCurrentVersion(reference: XcodeObject): void {
    this.addChild(reference);
    this.properties["currentVersion"] = reference.id;
  }
}

/**
 * An `XCBuildConfiguration` holds one named settings dictionary of a
 * target or of the project, for example Debug or Release.
 */
export class BuildConfiguration extends XcodeObject<BuildConfigurationProperties> {
  static readonly isa: string | null = Isa.buildConfiguration;

  /**
   * The configuration's name, when present.
   */
  get name(): string | undefined {
    return this.getString("name");
  }

  /**
   * The configuration's settings dictionary, typed with the keys
   * programmatic edits touch most, or `undefined` when the configuration
   * carries none. The dictionary is live. Writes through it land in the
   * document.
   */
  get buildSettings(): BuildSettings | undefined {
    return asDictionary(this.properties["buildSettings"]) as BuildSettings | undefined;
  }
}

/**
 * A `PBXBuildStyle` is the pre-Xcode-2 predecessor of
 * `XCBuildConfiguration`. Current Xcode neither creates nor reads them,
 * but old documents still carry them.
 */
export class BuildStyle extends XcodeObject<BuildStyleProperties> {
  static readonly isa: string | null = Isa.buildStyle;

  /**
   * The style's name, when present.
   */
  get name(): string | undefined {
    return this.getString("name");
  }

  /**
   * The style's settings dictionary, or `undefined` when the style
   * carries none. The dictionary is live. Writes through it land in the
   * document.
   */
  get buildSettings(): BuildSettings | undefined {
    return asDictionary(this.properties["buildSettings"]) as BuildSettings | undefined;
  }
}

/**
 * A `PBXFileReference` names one file on disk, from source files to the
 * built products themselves.
 */
export class FileReference extends XcodeObject<FileReferenceProperties> {
  static readonly isa: string | null = Isa.fileReference;

  /**
   * The reference's path, relative to its `sourceTree`, when present.
   */
  get path(): string | undefined {
    return this.getString("path");
  }

  /**
   * The reference's display name, when it carries one distinct from the
   * path.
   */
  get name(): string | undefined {
    return this.getString("name");
  }
}

/**
 * A `PBXContainerItemProxy` is the indirection Xcode places between a
 * target dependency and the target it points at.
 */
export class ContainerItemProxy extends XcodeObject<ContainerItemProxyProperties> {
  static readonly isa: string | null = Isa.containerItemProxy;

  /**
   * The display name of the object the proxy points at, when present.
   * For target dependencies this is the target's name.
   */
  get remoteInfo(): string | undefined {
    return this.getString("remoteInfo");
  }
}

/**
 * A `PBXTargetDependency` records that one target must build before
 * another, through a container item proxy naming the prerequisite.
 */
export class TargetDependency extends XcodeObject<TargetDependencyProperties> {
  static readonly isa: string | null = Isa.targetDependency;

  /**
   * The view of the target this dependency points at, when the reference
   * resolves to one inside this document.
   */
  target(): XcodeObject | undefined {
    return this.project.get(this.getString("target"));
  }

  /**
   * The view of the dependency's container item proxy, when the reference
   * resolves.
   */
  targetProxy(): ContainerItemProxy | undefined {
    const view = this.project.get(this.getString("targetProxy"));
    return ContainerItemProxy.is(view) ? view : undefined;
  }
}

/**
 * An `XCConfigurationList` owns the named build configurations of one
 * target or of the project, plus the default configuration choice.
 */
export class ConfigurationList extends XcodeObject<ConfigurationListProperties> {
  static readonly isa: string | null = Isa.configurationList;

  /**
   * The name of the configuration builds use when none is specified, when
   * present.
   */
  get defaultConfigurationName(): string | undefined {
    return this.getString("defaultConfigurationName");
  }

  /**
   * The views of the list's build configurations, in list order. Dangling
   * ids and objects of other kinds are skipped.
   */
  configurations(): BuildConfiguration[] {
    const configurations: BuildConfiguration[] = [];
    for (const id of stringItems(this.properties["buildConfigurations"])) {
      const view = this.project.get(id);
      if (BuildConfiguration.is(view)) {
        configurations.push(view);
      }
    }
    return configurations;
  }
}

/**
 * Behavior shared by the Swift package reference kinds. The type
 * parameter lets subclasses carry a more specific property shape.
 */
export class SwiftPackageReference<
  Properties extends SwiftPackageReferenceProperties = SwiftPackageReferenceProperties,
> extends XcodeObject<Properties> {}

/**
 * An `XCRemoteSwiftPackageReference` names a package repository and a
 * version requirement.
 */
export class RemoteSwiftPackageReference extends SwiftPackageReference<RemoteSwiftPackageReferenceProperties> {
  static readonly isa: string | null = Isa.remoteSwiftPackageReference;

  /**
   * The package's repository URL, when present.
   */
  get repositoryURL(): string | undefined {
    return this.getString("repositoryURL");
  }
}

/**
 * An `XCLocalSwiftPackageReference` names a package directory relative
 * to the project.
 */
export class LocalSwiftPackageReference extends SwiftPackageReference<LocalSwiftPackageReferenceProperties> {
  static readonly isa: string | null = Isa.localSwiftPackageReference;

  /**
   * The package's path relative to the project, when present.
   */
  get relativePath(): string | undefined {
    return this.getString("relativePath");
  }
}

/**
 * An `XCSwiftPackageProductDependency` links one product of a Swift
 * package to the target that consumes it.
 */
export class SwiftPackageProductDependency extends XcodeObject<SwiftPackageProductDependencyProperties> {
  static readonly isa: string | null = Isa.swiftPackageProductDependency;

  /**
   * The product's name as the package manifest declares it, when present.
   */
  get productName(): string | undefined {
    return this.getString("productName");
  }

  /**
   * The view of the package reference the product comes from, when the
   * reference resolves. Products of local packages can omit it.
   */
  packageReference(): SwiftPackageReference | undefined {
    const view = this.project.get(this.getString("package"));
    return SwiftPackageReference.is(view) ? view : undefined;
  }
}

/**
 * A `PBXReferenceProxy` stands in for a product built by a target of
 * another project referenced from this one.
 */
export class ReferenceProxy extends XcodeObject<ReferenceProxyProperties> {
  static readonly isa: string | null = Isa.referenceProxy;

  /**
   * The proxy's product path inside the other project's build directory,
   * when present.
   */
  get path(): string | undefined {
    return this.getString("path");
  }

  /**
   * The view of the container item proxy that names the remote target,
   * when the reference resolves.
   */
  remoteReference(): ContainerItemProxy | undefined {
    const view = this.project.get(this.getString("remoteRef"));
    return ContainerItemProxy.is(view) ? view : undefined;
  }
}
