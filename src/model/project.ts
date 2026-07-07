/**
 * The project document model. It gives typed, mutable access to a parsed
 * `project.pbxproj`.
 *
 * The model is a set of lightweight views over the plain parsed document.
 * All state lives in the document itself; views hold only an id and a
 * project reference, so model mutations and direct dictionary writes
 * compose freely and {@link XcodeProject.build} always serializes the
 * current state. New objects receive deterministic identifiers (see
 * `uuid.ts`), so programmatic edits are reproducible run to run.
 *
 * @module
 */

import { buildPbxproj } from "../build";
import { XcodeModelError } from "../errors";
import { parsePbxproj } from "../parse";
import { generateObjectId } from "../uuid";
import { pruneOrphanObjects, validateProject, type ProjectIssue } from "./doctor";
import { DEPLOYMENT_TARGET_KEY, Isa, PRODUCT_FILE_INFO, ProductType, type ApplePlatform } from "./isa";
import { XcodeObject } from "./object";
import {
  BuildConfiguration,
  BuildPhase,
  BuildRule,
  ContainerItemProxy,
  FileReference,
  Group,
  ReferenceProxy,
  SyncRootGroup,
  VersionGroup,
} from "./objects";
import { defaultConfigurationSettingsOf } from "./settings";
import { AggregateTarget, LegacyTarget, NativeTarget, Target } from "./target";
import { asDictionary, asString, ensureArray, stringItems } from "./values";

import type { PbxprojObject, PbxprojValue } from "../types";
import type { RootProjectProperties } from "./properties";

/**
 * The `PBXProject` object at the document root. It owns the target list,
 * the main group, and the project-level configurations.
 */
export class RootProject extends XcodeObject<RootProjectProperties> {
  /**
   * Ids of the project's targets, in project order.
   */
  targetIds(): string[] {
    return stringItems(this.properties["targets"]);
  }

  /**
   * The view of the project's main group, when the document has one. The
   * main group is the root of Xcode's navigator tree.
   */
  mainGroup(): Group | undefined {
    const group = this.project.get(this.getString("mainGroup"));
    return group instanceof Group ? group : undefined;
  }

  /**
   * The settings dictionary of the project-level default configuration.
   * Targets inherit from these settings; see
   * {@link NativeTarget.getBuildSetting}.
   */
  defaultConfigurationSettings(): PbxprojObject | undefined {
    return defaultConfigurationSettingsOf(this.project, this.getString("buildConfigurationList"));
  }

  /**
   * The views of the project's Swift package references, remote and local,
   * in declaration order.
   */
  packageReferences(): XcodeObject[] {
    return this.referencedViews("packageReferences");
  }

  /**
   * The group product references live in, creating it (and registering it
   * as the project's `productRefGroup`) when missing.
   */
  ensureProductsGroup(): Group {
    const existing = this.project.get(this.getString("productRefGroup"));
    if (existing instanceof Group) {
      return existing;
    }

    const group = this.project.add(
      Isa.group,
      { children: [], name: "Products", sourceTree: "<group>" },
      `${Isa.group} Products`,
    );
    this.mainGroup()?.addChild(group);
    this.set("productRefGroup", group.id);
    // The factory maps the group isa to Group.
    return group as Group;
  }
}

/**
 * Options for {@link XcodeProject.addNativeTarget}.
 */
export interface AddNativeTargetOptions {
  /** Target name, also used as the product name. */
  name: string;

  /**
   * Product type identifier. Must be one of the creatable kinds:
   * applications, app extensions, their Messages variants, watch
   * applications, App Clips, and ExtensionKit extensions.
   */
  productType: string;

  /**
   * Build settings applied to every created configuration. Each
   * configuration receives its own copy.
   */
  buildSettings?: Record<string, number | string>;

  /**
   * Names of the configurations to create. Defaults to `Debug` and
   * `Release`, matching the pair Xcode scaffolds.
   */
  configurationNames?: string[];

  /**
   * The configuration name recorded as the list's default. Defaults to
   * `Release`.
   */
  defaultConfigurationName?: string;
}

/**
 * A parsed `project.pbxproj` with typed, mutable access to its objects.
 *
 * ```ts
 * const project = XcodeProject.parse(pbxprojText);
 * const app = project.findMainAppTarget("ios");
 * app?.setBuildSetting("MARKETING_VERSION", "1.2.0");
 * const text = project.build();
 * ```
 */
export class XcodeProject {
  /** The parsed document this model wraps. */
  readonly document: PbxprojObject;

  /** The document's `objects` dictionary. */
  private readonly objectsDictionary: PbxprojObject;

  /**
   * Identity map of object views, one view per id, created on first
   * access, so views of the same object compare with `===`.
   */
  private readonly views = new Map<string, XcodeObject>();

  private constructor(document: PbxprojObject) {
    const objects = asDictionary(document["objects"]);
    if (objects == null) {
      throw new XcodeModelError("The document has no objects dictionary");
    }
    this.document = document;
    this.objectsDictionary = objects;
  }

  /**
   * Parses pbxproj text and wraps it in a model.
   *
   * @throws PbxprojParseError when the text is malformed.
   * @throws XcodeModelError when the document has no objects dictionary.
   */
  static parse(text: string): XcodeProject {
    const document = asDictionary(parsePbxproj(text));
    if (document == null) {
      throw new XcodeModelError("The document root is not a dictionary");
    }
    return new XcodeProject(document);
  }

  /**
   * Wraps an already parsed document in a model. The document is used in
   * place, not copied; model mutations write into it.
   */
  static fromDocument(document: PbxprojObject): XcodeProject {
    return new XcodeProject(document);
  }

  /**
   * Serializes the current document state to pbxproj text in Xcode's
   * canonical layout.
   */
  build(): string {
    return buildPbxproj(this.document);
  }

  /**
   * The raw properties dictionary of an object.
   *
   * @throws XcodeModelError when no object with the id exists; views use
   *   this accessor, so a view of a deleted object fails loudly instead of
   *   resurrecting the entry.
   */
  propertiesOf(id: string): PbxprojObject {
    const properties = asDictionary(this.objectsDictionary[id]);
    if (properties == null) {
      throw new XcodeModelError(`No object with id ${id} exists in the document`);
    }
    return properties;
  }

  /**
   * The raw properties dictionary of an object, or `undefined` when the id
   * is absent, dangling, or not a dictionary.
   */
  propertiesOfOptional(id: string | undefined): PbxprojObject | undefined {
    return id == null ? undefined : asDictionary(this.objectsDictionary[id]);
  }

  /**
   * The view of an object by id, or `undefined` when the id is absent or
   * its entry is not a dictionary. Repeated lookups return the same view
   * instance.
   */
  get(id: string | undefined): XcodeObject | undefined {
    if (id == null) {
      return undefined;
    }
    const existing = this.views.get(id);
    if (existing != null) {
      return existing;
    }
    const properties = asDictionary(this.objectsDictionary[id]);
    if (properties == null) {
      return undefined;
    }
    const view = this.createView(id, asString(properties["isa"]) ?? "");
    this.views.set(id, view);
    return view;
  }

  /**
   * Iterates `[id, view]` over every well-formed object in the document,
   * in document order. Entries that are not dictionaries are skipped.
   */
  *objects(): IterableIterator<[string, XcodeObject]> {
    for (const id of Object.keys(this.objectsDictionary)) {
      const view = this.get(id);
      if (view != null) {
        yield [id, view];
      }
    }
  }

  /**
   * Generates a deterministic 24-character id from a seed, avoiding every
   * id the document currently contains. The id is not reserved; adding an
   * object with it (see {@link add}) is what claims it.
   */
  generateId(seed: string): string {
    return generateObjectId(seed, new Set(Object.keys(this.objectsDictionary)));
  }

  /**
   * Adds an object to the document and returns its view.
   *
   * @param isa The object's kind; written as the `isa` property.
   * @param properties The object's remaining properties. The dictionary is
   *   stored as passed (not copied), with `isa` written first so the
   *   serialized entry leads with it.
   * @param seed Seed for the deterministic id; defaults to the isa, which
   *   is only sensible for singleton objects.
   * @returns The view of the created object.
   */
  add(isa: string, properties: PbxprojObject, seed?: string): XcodeObject {
    const id = this.generateId(seed ?? isa);
    this.objectsDictionary[id] = { isa, ...properties };
    const view = this.createView(id, isa);
    this.views.set(id, view);
    return view;
  }

  /**
   * The view of the document's root `PBXProject` object.
   *
   * @throws XcodeModelError when `rootObject` is missing or dangling,
   *   since without it no project-level operation is meaningful.
   */
  get rootProject(): RootProject {
    const view = this.get(asString(this.document["rootObject"]));
    if (!(view instanceof RootProject)) {
      throw new XcodeModelError("The document's rootObject does not reference a PBXProject");
    }
    return view;
  }

  /**
   * The views of the project's targets of every kind (native, aggregate,
   * and legacy), in project order.
   */
  targets(): Target[] {
    const targets: Target[] = [];
    for (const id of this.rootProject.targetIds()) {
      const view = this.get(id);
      if (view instanceof Target) {
        targets.push(view);
      }
    }
    return targets;
  }

  /**
   * The views of the project's native targets, in project order. Targets
   * of other kinds (aggregate and legacy targets) are not included.
   */
  nativeTargets(): NativeTarget[] {
    return this.targets().filter((target): target is NativeTarget => target instanceof NativeTarget);
  }

  /**
   * Finds a native target by name.
   */
  findTarget(name: string): NativeTarget | undefined {
    return this.nativeTargets().find((target) => target.name === name);
  }

  /**
   * Finds the main application target for a platform. It prefers the
   * application target whose own configurations carry the platform's
   * deployment-target key, and falls back to the first application target
   * in project order. Returns `undefined` when the project has no
   * application target.
   */
  findMainAppTarget(platform: ApplePlatform = "ios"): NativeTarget | undefined {
    const deploymentKey = DEPLOYMENT_TARGET_KEY[platform];
    const applications = this.nativeTargets().filter((target) => target.productType === ProductType.application);

    const byDeploymentTarget = applications.find((target) =>
      target.buildConfigurations().some((configuration) => {
        const settings = asDictionary(configuration.properties["buildSettings"]);
        return settings != null && deploymentKey in settings;
      }),
    );
    return byDeploymentTarget ?? applications[0];
  }

  /**
   * Creates a native target with its build configurations, product file
   * reference in the Products group, and the standard Sources, Frameworks,
   * and Resources build phases, and registers it on the project.
   *
   * @throws XcodeModelError for product types the model cannot create a
   *   product reference for; see {@link AddNativeTargetOptions.productType}.
   */
  addNativeTarget(options: AddNativeTargetOptions): NativeTarget {
    const productInfo = PRODUCT_FILE_INFO[options.productType];
    if (productInfo == null) {
      throw new XcodeModelError(`Cannot create a product reference for product type ${options.productType}`);
    }

    const configurationNames = options.configurationNames ?? ["Debug", "Release"];
    const configurationIds = configurationNames.map(
      (configurationName) =>
        this.add(
          Isa.buildConfiguration,
          { buildSettings: { ...options.buildSettings }, name: configurationName },
          `${Isa.buildConfiguration} ${options.name} ${configurationName}`,
        ).id,
    );
    const configurationList = this.add(
      Isa.configurationList,
      {
        buildConfigurations: configurationIds,
        defaultConfigurationIsVisible: 0,
        defaultConfigurationName: options.defaultConfigurationName ?? "Release",
      },
      `${Isa.configurationList} ${options.name}`,
    );

    const productReference = this.add(
      Isa.fileReference,
      {
        explicitFileType: productInfo.fileType,
        includeInIndex: 0,
        path: `${options.name}${productInfo.extension}`,
        sourceTree: "BUILT_PRODUCTS_DIR",
      },
      `${Isa.fileReference} ${options.name}${productInfo.extension}`,
    );
    this.rootProject.ensureProductsGroup().addChild(productReference);

    const target = this.add(
      Isa.nativeTarget,
      {
        buildConfigurationList: configurationList.id,
        buildPhases: [],
        buildRules: [],
        dependencies: [],
        name: options.name,
        productName: options.name,
        productReference: productReference.id,
        productType: options.productType,
      },
      `${Isa.nativeTarget} ${options.name}`,
    );
    ensureArray(this.rootProject.properties, "targets").push(target.id);

    // The factory maps the native-target isa to NativeTarget.
    const nativeTarget = target as NativeTarget;
    nativeTarget.ensureSourcesPhase();
    nativeTarget.ensureFrameworksPhase();
    nativeTarget.ensureResourcesPhase();
    return nativeTarget;
  }

  /**
   * Finds the remote Swift package reference for a repository URL.
   */
  findSwiftPackage(repositoryUrl: string): XcodeObject | undefined {
    for (const id of stringItems(this.rootProject.properties["packageReferences"])) {
      const reference = this.get(id);
      if (reference?.getString("repositoryURL") === repositoryUrl) {
        return reference;
      }
    }
    return undefined;
  }

  /**
   * Adds a remote Swift package reference and registers it on the project.
   * When the project already references the repository, the existing
   * reference is returned unchanged, requirement included; adjust an
   * existing requirement through the reference's properties. Link products
   * to targets with {@link NativeTarget.addSwiftPackageProduct}.
   *
   * @param options.repositoryURL The package's git URL.
   * @param options.requirement The version requirement dictionary as Xcode
   *   stores it, for example
   *   `{ kind: "upToNextMajorVersion", minimumVersion: "5.0.0" }`.
   * @returns The view of the package reference for the repository.
   */
  addSwiftPackage(options: { repositoryURL: string; requirement: Record<string, string> }): XcodeObject {
    const existing = this.findSwiftPackage(options.repositoryURL);
    if (existing != null) {
      return existing;
    }
    const reference = this.add(
      Isa.remoteSwiftPackageReference,
      { repositoryURL: options.repositoryURL, requirement: options.requirement },
      `${Isa.remoteSwiftPackageReference} ${options.repositoryURL}`,
    );
    ensureArray(this.rootProject.properties, "packageReferences").push(reference.id);
    return reference;
  }

  /**
   * Finds the local Swift package reference for a directory path.
   */
  findLocalSwiftPackage(relativePath: string): XcodeObject | undefined {
    return this.rootProject
      .packageReferences()
      .find(
        (reference) =>
          reference.isa === Isa.localSwiftPackageReference && reference.getString("relativePath") === relativePath,
      );
  }

  /**
   * Adds a local (path-based) Swift package reference and registers it on
   * the project, returning the existing reference when the path is already
   * registered. Products link to targets the same way as remote packages,
   * through {@link NativeTarget.addSwiftPackageProduct}.
   *
   * @param relativePath The package directory, relative to the project.
   * @returns The view of the package reference for the path.
   */
  addLocalSwiftPackage(relativePath: string): XcodeObject {
    const existing = this.findLocalSwiftPackage(relativePath);
    if (existing != null) {
      return existing;
    }
    const reference = this.add(
      Isa.localSwiftPackageReference,
      { relativePath },
      `${Isa.localSwiftPackageReference} ${relativePath}`,
    );
    ensureArray(this.rootProject.properties, "packageReferences").push(reference.id);
    return reference;
  }

  /**
   * The views of every `PBXBuildFile` that points at the referenced object
   * through `fileRef` or `productRef`. Useful for relocating a product
   * between copy phases.
   */
  buildFilesReferencing(reference: XcodeObject): XcodeObject[] {
    const buildFiles: XcodeObject[] = [];
    for (const [, view] of this.objects()) {
      if (
        view.isa === Isa.buildFile &&
        (view.getString("fileRef") === reference.id || view.getString("productRef") === reference.id)
      ) {
        buildFiles.push(view);
      }
    }
    return buildFiles;
  }

  /**
   * Validates the document's object graph and returns every problem
   * found. An empty array means the graph is structurally sound. The
   * checks cover the root object, object kinds, known references, and
   * reachability.
   */
  validate(): ProjectIssue[] {
    return validateProject(this);
  }

  /**
   * Removes every object unreachable from the root object and returns the
   * removed ids. Reachability is conservative. Any real reference keeps
   * an object alive, even through properties outside the known schema.
   */
  pruneOrphans(): string[] {
    return pruneOrphanObjects(this);
  }

  /**
   * The views of every object that references the id anywhere in its
   * properties. A reference is a string property naming the id, an id
   * list containing it, or a nested dictionary carrying it as a key or
   * string value.
   *
   * The scan is linear over the document; removal flows call it once per
   * removed object, which keeps teardown proportional to what is actually
   * removed.
   */
  referrersOf(id: string): XcodeObject[] {
    const referrers: XcodeObject[] = [];
    for (const [referrerId, view] of this.objects()) {
      if (referrerId !== id && objectReferences(view.properties, id)) {
        referrers.push(view);
      }
    }
    return referrers;
  }

  /**
   * Removes an object from the document and strips every reference to it
   * from the remaining objects. String properties naming the id are
   * deleted, id lists drop it, and nested dictionaries keyed by object id
   * (such as `TargetAttributes`) drop its entry.
   *
   * Removing an id the document does not contain is a no-op. This is the
   * low-level removal; {@link removeTarget} composes it into a full
   * teardown.
   */
  removeObject(id: string): void {
    if (!(id in this.objectsDictionary)) {
      return;
    }
    delete this.objectsDictionary[id];
    this.views.delete(id);
    for (const [, view] of this.objects()) {
      stripReferences(view.properties, id);
    }
  }

  /**
   * Removes a target and everything that exists only for its sake. That
   * covers its build phases and their build files, its configuration list
   * and configurations, its product reference and the build files
   * embedding it, dependency objects and container proxies in both
   * directions (other targets' dependencies on it, and its own
   * dependencies on others), its membership exception sets, and
   * synchronized folders no remaining target links.
   *
   * On-disk sources are untouched; the removal is document-only, like
   * deleting a target in Xcode and keeping its folder.
   *
   * @throws XcodeModelError when the target belongs to another project,
   *   since removing by another document's ids would tear down unrelated
   *   objects that happen to share them.
   */
  removeTarget(target: Target): void {
    if (target.project !== this) {
      throw new XcodeModelError("Cannot remove a target that belongs to another project");
    }

    const ownedIds = new Set<string>();

    for (const phase of target.buildPhases()) {
      for (const buildFileId of phase.buildFileIds) {
        ownedIds.add(buildFileId);
      }
      ownedIds.add(phase.id);
    }

    const configurationListId = target.getString("buildConfigurationList");
    if (configurationListId != null) {
      for (const configuration of target.buildConfigurations()) {
        ownedIds.add(configuration.id);
      }
      ownedIds.add(configurationListId);
    }

    const product = this.get(target.getString("productReference"));
    if (product != null) {
      for (const buildFile of this.buildFilesReferencing(product)) {
        ownedIds.add(buildFile.id);
      }
      ownedIds.add(product.id);
    }

    // The target's own dependencies on other targets, with their proxies;
    // nothing else references them once the target disappears.
    for (const dependency of target.dependencies()) {
      const proxyId = dependency.getString("targetProxy");
      if (proxyId != null) {
        ownedIds.add(proxyId);
      }
      ownedIds.add(dependency.id);
    }

    // Dependencies other targets hold on this one, with their proxies.
    for (const [, view] of this.objects()) {
      if (view.isa === Isa.targetDependency && view.getString("target") === target.id) {
        const proxyId = view.getString("targetProxy");
        if (proxyId != null) {
          ownedIds.add(proxyId);
        }
        ownedIds.add(view.id);
      }
      if (view.isa === Isa.fileSystemSynchronizedBuildFileExceptionSet && view.getString("target") === target.id) {
        ownedIds.add(view.id);
      }
    }

    const syncGroupIds = stringItems(target.properties["fileSystemSynchronizedGroups"]);

    this.removeObject(target.id);
    for (const id of ownedIds) {
      this.removeObject(id);
    }

    // Synchronized folders survive when another target still links them.
    for (const groupId of syncGroupIds) {
      const stillLinked = this.nativeTargets().some((remaining) =>
        stringItems(remaining.properties["fileSystemSynchronizedGroups"]).includes(groupId),
      );
      if (!stillLinked) {
        this.removeObject(groupId);
      }
    }
  }

  /**
   * Finds a file reference by its project-relative path, resolving each
   * reference's location through the group tree from the main group
   * (nested group `path` components join with `/`).
   *
   * Members of file-system-synchronized folders are not listed in the
   * document and therefore cannot be found; check
   * {@link NativeTarget.syncGroupPaths} for folder-level containment
   * instead.
   */
  findFileReference(projectRelativePath: string): XcodeObject | undefined {
    const mainGroup = this.rootProject.mainGroup();
    if (mainGroup == null) {
      return undefined;
    }

    // A malformed document can link groups into a cycle; visited ids bound
    // the walk to each group once.
    const visited = new Set<string>();
    const search = (group: Group, prefix: string): XcodeObject | undefined => {
      if (visited.has(group.id)) {
        return undefined;
      }
      visited.add(group.id);

      for (const childId of group.childIds) {
        const child = this.get(childId);
        if (child == null) {
          continue;
        }
        const childPath = child.getString("path");
        if (child instanceof Group) {
          const found = search(child, childPath == null ? prefix : joinPath(prefix, childPath));
          if (found != null) {
            return found;
          }
        } else if (
          child.isa === Isa.fileReference &&
          childPath != null &&
          joinPath(prefix, childPath) === projectRelativePath
        ) {
          return child;
        }
      }
      return undefined;
    };
    return search(mainGroup, "");
  }

  /**
   * Creates the typed view for an object, dispatching on its isa. Objects
   * outside the typed vocabulary get the generic base view.
   */
  private createView(id: string, isa: string): XcodeObject {
    switch (isa) {
      case Isa.nativeTarget:
        return new NativeTarget(this, id);
      case Isa.aggregateTarget:
        return new AggregateTarget(this, id);
      case Isa.legacyTarget:
        return new LegacyTarget(this, id);
      case Isa.project:
        return new RootProject(this, id);
      case Isa.group:
      case Isa.variantGroup:
        return new Group(this, id);
      case Isa.versionGroup:
        return new VersionGroup(this, id);
      case Isa.fileSystemSynchronizedRootGroup:
        return new SyncRootGroup(this, id);
      case Isa.buildRule:
        return new BuildRule(this, id);
      case Isa.buildConfiguration:
        return new BuildConfiguration(this, id);
      case Isa.fileReference:
        return new FileReference(this, id);
      case Isa.containerItemProxy:
        return new ContainerItemProxy(this, id);
      case Isa.referenceProxy:
        return new ReferenceProxy(this, id);
      default:
        return isa.endsWith("BuildPhase") ? new BuildPhase(this, id) : new XcodeObject(this, id);
    }
  }
}

/**
 * Joins two path segments with a `/`, treating an empty prefix as the
 * project root.
 */
function joinPath(prefix: string, segment: string): string {
  return prefix === "" ? segment : `${prefix}/${segment}`;
}

/**
 * Whether a value references the id anywhere in its structure. A
 * reference is a string equal to it, an array containing it at any depth,
 * or a dictionary carrying it as a key or somewhere in its values.
 */
function valueReferences(value: PbxprojValue | undefined, id: string): boolean {
  if (typeof value === "string") {
    return value === id;
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueReferences(item, id));
  }
  const nested = asDictionary(value);
  if (nested != null) {
    return id in nested || objectReferences(nested, id);
  }
  return false;
}

/**
 * Whether an object's properties reference the id anywhere. See
 * {@link valueReferences} for the shapes considered.
 */
function objectReferences(properties: PbxprojObject, id: string): boolean {
  for (const key of Object.keys(properties)) {
    if (valueReferences(properties[key], id)) {
      return true;
    }
  }
  return false;
}

/**
 * Strips every reference to the id inside a value and returns the value
 * to keep. Strings equal to the id become `undefined`, arrays drop
 * matching items at any depth, and dictionaries drop entries keyed by it
 * and recurse into their values.
 */
function stripValue(value: PbxprojValue, id: string): PbxprojValue | undefined {
  if (typeof value === "string") {
    return value === id ? undefined : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const kept: PbxprojValue[] = [];
    for (const item of value) {
      const stripped = stripValue(item, id);
      if (stripped == null || stripped !== item) {
        changed = true;
      }
      if (stripped != null) {
        kept.push(stripped);
      }
    }
    return changed ? kept : value;
  }
  const nested = asDictionary(value);
  if (nested != null) {
    if (id in nested) {
      delete nested[id];
    }
    stripReferences(nested, id);
  }
  return value;
}

/**
 * Strips every reference to the id from an object's properties; see
 * {@link stripValue} for the shapes handled. String properties naming the
 * id are deleted rather than left empty.
 */
function stripReferences(properties: PbxprojObject, id: string): void {
  for (const key of Object.keys(properties)) {
    const value = properties[key];
    if (value == null) {
      continue;
    }
    const stripped = stripValue(value, id);
    if (stripped == null) {
      delete properties[key];
    } else if (stripped !== value) {
      properties[key] = stripped;
    }
  }
}
