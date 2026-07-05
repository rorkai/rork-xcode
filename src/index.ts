/**
 * rork-xcode — zero-dependency Xcode project (pbxproj) parser and builder.
 *
 * The library is a single ESM artifact with named exports and no
 * environment-conditional entry points, so the same code path runs in
 * browsers, Node.js, Bun, Electron, Cloudflare Workers, and React Native.
 *
 * ```ts
 * import { buildPbxproj, parsePbxproj } from "rork-xcode";
 *
 * const project = parsePbxproj(pbxprojText);
 * const text = buildPbxproj(project);
 * ```
 *
 * @module
 */

export { buildPbxproj } from "./build";
export { PbxprojBuildError, PbxprojParseError, type PbxprojErrorPosition } from "./errors";
export { parsePbxproj } from "./parse";
export type { PbxprojArray, PbxprojObject, PbxprojValue } from "./types";
