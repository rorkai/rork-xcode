/**
 * The stem-matching rule shared by the rename flows. The project model
 * renames product file references and host paths with it, and the scheme
 * model renames buildable names with it, so both sides agree on what
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
