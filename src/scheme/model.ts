/**
 * The scheme object model and its helpers.
 *
 * {@link Xcscheme} wraps a parsed document with the typed access editing
 * flows want, {@link BuildableReference} gives buildable references
 * property-style attribute access, {@link xcschemeElements} is the
 * recursive query underneath it all, and {@link createXcscheme} produces
 * the scheme Xcode's own "New Scheme" action writes. The node tree stays
 * the single source of truth. Views hold only a reference into it, so
 * model calls and direct tree edits compose freely.
 *
 * @module
 */

import { renameFileNameStem } from "../rename";
import { xmlElements } from "../xml/types";
import { buildXcscheme } from "./build";
import { parseXcscheme } from "./parse";

import type { XcschemeDocument, XcschemeElement } from "./types";

/**
 * Collects elements of the given name anywhere in the tree, in document
 * order, the subtree root included. Passing no name collects every
 * element.
 */
export function xcschemeElements(root: XcschemeElement, name?: string): XcschemeElement[] {
  return xmlElements(root, name);
}

/**
 * A `BuildableReference` element with property-style attribute access.
 *
 * Buildable references are the elements editing flows touch most, since
 * every action points at its target through one. The view reads and
 * writes the element's attributes directly, so it never goes stale and
 * needs no separate save step.
 */
export class BuildableReference {
  /** The underlying element inside the document tree. */
  readonly element: XcschemeElement;

  constructor(element: XcschemeElement) {
    this.element = element;
  }

  /**
   * The referenced target's object id in the project document, when
   * present. Xcode repairs a missing or stale identifier on first open.
   */
  get blueprintIdentifier(): string | undefined {
    return this.element.attributes["BlueprintIdentifier"];
  }

  set blueprintIdentifier(value: string) {
    this.element.attributes["BlueprintIdentifier"] = value;
  }

  /**
   * The referenced target's name, when present.
   */
  get blueprintName(): string | undefined {
    return this.element.attributes["BlueprintName"];
  }

  set blueprintName(value: string) {
    this.element.attributes["BlueprintName"] = value;
  }

  /**
   * The built product's file name, for example `DemoApp.app`, when
   * present.
   */
  get buildableName(): string | undefined {
    return this.element.attributes["BuildableName"];
  }

  set buildableName(value: string) {
    this.element.attributes["BuildableName"] = value;
  }

  /**
   * The container the target lives in, for example
   * `container:DemoApp.xcodeproj`, when present.
   */
  get referencedContainer(): string | undefined {
    return this.element.attributes["ReferencedContainer"];
  }

  set referencedContainer(value: string) {
    this.element.attributes["ReferencedContainer"] = value;
  }
}

/**
 * A scheme document with typed access to the elements editing flows
 * touch.
 *
 * The model is a thin layer over the node tree. All state lives in the
 * document itself, and {@link build} serializes whatever the tree
 * currently says, so typed edits and direct tree edits compose freely.
 *
 * ```ts
 * const scheme = Xcscheme.parse(xcschemeText);
 * for (const reference of scheme.buildableReferences()) {
 *   reference.blueprintName = "RenamedApp";
 *   reference.buildableName = "RenamedApp.app";
 * }
 * const text = scheme.build();
 * ```
 */
export class Xcscheme {
  /** The underlying parsed document. */
  readonly document: XcschemeDocument;

  constructor(document: XcschemeDocument) {
    this.document = document;
  }

  /**
   * Parses the text of a `.xcscheme` file into a scheme model.
   *
   * @throws XcschemeParseError when the text is not a well-formed scheme
   *   document, with the line and column of the failure.
   */
  static parse(text: string): Xcscheme {
    return new Xcscheme(parseXcscheme(text));
  }

  /**
   * Creates the scheme Xcode writes for an application target. See
   * {@link createXcscheme} for the shape it produces.
   */
  static create(options: CreateXcschemeOptions): Xcscheme {
    return new Xcscheme(createXcscheme(options));
  }

  /**
   * The document's `Scheme` element.
   */
  get root(): XcschemeElement {
    return this.document.root;
  }

  /**
   * Serializes the scheme to the text of a `.xcscheme` file in Xcode's
   * canonical layout.
   */
  build(): string {
    return buildXcscheme(this.document);
  }

  /**
   * Collects elements of the given name anywhere in the document, in
   * document order. Passing no name collects every element.
   */
  elements(name?: string): XcschemeElement[] {
    return xcschemeElements(this.document.root, name);
  }

  /**
   * The views of every buildable reference in the document, in document
   * order. Build entries, testables, macro expansions, runnables, and
   * action environment buildables all point at their target through one
   * of these, so rename flows iterate this list.
   */
  buildableReferences(): BuildableReference[] {
    return this.elements("BuildableReference").map((element) => new BuildableReference(element));
  }

  /**
   * Renames every buildable reference pointing at a target. The blueprint
   * name is matched whole, and the buildable name is matched by its stem,
   * so `OldApp.app` becomes `NewApp.app` while `OldAppTests.xctest`, a
   * different target's product, stays untouched. This is the scheme-file
   * side of `XcodeProject.renameTarget`. Returns whether anything
   * changed, so callers can skip rewriting untouched files.
   */
  renameTarget(oldName: string, newName: string): boolean {
    if (oldName === newName) {
      return false;
    }
    let changed = false;
    for (const reference of this.buildableReferences()) {
      if (reference.blueprintName === oldName) {
        reference.blueprintName = newName;
        changed = true;
      }
      const buildableName = reference.buildableName;
      const renamed = buildableName == null ? undefined : renameFileNameStem(buildableName, oldName, newName);
      if (renamed != null) {
        reference.buildableName = renamed;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Rewrites every buildable reference's container after the
   * `.xcodeproj` directory itself is renamed, so `container:Old.xcodeproj`
   * becomes `container:New.xcodeproj`. The project names are matched
   * exactly. Returns whether anything changed.
   */
  renameContainer(oldProjectName: string, newProjectName: string): boolean {
    if (oldProjectName === newProjectName) {
      return false;
    }
    let changed = false;
    for (const reference of this.buildableReferences()) {
      if (reference.referencedContainer === `container:${oldProjectName}.xcodeproj`) {
        reference.referencedContainer = `container:${newProjectName}.xcodeproj`;
        changed = true;
      }
    }
    return changed;
  }
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
 * Creates the scheme Xcode writes for an application target. The
 * document carries build, launch, profile, analyze, and archive actions
 * wired to the app product, with Xcode's default configuration choices
 * of Debug for development actions and Release for profiling and
 * archiving.
 */
export function createXcscheme(options: CreateXcschemeOptions): XcschemeDocument {
  const xcodeprojName = options.xcodeprojName ?? `${options.appName}.xcodeproj`;

  /**
   * Buildable references appear once per action. Each site gets its own
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
