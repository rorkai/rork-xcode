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
  BuildPhaseProperties,
  BuildRuleProperties,
  BuildSettings,
  ConfigurationListProperties,
  ContainerItemProxyProperties,
  ExceptionSetProperties,
  FileReferenceProperties,
  GroupProperties,
  ReferenceProxyProperties,
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
  static readonly isas: readonly string[] = [Isa.group];
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
      // The factory maps the group isa to Group.
      return created as Group;
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
  static readonly isas: readonly string[] = [Isa.variantGroup];
}

/**
 * A build phase is an ordered list of build files processed by one step
 * of a target's build. Every `PBX*BuildPhase` kind shares this view, and
 * kinds outside the list below still map here through the factory's
 * suffix fallback.
 */
export class BuildPhase extends XcodeObject<BuildPhaseProperties> {
  static readonly isas: readonly string[] = [
    Isa.copyFilesBuildPhase,
    Isa.frameworksBuildPhase,
    Isa.headersBuildPhase,
    Isa.resourcesBuildPhase,
    Isa.shellScriptBuildPhase,
    Isa.sourcesBuildPhase,
  ];
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
    // The factory maps the build-file isa to BuildFile.
    return buildFile as BuildFile;
  }
}

/**
 * A `PBXBuildFile` places one file reference or package product inside
 * one build phase, optionally with per-file settings.
 */
export class BuildFile extends XcodeObject<BuildFileProperties> {
  static readonly isas: readonly string[] = [Isa.buildFile];

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
  static readonly isas: readonly string[] = [Isa.fileSystemSynchronizedRootGroup];

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
  addMembershipExceptions(target: NativeTarget, membershipExceptions: string[]): ExceptionSet {
    for (const id of stringItems(this.properties["exceptions"])) {
      const existing = this.project.get(id);
      if (
        ExceptionSet.is(existing) &&
        existing.isa === Isa.fileSystemSynchronizedBuildFileExceptionSet &&
        existing.getString("target") === target.id
      ) {
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
    // The factory maps the exception-set isas to ExceptionSet.
    return exceptionSet as ExceptionSet;
  }
}

/**
 * A `PBXFileSystemSynchronizedBuildFileExceptionSet` or its
 * build-phase-membership variant. Exception sets carve files out of a
 * synchronized folder's automatic membership for one target.
 */
export class ExceptionSet extends XcodeObject<ExceptionSetProperties> {
  static readonly isas: readonly string[] = [
    Isa.fileSystemSynchronizedBuildFileExceptionSet,
    Isa.fileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet,
  ];

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
 * A `PBXBuildRule` tells a target which compiler or script processes a
 * kind of file.
 */
export class BuildRule extends XcodeObject<BuildRuleProperties> {
  static readonly isas: readonly string[] = [Isa.buildRule];
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
  static readonly isas: readonly string[] = [Isa.versionGroup];

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
  static readonly isas: readonly string[] = [Isa.buildConfiguration];

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
 * A `PBXFileReference` names one file on disk, from source files to the
 * built products themselves.
 */
export class FileReference extends XcodeObject<FileReferenceProperties> {
  static readonly isas: readonly string[] = [Isa.fileReference];

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
  static readonly isas: readonly string[] = [Isa.containerItemProxy];

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
  static readonly isas: readonly string[] = [Isa.targetDependency];

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
  static readonly isas: readonly string[] = [Isa.configurationList];

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
 * An `XCRemoteSwiftPackageReference` or `XCLocalSwiftPackageReference`.
 * Remote references name a repository and version requirement, and local
 * ones name a path relative to the project.
 */
export class SwiftPackageReference extends XcodeObject<SwiftPackageReferenceProperties> {
  static readonly isas: readonly string[] = [Isa.localSwiftPackageReference, Isa.remoteSwiftPackageReference];

  /**
   * The remote package's repository URL, when this is a remote reference.
   */
  get repositoryURL(): string | undefined {
    return this.getString("repositoryURL");
  }

  /**
   * The local package's path relative to the project, when this is a
   * local reference.
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
  static readonly isas: readonly string[] = [Isa.swiftPackageProductDependency];

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
  static readonly isas: readonly string[] = [Isa.referenceProxy];

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
