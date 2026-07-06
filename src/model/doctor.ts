/**
 * Structural validation and cleanup for project documents.
 *
 * Real projects accumulate damage: references to deleted objects, objects
 * nothing points at anymore, entries missing their kind. Xcode tolerates
 * some of it silently and breaks on the rest, so tooling benefits from an
 * explicit check. {@link validateProject} reports the problems;
 * {@link pruneOrphanObjects} removes the unreachable ones.
 *
 * @module
 */

import { asDictionary } from "./values";

import type { PbxprojObject, PbxprojValue } from "../types";
import type { XcodeProject } from "./project";

/**
 * Object properties that hold a single reference to another object of the
 * same document. `remoteGlobalIDString` and `TestTargetID` are absent by
 * design: they reference objects of another container, so they cannot be
 * resolved here.
 */
const SCALAR_REFERENCE_PROPERTIES = [
  "baseConfigurationReference",
  "buildConfigurationList",
  "buildPhase",
  "containerPortal",
  "fileRef",
  "mainGroup",
  "package",
  "productRef",
  "productRefGroup",
  "productReference",
  "target",
  "targetProxy",
] as const;

/**
 * Object properties that hold a list of references to other objects of the
 * same document.
 */
const LIST_REFERENCE_PROPERTIES = [
  "buildConfigurations",
  "buildPhases",
  "buildRules",
  "children",
  "dependencies",
  "exceptions",
  "files",
  "fileSystemSynchronizedGroups",
  "packageProductDependencies",
  "packageReferences",
  "targets",
] as const;

/**
 * The kinds of problem {@link validateProject} reports.
 *
 * - `dangling-root`: the document's `rootObject` is missing or does not
 *   resolve to a `PBXProject`.
 * - `missing-isa`: an object carries no kind, which Xcode cannot read.
 * - `dangling-reference`: a known reference property points at an id the
 *   document does not contain.
 * - `unreachable-object`: nothing on the path from the root references the
 *   object; Xcode ignores such orphans, and {@link pruneOrphanObjects}
 *   removes them.
 */
export type ProjectIssueKind = "dangling-root" | "missing-isa" | "dangling-reference" | "unreachable-object";

/**
 * One problem found by {@link validateProject}.
 */
export interface ProjectIssue {
  /** The problem's kind; see {@link ProjectIssueKind}. */
  kind: ProjectIssueKind;

  /** Human-readable description with the involved ids and properties. */
  message: string;

  /** The object the problem sits on, when it sits on one. */
  objectId?: string;
}

/**
 * Collects the ids of every object reachable from the document's root
 * object.
 *
 * Reachability follows every string that names an existing object,
 * anywhere in an object's properties (including nested dictionaries, their
 * keys, and arrays). This is deliberately broader than the known reference
 * schema: an unknown-but-real reference keeps its object alive, so pruning
 * stays conservative.
 */
export function reachableObjectIds(project: XcodeProject): Set<string> {
  const reachable = new Set<string>();
  const rootId = project.document["rootObject"];
  if (typeof rootId !== "string" || project.propertiesOfOptional(rootId) == null) {
    return reachable;
  }

  const pending: string[] = [rootId];
  const visitValue = (value: PbxprojValue | undefined): void => {
    if (typeof value === "string") {
      if (!reachable.has(value) && project.propertiesOfOptional(value) != null) {
        pending.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visitValue(item);
      }
      return;
    }
    const nested = asDictionary(value);
    if (nested != null) {
      for (const key of Object.keys(nested)) {
        visitValue(key);
        visitValue(nested[key]);
      }
    }
  };

  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reachable.has(id)) {
      continue;
    }
    reachable.add(id);
    const properties = project.propertiesOfOptional(id);
    if (properties != null) {
      for (const key of Object.keys(properties)) {
        visitValue(properties[key]);
      }
    }
  }
  return reachable;
}

/**
 * Reports one dangling reference when the id does not resolve.
 */
function checkReference(
  project: XcodeProject,
  issues: ProjectIssue[],
  objectId: string,
  property: string,
  id: string,
): void {
  if (project.propertiesOfOptional(id) == null) {
    issues.push({
      kind: "dangling-reference",
      message: `${objectId}.${property} references ${id}, which does not exist in the document`,
      objectId,
    });
  }
}

/**
 * Validates the document's object graph and returns every problem found;
 * an empty array means the graph is structurally sound. The checks cover
 * the root object, object kinds, the known reference schema, and
 * reachability. See {@link ProjectIssueKind} for the meanings.
 */
export function validateProject(project: XcodeProject): ProjectIssue[] {
  const issues: ProjectIssue[] = [];

  const rootId = project.document["rootObject"];
  const rootProperties = typeof rootId === "string" ? project.propertiesOfOptional(rootId) : undefined;
  if (rootProperties == null || rootProperties["isa"] !== "PBXProject") {
    issues.push({
      kind: "dangling-root",
      message:
        typeof rootId === "string"
          ? `rootObject references ${rootId}, which is not a PBXProject in the document`
          : "The document has no rootObject",
    });
  }

  for (const [id, view] of project.objects()) {
    const properties: PbxprojObject = view.properties;
    if (view.isa === "") {
      issues.push({
        kind: "missing-isa",
        message: `${id} has no isa, so Xcode cannot read it`,
        objectId: id,
      });
    }

    for (const property of SCALAR_REFERENCE_PROPERTIES) {
      const value = properties[property];
      if (typeof value === "string") {
        checkReference(project, issues, id, property, value);
      }
    }
    for (const property of LIST_REFERENCE_PROPERTIES) {
      const value = properties[property];
      const items = Array.isArray(value) ? value : [];
      for (const item of items) {
        if (typeof item === "string") {
          checkReference(project, issues, id, property, item);
        }
      }
    }
  }

  const reachable = reachableObjectIds(project);
  if (reachable.size > 0) {
    for (const [id] of project.objects()) {
      if (!reachable.has(id)) {
        issues.push({
          kind: "unreachable-object",
          message: `${id} is unreachable from the root object`,
          objectId: id,
        });
      }
    }
  }

  return issues;
}

/**
 * Removes every object unreachable from the document's root object and
 * returns the removed ids, in document order. A document whose root is
 * missing prunes nothing, since reachability is undefined there.
 *
 * Reachability is the conservative walk of {@link reachableObjectIds}, so
 * an object kept alive by any real reference survives even when the
 * reference property is outside the known schema.
 */
export function pruneOrphanObjects(project: XcodeProject): string[] {
  const reachable = reachableObjectIds(project);
  if (reachable.size === 0) {
    return [];
  }
  const orphanIds: string[] = [];
  for (const [id] of project.objects()) {
    if (!reachable.has(id)) {
      orphanIds.push(id);
    }
  }
  for (const id of orphanIds) {
    project.removeObject(id);
  }
  return orphanIds;
}
