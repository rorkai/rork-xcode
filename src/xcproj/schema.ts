/**
 * The layout knowledge {@link buildXcproj} needs to write a project the
 * way Xcode does.
 *
 * Xcode's encoder settles three questions for every position in a
 * project document. Records write their keys in a fixed order per kind,
 * so a target always opens with its name and id. Collections without a
 * meaningful order, like build settings and folder memberships, are
 * written sorted. And small, repetitive objects print on a single line
 * while big ones spread over many, so one edit in Xcode stays one diff
 * hunk. This module captures those decisions as a tree of shapes that
 * mirrors the project schema, and the builder walks it alongside the
 * document.
 *
 * Positions the schema does not know, such as keys a newer Xcode adds,
 * keep their document order and print over multiple lines, which is
 * Xcode's own default for any container.
 *
 * @module
 */

import type { XcprojArray, XcprojObject, XcprojValue } from "./types";

/**
 * How the builder treats the value at one position of a project document.
 *
 * Each facet applies to the JSON type it describes and is ignored for the
 * others, because many positions accept several encodings. A build file
 * is either a `"Target/phase"` string or a compact dictionary, and a group
 * tree reference is a string or an array of path components.
 */
export interface XcprojShape {
  /**
   * Picks the concrete shape of a dictionary at a position whose records
   * come in several kinds, such as the `kind` of a file tree reference.
   */
  readonly variant?: (record: XcprojObject) => XcprojShape;

  /**
   * The canonical position of each known key of a record. Known keys are
   * written in this order and unknown keys follow in document order.
   */
  readonly rank?: ReadonlyMap<string, number>;

  /**
   * The shapes of the values under the known keys of a record. A map
   * rather than an object, so document keys like `constructor` can never
   * resolve to inherited properties.
   */
  readonly fields?: ReadonlyMap<string, XcprojShape>;

  /**
   * Marks a dictionary keyed by arbitrary names (build settings, folder
   * members) and gives the shape of its values. Xcode writes the keys of
   * such dictionaries sorted.
   */
  readonly values?: XcprojShape;

  /**
   * The shape of each element of an array.
   */
  readonly items?: XcprojShape;

  /**
   * Returns the elements of an array in the order Xcode writes them, for
   * collections Xcode sorts. The input array must not be mutated.
   */
  readonly order?: (items: XcprojArray) => XcprojArray;

  /**
   * Whether the container at this position prints on a single line. A
   * single-line container prints everything inside it on that line too.
   */
  readonly compact?: boolean | ((container: XcprojObject | XcprojArray) => boolean);
}

/**
 * Whether the runtime can normalize strings. Every engine the library
 * targets ships `String.prototype.normalize`, and the check keeps an
 * engine built without it on plain code point order instead of throwing.
 */
const CAN_NORMALIZE = typeof "".normalize === "function";

/**
 * Compares two strings by Unicode code point. JavaScript's own string
 * comparison orders UTF-16 code units instead, and the two disagree only
 * when a character outside the Basic Multilingual Plane meets one in the
 * range U+E000–U+FFFF.
 */
function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      const xIsSurrogate = x >= 0xd800 && x <= 0xdfff;
      const yIsSurrogate = y >= 0xd800 && y <= 0xdfff;
      if (xIsSurrogate !== yIsSurrogate) {
        return xIsSurrogate ? 1 : -1;
      }
      return x - y;
    }
  }
  return a.length - b.length;
}

/**
 * Whether every code unit of a string is ASCII.
 */
function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * Compares two strings in the order Xcode sorts keys and set members,
 * which is Swift's string order. Swift compares the code points of the
 * NFC forms, so a decomposed `e` with a combining accent sorts where the
 * precomposed `é` does. Strings that normalize to the same text fall back
 * to their raw code points, which keeps the order total. ASCII text, which
 * is nearly every key Xcode writes, takes a direct comparison.
 */
export function compareStrings(a: string, b: string): number {
  if (isAscii(a) && isAscii(b)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (CAN_NORMALIZE) {
    const order = compareCodePoints(a.normalize("NFC"), b.normalize("NFC"));
    if (order !== 0) {
      return order;
    }
  }
  return compareCodePoints(a, b);
}

/**
 * Returns the elements of a set sorted by code point, the order Xcode
 * writes sets in. Arrays holding anything but strings are returned
 * unchanged, because sorting malformed content would only guess.
 */
function sortedStrings(items: XcprojArray): XcprojArray {
  let sorted = true;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item !== "string") {
      return items;
    }
    if (sorted && i > 0 && compareStrings(items[i - 1] as string, item) > 0) {
      sorted = false;
    }
  }
  return sorted ? items : items.toSorted((a, b) => compareStrings(a as string, b as string));
}

/**
 * Compares two tuples of strings element by element.
 */
function compareTuples(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < a.length; i++) {
    const order = compareStrings(a[i] ?? "", b[i] ?? "");
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

/**
 * Returns the value when it is a string, and the fallback otherwise.
 */
function stringOr(value: XcprojValue | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * The sort key Xcode orders a target's package product members by. That
 * key is the package name, the product name, and the product type
 * (defaulting to `other`), followed by the build phase the product links
 * into. A named phase contributes its kind and name, and an id reference
 * contributes two empty components and then the id, so for the same
 * product an id reference sorts before every named phase, as in Xcode.
 */
function packageProductMemberKey(member: XcprojObject): string[] {
  const buildFile = member["build-phase"];
  const phase =
    typeof buildFile === "object" && buildFile !== null && !Array.isArray(buildFile)
      ? buildFile["build-phase"]
      : undefined;
  let phaseKey = ["", "", ""];
  if (typeof phase === "string" && phase.startsWith("id:")) {
    phaseKey = ["", "", phase.slice(3)];
  } else if (typeof phase === "string") {
    const [kind = "", name = ""] = phase.split("/");
    phaseKey = [kind, name, ""];
  } else if (Array.isArray(phase)) {
    const names = phase.map((component) =>
      typeof component === "string"
        ? component
        : typeof component === "object" && component !== null && !Array.isArray(component)
          ? stringOr(component["name"], "")
          : "",
    );
    phaseKey = [names[0] ?? "", names[1] ?? "", ""];
  }
  return [
    stringOr(member["package"], ""),
    stringOr(member["product-name"], ""),
    stringOr(member["product-type"], "other"),
    ...phaseKey,
  ];
}

/**
 * Returns a target's package product members in Xcode's order, or the
 * array unchanged when it holds anything but dictionaries.
 */
function sortedPackageProductMembers(items: XcprojArray): XcprojArray {
  const keyed: { item: XcprojValue; key: string[] }[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return items;
    }
    keyed.push({ item, key: packageProductMemberKey(item) });
  }
  return keyed.toSorted((a, b) => compareTuples(a.key, b.key)).map((entry) => entry.item);
}

/**
 * The number of elements of an array value, counting anything else as
 * empty.
 */
function countOf(value: XcprojValue | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Builds a record shape from its keys in canonical order.
 */
function record(
  keys: readonly string[],
  fields: Readonly<Record<string, XcprojShape>> = {},
  compact?: XcprojShape["compact"],
): XcprojShape {
  const rank = new Map(keys.map((key, index) => [key, index]));
  const fieldMap = new Map(Object.entries(fields));
  return compact == null ? { rank, fields: fieldMap } : { rank, fields: fieldMap, compact };
}

/**
 * The shape of positions the schema says nothing more about.
 */
const PLAIN: XcprojShape = {};

/**
 * A set of strings, which Xcode writes sorted.
 */
const SET: XcprojShape = { order: sortedStrings };

/**
 * A set of strings that prints on a single line.
 */
const COMPACT_SET: XcprojShape = { order: sortedStrings, compact: true };

/**
 * A dictionary of strings keyed by arbitrary names, written sorted.
 */
const STRING_MAP: XcprojShape = { values: PLAIN };

/**
 * One component of a name path that cannot be written as a plain string,
 * such as a name containing `/`, which encodes as `{ "name": "a/b" }`.
 */
const NAME_PATH_COMPONENT = record(["name"]);

/**
 * A reference into the file tree, either as an `"id:…"` or `"A/B"` string
 * or as an array of path components.
 */
const GROUP_TREE_REFERENCE: XcprojShape = { items: NAME_PATH_COMPONENT };

/**
 * A configuration's xcconfig file, which may be anchored at a folder of
 * the file tree and continue as a path inside it. Xcode prints it on one
 * line in every encoding.
 */
const CONFIGURATION_FILE: XcprojShape = {
  ...record(["anchor", "relative-path"], { anchor: GROUP_TREE_REFERENCE, "relative-path": GROUP_TREE_REFERENCE }, true),
  items: NAME_PATH_COMPONENT,
};

/**
 * A build configuration, either as its bare name or as a single-line
 * record carrying an id or an xcconfig file.
 */
const CONFIGURATION = record(["id", "name", "file"], { file: CONFIGURATION_FILE }, true);

/**
 * The build-file attributes shared by build files and the per-member
 * attributes of folder exception sets, in canonical order.
 */
const BUILD_FILE_ATTRIBUTE_KEYS = [
  "header-role",
  "mach-interface-generation",
  "is-weak",
  "code-sign-on-copy",
  "code-generation",
  "header-preservation",
  "decompress",
  "code-generation-visibility",
];

/**
 * A file's membership in a build phase, either as a `"Target/phase"`
 * string or as a single-line record with attributes.
 */
const BUILD_FILE = record(
  ["id", "build-phase", "platforms", ...BUILD_FILE_ATTRIBUTE_KEYS, "arguments", "asset-tags"],
  { "build-phase": GROUP_TREE_REFERENCE, platforms: COMPACT_SET, "asset-tags": COMPACT_SET },
  true,
);

/**
 * The target membership list of a file, which keeps Xcode's order.
 */
const BUILD_FILES: XcprojShape = { items: BUILD_FILE };

/**
 * The attributes a folder exception set assigns to one folder member.
 */
const EXCEPTION_ATTRIBUTES = record(BUILD_FILE_ATTRIBUTE_KEYS, {}, true);

/**
 * A folder exception set. Target exception sets carry `target` and build
 * phase exception sets carry `build-phase`, and the merged key order
 * below agrees with both.
 */
const EXCEPTION_SET = record(
  [
    "target",
    "build-phase",
    "public-headers",
    "private-headers",
    "compiler-flags",
    "inclusions",
    "exclusions",
    "platforms",
    "attributes",
    "asset-tags",
  ],
  {
    "build-phase": GROUP_TREE_REFERENCE,
    "public-headers": SET,
    "private-headers": SET,
    "compiler-flags": STRING_MAP,
    inclusions: SET,
    exclusions: SET,
    platforms: { values: COMPACT_SET },
    attributes: { values: EXCEPTION_ATTRIBUTES },
    "asset-tags": { values: COMPACT_SET },
  },
);

/**
 * The key order of a file reference after its `kind`.
 */
const FILE_REFERENCE_KEYS = [
  "path",
  "id",
  "type",
  "signature",
  "encoding",
  "line-ending",
  "index",
  "target-membership",
];

/**
 * A file reference listed inside a variant or version group, which Xcode
 * writes without a `kind` and over multiple lines.
 */
const CHILD_FILE_REFERENCE = record(FILE_REFERENCE_KEYS, { "target-membership": BUILD_FILES });

/**
 * Variant and version groups list plain file references as children.
 */
const CHILD_FILE_REFERENCES: XcprojShape = { items: CHILD_FILE_REFERENCE };

/**
 * Children of groups are references of any kind. The shape is assigned
 * after {@link REFERENCE} exists, because the tree is recursive.
 */
const REFERENCES: { items?: XcprojShape } = {};

/**
 * A file reference in the file tree, which prints on one line unless it
 * is a member of more than one build phase.
 */
const FILE_REFERENCE = record(
  ["kind", ...FILE_REFERENCE_KEYS],
  { "target-membership": BUILD_FILES },
  (container) => countOf((container as XcprojObject)["target-membership"]) <= 1,
);

/**
 * A group, which prints on one line when it has no children.
 */
const GROUP = record(
  ["kind", "id", "path", "name", "index", "children"],
  { children: REFERENCES },
  (container) => countOf((container as XcprojObject)["children"]) === 0,
);

/**
 * A synchronized folder, which prints on one line when it carries no
 * exception sets.
 */
const FOLDER = record(
  ["kind", "id", "path", "file-types", "opaque-folders", "target-membership", "membership-exceptions", "index"],
  {
    "file-types": STRING_MAP,
    "opaque-folders": SET,
    "target-membership": SET,
    "membership-exceptions": { items: EXCEPTION_SET },
  },
  (container) => countOf((container as XcprojObject)["membership-exceptions"]) === 0,
);

/**
 * Whether a variant or version group prints on one line, which takes no
 * children and at most one build phase membership.
 */
function isCompactLocalizedGroup(container: XcprojObject | XcprojArray): boolean {
  const group = container as XcprojObject;
  return countOf(group["children"]) === 0 && countOf(group["target-membership"]) <= 1;
}

/**
 * A variant group, which collects the localizations of one resource.
 */
const VARIANT_GROUP = record(
  ["kind", "id", "path", "name", "index", "target-membership", "children"],
  { "target-membership": BUILD_FILES, children: CHILD_FILE_REFERENCES },
  isCompactLocalizedGroup,
);

/**
 * A version group, which collects the versions of a Core Data model.
 */
const VERSION_GROUP = record(
  ["kind", "id", "path", "name", "current-version", "type", "index", "target-membership", "children"],
  {
    "current-version": GROUP_TREE_REFERENCE,
    "target-membership": BUILD_FILES,
    children: CHILD_FILE_REFERENCES,
  },
  isCompactLocalizedGroup,
);

/**
 * A reference of any kind in the file tree. A missing `kind` means a
 * file reference, as in Xcode's decoder.
 */
const REFERENCE: XcprojShape = {
  variant: (reference) => {
    switch (reference["kind"] ?? "file-reference") {
      case "file-reference":
        return FILE_REFERENCE;
      case "group":
        return GROUP;
      case "folder":
        return FOLDER;
      case "variant-group":
        return VARIANT_GROUP;
      case "version-group":
        return VERSION_GROUP;
      default:
        return PLAIN;
    }
  },
};
REFERENCES.items = REFERENCE;

/**
 * The build phase kinds that carry nothing but an optional id and name,
 * and therefore print on one line.
 */
const SIMPLE_BUILD_PHASE_KINDS = new Set([
  "frameworks",
  "headers",
  "java-archive",
  "resources",
  "rez",
  "compile-sources",
]);

/**
 * The key order of build phases. Copy, script, and AppleScript phases add
 * their own keys after the shared `kind`, `id`, and `name`, and the merged
 * order below agrees with each of them.
 */
const BUILD_PHASE_KEYS = [
  "kind",
  "id",
  "name",
  "bundle-base-path",
  "relative-path",
  "log-environment-variables",
  "input-paths",
  "input-file-list-paths",
  "output-paths",
  "output-file-list-paths",
  "dependency-file",
  "run-on-every-build",
  "scope",
  "shell",
  "script",
  "is-shared-context",
  "context-name",
];

/**
 * A build phase of a target, either as its bare kind or as a record.
 */
const BUILD_PHASE = record(BUILD_PHASE_KEYS, {}, (container) => {
  const kind = (container as XcprojObject)["kind"];
  return typeof kind === "string" && SIMPLE_BUILD_PHASE_KINDS.has(kind);
});

/**
 * A custom build rule of a target.
 */
const BUILD_RULE = record([
  "name",
  "id",
  "processor",
  "file-type",
  "file-patterns",
  "input-files",
  "input-file-lists",
  "output-files",
  "output-file-lists",
  "output-files-compiler-flags",
  "dependency-file",
  "run-once-per-architecture",
  "script",
]);

/**
 * A target dependency, either as the bare name of a local target or as a
 * single-line record. Local, remote, and package dependencies share the
 * merged key order below.
 */
const DEPENDENCY = record(
  ["kind", "project", "target", "target-id", "package", "id", "product-name", "product-type", "platforms"],
  { project: GROUP_TREE_REFERENCE, platforms: COMPACT_SET },
  true,
);

/**
 * A Swift package product linked into one of the target's build phases.
 */
const PACKAGE_PRODUCT_MEMBER = record(["package", "id", "product-name", "product-type", "build-phase"], {
  "build-phase": BUILD_FILE,
});

/**
 * The build settings of a project or target, keyed by setting name with
 * any `[config=…]`, `[sdk=…]`, or `[arch=…]` conditions appended, and
 * written sorted.
 */
const BUILD_SETTINGS: XcprojShape = { values: PLAIN };

/**
 * A target of any kind. External build system targets add their tool keys
 * after the build settings.
 */
const TARGET = record(
  [
    "name",
    "id",
    "configuration-list-debug-id",
    "kind",
    "product",
    "product-type",
    "full-product-type",
    "last-swift-update",
    "last-swift-migration",
    "legacy-provisioning-style",
    "legacy-team-id",
    "test-host-target",
    "specialized-configurations",
    "dependencies",
    "build-phases",
    "build-rules",
    "package-product-members",
    "build-settings",
    "build-tool-path",
    "build-tool-arguments",
    "build-tool-working-directory",
    "pass-build-settings-in-environment",
  ],
  {
    product: GROUP_TREE_REFERENCE,
    "specialized-configurations": { items: CONFIGURATION },
    dependencies: { items: DEPENDENCY },
    "build-phases": { items: BUILD_PHASE },
    "build-rules": { items: BUILD_RULE },
    "package-product-members": { items: PACKAGE_PRODUCT_MEMBER, order: sortedPackageProductMembers },
    "build-settings": BUILD_SETTINGS,
  },
);

/**
 * A Swift package the project depends on, local or remote.
 */
const PACKAGE = record(["kind", "path", "repository", "version", "traits"], {
  version: record([
    "revision",
    "branch",
    "version",
    "up-to-next-minor-version",
    "up-to-next-major-version",
    "version-range",
    "version-range-min",
    "version-range-max",
  ]),
});

/**
 * A product of a target in a referenced project, mapped into local build
 * phases.
 */
const IMPORTED_PRODUCT = record(["name", "path", "project", "target", "product-id", "type", "target-membership"], {
  project: GROUP_TREE_REFERENCE,
  "target-membership": BUILD_FILES,
});

/**
 * The root project record.
 */
export const PROJECT_SHAPE: XcprojShape = record(
  [
    "required-capabilities",
    "id",
    "root-group-debug-id",
    "configuration-list-debug-id",
    "organization",
    "class-prefix",
    "build-independent-targets-in-parallel",
    "default-configuration",
    "configurations",
    "localizations",
    "imported-products",
    "packages",
    "files",
    "targets",
    "build-settings",
    "products-group",
    "last-upgrade",
    "last-swift-update",
    "last-swift-migration",
  ],
  {
    "required-capabilities": SET,
    configurations: { items: CONFIGURATION },
    localizations: record(["development", "supported"], { supported: SET }),
    "imported-products": { items: IMPORTED_PRODUCT },
    packages: { items: PACKAGE },
    files: REFERENCES,
    targets: { items: TARGET },
    "build-settings": BUILD_SETTINGS,
    "products-group": GROUP_TREE_REFERENCE,
  },
);

/**
 * The shape for values below a position the schema knows nothing about.
 */
export const PLAIN_SHAPE: XcprojShape = PLAIN;
