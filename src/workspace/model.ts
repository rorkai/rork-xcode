/**
 * The workspace object model.
 *
 * A `.xcworkspace` directory carries a `contents.xcworkspacedata` file
 * listing the projects and folders the workspace shows, in the same XML
 * dialect scheme files use. {@link Xcworkspace} wraps the parsed
 * document with typed access to the file references, so tooling resolves
 * which projects a workspace opens instead of globbing the directory
 * tree. The node tree stays the single source of truth. Views hold only
 * a reference into it, so model calls and direct tree edits compose
 * freely.
 *
 * @module
 */

import { isXmlElement, xmlElements } from "../xml/types";
import { buildXcworkspace } from "./build";
import { parseXcworkspace } from "./parse";

import type { XmlDocument, XmlElement } from "../xml/types";

/**
 * A workspace location string split at its kind prefix, so
 * `group:Pods/Pods.xcodeproj` reads as the kind `group` and the path
 * `Pods/Pods.xcodeproj`. A location without a kind prefix reads as
 * `group`, which is how Xcode treats a bare path.
 */
export interface WorkspaceLocation {
  /** The anchor the path is relative to, for example `group`. */
  kind: string;

  /** The path after the kind prefix. */
  path: string;
}

/**
 * Splits a location attribute into its kind and path. Xcode writes the
 * kinds `group` (relative to the enclosing group), `container` (relative
 * to the directory containing the `.xcworkspace`), `absolute`, `self`
 * (the containing `.xcodeproj` itself), and `developer` (inside the
 * developer directory).
 */
export function parseWorkspaceLocation(location: string): WorkspaceLocation {
  const colon = location.indexOf(":");
  if (colon === -1) {
    return { kind: "group", path: location };
  }
  return { kind: location.slice(0, colon), path: location.slice(colon + 1) };
}

/**
 * A `FileRef` element with property-style attribute access. File
 * references are the elements workspace edits touch, since each one
 * names a project or folder the workspace shows. The view reads and
 * writes the element's attributes directly, so it never goes stale and
 * needs no separate save step.
 */
export class WorkspaceFileRef {
  /** The underlying element inside the document tree. */
  readonly element: XmlElement;

  constructor(element: XmlElement) {
    this.element = element;
  }

  /**
   * The reference's location attribute, when present, for example
   * `group:Pods/Pods.xcodeproj`.
   */
  get location(): string | undefined {
    return this.element.attributes["location"];
  }

  set location(value: string) {
    this.element.attributes["location"] = value;
  }
}

export interface CreateXcworkspaceOptions {
  /**
   * The location of each file reference the workspace lists, in order,
   * for example `group:DemoApp.xcodeproj`. An omitted list creates an
   * empty workspace to add references to.
   */
  locations?: string[];
}

/**
 * A workspace document with typed access to the elements editing flows
 * touch.
 *
 * The model is a thin layer over the node tree. All state lives in the
 * document itself, and {@link build} serializes whatever the tree
 * currently says, so typed edits and direct tree edits compose freely.
 *
 * ```ts
 * const workspace = Xcworkspace.parse(xcworkspacedataText);
 * workspace.projectFilePaths(); // ["DemoApp.xcodeproj", "Pods/Pods.xcodeproj"]
 * ```
 */
export class Xcworkspace {
  /** The underlying parsed document. */
  readonly document: XmlDocument;

  constructor(document: XmlDocument) {
    this.document = document;
  }

  /**
   * Parses the text of a `contents.xcworkspacedata` file into a
   * workspace model.
   *
   * @throws XcworkspaceParseError when the text is not a well-formed
   *   workspace document, with the line and column of the failure.
   */
  static parse(text: string): Xcworkspace {
    return new Xcworkspace(parseXcworkspace(text));
  }

  /**
   * Creates the workspace document Xcode writes, listing the given
   * locations as file references.
   */
  static create(options?: CreateXcworkspaceOptions): Xcworkspace {
    const children = (options?.locations ?? []).map(
      (location): XmlElement => ({ name: "FileRef", attributes: { location }, children: [] }),
    );
    return new Xcworkspace({
      leading: [],
      root: { name: "Workspace", attributes: { version: "1.0" }, children },
      trailing: [],
    });
  }

  /**
   * The document's `Workspace` element.
   */
  get root(): XmlElement {
    return this.document.root;
  }

  /**
   * Serializes the workspace to the text of a `contents.xcworkspacedata`
   * file in Xcode's canonical layout.
   */
  build(): string {
    return buildXcworkspace(this.document);
  }

  /**
   * Collects elements of the given name anywhere in the document, in
   * document order. Passing no name collects every element.
   */
  elements(name?: string): XmlElement[] {
    return xmlElements(this.document.root, name);
  }

  /**
   * The views of every file reference in the document, in document
   * order, references nested inside groups included.
   */
  fileRefs(): WorkspaceFileRef[] {
    return this.elements("FileRef").map((element) => new WorkspaceFileRef(element));
  }

  /**
   * Appends a file reference to the workspace's top level and returns
   * its view.
   */
  addFileRef(location: string): WorkspaceFileRef {
    const element: XmlElement = { name: "FileRef", attributes: { location }, children: [] };
    this.root.children.push(element);
    return new WorkspaceFileRef(element);
  }

  /**
   * Removes a file reference from whichever element holds it. Returns
   * whether the reference was found and removed.
   */
  removeFileRef(reference: WorkspaceFileRef): boolean {
    for (const parent of this.elements()) {
      const index = parent.children.indexOf(reference.element);
      if (index !== -1) {
        parent.children.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * The paths of every `.xcodeproj` the workspace references, in
   * document order, resolved relative to the directory containing the
   * `.xcworkspace`. Group locations compose through their enclosing
   * groups, container locations anchor at the workspace's directory, and
   * absolute locations pass through unchanged.
   *
   * The resolution is textual. The library never touches the
   * filesystem, so locations that only the running Xcode can resolve
   * (`self` and `developer`) are not listed.
   */
  projectFilePaths(): string[] {
    const paths: string[] = [];
    const visit = (element: XmlElement, base: string): void => {
      for (const child of element.children) {
        if (!isXmlElement(child)) {
          continue;
        }
        const location = parseWorkspaceLocation(child.attributes["location"] ?? "");
        const resolved = resolveLocationPath(location, base);
        if (child.name === "Group") {
          visit(child, resolved ?? base);
        } else if (child.name === "FileRef" && resolved != null && resolved.endsWith(".xcodeproj")) {
          paths.push(resolved);
        }
      }
    };
    visit(this.document.root, "");
    return paths;
  }
}

/**
 * Resolves a location against the enclosing group's base path, or
 * `undefined` for the kinds only a running Xcode can resolve. The empty
 * string names the workspace's own directory.
 */
function resolveLocationPath(location: WorkspaceLocation, base: string): string | undefined {
  switch (location.kind) {
    case "group":
      return joinPaths(base, location.path);
    case "container":
      return location.path;
    case "absolute":
      return location.path;
    default:
      return undefined;
  }
}

/**
 * Joins two textual path segments, keeping the result free of empty
 * segments when either side is empty.
 */
function joinPaths(base: string, path: string): string {
  if (base === "" || path === "") {
    return base === "" ? path : base;
  }
  return `${base}/${path}`;
}
