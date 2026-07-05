/**
 * Inline reference comments for `project.pbxproj` output.
 *
 * Xcode annotates every object reference with a display comment —
 * `13B07F861A680F5B00A75B9A /* AppDelegate.swift in Sources *​/` — derived
 * from the referenced object's name, its container, or its role. The
 * comments carry no semantic weight, but emitting them keeps documents
 * diffable against what Xcode writes, so this module reproduces the
 * derivation rules for each object kind.
 *
 * @module
 */

import type { PbxprojObject, PbxprojValue } from "./types";

/**
 * Narrows a value to a dictionary.
 *
 * Arrays and `Uint8Array` data are objects at runtime too, so a bare
 * `typeof` check is not enough.
 */
export function isDictionary(value: PbxprojValue | undefined): value is PbxprojObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

/**
 * Returns the value when it is a string, and `undefined` otherwise.
 *
 * Field access on parsed documents goes through this because any field of
 * an untrusted document can hold any value type.
 */
function asString(value: PbxprojValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * What a build-file comment needs to know about the phase containing it.
 */
interface PhaseInfo {
  /** The phase's isa, e.g. `PBXSourcesBuildPhase`. */
  isa: string;

  /** The phase's explicit `name` field, when present. */
  name: string | undefined;
}

/**
 * Derives the display name of a build phase from its isa:
 * `PBXSourcesBuildPhase` becomes `Sources`. Returns `undefined` for isa
 * names outside the `PBX…BuildPhase` pattern.
 */
function defaultBuildPhaseName(isa: string): string | undefined {
  if (isa.startsWith("PBX") && isa.endsWith("BuildPhase")) {
    return isa.slice("PBX".length, isa.length - "BuildPhase".length);
  }
  return undefined;
}

/**
 * Extracts the repository name for a Swift package reference comment.
 *
 * GitHub URLs reduce to their last path segment without the `.git` suffix;
 * anything else is used verbatim, which matches how Xcode renders unknown
 * hosts.
 */
function repoNameFromUrl(repoUrl: string): string {
  for (const prefix of ["https://github.com/", "http://github.com/"]) {
    if (repoUrl.startsWith(prefix)) {
      const last = repoUrl.slice(prefix.length).split("/").at(-1) ?? "";
      const name = last.endsWith(".git") ? last.slice(0, -".git".length) : last;
      if (name.length > 0) {
        return name;
      }
    }
  }
  return repoUrl;
}

/**
 * Builds the uuid-to-comment map for a parsed project document.
 *
 * Objects that should render without a comment (unnamed groups) map to the
 * empty string; uuids absent from the map are not references at all.
 * Derivation is linear over the object graph: reverse indexes are built in
 * one pass, and every object's comment is computed once and cached.
 */
export function createReferenceComments(root: PbxprojValue): Map<string, string> {
  const cache = new Map<string, string>();
  // Ids whose comment is currently being derived. A malformed project can
  // point build files at each other (fileRef cycles); re-entering an
  // in-progress id must fall back instead of recursing forever.
  const inProgress = new Set<string>();

  const objectsValue = isDictionary(root) ? root["objects"] : undefined;
  if (!isDictionary(objectsValue)) {
    return cache;
  }
  const objects = objectsValue;

  // Reverse indexes, derived in one pass over the object graph. Per-lookup
  // linear scans would make comment derivation quadratic over projects with
  // thousands of build files or many configuration lists. Where multiple
  // owners are possible, the first occurrence wins, matching document order.
  const fileToPhase = new Map<string, PhaseInfo>();
  const configurationListOwners = new Map<string, [id: string, owner: PbxprojObject]>();
  const proxyRemoteInfoByPortal = new Map<string, string>();
  const syncGroupByExceptionSet = new Map<string, PbxprojObject>();
  const targetByBuildPhase = new Map<string, PbxprojObject>();
  for (const ownerId of Object.keys(objects)) {
    const owner = objects[ownerId];
    if (!isDictionary(owner)) continue;
    const isa = asString(owner["isa"]) ?? "";

    if (isa.endsWith("BuildPhase")) {
      const files = owner["files"];
      if (Array.isArray(files)) {
        for (const file of files) {
          if (typeof file === "string" && !fileToPhase.has(file)) {
            fileToPhase.set(file, { isa, name: asString(owner["name"]) });
          }
        }
      }
    } else if (isa === "PBXContainerItemProxy") {
      const portal = asString(owner["containerPortal"]);
      const remoteInfo = asString(owner["remoteInfo"]);
      if (portal != null && remoteInfo != null && !proxyRemoteInfoByPortal.has(portal)) {
        proxyRemoteInfoByPortal.set(portal, remoteInfo);
      }
    }

    // File-system-synchronized groups list their exception sets, and targets
    // list their build phases; both indexes serve the exception-set comments.
    const exceptions = owner["exceptions"];
    if (Array.isArray(exceptions)) {
      for (const exceptionId of exceptions) {
        if (typeof exceptionId === "string" && !syncGroupByExceptionSet.has(exceptionId)) {
          syncGroupByExceptionSet.set(exceptionId, owner);
        }
      }
    }
    const buildPhases = owner["buildPhases"];
    if (Array.isArray(buildPhases)) {
      for (const phaseId of buildPhases) {
        if (typeof phaseId === "string" && !targetByBuildPhase.has(phaseId)) {
          targetByBuildPhase.set(phaseId, owner);
        }
      }
    }

    const listId = asString(owner["buildConfigurationList"]);
    if (listId != null && !configurationListOwners.has(listId)) {
      configurationListOwners.set(listId, [ownerId, owner]);
    }
  }

  /**
   * The name an object displays as when nothing more specific applies:
   * `name`, then `productName`, then `path`, then its isa.
   */
  const defaultName = (object: PbxprojObject, isa: string): string =>
    asString(object["name"]) ?? asString(object["productName"]) ?? asString(object["path"]) ?? isa;

  /**
   * The display name of the synchronized folder an exception set belongs
   * to, found through the sync group whose `exceptions` array lists it.
   */
  const exceptionSetFolderName = (id: string): string | undefined => {
    const group = syncGroupByExceptionSet.get(id);
    return group == null ? undefined : (asString(group["name"]) ?? asString(group["path"]));
  };

  /**
   * Comment for a `PBXFileSystemSynchronizedBuildFileExceptionSet`,
   * matching current Xcode: `Exceptions for "clip" folder in "clip"
   * target`. Falls back to the isa when the folder or target cannot be
   * resolved (older documents and hand-edited graphs).
   */
  const buildFileExceptionSetComment = (id: string, set: PbxprojObject): string | undefined => {
    const folder = exceptionSetFolderName(id);
    const targetId = asString(set["target"]);
    const target = targetId == null ? undefined : objects[targetId];
    if (folder == null || !isDictionary(target)) {
      return undefined;
    }
    const targetName = asString(target["name"]) ?? asString(target["productName"]) ?? asString(target["path"]);
    return targetName == null ? undefined : `Exceptions for "${folder}" folder in "${targetName}" target`;
  };

  /**
   * Comment for a `PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet`,
   * matching current Xcode: `Exceptions for "Tophat" folder in "CopyFiles"
   * phase from "Tophat" target`. Falls back to the isa when any of the
   * three names cannot be resolved.
   */
  const membershipExceptionSetComment = (id: string, set: PbxprojObject): string | undefined => {
    const folder = exceptionSetFolderName(id);
    const phaseId = asString(set["buildPhase"]);
    const phase = phaseId == null ? undefined : objects[phaseId];
    if (folder == null || phaseId == null || !isDictionary(phase)) {
      return undefined;
    }
    const phaseName = asString(phase["name"]) ?? defaultBuildPhaseName(asString(phase["isa"]) ?? "");
    const target = targetByBuildPhase.get(phaseId);
    const targetName =
      target == null
        ? undefined
        : (asString(target["name"]) ?? asString(target["productName"]) ?? asString(target["path"]));
    if (phaseName == null || targetName == null) {
      return undefined;
    }
    return `Exceptions for "${folder}" folder in "${phaseName}" phase from "${targetName}" target`;
  };

  /**
   * Comment for a `PBXBuildFile`: the referenced file's own comment plus
   * the phase it belongs to, e.g. `AppDelegate.swift in Sources`.
   */
  const buildFileComment = (id: string, buildFile: PbxprojObject): string => {
    const phase = fileToPhase.get(id);
    const phaseName = phase == null ? "[missing build phase]" : (phase.name ?? defaultBuildPhaseName(phase.isa) ?? "");

    const refId = asString(buildFile["fileRef"]) ?? asString(buildFile["productRef"]);
    const referenced = refId == null ? undefined : objects[refId];
    const name = refId != null && isDictionary(referenced) ? commentFor(refId, referenced) : undefined;

    return `${name ?? "(null)"} in ${phaseName}`;
  };

  /**
   * Comment for an `XCConfigurationList`, naming the target or project that
   * owns it, e.g. `Build configuration list for PBXNativeTarget "App"`.
   */
  const configurationListComment = (id: string): string => {
    const ownerEntry = configurationListOwners.get(id);
    if (ownerEntry == null) {
      return "Build configuration list for [unknown]";
    }
    const [ownerId, owner] = ownerEntry;

    const isa = asString(owner["isa"]) ?? "";
    const ownName = asString(owner["name"]) ?? asString(owner["path"]) ?? asString(owner["productName"]);
    if (ownName != null) {
      return `Build configuration list for ${isa} "${ownName}"`;
    }

    // A PBXProject has no name of its own; borrow the first target's.
    const targets = owner["targets"];
    if (Array.isArray(targets)) {
      const firstTargetId = targets.find((target): target is string => typeof target === "string");
      const firstTarget = firstTargetId == null ? undefined : objects[firstTargetId];
      if (isDictionary(firstTarget)) {
        const targetName = asString(firstTarget["productName"]) ?? asString(firstTarget["name"]);
        if (targetName != null) {
          return `Build configuration list for ${isa} "${targetName}"`;
        }
      }
    }

    const remoteInfo = proxyRemoteInfoByPortal.get(ownerId);
    if (remoteInfo != null) {
      return `Build configuration list for ${isa} "${remoteInfo}"`;
    }

    return `Build configuration list for ${isa}`;
  };

  /**
   * Derives (and caches) the comment for one object, dispatching on its
   * isa. Returns `undefined` for objects with no isa and for re-entrant
   * lookups on a reference cycle.
   */
  const commentFor = (id: string, object: PbxprojObject): string | undefined => {
    const cached = cache.get(id);
    if (cached != null) {
      return cached;
    }
    const isa = asString(object["isa"]);
    if (isa == null) {
      return undefined;
    }
    if (inProgress.has(id)) {
      return undefined;
    }
    inProgress.add(id);

    let comment: string;
    if (isa === "PBXBuildFile") {
      comment = buildFileComment(id, object);
    } else if (isa === "XCConfigurationList") {
      comment = configurationListComment(id);
    } else if (isa === "XCRemoteSwiftPackageReference") {
      const repoUrl = asString(object["repositoryURL"]);
      comment = repoUrl == null ? isa : `${isa} "${repoNameFromUrl(repoUrl)}"`;
    } else if (isa === "XCLocalSwiftPackageReference") {
      const relativePath = asString(object["relativePath"]);
      comment = relativePath == null ? isa : `${isa} "${relativePath}"`;
    } else if (isa === "PBXProject") {
      comment = "Project object";
    } else if (isa === "PBXFileSystemSynchronizedBuildFileExceptionSet") {
      comment = buildFileExceptionSetComment(id, object) ?? isa;
    } else if (isa === "PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet") {
      comment = membershipExceptionSetComment(id, object) ?? isa;
    } else if (isa === "PBXTargetDependency") {
      // Xcode always renders dependencies as their isa, even when they
      // carry a name field.
      comment = isa;
    } else if (isa.endsWith("BuildPhase")) {
      comment = asString(object["name"]) ?? defaultBuildPhaseName(isa) ?? "";
    } else if (isa === "PBXGroup" && asString(object["name"]) == null && asString(object["path"]) == null) {
      // Unnamed groups (typically the main group) render without a comment.
      comment = "";
    } else {
      comment = defaultName(object, isa);
    }

    inProgress.delete(id);
    cache.set(id, comment);
    return comment;
  };

  for (const id of Object.keys(objects)) {
    const object = objects[id];
    if (isDictionary(object)) {
      commentFor(id, object);
    }
  }

  return cache;
}
