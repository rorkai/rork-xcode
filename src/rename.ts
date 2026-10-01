/**
 * The stem-matching rule shared by the rename flows. Both project models
 * rename product file references and host paths with it, and the scheme
 * model renames buildable names with it, so every side agrees on what
 * counts as the renamed target's file.
 *
 * @module
 */

/**
 * Renames a file name whose stem is the target name, keeping the
 * extension. `SampleApp` and `SampleApp.app` rename, and so does a
 * multi-part extension like `SampleApp.app.dSYM`. A name whose stem
 * merely starts with the old name, like `SampleAppTests.xctest`, is a
 * different target's product and returns `undefined`.
 */
export function renameFileNameStem(fileName: string, oldName: string, newName: string): string | undefined {
  if (fileName === oldName) {
    return newName;
  }
  if (fileName.startsWith(`${oldName}.`)) {
    return newName + fileName.slice(oldName.length);
  }
  return undefined;
}

/**
 * Renames the segments of a path-valued build setting that name the
 * target or one of its products. Settings like `TEST_HOST` embed the
 * product path as
 * `$(BUILT_PRODUCTS_DIR)/SampleApp.app/.../SampleApp`, so each segment
 * is matched whole against the target name. Substring occurrences inside
 * unrelated segments stay untouched.
 */
export function renamePathSegments(value: string, oldName: string, newName: string): string {
  return value
    .split("/")
    .map((segment) => renameFileNameStem(segment, oldName, newName) ?? segment)
    .join("/");
}
