/**
 * rork-xcode: zero-dependency Xcode project (pbxproj) parser and builder.
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
export { PbxprojBuildError, PbxprojParseError, XcodeModelError, type PbxprojErrorPosition } from "./errors";
export { CopyFilesDestination, Isa, ProductType, type ApplePlatform } from "./model/isa";
export { XcodeObject } from "./model/object";
export { BuildPhase, BuildRule, Group, ReferenceProxy, SyncRootGroup, VersionGroup } from "./model/objects";
export { RootProject, XcodeProject, type AddNativeTargetOptions } from "./model/project";
export { AggregateTarget, LegacyTarget, NativeTarget, Target } from "./model/target";
export { parsePbxproj } from "./parse";
export { generateObjectId } from "./uuid";

export type { ProjectIssue, ProjectIssueKind } from "./model/doctor";
export type {
  BuildConfigurationProperties,
  BuildFileProperties,
  BuildPhaseProperties,
  BuildRuleProperties,
  BuildSettings,
  ConfigurationListProperties,
  ContainerItemProxyProperties,
  ExceptionSetProperties,
  FileReferenceProperties,
  GroupProperties,
  LegacyTargetProperties,
  NativeTargetProperties,
  ReferenceProxyProperties,
  RootProjectProperties,
  SwiftPackageProductDependencyProperties,
  SwiftPackageReferenceProperties,
  SyncRootGroupProperties,
  TargetDependencyProperties,
  TargetProperties,
  VersionGroupProperties,
} from "./model/properties";
export type { PbxprojArray, PbxprojObject, PbxprojValue } from "./types";
