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

/** Narrow to a dictionary value (arrays and data are objects too at runtime). */
export function isDictionary(value: PbxprojValue | undefined): value is PbxprojObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function asString(value: PbxprojValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface PhaseInfo {
  isa: string;
  name: string | undefined;
}

/** `PBXSourcesBuildPhase` → `Sources`; undefined for non-phase isa names. */
function defaultBuildPhaseName(isa: string): string | undefined {
  if (isa.startsWith("PBX") && isa.endsWith("BuildPhase")) {
    return isa.slice("PBX".length, isa.length - "BuildPhase".length);
  }
  return undefined;
}

/** Repository name for Swift package reference comments. */
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
 * Builds the uuid → comment map for a parsed project document.
 *
 * Objects that should render without a comment (unnamed groups) map to the
 * empty string; uuids absent from the map are not references at all.
 */
export function createReferenceComments(root: PbxprojValue): Map<string, string> {
  const cache = new Map<string, string>();

  const objectsValue = isDictionary(root) ? root["objects"] : undefined;
  if (!isDictionary(objectsValue)) {
    return cache;
  }
  const objects = objectsValue;

  // Reverse index: build-file uuid → containing phase. Precomputing it keeps
  // PBXBuildFile comment derivation linear over projects with thousands of
  // build files.
  const fileToPhase = new Map<string, PhaseInfo>();
  for (const object of Object.values(objects)) {
    if (!isDictionary(object)) continue;
    const isa = asString(object["isa"]) ?? "";
    if (!isa.endsWith("BuildPhase")) continue;
    const files = object["files"];
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      if (typeof file === "string") {
        fileToPhase.set(file, { isa, name: asString(object["name"]) });
      }
    }
  }

  const defaultName = (object: PbxprojObject, isa: string): string =>
    asString(object["name"]) ?? asString(object["productName"]) ?? asString(object["path"]) ?? isa;

  const buildFileComment = (id: string, buildFile: PbxprojObject): string => {
    const phase = fileToPhase.get(id);
    const phaseName = phase == null ? "[missing build phase]" : (phase.name ?? defaultBuildPhaseName(phase.isa) ?? "");

    const refId = asString(buildFile["fileRef"]) ?? asString(buildFile["productRef"]);
    const referenced = refId == null ? undefined : objects[refId];
    const name = refId != null && isDictionary(referenced) ? commentFor(refId, referenced) : undefined;

    return `${name ?? "(null)"} in ${phaseName}`;
  };

  const configurationListComment = (id: string): string => {
    for (const [ownerId, owner] of Object.entries(objects)) {
      if (!isDictionary(owner) || asString(owner["buildConfigurationList"]) !== id) continue;

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

      for (const candidate of Object.values(objects)) {
        if (
          isDictionary(candidate) &&
          asString(candidate["isa"]) === "PBXContainerItemProxy" &&
          asString(candidate["containerPortal"]) === ownerId
        ) {
          const remoteInfo = asString(candidate["remoteInfo"]);
          if (remoteInfo != null) {
            return `Build configuration list for ${isa} "${remoteInfo}"`;
          }
        }
      }

      return `Build configuration list for ${isa}`;
    }
    return "Build configuration list for [unknown]";
  };

  const commentFor = (id: string, object: PbxprojObject): string | undefined => {
    const cached = cache.get(id);
    if (cached != null) {
      return cached;
    }
    const isa = asString(object["isa"]);
    if (isa == null) {
      return undefined;
    }

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
    } else if (isa.endsWith("BuildPhase")) {
      comment = asString(object["name"]) ?? defaultBuildPhaseName(isa) ?? "";
    } else if (isa === "PBXGroup" && asString(object["name"]) == null && asString(object["path"]) == null) {
      // Unnamed groups (typically the main group) render without a comment.
      comment = "";
    } else {
      comment = defaultName(object, isa);
    }

    cache.set(id, comment);
    return comment;
  };

  for (const [id, object] of Object.entries(objects)) {
    if (isDictionary(object)) {
      commentFor(id, object);
    }
  }

  return cache;
}
