/**
 * rork-xcode is a zero-dependency Xcode project (pbxproj) parser and
 * builder.
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
export {
  PbxprojBuildError,
  PbxprojParseError,
  XcconfigParseError,
  XcodeModelError,
  XcschemeBuildError,
  XcschemeParseError,
  XcworkspaceBuildError,
  XcworkspaceParseError,
  type PbxprojErrorPosition,
  type TextPosition,
} from "./errors";
export {
  expandBuildSettingReferences,
  type BuildSettingLookup,
  type BuildSettingOperator,
  type ExpandBuildSettingOptions,
} from "./expansion";
export {
  CopyFilesDestination,
  Isa,
  parseApplePlatform,
  ProductType,
  type ApplePlatform,
  type BuildPhaseIsa,
  type IsaValue,
} from "./model/isa";
export { XcodeObject } from "./model/object";
export {
  AppleScriptBuildPhase,
  BuildConfiguration,
  BuildFile,
  BuildFileExceptionSet,
  BuildPhase,
  BuildPhaseMembershipExceptionSet,
  BuildRule,
  BuildStyle,
  ConfigurationList,
  ContainerItemProxy,
  CopyFilesBuildPhase,
  ExceptionSet,
  FileReference,
  FrameworksBuildPhase,
  Group,
  HeadersBuildPhase,
  LocalSwiftPackageReference,
  ReferenceProxy,
  RemoteSwiftPackageReference,
  ResourcesBuildPhase,
  RezBuildPhase,
  ShellScriptBuildPhase,
  SourcesBuildPhase,
  SwiftPackageProductDependency,
  SwiftPackageReference,
  SyncRootGroup,
  TargetDependency,
  VariantGroup,
  VersionGroup,
} from "./model/objects";
export {
  RootProject,
  XcodeProject,
  type AddNativeTargetOptions,
  type BuildPhaseOf,
  type ViewByIsa,
  type ViewOf,
} from "./model/project";
export { AggregateTarget, LegacyTarget, NativeTarget, Target, type ResolveBuildSettingOptions } from "./model/target";
export { parsePbxproj } from "./parse";
export { buildXcscheme } from "./scheme/build";
export {
  BuildableReference,
  createXcscheme,
  Xcscheme,
  xcschemeElements,
  type CreateXcschemeOptions,
} from "./scheme/model";
export { parseXcscheme } from "./scheme/parse";
export { isXcschemeElement } from "./scheme/types";
export { generateObjectId } from "./uuid";
export { buildXcworkspace } from "./workspace/build";
export {
  parseWorkspaceLocation,
  WorkspaceFileRef,
  Xcworkspace,
  type CreateXcworkspaceOptions,
  type WorkspaceLocation,
} from "./workspace/model";
export { parseXcworkspace } from "./workspace/parse";
export { buildXcconfig } from "./xcconfig/build";
export { Xcconfig, type XcconfigIncludeResolver, type XcconfigSettingsOptions } from "./xcconfig/model";
export { parseXcconfig } from "./xcconfig/parse";
export { isXmlElement, xmlElements } from "./xml/types";

export type { ProjectIssue, ProjectIssueKind } from "./model/doctor";
export type {
  BuildConfigurationProperties,
  BuildFileProperties,
  BuildPhaseMembershipExceptionSetProperties,
  BuildPhaseProperties,
  BuildRuleProperties,
  BuildSettings,
  BuildStyleProperties,
  ConfigurationListProperties,
  ContainerItemProxyProperties,
  CopyFilesBuildPhaseProperties,
  ExceptionSetProperties,
  FileReferenceProperties,
  GroupProperties,
  LegacyTargetProperties,
  LocalSwiftPackageReferenceProperties,
  NativeTargetProperties,
  ReferenceProxyProperties,
  RemoteSwiftPackageReferenceProperties,
  RootProjectProperties,
  ShellScriptBuildPhaseProperties,
  SwiftPackageProductDependencyProperties,
  SwiftPackageReferenceProperties,
  SyncRootGroupProperties,
  TargetDependencyProperties,
  TargetProperties,
  VersionGroupProperties,
} from "./model/properties";
export type { XcschemeComment, XcschemeDocument, XcschemeElement, XcschemeNode } from "./scheme/types";
export type { PbxprojArray, PbxprojObject, PbxprojValue } from "./types";
export type {
  XcconfigAssignment,
  XcconfigBlank,
  XcconfigComment,
  XcconfigCondition,
  XcconfigDocument,
  XcconfigInclude,
  XcconfigStatement,
} from "./xcconfig/types";
export type { XmlComment, XmlDocument, XmlElement, XmlNode } from "./xml/types";
