/**
 * Build settings across configurations.
 *
 * A pbxproj keeps one settings dictionary per build configuration. The
 * JSON format folds them into a single dictionary instead. A value every
 * configuration shares is written once under its plain key, and a value
 * that differs is written once per configuration under a key carrying a
 * `[config=Name]` condition, placed before any `sdk` or `arch` condition:
 *
 * ```json
 * "SWIFT_VERSION": "5.0",
 * "SWIFT_OPTIMIZATION_LEVEL[config=Debug]": "-Onone",
 * "SWIFT_OPTIMIZATION_LEVEL[config=Release]": "-O",
 * "OTHER_LDFLAGS[config=Debug][sdk=iphoneos*]": "-ObjC",
 * ```
 *
 * The helpers here read one configuration's view of such a dictionary
 * and write values back in that same folded form, so edits come out the
 * way Xcode would save them.
 *
 * @module
 */

import type { XcprojObject, XcprojValue } from "./types";

/**
 * A setting value, which is a string or a list of strings.
 */
export type XcprojBuildSettingValue = string | readonly string[];

/**
 * A settings key split around its configuration condition.
 */
interface SplitKey {
  /** The key without its `[config=…]` condition, other conditions kept. */
  readonly base: string;

  /** The configuration the key is conditioned on, when it is. */
  readonly configuration: string | undefined;
}

/**
 * The opening of a configuration condition inside a settings key.
 */
const CONFIGURATION_CONDITION = "[config=";

/**
 * Splits a settings key into the key without its configuration
 * condition and the configuration name, wherever the condition sits. A
 * key whose condition is never closed is not conditioned at all.
 */
export function splitConfigurationCondition(key: string): SplitKey {
  const start = key.indexOf(CONFIGURATION_CONDITION);
  const end = start === -1 ? -1 : key.indexOf("]", start);
  if (end === -1) {
    return { base: key, configuration: undefined };
  }
  return {
    base: key.slice(0, start) + key.slice(end + 1),
    configuration: key.slice(start + CONFIGURATION_CONDITION.length, end),
  };
}

/**
 * Adds a configuration condition to a key, before any other condition
 * the key carries, which is where Xcode places it.
 */
export function withConfigurationCondition(key: string, configuration: string): string {
  const open = key.indexOf("[");
  const condition = `[config=${configuration}]`;
  return open === -1 ? key + condition : key.slice(0, open) + condition + key.slice(open);
}

/**
 * The name of a setting without any conditions, so
 * `OTHER_LDFLAGS[config=Debug][sdk=iphoneos*]` reads as `OTHER_LDFLAGS`.
 */
export function settingName(key: string): string {
  const open = key.indexOf("[");
  return open === -1 ? key : key.slice(0, open);
}

/**
 * Narrows a stored value to a setting value. Lists holding anything but
 * strings are malformed and read as missing.
 */
export function asSettingValue(value: XcprojValue | undefined): XcprojBuildSettingValue | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  return undefined;
}

/**
 * The view of a folded settings dictionary that one configuration sees,
 * with configuration conditions removed from the keys. Keys conditioned
 * on another configuration are left out, and a key conditioned on this
 * configuration wins over the same key without the condition.
 *
 * Passing no configuration keeps only the unconditional keys, which is
 * what every configuration shares.
 */
export function configurationView(
  settings: XcprojObject | undefined,
  configuration: string | undefined,
): Map<string, XcprojBuildSettingValue> {
  const view = new Map<string, XcprojBuildSettingValue>();
  if (settings == null) {
    return view;
  }
  const conditioned: [string, XcprojBuildSettingValue][] = [];
  for (const key of Object.keys(settings)) {
    const value = asSettingValue(settings[key]);
    if (value == null) {
      continue;
    }
    const split = splitConfigurationCondition(key);
    if (split.configuration == null) {
      view.set(key, value);
    } else if (split.configuration === configuration) {
      conditioned.push([split.base, value]);
    }
  }
  for (const [key, value] of conditioned) {
    view.set(key, value);
  }
  return view;
}

/**
 * Whether two setting values are equal.
 */
function sameValue(a: XcprojBuildSettingValue, b: XcprojBuildSettingValue): boolean {
  if (typeof a === "string" || typeof b === "string") {
    return a === b;
  }
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Copies a setting value into the document, so later edits of the
 * caller's array do not reach into it.
 */
function storedValue(value: XcprojBuildSettingValue): XcprojValue {
  return typeof value === "string" ? value : [...value];
}

/**
 * Rewrites one setting of a folded dictionary from its value per
 * configuration. Every existing entry of the key, unconditional or
 * conditioned on a configuration, is replaced. When all configurations
 * hold the same value it is written once under the plain key, and
 * otherwise once per configuration that has a value, the same folding
 * Xcode applies on save.
 */
function writeFolded(
  settings: XcprojObject,
  key: string,
  values: ReadonlyMap<string, XcprojBuildSettingValue | undefined>,
): void {
  for (const existing of Object.keys(settings)) {
    if (splitConfigurationCondition(existing).base === key) {
      delete settings[existing];
    }
  }

  const defined = [...values].filter((entry): entry is [string, XcprojBuildSettingValue] => entry[1] != null);
  const [first] = defined;
  if (first == null) {
    return;
  }
  if (defined.length === values.size && defined.every(([, value]) => sameValue(value, first[1]))) {
    settings[key] = storedValue(first[1]);
    return;
  }
  for (const [configuration, value] of defined) {
    settings[withConfigurationCondition(key, configuration)] = storedValue(value);
  }
}

/**
 * The value of a setting per configuration, before an edit.
 */
function valuesPerConfiguration(
  settings: XcprojObject,
  key: string,
  configurations: readonly string[],
): Map<string, XcprojBuildSettingValue | undefined> {
  const values = new Map<string, XcprojBuildSettingValue | undefined>();
  for (const configuration of configurations) {
    values.set(configuration, configurationView(settings, configuration).get(key));
  }
  return values;
}

/**
 * Writes a setting into a folded dictionary.
 *
 * Without a configuration the value applies to every configuration, so
 * it replaces the key's per-configuration variants with one plain entry.
 * With a configuration only that configuration changes, and the others
 * keep their values, folded back into one entry when they all agree.
 *
 * @param settings The folded dictionary.
 * @param key The setting key, with any `sdk` or `arch` conditions but
 *   without a `config` condition.
 * @param value The value to write.
 * @param configuration The configuration to write for, if only one.
 * @param configurations The names of every configuration of the project.
 */
export function setFoldedSetting(
  settings: XcprojObject,
  key: string,
  value: XcprojBuildSettingValue,
  configuration: string | undefined,
  configurations: readonly string[],
): void {
  if (configuration == null) {
    writeFolded(settings, key, new Map([["", value]]));
    return;
  }
  const names = configurations.includes(configuration) ? configurations : [...configurations, configuration];
  const values = valuesPerConfiguration(settings, key, names);
  values.set(configuration, value);
  writeFolded(settings, key, values);
}

/**
 * Removes a setting from a folded dictionary, from every configuration
 * or from one.
 *
 * @returns Whether anything was removed.
 */
export function removeFoldedSetting(
  settings: XcprojObject,
  key: string,
  configuration: string | undefined,
  configurations: readonly string[],
): boolean {
  const before = Object.keys(settings).length;
  if (configuration == null) {
    writeFolded(settings, key, new Map());
    return Object.keys(settings).length !== before;
  }
  const values = valuesPerConfiguration(settings, key, configurations);
  if (values.get(configuration) == null) {
    return false;
  }
  values.set(configuration, undefined);
  writeFolded(settings, key, values);
  return true;
}
