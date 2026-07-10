/**
 * Deterministic object identifiers for generated pbxproj objects.
 *
 * Xcode identifies every object with 24 hexadecimal characters. Generated
 * ids here are deterministic. The same seed always produces the same id, so
 * programmatic edits are reproducible and diffs stay minimal across runs.
 * The format is `XX` + the first 20 characters of `md5(seed)` + `XX`, which
 * is a valid identifier that remains recognizable as generated.
 *
 * @module
 */

import { md5Hex } from "./md5";

/**
 * Formats the deterministic id for a seed without collision handling.
 */
function idForSeed(seed: string): string {
  return `XX${md5Hex(seed).slice(0, 20)}XX`;
}

/**
 * Generates a deterministic 24-character object id from a seed string.
 *
 * When the id already exists in `existing`, the seed is retried with a
 * space appended until it is free, so ids stay deterministic (the same
 * seeds in the same order produce the same ids) while never colliding
 * within a document.
 *
 * @param seed Any text that identifies the object being created, for
 *   example `PBXNativeTarget DemoWidget`.
 * @param existing Ids already present in the document.
 * @returns An id not contained in `existing`; the caller records it.
 */
export function generateObjectId(seed: string, existing: ReadonlySet<string>): string {
  let currentSeed = seed;
  for (;;) {
    const id = idForSeed(currentSeed);
    if (!existing.has(id)) {
      return id;
    }
    currentSeed += " ";
  }
}
