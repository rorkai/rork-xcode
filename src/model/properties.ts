/**
 * Property shapes of the object kinds the model works with.
 *
 * These interfaces describe well-formed documents: they type the keys a
 * kind carries and the values Xcode writes for them, which gives authoring
 * code autocompletion and catches wrong-typed writes. Every interface
 * stays open (it extends the document's index signature), so keys outside
 * the described set, like arbitrary `INFOPLIST_KEY_*` build settings,
 * remain first-class.
 *
 * Reads from untrusted documents should not lean on these shapes: a
 * malformed document can put any value under any key. The model's
 * accessors narrow at runtime and never trust the declared types; use them
 * (or narrow manually) when the document's origin is unknown.
 *
 * @module
 */

import type { PbxprojObject } from "../types";

/**
 * Build settings of one configuration. The named keys are the ones
 * programmatic edits touch most; projects carry many more, and all of
 * them remain accessible through the index signature.
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
  TVOS_DEPLOYMENT_TARGET?: string;
  WATCHOS_DEPLOYMENT_TARGET?: string;
  XROS_DEPLOYMENT_TARGET?: string;
}

/**
 * Properties of a `PBXNativeTarget`.
 */
export interface NativeTargetProperties extends PbxprojObject {
  buildConfigurationList?: string;
  buildPhases?: string[];
  buildRules?: string[];
  dependencies?: string[];
  fileSystemSynchronizedGroups?: string[];
  name?: string;
  packageProductDependencies?: string[];
  productName?: string;
  productReference?: string;
  productType?: string;
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
 * Properties shared by the `PBX*BuildPhase` kinds. Copy-files and
 * shell-script phases carry the destination and script keys; the standard
 * phases leave them absent.
 */
export interface BuildPhaseProperties extends PbxprojObject {
  buildActionMask?: number;
  dstPath?: string;
  dstSubfolderSpec?: number;
  files?: string[];
  inputFileListPaths?: string[];
  inputPaths?: string[];
  name?: string;
  outputFileListPaths?: string[];
  outputPaths?: string[];
  runOnlyForDeploymentPostprocessing?: number;
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
 * Properties of an `XCRemoteSwiftPackageReference` or
 * `XCLocalSwiftPackageReference`; remote references carry the repository
 * and requirement, local ones the relative path.
 */
export interface SwiftPackageReferenceProperties extends PbxprojObject {
  relativePath?: string;
  repositoryURL?: string;
  requirement?: PbxprojObject;
}

/**
 * Properties of an `XCSwiftPackageProductDependency`.
 */
export interface SwiftPackageProductDependencyProperties extends PbxprojObject {
  package?: string;
  productName?: string;
}

/**
 * Properties of a `PBXFileSystemSynchronizedBuildFileExceptionSet` or its
 * build-phase-membership variant.
 */
export interface ExceptionSetProperties extends PbxprojObject {
  buildPhase?: string;
  membershipExceptions?: string[];
  target?: string;
}
