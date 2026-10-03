/**
 * The object model for Xcode 27's JSON project format (`project.xcproj`).
 *
 * The format describes the same project a pbxproj does, reorganized for
 * readable diffs. There is no flat object table. Files sit in a nested
 * tree and name the build phases they belong to, targets refer to each
 * other by name, and the per-configuration settings of a pbxproj fold
 * into one dictionary with `[config=…]` conditions. {@link Xcproj} wraps a
 * parsed document with typed access to these pieces.
 *
 * As with the other models, the document stays the single source of
 * truth. Views hold the dictionary they describe and nothing else, so
 * model calls and direct edits compose freely, and {@link Xcproj.build}
 * writes whatever the document says in Xcode's layout.
 *
 * @module
 */

import { XcodeModelError } from "../errors";
import { expandBuildSettingReferences } from "../expansion";
import { DEPLOYMENT_TARGET_KEY, ProductType } from "../model/isa";
import { renameFileNameStem, renamePathSegments } from "../rename";
import { buildXcproj } from "./build";
import { parseXcproj } from "./parse";
import { decodeFilePath, decodeNamePath, encodeFilePath, encodeNamePath, lastPathComponent } from "./paths";
import {
  configurationView,
  removeFoldedSetting,
  setFoldedSetting,
  settingName,
  splitConfigurationCondition,
} from "./settings";

import type { BuildSettingLookup } from "../expansion";
import type { ApplePlatform } from "../model/isa";
import type { Xcconfig, XcconfigSettingsOptions } from "../xcconfig/model";
import type { NamePathComponent } from "./paths";
import type { XcprojBuildSettingValue } from "./settings";
import type { XcprojArray, XcprojObject, XcprojValue } from "./types";

/**
 * The prefix Xcode leaves out of product types, so `application` stands
 * for `com.apple.product-type.application`.
 */
const PRODUCT_TYPE_PREFIX = "com.apple.product-type.";

/**
 * The prefix of group tree references that name an object by id.
 */
const ID_PREFIX = "id:";

/**
 * Options for reading and writing build settings.
 */
export interface XcprojBuildSettingOptions {
  /**
   * The build configuration to read or write, for example `Debug`.
   * Reads default to the project's default configuration. Writes without
   * a configuration apply to every configuration.
   */
  configuration?: string;
}

/**
 * Options for {@link XcprojTarget.resolveBuildSetting}.
 */
export interface XcprojResolveBuildSettingOptions extends XcprojBuildSettingOptions {
  /**
   * Answers references the document itself cannot, for example
   * `$(BUILT_PRODUCTS_DIR)` when the caller knows the build layout. The
   * lookup is consulted after the setting layers and before the built-in
   * `$(TARGET_NAME)` fallback, and a reference it leaves unanswered stays
   * verbatim in the result.
   */
  lookup?: BuildSettingLookup;
}

/**
 * The layers a build setting resolves through, from the most specific.
 */
type SettingLayers = readonly (ReadonlyMap<string, XcprojBuildSettingValue> | undefined)[];

/**
 * Whether a value is a dictionary.
 */
function isRecord(value: XcprojValue | undefined): value is XcprojObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the value when it is a string, and `undefined` otherwise.
 */
function asString(value: XcprojValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Returns the dictionaries of an array value, skipping anything else.
 */
function recordsOf(value: XcprojValue | undefined): XcprojObject[] {
  return Array.isArray(value) ? value.filter((item): item is XcprojObject => isRecord(item)) : [];
}

/**
 * Returns the array under a key, creating an empty one when it is
 * missing or malformed.
 */
function ensureArray(object: XcprojObject, key: string): XcprojArray {
  const existing = object[key];
  if (Array.isArray(existing)) {
    return existing;
  }
  const created: XcprojArray = [];
  object[key] = created;
  return created;
}

/**
 * Returns the dictionary under a key, creating an empty one when it is
 * missing or malformed.
 */
function ensureRecord(object: XcprojObject, key: string): XcprojObject {
  const existing = object[key];
  if (isRecord(existing)) {
    return existing;
  }
  const created: XcprojObject = {};
  object[key] = created;
  return created;
}

/**
 * Deletes a key whose array or dictionary value has become empty, since
 * Xcode leaves empty collections out of the file.
 */
function dropIfEmpty(object: XcprojObject, key: string): void {
  const value = object[key];
  if ((Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0)) {
    delete object[key];
  }
}

/**
 * The kind of a file tree reference. A missing `kind` means a file
 * reference, as in Xcode's decoder.
 */
function referenceKind(reference: XcprojObject): string {
  return asString(reference["kind"]) ?? "file-reference";
}

/**
 * The name Xcode gives a reference in the file tree. Groups of every kind
 * may carry an explicit name, and every other reference is named after
 * the last component of its path.
 */
function referenceName(reference: XcprojObject): string {
  const kind = referenceKind(reference);
  if (kind === "group" || kind === "variant-group" || kind === "version-group") {
    const name = asString(reference["name"]);
    if (name != null) {
      return name;
    }
  }
  return lastPathComponent(decodeFilePath(asString(reference["path"]) ?? "").path);
}

/**
 * Calls `visit` for every reference of a tree, depth first and in
 * document order, including the file references inside variant and
 * version groups.
 */
function visitReferences(items: XcprojValue | undefined, visit: (reference: XcprojObject) => void): void {
  for (const reference of recordsOf(items)) {
    visit(reference);
    visitReferences(reference["children"], visit);
  }
}

/**
 * Removes one reference from whichever list of the tree holds it.
 *
 * @returns Whether the reference was found.
 */
function removeFromTree(items: XcprojValue | undefined, target: XcprojObject): boolean {
  if (!Array.isArray(items)) {
    return false;
  }
  const index = items.indexOf(target);
  if (index !== -1) {
    items.splice(index, 1);
    return true;
  }
  for (const reference of recordsOf(items)) {
    if (removeFromTree(reference["children"], target)) {
      dropIfEmpty(reference, "children");
      return true;
    }
  }
  return false;
}

/**
 * The build phase reference of a target membership entry, which is the
 * entry itself in the string form and its `build-phase` in the record
 * form.
 */
function membershipPhase(entry: XcprojValue | undefined): XcprojValue | undefined {
  return isRecord(entry) ? entry["build-phase"] : entry;
}

/**
 * The name of the target a name-based build phase reference points into,
 * which is its first component, as in `App/compile-sources`.
 */
function phaseTargetName(phase: XcprojValue | undefined): string | undefined {
  const first = decodeNamePath(phase)?.[0];
  return first == null || first.relative ? undefined : first.name;
}

/**
 * Re-encodes a name-based build phase reference with a new target name.
 */
function retargetPhase(phase: XcprojValue, newName: string): XcprojValue {
  const components = decodeNamePath(phase) ?? [];
  return encodeNamePath([{ name: newName, relative: false }, ...components.slice(1)]);
}

/**
 * Points every target membership entry naming one target at another.
 * An entry that only carries its phase collapses to the string form when
 * the new reference allows it, and expands to a record when the new name
 * needs the array form, which is how Xcode encodes the two cases.
 */
function retargetMemberships(memberships: XcprojValue | undefined, oldName: string, newName: string): void {
  if (!Array.isArray(memberships)) {
    return;
  }
  for (let index = 0; index < memberships.length; index++) {
    const entry = memberships[index];
    const phase = membershipPhase(entry);
    if (phase == null || phaseTargetName(phase) !== oldName) {
      continue;
    }
    const renamed = retargetPhase(phase, newName);
    if (isRecord(entry) && Object.keys(entry).some((key) => key !== "build-phase")) {
      entry["build-phase"] = renamed;
    } else {
      memberships[index] = typeof renamed === "string" ? renamed : { "build-phase": renamed };
    }
  }
}

/**
 * The project's settings in one configuration's view, as a layer.
 */
function settingsLayer(settings: XcprojValue | undefined, configuration: string | undefined): SettingLayers[number] {
  return isRecord(settings) ? configurationView(settings, configuration) : undefined;
}

/**
 * Reads a setting from the first layer that defines it.
 */
function readLayers(layers: SettingLayers, key: string): XcprojBuildSettingValue | undefined {
  for (const layer of layers) {
    const value = layer?.get(key);
    if (value != null) {
      return value;
    }
  }
  return undefined;
}

/**
 * Resolves a setting through layers and expands its references, the way
 * the pbxproj model does. `$(inherited)` and a setting referencing itself
 * continue from the next layer down, other references start over at the
 * top, and the caller's lookup and the built-in settings answer the rest.
 * A list value resolves item by item and joins the items with single
 * spaces, leaving out items that expand to nothing.
 */
function resolveLayers(
  layers: SettingLayers,
  key: string,
  fallback: (reference: string) => string | undefined,
): string | undefined {
  // Guards are per name and starting layer, so an inherited chain of the
  // same name walks down the layers freely while a pair of settings
  // referencing each other stays finite.
  const resolve = (name: string, fromLayer: number, active: ReadonlySet<string>): string | undefined => {
    const guard = `${fromLayer}:${name}`;
    if (active.has(guard)) {
      return undefined;
    }
    const nested = new Set([...active, guard]);

    for (let layer = fromLayer; layer < layers.length; layer++) {
      const value = layers[layer]?.get(name);
      if (value == null) {
        continue;
      }
      const expand = (text: string): string =>
        expandBuildSettingReferences(
          text,
          (reference) => {
            if (reference === "inherited" || reference === name) {
              // Nothing below the last layer means inherited adds nothing,
              // which is how Xcode splices an empty chain.
              return resolve(name, layer + 1, nested) ?? "";
            }
            return resolve(reference, 0, nested) ?? fallback(reference);
          },
          { expandLookupValues: false },
        );
      return typeof value === "string"
        ? expand(value)
        : value
            .map((item) => expand(item))
            .filter((item) => item !== "")
            .join(" ");
    }
    return undefined;
  };

  return resolve(key, 0, new Set());
}

/**
 * Splits a settings key that carries its own `[config=…]` condition into
 * the plain key and that configuration, which takes precedence over the
 * one in the options.
 */
function normalizeSettingKey(
  key: string,
  options: XcprojBuildSettingOptions | undefined,
): { key: string; configuration: string | undefined } {
  const split = splitConfigurationCondition(key);
  return { key: split.base, configuration: split.configuration ?? options?.configuration };
}

/**
 * Rewrites the string values of every key naming a setting, whatever
 * conditions the key carries.
 */
function rewriteSetting(
  settings: XcprojValue | undefined,
  name: string,
  rewrite: (value: string) => string | undefined,
): void {
  if (!isRecord(settings)) {
    return;
  }
  for (const key of Object.keys(settings)) {
    const value = settings[key];
    if (settingName(key) === name && typeof value === "string") {
      const rewritten = rewrite(value);
      if (rewritten != null && rewritten !== value) {
        settings[key] = rewritten;
      }
    }
  }
}

/**
 * A reference in the project's file tree, which is a file, a group, a
 * synchronized folder, a variant group of localizations, or a version
 * group of Core Data models.
 */
export class XcprojReference {
  /** The project this reference belongs to. */
  readonly project: Xcproj;

  /** The reference's dictionary inside the document. */
  readonly properties: XcprojObject;

  /**
   * Views are created through {@link Xcproj.viewOfReference}, which keeps
   * one view per dictionary.
   */
  constructor(project: Xcproj, properties: XcprojObject) {
    this.project = project;
    this.properties = properties;
  }

  /**
   * The reference's kind, which is `file-reference`, `group`, `folder`,
   * `variant-group`, or `version-group`.
   */
  get kind(): string {
    return referenceKind(this.properties);
  }

  /**
   * The name the reference goes by in the file tree and in name paths.
   * Groups may carry an explicit name, and everything else is named after
   * the last component of its path.
   */
  get name(): string {
    return referenceName(this.properties);
  }

  /**
   * The reference's path as written, for example `Sources/App.swift` or
   * `<PRODUCTS>/App.app`.
   */
  get path(): string | undefined {
    return asString(this.properties["path"]);
  }

  /**
   * The views of the reference's children, in document order. Only
   * groups, variant groups, and version groups have children.
   */
  children(): XcprojReference[] {
    return recordsOf(this.properties["children"]).map((child) => this.project.viewOfReference(child));
  }

  /**
   * The names of the targets this reference is a member of, in document
   * order. A folder lists its targets directly, and any other reference
   * names the targets of the build phases it belongs to, resolving
   * id-based phase references through the targets' phases.
   */
  targetNames(): string[] {
    const names: string[] = [];
    const memberships = this.properties["target-membership"];
    if (!Array.isArray(memberships)) {
      return names;
    }
    for (const entry of memberships) {
      const name = this.kind === "folder" ? asString(entry) : this.project.targetNameOfPhase(membershipPhase(entry));
      if (name != null && !names.includes(name)) {
        names.push(name);
      }
    }
    return names;
  }
}

/**
 * A target of any kind, which is a `native` target building a product,
 * an `aggregate` target grouping other targets, or an
 * `external-build-system` target driving a build tool.
 */
export class XcprojTarget {
  /** The project this target belongs to. */
  readonly project: Xcproj;

  /** The target's dictionary inside the document. */
  readonly properties: XcprojObject;

  /**
   * Views are created through {@link Xcproj.viewOfTarget}, which keeps one
   * view per dictionary.
   */
  constructor(project: Xcproj, properties: XcprojObject) {
    this.project = project;
    this.properties = properties;
  }

  /**
   * The target's name. Targets in this format refer to each other by
   * name, so renames go through {@link Xcproj.renameTarget}.
   */
  get name(): string | undefined {
    return asString(this.properties["name"]);
  }

  /**
   * The target's object id, which other projects and scheme files
   * reference it by.
   */
  get id(): string | undefined {
    return asString(this.properties["id"]);
  }

  /**
   * The target's kind, `native` unless the document says otherwise.
   */
  get kind(): string {
    return asString(this.properties["kind"]) ?? "native";
  }

  /**
   * The target's full product type identifier, for example
   * `com.apple.product-type.application`. The document writes Apple's
   * product types without the common prefix under `product-type`, and any
   * other identifier in full under `full-product-type`.
   */
  get productType(): string | undefined {
    const abbreviated = asString(this.properties["product-type"]);
    return abbreviated == null ? asString(this.properties["full-product-type"]) : PRODUCT_TYPE_PREFIX + abbreviated;
  }

  set productType(value: string) {
    delete this.properties["product-type"];
    delete this.properties["full-product-type"];
    if (value.startsWith(PRODUCT_TYPE_PREFIX)) {
      this.properties["product-type"] = value.slice(PRODUCT_TYPE_PREFIX.length);
    } else {
      this.properties["full-product-type"] = value;
    }
  }

  /**
   * The view of the target's product file reference, when the target has
   * one and its reference resolves.
   */
  productReference(): XcprojReference | undefined {
    const reference = this.project.resolveReference(this.properties["product"]);
    return reference == null ? undefined : this.project.viewOfReference(reference);
  }

  /**
   * The view of the target that hosts this one's tests, when it names one
   * that exists.
   */
  testHost(): XcprojTarget | undefined {
    const name = asString(this.properties["test-host-target"]);
    return name == null ? undefined : this.project.findTarget(name);
  }

  /**
   * The names of the local targets this target depends on, in
   * declaration order. Dependencies on targets of other projects and on
   * package products are not included.
   */
  dependencyNames(): string[] {
    const names: string[] = [];
    for (const dependency of Array.isArray(this.properties["dependencies"]) ? this.properties["dependencies"] : []) {
      const name = isRecord(dependency)
        ? (asString(dependency["kind"]) ?? "localTarget") === "localTarget"
          ? asString(dependency["target"])
          : undefined
        : asString(dependency);
      if (name != null) {
        names.push(name);
      }
    }
    return names;
  }

  /**
   * The views of the local targets this target depends on, in
   * declaration order, skipping names that do not resolve.
   */
  dependencies(): XcprojTarget[] {
    return this.dependencyNames()
      .map((name) => this.project.findTarget(name))
      .filter((target): target is XcprojTarget => target != null);
  }

  /**
   * Adds a dependency on another target of the project. Adding an existing
   * dependency changes nothing.
   *
   * @throws XcodeModelError when the dependency has no name to be
   *   referenced by.
   */
  addDependency(target: XcprojTarget): void {
    const name = target.name;
    if (name == null) {
      throw new XcodeModelError("Cannot depend on a target without a name");
    }
    if (!this.dependencyNames().includes(name)) {
      ensureArray(this.properties, "dependencies").push(name);
    }
  }

  /**
   * The layers this target's settings resolve through for one
   * configuration, in Xcode's order of target settings, the target's
   * xcconfig, project settings, and the project's xcconfig.
   */
  private settingLayers(configuration: string | undefined): SettingLayers {
    const project = this.project;
    return [
      settingsLayer(this.properties["build-settings"], configuration),
      project.xcconfigLayer(this.properties["specialized-configurations"], configuration),
      settingsLayer(project.document["build-settings"], configuration),
      project.xcconfigLayer(project.document["configurations"], configuration),
    ];
  }

  /**
   * The target's own settings as one configuration sees them, with the
   * `[config=…]` conditions folded away. Settings the target inherits
   * from the project are not included.
   *
   * @param configuration The configuration, defaulting to the project's
   *   default configuration.
   */
  buildSettingsFor(configuration?: string): Record<string, XcprojBuildSettingValue> {
    const view = configurationView(
      isRecord(this.properties["build-settings"]) ? this.properties["build-settings"] : undefined,
      this.project.readConfiguration(configuration),
    );
    return Object.fromEntries(view);
  }

  /**
   * Reads a build setting the way Xcode resolves it, from the target's
   * settings first and the project's below them. Configurations based on
   * `.xcconfig` files take part once the files are registered through
   * {@link Xcproj.registerXcconfig}.
   *
   * The value comes back as stored, so list settings such as
   * `LD_RUNPATH_SEARCH_PATHS` read as arrays.
   */
  getBuildSetting(key: string, options?: XcprojBuildSettingOptions): XcprojBuildSettingValue | undefined {
    const normalized = normalizeSettingKey(key, options);
    return readLayers(this.settingLayers(this.project.readConfiguration(normalized.configuration)), normalized.key);
  }

  /**
   * Reads a build setting like {@link getBuildSetting} and expands the
   * `$(NAME)` and `${NAME}` references in it. Referenced settings resolve
   * through the same layering, `$(inherited)` continues from the next
   * layer down, and `$(TARGET_NAME)` falls back to the target's name.
   * References nothing answers stay verbatim, so no information is
   * invented. A list setting resolves to its expanded items joined with
   * single spaces.
   */
  resolveBuildSetting(key: string, options?: XcprojResolveBuildSettingOptions): string | undefined {
    const normalized = normalizeSettingKey(key, options);
    const layers = this.settingLayers(this.project.readConfiguration(normalized.configuration));
    return resolveLayers(
      layers,
      normalized.key,
      (reference) => options?.lookup?.(reference) ?? (reference === "TARGET_NAME" ? this.name : undefined),
    );
  }

  /**
   * Writes a build setting on the target. Without a configuration the
   * value applies to every configuration, replacing any per-configuration
   * values of the key. With one, only that configuration changes, and the
   * values are folded the way Xcode writes them.
   */
  setBuildSetting(key: string, value: XcprojBuildSettingValue, options?: XcprojBuildSettingOptions): void {
    const normalized = normalizeSettingKey(key, options);
    const settings = ensureRecord(this.properties, "build-settings");
    setFoldedSetting(settings, normalized.key, value, normalized.configuration, this.project.configurationNames());
  }

  /**
   * Removes a build setting from every configuration of the target, or
   * from one.
   *
   * @returns Whether anything was removed.
   */
  removeBuildSetting(key: string, options?: XcprojBuildSettingOptions): boolean {
    const settings = this.properties["build-settings"];
    if (!isRecord(settings)) {
      return false;
    }
    const normalized = normalizeSettingKey(key, options);
    const removed = removeFoldedSetting(
      settings,
      normalized.key,
      normalized.configuration,
      this.project.configurationNames(),
    );
    dropIfEmpty(this.properties, "build-settings");
    return removed;
  }
}

/**
 * A `project.xcproj` document with typed access to its targets, file
 * tree, and build settings.
 *
 * ```ts
 * const project = Xcproj.parse(xcprojText);
 * const app = project.findMainAppTarget("ios");
 * app?.getBuildSetting("PRODUCT_BUNDLE_IDENTIFIER");
 * app?.setBuildSetting("MARKETING_VERSION", "1.2.0");
 * const text = project.build();
 * ```
 */
export class Xcproj {
  /** The parsed document this model wraps. */
  readonly document: XcprojObject;

  /** One view per target dictionary, so views compare with `===`. */
  private readonly targetViews = new WeakMap<XcprojObject, XcprojTarget>();

  /** One view per reference dictionary, so views compare with `===`. */
  private readonly referenceViews = new WeakMap<XcprojObject, XcprojReference>();

  /** Flattened settings of registered `.xcconfig` files, by file reference. */
  private readonly xcconfigSettings = new Map<string, ReadonlyMap<string, string>>();

  private constructor(document: XcprojObject) {
    this.document = document;
  }

  /**
   * Parses the text of a `project.xcproj` file into a model.
   *
   * @throws XcprojParseError when the text is not well-formed JSON5, with
   *   the line and column of the failure.
   * @throws XcodeModelError when the document is not a dictionary.
   */
  static parse(text: string): Xcproj {
    const document = parseXcproj(text);
    if (!isRecord(document)) {
      throw new XcodeModelError("A project.xcproj document must be a dictionary");
    }
    return new Xcproj(document);
  }

  /**
   * Wraps an already parsed document. The model works on the document in
   * place.
   */
  static fromDocument(document: XcprojObject): Xcproj {
    return new Xcproj(document);
  }

  /**
   * Serializes the document to the text of a `project.xcproj` file in
   * Xcode's layout.
   */
  build(): string {
    return buildXcproj(this.document);
  }

  /**
   * The name of the configuration builds use when none is chosen, for
   * example `Release`.
   */
  get defaultConfiguration(): string | undefined {
    return asString(this.document["default-configuration"]);
  }

  /**
   * The names of the project's build configurations, in document order.
   * Targets share these configurations.
   */
  configurationNames(): string[] {
    const names: string[] = [];
    for (const configuration of Array.isArray(this.document["configurations"]) ? this.document["configurations"] : []) {
      const name = isRecord(configuration) ? asString(configuration["name"]) : asString(configuration);
      if (name != null) {
        names.push(name);
      }
    }
    return names;
  }

  /**
   * The configuration a read uses, which is the requested one, else the
   * default configuration, else the first configuration.
   */
  readConfiguration(configuration: string | undefined): string | undefined {
    return configuration ?? this.defaultConfiguration ?? this.configurationNames()[0];
  }

  /**
   * Registers the contents of a `.xcconfig` file so build-setting reads
   * can layer it below the configurations based on it. The library never
   * touches the filesystem, so the caller loads the file and hands it over
   * together with the reference configurations name it by, which is the
   * `file` value as written, for example `Configs/Base.xcconfig`. A file
   * anchored inside a folder is named by the anchor and the relative path
   * joined with `/`. Included files take part through
   * {@link XcconfigSettingsOptions.resolveInclude}, and the settings are
   * flattened once, at registration.
   */
  registerXcconfig(file: string, config: Xcconfig, options: XcconfigSettingsOptions = {}): void {
    this.xcconfigSettings.set(file, new Map(Object.entries(config.settings(options))));
  }

  /**
   * The registered xcconfig settings of the configuration named in a
   * configuration list, as a layer, or `undefined` when the configuration
   * names no file or the file was not registered.
   */
  xcconfigLayer(
    configurations: XcprojValue | undefined,
    configuration: string | undefined,
  ): ReadonlyMap<string, string> | undefined {
    const entry = recordsOf(configurations).find((candidate) => candidate["name"] === configuration);
    const file = entry == null ? undefined : configurationFileName(entry["file"]);
    return file == null ? undefined : this.xcconfigSettings.get(file);
  }

  /**
   * The layers project-level settings resolve through for one
   * configuration.
   */
  private settingLayers(configuration: string | undefined): SettingLayers {
    return [
      settingsLayer(this.document["build-settings"], configuration),
      this.xcconfigLayer(this.document["configurations"], configuration),
    ];
  }

  /**
   * The project's own settings as one configuration sees them, with the
   * `[config=…]` conditions folded away.
   *
   * @param configuration The configuration, defaulting to the default
   *   configuration.
   */
  buildSettingsFor(configuration?: string): Record<string, XcprojBuildSettingValue> {
    const settings = this.document["build-settings"];
    return Object.fromEntries(
      configurationView(isRecord(settings) ? settings : undefined, this.readConfiguration(configuration)),
    );
  }

  /**
   * Reads a project-level build setting, from the project's settings and
   * then the xcconfig file of the configuration.
   */
  getBuildSetting(key: string, options?: XcprojBuildSettingOptions): XcprojBuildSettingValue | undefined {
    const normalized = normalizeSettingKey(key, options);
    return readLayers(this.settingLayers(this.readConfiguration(normalized.configuration)), normalized.key);
  }

  /**
   * Reads a project-level build setting and expands its references, like
   * {@link XcprojTarget.resolveBuildSetting} does for targets.
   */
  resolveBuildSetting(key: string, options?: XcprojResolveBuildSettingOptions): string | undefined {
    const normalized = normalizeSettingKey(key, options);
    const layers = this.settingLayers(this.readConfiguration(normalized.configuration));
    return resolveLayers(layers, normalized.key, (reference) => options?.lookup?.(reference));
  }

  /**
   * Writes a project-level build setting, for every configuration or for
   * one, folded the way Xcode writes it.
   */
  setBuildSetting(key: string, value: XcprojBuildSettingValue, options?: XcprojBuildSettingOptions): void {
    const normalized = normalizeSettingKey(key, options);
    const settings = ensureRecord(this.document, "build-settings");
    setFoldedSetting(settings, normalized.key, value, normalized.configuration, this.configurationNames());
  }

  /**
   * Removes a project-level build setting from every configuration, or
   * from one.
   *
   * @returns Whether anything was removed.
   */
  removeBuildSetting(key: string, options?: XcprojBuildSettingOptions): boolean {
    const settings = this.document["build-settings"];
    if (!isRecord(settings)) {
      return false;
    }
    const normalized = normalizeSettingKey(key, options);
    const removed = removeFoldedSetting(settings, normalized.key, normalized.configuration, this.configurationNames());
    dropIfEmpty(this.document, "build-settings");
    return removed;
  }

  /**
   * Returns the view of a target dictionary. Two calls with the same
   * dictionary return the same view.
   */
  viewOfTarget(properties: XcprojObject): XcprojTarget {
    let view = this.targetViews.get(properties);
    if (view == null) {
      view = new XcprojTarget(this, properties);
      this.targetViews.set(properties, view);
    }
    return view;
  }

  /**
   * Returns the view of a file tree reference dictionary. Two calls with
   * the same dictionary return the same view.
   */
  viewOfReference(properties: XcprojObject): XcprojReference {
    let view = this.referenceViews.get(properties);
    if (view == null) {
      view = new XcprojReference(this, properties);
      this.referenceViews.set(properties, view);
    }
    return view;
  }

  /**
   * The views of the project's targets of every kind, in document order.
   */
  targets(): XcprojTarget[] {
    return recordsOf(this.document["targets"]).map((target) => this.viewOfTarget(target));
  }

  /**
   * Finds a target of any kind by name. Target names are unique in a
   * project, which is what lets the format reference targets by name.
   */
  findTarget(name: string): XcprojTarget | undefined {
    return this.targets().find((target) => target.name === name);
  }

  /**
   * Finds the main application target for a platform. It prefers the
   * application target whose own settings carry the platform's
   * deployment-target key, and falls back to the first application target
   * in project order.
   */
  findMainAppTarget(platform: ApplePlatform = "ios"): XcprojTarget | undefined {
    const deploymentKey = DEPLOYMENT_TARGET_KEY[platform];
    const applications = this.targets().filter(
      (target) => target.kind === "native" && target.productType === ProductType.application,
    );
    const byDeploymentTarget = applications.find((target) => {
      const settings = target.properties["build-settings"];
      return isRecord(settings) && Object.keys(settings).some((key) => settingName(key) === deploymentKey);
    });
    return byDeploymentTarget ?? applications[0];
  }

  /**
   * The views of the top-level references of the file tree, in document
   * order.
   */
  files(): XcprojReference[] {
    return recordsOf(this.document["files"]).map((reference) => this.viewOfReference(reference));
  }

  /**
   * The views of every reference in the file tree, depth first and in
   * document order.
   */
  references(): XcprojReference[] {
    const views: XcprojReference[] = [];
    visitReferences(this.document["files"], (reference) => views.push(this.viewOfReference(reference)));
    return views;
  }

  /**
   * Finds a reference by its name path from the top of the file tree, as
   * in `Products/App.app`. Each step matches the first child whose name
   * is the component, the way a target's `product` reference resolves.
   * Pass an array of names to look up names that contain `/`.
   *
   * The names are the names in the file tree, not the paths on disk, and
   * members of synchronized folders are not listed in the document, so
   * they cannot be found.
   */
  findReference(namePath: string | readonly string[]): XcprojReference | undefined {
    const components =
      typeof namePath === "string"
        ? decodeNamePath(namePath)
        : namePath.map((name): NamePathComponent => ({ name, relative: false }));
    const reference = components == null ? undefined : this.resolveNamePath(components);
    return reference == null ? undefined : this.viewOfReference(reference);
  }

  /**
   * Resolves a group tree reference value, by object id or by name path,
   * to the reference dictionary it names.
   */
  resolveReference(value: XcprojValue | undefined): XcprojObject | undefined {
    if (typeof value === "string" && value.startsWith(ID_PREFIX)) {
      const id = value.slice(ID_PREFIX.length);
      let found: XcprojObject | undefined;
      visitReferences(this.document["files"], (reference) => {
        if (found == null && reference["id"] === id) {
          found = reference;
        }
      });
      return found;
    }
    const components = decodeNamePath(value);
    return components == null ? undefined : this.resolveNamePath(components);
  }

  /**
   * Walks decoded name path components down from the top of the tree.
   */
  private resolveNamePath(components: readonly NamePathComponent[]): XcprojObject | undefined {
    const trail: XcprojObject[] = [];
    for (const component of components) {
      if (component.relative) {
        if (component.name === "..") {
          trail.pop();
        }
        continue;
      }
      const parent = trail.at(-1);
      const siblings = parent == null ? this.document["files"] : parent["children"];
      const match = recordsOf(siblings).find((reference) => referenceName(reference) === component.name);
      if (match == null) {
        return undefined;
      }
      trail.push(match);
    }
    return trail.at(-1);
  }

  /**
   * The name of the target a build phase reference points into. Name
   * references carry the target as their first component, and id
   * references are looked up among the targets' build phases.
   */
  targetNameOfPhase(phase: XcprojValue | undefined): string | undefined {
    if (typeof phase === "string" && phase.startsWith(ID_PREFIX)) {
      const id = phase.slice(ID_PREFIX.length);
      return this.targets().find((target) => recordsOf(target.properties["build-phases"]).some((p) => p["id"] === id))
        ?.name;
    }
    return phaseTargetName(phase);
  }

  /**
   * Throws unless the target is one of this project's targets.
   */
  private requireOwnTarget(target: XcprojTarget, action: string): XcprojArray {
    const targets = this.document["targets"];
    if (target.project !== this || !Array.isArray(targets) || !targets.includes(target.properties)) {
      throw new XcodeModelError(`Cannot ${action} a target that is not part of this project`);
    }
    return targets;
  }

  /**
   * Renames a target and every place the document knows it by name.
   *
   * Targets in this format are referenced by name, so a rename touches
   * more than the target itself. It covers other targets' dependencies and
   * test hosts, the build phase references in the target membership of
   * files and imported products, folder memberships and exception sets,
   * the product file reference and the target's name path to it, the
   * target's own `PRODUCT_NAME` when it spells the old name, and the
   * `TEST_TARGET_NAME`, `TEST_HOST`, and `BUNDLE_LOADER` settings naming
   * the target or its product. Names match whole, so renaming `DemoApp`
   * leaves `DemoAppTests` alone.
   *
   * Scheme files live outside the project file and are renamed through
   * `Xcscheme.renameTarget`. On-disk renames stay with the caller.
   *
   * @throws XcodeModelError when the target is not part of this project,
   *   another target already has the new name, or the renamed product
   *   file name would contain `/`, which this format cannot represent.
   *   Nothing is changed in those cases.
   */
  renameTarget(target: XcprojTarget, newName: string): void {
    this.requireOwnTarget(target, "rename");
    const oldName = target.name;
    if (oldName === newName) {
      return;
    }
    if (this.findTarget(newName) != null) {
      throw new XcodeModelError(`Cannot rename a target to ${newName}, which another target already uses`);
    }
    const productRename = oldName == null ? undefined : this.planProductRename(target, oldName, newName);
    target.properties["name"] = newName;
    // A target with no name gains one, and there is no old name for the
    // rest of the document to know it by.
    if (oldName == null) {
      return;
    }

    productRename?.();
    rewriteSetting(target.properties["build-settings"], "PRODUCT_NAME", (value) =>
      value === oldName ? newName : undefined,
    );

    for (const settings of [
      this.document["build-settings"],
      ...this.targets().map((other) => other.properties["build-settings"]),
    ]) {
      rewriteSetting(settings, "TEST_TARGET_NAME", (value) => (value === oldName ? newName : undefined));
      for (const name of ["TEST_HOST", "BUNDLE_LOADER"]) {
        rewriteSetting(settings, name, (value) => renamePathSegments(value, oldName, newName));
      }
    }

    for (const other of this.targets()) {
      const properties = other.properties;
      if (properties["test-host-target"] === oldName) {
        properties["test-host-target"] = newName;
      }
      const dependencies = properties["dependencies"];
      if (!Array.isArray(dependencies)) {
        continue;
      }
      for (let index = 0; index < dependencies.length; index++) {
        const dependency = dependencies[index];
        if (dependency === oldName) {
          dependencies[index] = newName;
        } else if (
          isRecord(dependency) &&
          (asString(dependency["kind"]) ?? "localTarget") === "localTarget" &&
          dependency["target"] === oldName
        ) {
          dependency["target"] = newName;
        }
      }
    }

    visitReferences(this.document["files"], (reference) => {
      if (referenceKind(reference) !== "folder") {
        retargetMemberships(reference["target-membership"], oldName, newName);
        return;
      }
      const memberships = reference["target-membership"];
      if (Array.isArray(memberships)) {
        for (let index = 0; index < memberships.length; index++) {
          if (memberships[index] === oldName) {
            memberships[index] = newName;
          }
        }
      }
      for (const exceptions of recordsOf(reference["membership-exceptions"])) {
        if (exceptions["target"] === oldName) {
          exceptions["target"] = newName;
        }
        const phase = exceptions["build-phase"];
        if (phase != null && phaseTargetName(phase) === oldName) {
          exceptions["build-phase"] = retargetPhase(phase, newName);
        }
      }
    });

    for (const product of recordsOf(this.document["imported-products"])) {
      retargetMemberships(product["target-membership"], oldName, newName);
    }
  }

  /**
   * Plans the rename of a target's product file, whose file name stem is
   * the old target name, and of the target's name path to it. The plan is
   * returned as a function so the caller can validate everything before
   * changing anything, and it is `undefined` when the product keeps its
   * name.
   *
   * @throws XcodeModelError when the renamed file name would contain `/`.
   *   Xcode names a file reference after the last component of its path,
   *   so such a product could not keep its name.
   */
  private planProductRename(target: XcprojTarget, oldName: string, newName: string): (() => void) | undefined {
    const product = this.resolveReference(target.properties["product"]);
    const path = product == null ? undefined : asString(product["path"]);
    if (product == null || path == null) {
      return undefined;
    }
    const decoded = decodeFilePath(path);
    const fileName = lastPathComponent(decoded.path);
    const renamed = renameFileNameStem(fileName, oldName, newName);
    if (renamed == null || !decoded.path.endsWith(fileName)) {
      return undefined;
    }
    if (renamed.includes("/")) {
      throw new XcodeModelError(
        `Cannot rename ${oldName} to ${newName}, because its product would be named ${renamed}, and product names cannot contain "/"`,
      );
    }

    return () => {
      product["path"] = encodeFilePath({
        base: decoded.base,
        path: decoded.path.slice(0, decoded.path.length - fileName.length) + renamed,
      });
      const components = decodeNamePath(target.properties["product"]);
      const last = components?.at(-1);
      if (components != null && last != null && !last.relative && last.name === fileName) {
        target.properties["product"] = encodeNamePath([...components.slice(0, -1), { name: renamed, relative: false }]);
      }
    };
  }

  /**
   * Removes a target and every reference the document holds to it.
   *
   * That covers the target itself, its product file reference (and with
   * it any embedding of the product into other targets), other targets'
   * dependencies on it and test host references to it, file memberships
   * in its build phases, folder memberships and exception sets for it,
   * and imported products linked into it. A folder that only this target
   * used is removed too. Sources on disk are untouched.
   *
   * @throws XcodeModelError when the target is not part of this project.
   */
  removeTarget(target: XcprojTarget): void {
    const targets = this.requireOwnTarget(target, "remove");
    const name = target.name;
    const product = this.resolveReference(target.properties["product"]);
    const phaseIds = new Set(
      recordsOf(target.properties["build-phases"])
        .map((phase) => asString(phase["id"]))
        .filter((id): id is string => id != null)
        .map((id) => ID_PREFIX + id),
    );

    targets.splice(targets.indexOf(target.properties), 1);
    dropIfEmpty(this.document, "targets");
    if (product != null) {
      removeFromTree(this.document["files"], product);
    }
    if (name == null) {
      return;
    }

    const namesRemoved = (phase: XcprojValue | undefined): boolean =>
      (typeof phase === "string" && phaseIds.has(phase)) || phaseTargetName(phase) === name;
    const keepMemberships = (owner: XcprojObject, keepEmpty: boolean): void => {
      const memberships = owner["target-membership"];
      if (!Array.isArray(memberships)) {
        return;
      }
      owner["target-membership"] = memberships.filter((entry) => !namesRemoved(membershipPhase(entry)));
      if (!keepEmpty) {
        dropIfEmpty(owner, "target-membership");
      }
    };

    for (const other of this.targets()) {
      const properties = other.properties;
      if (properties["test-host-target"] === name) {
        delete properties["test-host-target"];
      }
      if (Array.isArray(properties["dependencies"])) {
        properties["dependencies"] = properties["dependencies"].filter(
          (dependency) =>
            dependency !== name &&
            !(
              isRecord(dependency) &&
              (asString(dependency["kind"]) ?? "localTarget") === "localTarget" &&
              dependency["target"] === name
            ),
        );
        dropIfEmpty(properties, "dependencies");
      }
    }

    const abandonedFolders: XcprojObject[] = [];
    visitReferences(this.document["files"], (reference) => {
      if (referenceKind(reference) !== "folder") {
        keepMemberships(reference, false);
        return;
      }
      const memberships = reference["target-membership"];
      if (Array.isArray(memberships) && memberships.includes(name)) {
        const kept = memberships.filter((member) => member !== name);
        reference["target-membership"] = kept;
        if (kept.length === 0) {
          abandonedFolders.push(reference);
        }
        dropIfEmpty(reference, "target-membership");
      }
      if (Array.isArray(reference["membership-exceptions"])) {
        reference["membership-exceptions"] = reference["membership-exceptions"].filter(
          (exceptions) =>
            !(isRecord(exceptions) && (exceptions["target"] === name || namesRemoved(exceptions["build-phase"]))),
        );
        dropIfEmpty(reference, "membership-exceptions");
      }
    });
    for (const folder of abandonedFolders) {
      removeFromTree(this.document["files"], folder);
    }

    for (const imported of recordsOf(this.document["imported-products"])) {
      keepMemberships(imported, true);
    }
  }
}

/**
 * The name a configuration's `file` value goes by for
 * {@link Xcproj.registerXcconfig}. A name path reads as its names joined
 * with `/`, and a file anchored in a folder as the anchor and the
 * relative path joined the same way.
 */
function configurationFileName(file: XcprojValue | undefined): string | undefined {
  if (typeof file === "string") {
    return file;
  }
  if (Array.isArray(file)) {
    return decodeNamePath(file)
      ?.map((component) => component.name)
      .join("/");
  }
  if (isRecord(file)) {
    const anchor = configurationFileName(file["anchor"]);
    const relative = configurationFileName(file["relative-path"]);
    return anchor == null || relative == null ? undefined : `${anchor}/${relative}`;
  }
  return undefined;
}
