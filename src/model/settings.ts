/**
 * Build-configuration helpers shared by targets and the root project
 * object, both of which own an `XCConfigurationList`.
 *
 * @module
 */

import { BuildConfiguration } from "./objects";
import { asDictionary, asString, stringItems } from "./values";

import type { PbxprojObject } from "../types";
import type { XcodeProject } from "./project";

/**
 * The views of a configuration list's build configurations, in list order.
 * Dangling ids and objects of other kinds in malformed documents are
 * skipped.
 */
export function configurationsOf(project: XcodeProject, configurationListId: string | undefined): BuildConfiguration[] {
  const list = asDictionary(project.propertiesOfOptional(configurationListId));
  const configurations: BuildConfiguration[] = [];
  for (const id of stringItems(list?.["buildConfigurations"])) {
    const configuration = project.get(id);
    if (BuildConfiguration.is(configuration)) {
      configurations.push(configuration);
    }
  }
  return configurations;
}

/**
 * The settings dictionary of a configuration list's default configuration:
 * the one named by `defaultConfigurationName`, falling back to the first
 * configuration. Returns `undefined` when the list has no configurations
 * or the default carries no settings dictionary.
 */
export function defaultConfigurationSettingsOf(
  project: XcodeProject,
  configurationListId: string | undefined,
): PbxprojObject | undefined {
  const list = asDictionary(project.propertiesOfOptional(configurationListId));
  const configurations = configurationsOf(project, configurationListId);
  const defaultName = asString(list?.["defaultConfigurationName"]);
  const defaultConfiguration =
    configurations.find((configuration) => configuration.getString("name") === defaultName) ?? configurations[0];
  return asDictionary(defaultConfiguration?.properties["buildSettings"]);
}
