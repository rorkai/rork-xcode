/**
 * Names and well-known values of the pbxproj object vocabulary.
 *
 * Everything here mirrors strings Xcode itself writes; nothing is invented.
 * Centralizing them keeps the object model free of string literals and
 * gives call sites one place to import from.
 *
 * @module
 */

/**
 * The `isa` names the object model works with. The parser and serializer
 * accept any isa; this list only covers the kinds the model creates or
 * gives typed access to.
 */
export const Isa = {
  aggregateTarget: "PBXAggregateTarget",
  buildFile: "PBXBuildFile",
  buildRule: "PBXBuildRule",
  containerItemProxy: "PBXContainerItemProxy",
  copyFilesBuildPhase: "PBXCopyFilesBuildPhase",
  fileReference: "PBXFileReference",
  fileSystemSynchronizedBuildFileExceptionSet: "PBXFileSystemSynchronizedBuildFileExceptionSet",
  fileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet:
    "PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet",
  fileSystemSynchronizedRootGroup: "PBXFileSystemSynchronizedRootGroup",
  frameworksBuildPhase: "PBXFrameworksBuildPhase",
  group: "PBXGroup",
  headersBuildPhase: "PBXHeadersBuildPhase",
  legacyTarget: "PBXLegacyTarget",
  nativeTarget: "PBXNativeTarget",
  project: "PBXProject",
  referenceProxy: "PBXReferenceProxy",
  resourcesBuildPhase: "PBXResourcesBuildPhase",
  shellScriptBuildPhase: "PBXShellScriptBuildPhase",
  sourcesBuildPhase: "PBXSourcesBuildPhase",
  targetDependency: "PBXTargetDependency",
  variantGroup: "PBXVariantGroup",
  buildConfiguration: "XCBuildConfiguration",
  configurationList: "XCConfigurationList",
  localSwiftPackageReference: "XCLocalSwiftPackageReference",
  remoteSwiftPackageReference: "XCRemoteSwiftPackageReference",
  swiftPackageProductDependency: "XCSwiftPackageProductDependency",
  versionGroup: "XCVersionGroup",
} as const;

/**
 * Product type identifiers of the targets the model creates or reasons
 * about. Other product types pass through untouched.
 */
export const ProductType = {
  application: "com.apple.product-type.application",
  messagesApplication: "com.apple.product-type.application.messages",
  appExtension: "com.apple.product-type.app-extension",
  messagesExtension: "com.apple.product-type.app-extension.messages",
  extensionKitExtension: "com.apple.product-type.extensionkit-extension",
  onDemandInstallCapableApplication: "com.apple.product-type.application.on-demand-install-capable",
  watchApp: "com.apple.product-type.application.watchapp2",
} as const;

/**
 * How a product type's build product appears on disk. Each entry carries
 * the wrapper file extension and the `explicitFileType` of the product
 * file reference.
 */
export const PRODUCT_FILE_INFO: Readonly<Record<string, { extension: string; fileType: string }>> = {
  [ProductType.application]: { extension: ".app", fileType: "wrapper.application" },
  [ProductType.messagesApplication]: { extension: ".app", fileType: "wrapper.application" },
  [ProductType.onDemandInstallCapableApplication]: { extension: ".app", fileType: "wrapper.application" },
  [ProductType.watchApp]: { extension: ".app", fileType: "wrapper.application" },
  [ProductType.appExtension]: { extension: ".appex", fileType: "wrapper.app-extension" },
  [ProductType.messagesExtension]: { extension: ".appex", fileType: "wrapper.app-extension" },
  [ProductType.extensionKitExtension]: { extension: ".appex", fileType: "wrapper.app-extension" },
};

/**
 * The Apple platforms the model can resolve a main application target for.
 */
export type ApplePlatform = "ios" | "macos" | "tvos" | "watchos" | "visionos";

/**
 * The build-setting key that carries each platform's deployment target.
 * A target (or its project) sets exactly one of these per platform it
 * builds for, which is what makes them usable as a platform signal.
 */
export const DEPLOYMENT_TARGET_KEY: Readonly<Record<ApplePlatform, string>> = {
  ios: "IPHONEOS_DEPLOYMENT_TARGET",
  macos: "MACOSX_DEPLOYMENT_TARGET",
  tvos: "TVOS_DEPLOYMENT_TARGET",
  watchos: "WATCHOS_DEPLOYMENT_TARGET",
  visionos: "XROS_DEPLOYMENT_TARGET",
};

/**
 * `dstSubfolderSpec` values for copy-files build phases, named after the
 * destination each selects.
 */
export const CopyFilesDestination = {
  plugins: 13,
  productsDirectory: 16,
} as const;

/**
 * Destination defaults for the copy-files phase that embeds a product of
 * the given type into a host, matching what Xcode configures for each
 * embed phase kind.
 */
export interface EmbedDestination {
  /** Display name of the embed phase. */
  phaseName: string;

  /** Destination folder selector. */
  dstSubfolderSpec: number;

  /** Destination path within the selected folder. */
  dstPath: string;
}

/**
 * Resolves the embed phase destination for an extension-like product type.
 * Watch applications are embedded by product type here; callers that only
 * know build settings should check the deployment-target key instead.
 */
export function embedDestinationFor(productType: string | undefined): EmbedDestination {
  switch (productType) {
    case ProductType.onDemandInstallCapableApplication:
      return {
        phaseName: "Embed App Clips",
        dstSubfolderSpec: CopyFilesDestination.productsDirectory,
        dstPath: "$(CONTENTS_FOLDER_PATH)/AppClips",
      };
    // Watch applications embed as full products under Watch; a plain
    // application only reaches here from watch pairings, where the same
    // destination applies.
    case ProductType.watchApp:
    case ProductType.application:
      return {
        phaseName: "Embed Watch Content",
        dstSubfolderSpec: CopyFilesDestination.productsDirectory,
        dstPath: "$(CONTENTS_FOLDER_PATH)/Watch",
      };
    case ProductType.extensionKitExtension:
      return {
        phaseName: "Embed ExtensionKit Extensions",
        dstSubfolderSpec: CopyFilesDestination.productsDirectory,
        dstPath: "$(EXTENSIONS_FOLDER_PATH)",
      };
    default:
      return {
        phaseName: "Embed Foundation Extensions",
        dstSubfolderSpec: CopyFilesDestination.plugins,
        dstPath: "",
      };
  }
}

/**
 * `lastKnownFileType` values for file references created by path, keyed by
 * file extension. Extensions outside the map create references without a
 * type, which Xcode tolerates and re-derives.
 */
export const FILE_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".swift": "sourcecode.swift",
  ".m": "sourcecode.c.objc",
  ".mm": "sourcecode.cpp.objcpp",
  ".h": "sourcecode.c.h",
  ".c": "sourcecode.c.c",
  ".cpp": "sourcecode.cpp.cpp",
  ".plist": "text.plist.xml",
  ".entitlements": "text.plist.entitlements",
  ".xcconfig": "text.xcconfig",
  ".storyboard": "file.storyboard",
  ".xib": "file.xib",
  ".xcassets": "folder.assetcatalog",
  ".framework": "wrapper.framework",
  ".xcdatamodeld": "wrapper.xcdatamodeld",
  ".metal": "sourcecode.metal",
  ".md": "net.daringfireball.markdown",
  ".json": "text.json",
};
