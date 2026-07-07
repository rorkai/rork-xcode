/**
 * Helpers over the scheme node tree: element queries and the default
 * scheme factory.
 *
 * The tree itself is plain data, so most edits are direct property
 * writes. What this module adds is the recursive query that editing
 * flows start from and a factory producing the scheme Xcode's own "New
 * Scheme" action writes for an application target.
 *
 * @module
 */

import { isXcschemeElement } from "./types";

import type { XcschemeDocument, XcschemeElement } from "./types";

/**
 * Collects elements of the given name anywhere in the tree, in document
 * order, the subtree root included. Passing no name collects every
 * element.
 *
 * ```ts
 * for (const reference of xcschemeElements(scheme.root, "BuildableReference")) {
 *   reference.attributes["BlueprintName"] = "RenamedApp";
 * }
 * ```
 */
export function xcschemeElements(root: XcschemeElement, name?: string): XcschemeElement[] {
  const found: XcschemeElement[] = [];
  const visit = (element: XcschemeElement): void => {
    if (name == null || element.name === name) {
      found.push(element);
    }
    for (const child of element.children) {
      if (isXcschemeElement(child)) {
        visit(child);
      }
    }
  };
  visit(root);
  return found;
}

/**
 * Options for {@link createXcscheme}.
 */
export interface CreateXcschemeOptions {
  /** The application target's name, which also names the scheme. */
  appName: string;

  /**
   * The `.xcodeproj` directory name the buildable references point at.
   * Defaults to `<appName>.xcodeproj`.
   */
  xcodeprojName?: string;

  /**
   * The application target's object id in the project document. Xcode
   * repairs an empty identifier on first open, so omitting it still
   * produces a working scheme.
   */
  blueprintIdentifier?: string;
}

/**
 * Creates the scheme Xcode writes for an application target: build,
 * launch, profile, analyze, and archive actions wired to the app product,
 * with Xcode's default configuration choices (Debug for development
 * actions, Release for profiling and archiving).
 */
export function createXcscheme(options: CreateXcschemeOptions): XcschemeDocument {
  const xcodeprojName = options.xcodeprojName ?? `${options.appName}.xcodeproj`;

  /**
   * Buildable references appear once per action; each site gets its own
   * element so a mutation through one action cannot alias into another.
   */
  const buildableReference = (): XcschemeElement => ({
    name: "BuildableReference",
    attributes: {
      BuildableIdentifier: "primary",
      BlueprintIdentifier: options.blueprintIdentifier ?? "",
      BuildableName: `${options.appName}.app`,
      BlueprintName: options.appName,
      ReferencedContainer: `container:${xcodeprojName}`,
    },
    children: [],
  });

  const root: XcschemeElement = {
    name: "Scheme",
    attributes: { version: "1.7" },
    children: [
      {
        name: "BuildAction",
        attributes: { parallelizeBuildables: "YES", buildImplicitDependencies: "YES" },
        children: [
          {
            name: "BuildActionEntries",
            attributes: {},
            children: [
              {
                name: "BuildActionEntry",
                attributes: {
                  buildForTesting: "YES",
                  buildForRunning: "YES",
                  buildForProfiling: "YES",
                  buildForArchiving: "YES",
                  buildForAnalyzing: "YES",
                },
                children: [buildableReference()],
              },
            ],
          },
        ],
      },
      {
        name: "LaunchAction",
        attributes: {
          buildConfiguration: "Debug",
          selectedDebuggerIdentifier: "Xcode.DebuggerFoundation.Debugger.LLDB",
          selectedLauncherIdentifier: "Xcode.DebuggerFoundation.Launcher.LLDB",
          launchStyle: "0",
          useCustomWorkingDirectory: "NO",
          ignoresPersistentStateOnLaunch: "NO",
          debugDocumentVersioning: "YES",
          debugServiceExtension: "internal",
          allowLocationSimulation: "YES",
        },
        children: [
          {
            name: "BuildableProductRunnable",
            attributes: { runnableDebuggingMode: "0" },
            children: [buildableReference()],
          },
        ],
      },
      {
        name: "ProfileAction",
        attributes: {
          buildConfiguration: "Release",
          shouldUseLaunchSchemeArgsEnv: "YES",
          savedToolIdentifier: "",
          useCustomWorkingDirectory: "NO",
          debugDocumentVersioning: "YES",
        },
        children: [
          {
            name: "BuildableProductRunnable",
            attributes: { runnableDebuggingMode: "0" },
            children: [buildableReference()],
          },
        ],
      },
      {
        name: "AnalyzeAction",
        attributes: { buildConfiguration: "Debug" },
        children: [],
      },
      {
        name: "ArchiveAction",
        attributes: { buildConfiguration: "Release", revealArchiveInOrganizer: "YES" },
        children: [],
      },
    ],
  };

  return { leading: [], root, trailing: [] };
}
