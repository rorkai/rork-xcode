/**
 * Property shapes of the object kinds the model works with.
 *
 * These interfaces describe well-formed documents. They name the keys of
 * each kind and the values Xcode writes for them, so authoring code gets
 * autocompletion and wrong-typed writes fail. Every interface stays open
 * through the document's index signature, which keeps unlisted keys like
 * `INFOPLIST_KEY_*` settings first-class.
 *
 * Do not lean on these shapes when reading untrusted documents. A
 * malformed file can put any value under any key. The model's accessors
 * narrow at runtime and never trust the declared types.
 *
 * @module
 */

import type { PbxprojObject } from "../types";

/**
 * Build settings of one configuration. The named keys are the ones
 * programmatic edits touch most. Projects carry many more, and all of
 * them stay accessible through the index signature.
 */
export interface BuildSettings extends PbxprojObject {
  ASSETCATALOG_COMPILER_APPICON_NAME?: string;
  CODE_SIGN_ENTITLEMENTS?: string;
  CODE_SIGN_IDENTITY?: string;
  CODE_SIGN_STYLE?: string;
  CURRENT_PROJECT_VERSION?: number | string;
  DEVELOPMENT_TEAM?: string;
  GENERATE_INFOPLIST_FILE?: string;
  INFOPLIST_FILE?: string;
  IPHONEOS_DEPLOYMENT_TARGET?: string;
  LD_RUNPATH_SEARCH_PATHS?: string;
  MACOSX_DEPLOYMENT_TARGET?: string;
  MARKETING_VERSION?: number | string;
  PRODUCT_BUNDLE_IDENTIFIER?: string;
  PRODUCT_NAME?: string;
  PROVISIONING_PROFILE_SPECIFIER?: string;
  SDKROOT?: string;
  SKIP_INSTALL?: string;
  SUPPORTED_PLATFORMS?: string;
  SWIFT_VERSION?: string;
  TARGETED_DEVICE_FAMILY?: number | string;
  TEST_HOST?: string;
  TEST_TARGET_NAME?: string;
  TVOS_DEPLOYMENT_TARGET?: string;
  WATCHOS_DEPLOYMENT_TARGET?: string;
  XROS_DEPLOYMENT_TARGET?: string;
}

/**
 * Properties shared by every target kind. Native, aggregate, and legacy
 * targets all carry a name, a configuration list, build phases, and
 * dependencies.
 */
export interface TargetProperties extends PbxprojObject {
  buildConfigurationList?: string;
  buildPhases?: string[];
  dependencies?: string[];
  name?: string;
  productName?: string;
}

/**
 * Properties of a `PBXNativeTarget`.
 */
export interface NativeTargetProperties extends TargetProperties {
  buildRules?: string[];
  fileSystemSynchronizedGroups?: string[];
  packageProductDependencies?: string[];
  productReference?: string;
  productType?: string;
}

/**
 * Properties of a `PBXLegacyTarget`, a target that shells out to an
 * external build tool such as make.
 */
export interface LegacyTargetProperties extends TargetProperties {
  buildArgumentsString?: string;
  buildToolPath?: string;
  buildWorkingDirectory?: string;
  passBuildSettingsInEnvironment?: number;
}

/**
 * Properties of a `PBXBuildRule`, a per-target rule mapping a file kind to
 * the compiler or script that processes it.
 */
export interface BuildRuleProperties extends PbxprojObject {
  compilerSpec?: string;
  filePatterns?: string;
  fileType?: string;
  inputFiles?: string[];
  isEditable?: number;
  name?: string;
  outputFiles?: string[];
  runOncePerArchitecture?: number;
  script?: string;
}

/**
 * Properties of the root `PBXProject` object.
 */
export interface RootProjectProperties extends PbxprojObject {
  attributes?: PbxprojObject;
  buildConfigurationList?: string;
  developmentRegion?: string;
  knownRegions?: string[];
  mainGroup?: string;
  packageReferences?: string[];
  productRefGroup?: string;
  projectDirPath?: string;
  projectRoot?: string;
  targets?: string[];
}

/**
 * Properties of a `PBXGroup` or `PBXVariantGroup`.
 */
export interface GroupProperties extends PbxprojObject {
  children?: string[];
  name?: string;
  path?: string;
  sourceTree?: string;
}

/**
 * Properties of an `XCVersionGroup`, the container of a versioned Core
 * Data model (`.xcdatamodeld`). Its children are the model versions and
 * `currentVersion` names the active one.
 */
export interface VersionGroupProperties extends GroupProperties {
  currentVersion?: string;
  versionGroupType?: string;
}

/**
 * Properties of a `PBXReferenceProxy`, the stand-in for a product built
 * by a target of another project referenced from this one.
 */
export interface ReferenceProxyProperties extends PbxprojObject {
  fileType?: string;
  name?: string;
  path?: string;
  remoteRef?: string;
  sourceTree?: string;
}

/**
 * Properties shared by every `PBX*BuildPhase` kind.
 */
export interface BuildPhaseProperties extends PbxprojObject {
  buildActionMask?: number;
  files?: string[];
  name?: string;
  runOnlyForDeploymentPostprocessing?: number;
}

/**
 * Properties of a `PBXCopyFilesBuildPhase`, which adds the destination
 * the files are copied to.
 */
export interface CopyFilesBuildPhaseProperties extends BuildPhaseProperties {
  dstPath?: string;
  dstSubfolderSpec?: number;
}

/**
 * Properties of a `PBXShellScriptBuildPhase`, which adds the script, its
 * interpreter, and the declared inputs and outputs.
 */
export interface ShellScriptBuildPhaseProperties extends BuildPhaseProperties {
  inputFileListPaths?: string[];
  inputPaths?: string[];
  outputFileListPaths?: string[];
  outputPaths?: string[];
  shellPath?: string;
  shellScript?: string;
}

/**
 * Properties of a `PBXFileSystemSynchronizedRootGroup`.
 */
export interface SyncRootGroupProperties extends PbxprojObject {
  exceptions?: string[];
  explicitFileTypes?: PbxprojObject;
  explicitFolders?: string[];
  path?: string;
  sourceTree?: string;
}

/**
 * Properties of a `PBXFileReference`.
 */
export interface FileReferenceProperties extends PbxprojObject {
  explicitFileType?: string;
  fileEncoding?: number;
  includeInIndex?: number;
  lastKnownFileType?: string;
  name?: string;
  path?: string;
  sourceTree?: string;
}

/**
 * Properties of a `PBXBuildFile`.
 */
export interface BuildFileProperties extends PbxprojObject {
  fileRef?: string;
  productRef?: string;
  settings?: PbxprojObject;
}

/**
 * Properties of an `XCBuildConfiguration`.
 */
export interface BuildConfigurationProperties extends PbxprojObject {
  baseConfigurationReference?: string;
  buildSettings?: BuildSettings;
  name?: string;
}

/**
 * Properties of an `XCConfigurationList`.
 */
export interface ConfigurationListProperties extends PbxprojObject {
  buildConfigurations?: string[];
  defaultConfigurationIsVisible?: number;
  defaultConfigurationName?: string;
}

/**
 * Properties of a `PBXTargetDependency`.
 */
export interface TargetDependencyProperties extends PbxprojObject {
  name?: string;
  target?: string;
  targetProxy?: string;
}

/**
 * Properties of a `PBXContainerItemProxy`.
 */
export interface ContainerItemProxyProperties extends PbxprojObject {
  containerPortal?: string;
  proxyType?: number;
  remoteGlobalIDString?: string;
  remoteInfo?: string;
}

/**
 * Properties shared by the Swift package reference kinds. The remote and
 * local interfaces below add their own keys.
 */
export interface SwiftPackageReferenceProperties extends PbxprojObject {}

/**
 * Properties of an `XCRemoteSwiftPackageReference`, which names a
 * repository and a version requirement.
 */
export interface RemoteSwiftPackageReferenceProperties extends SwiftPackageReferenceProperties {
  repositoryURL?: string;
  requirement?: PbxprojObject;
}

/**
 * Properties of an `XCLocalSwiftPackageReference`, which names a package
 * directory relative to the project.
 */
export interface LocalSwiftPackageReferenceProperties extends SwiftPackageReferenceProperties {
  relativePath?: string;
}

/**
 * Properties of an `XCSwiftPackageProductDependency`.
 */
export interface SwiftPackageProductDependencyProperties extends PbxprojObject {
  package?: string;
  productName?: string;
}

/**
 * Properties shared by the synchronized-folder exception set kinds.
 */
export interface ExceptionSetProperties extends PbxprojObject {
  membershipExceptions?: string[];
  target?: string;
}

/**
 * Properties of a
 * `PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet`, which
 * adds the build phase the listed files belong to.
 */
export interface BuildPhaseMembershipExceptionSetProperties extends ExceptionSetProperties {
  buildPhase?: string;
}

/**
 * Properties of a `PBXBuildStyle`, the pre-Xcode-2 predecessor of
 * `XCBuildConfiguration` still found in old documents.
 */
export interface BuildStyleProperties extends PbxprojObject {
  buildSettings?: BuildSettings;
  name?: string;
}
