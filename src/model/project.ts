/**
 * The project document model: typed, mutable access to a parsed
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
import type { PbxprojObject } from "../types";
import { generateObjectId } from "../uuid";
import { DEPLOYMENT_TARGET_KEY, Isa, PRODUCT_FILE_INFO, ProductType, type ApplePlatform } from "./isa";
import { XcodeObject } from "./object";
import { BuildPhase, Group, SyncRootGroup } from "./objects";
import { defaultConfigurationSettingsOf } from "./settings";
import { NativeTarget } from "./target";
import { asDictionary, asString, ensureArray, stringItems } from "./values";

/**
 * The `PBXProject` object at the document root: the container that owns
 * the target list, the main group, and project-level configurations.
 */
export class RootProject extends XcodeObject {
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
   * Identity map of object views: one view per id, created on first
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
   * The views of the project's native targets, in project order. Targets
   * of other kinds (aggregate and legacy targets) are not included.
   */
  nativeTargets(): NativeTarget[] {
    const targets: NativeTarget[] = [];
    for (const id of this.rootProject.targetIds()) {
      const view = this.get(id);
      if (view instanceof NativeTarget) {
        targets.push(view);
      }
    }
    return targets;
  }

  /**
   * Finds a native target by name.
   */
  findTarget(name: string): NativeTarget | undefined {
    return this.nativeTargets().find((target) => target.name === name);
  }

  /**
   * Finds the main application target for a platform: prefers the
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
   * Link its products to targets with
   * {@link NativeTarget.addSwiftPackageProduct}.
   *
   * @param options.repositoryURL The package's git URL.
   * @param options.requirement The version requirement dictionary as Xcode
   *   stores it, for example
   *   `{ kind: "upToNextMajorVersion", minimumVersion: "5.0.0" }`.
   * @returns The view of the created package reference.
   */
  addSwiftPackage(options: { repositoryURL: string; requirement: Record<string, string> }): XcodeObject {
    const reference = this.add(
      Isa.remoteSwiftPackageReference,
      { repositoryURL: options.repositoryURL, requirement: options.requirement },
      `${Isa.remoteSwiftPackageReference} ${options.repositoryURL}`,
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
    if (isa === Isa.nativeTarget) {
      return new NativeTarget(this, id);
    }
    if (isa === Isa.project) {
      return new RootProject(this, id);
    }
    if (isa === Isa.group || isa === "PBXVariantGroup") {
      return new Group(this, id);
    }
    if (isa === Isa.fileSystemSynchronizedRootGroup) {
      return new SyncRootGroup(this, id);
    }
    if (isa.endsWith("BuildPhase")) {
      return new BuildPhase(this, id);
    }
    return new XcodeObject(this, id);
  }
}

/**
 * Joins two path segments with a `/`, treating an empty prefix as the
 * project root.
 */
function joinPath(prefix: string, segment: string): string {
  return prefix === "" ? segment : `${prefix}/${segment}`;
}
