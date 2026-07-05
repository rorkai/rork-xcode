/**
 * Cross-library benchmark comparing rork-xcode with the pbxproj packages on
 * npm — @bacons/xcode (its `/json` parse/build entry point) and xcode (the
 * long-standing package used by native build tooling). Run it with
 * `pnpm bench:compare`, which builds first so the measured artifact is the
 * published one.
 *
 * Fixtures are the two real Xcode-written projects from the test suite plus
 * a deterministically generated large app. The generated document is
 * serialized by this library's writer, whose byte-for-byte agreement with
 * Xcode's own layout is enforced by the golden round-trip tests — so every
 * library parses the same Xcode-canonical text.
 *
 * Each operation runs as interleaved round-robin batches (library A, B, C,
 * then A again) so JIT tiering, garbage collection, and thermal drift hit
 * every library equally. The reported figure is the median batch, in
 * nanoseconds per operation. Before timing, every library must round-trip
 * the fixture it is measured on.
 *
 * The script runs as TypeScript directly through Node's native type
 * stripping, which is on by default in Node 22.18 and later.
 */
/* oxlint-disable no-console -- printing results to stdout is this script's output */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { buildPbxproj, parsePbxproj, type PbxprojObject } from "../dist/index.js";

// Both compared packages are CommonJS; xcode ships no usable types, so they
// load through require and are typed here at the boundary.
const require = createRequire(import.meta.url);

const baconsJson = require("@bacons/xcode/json") as {
  build(root: unknown): string;
  parse(text: string): unknown;
};

const xcodePackage = require("xcode") as {
  project(path: string): { hash: unknown; writeSync(): string };
};
const xcodeParser = require("xcode/lib/parser/pbxproj") as {
  parse(text: string): unknown;
};

/** Serializes a document through the xcode package's project writer. */
function xcodeWrite(hash: unknown): string {
  const project = xcodePackage.project("project.pbxproj");
  project.hash = hash;
  return project.writeSync();
}

/** Parses a fixture and narrows the root to the dictionary every pbxproj document has. */
function parseDocument(text: string): PbxprojObject {
  const document = parsePbxproj(text);
  if (typeof document !== "object" || document === null || Array.isArray(document) || document instanceof Uint8Array) {
    throw new Error("fixture root is not a dictionary");
  }
  return document;
}

/** Deterministic 24-hex-digit ids in the style Xcode generates. */
const id = (n: number): string => `AA${n.toString(16).toUpperCase().padStart(20, "0")}BB`;

/**
 * A deterministically generated app project: five targets of 160 sources
 * each, per-file build settings on a slice of them, framework and resource
 * phases, groups, and per-target build configurations — the object mix and
 * uuid density of a mature production project.
 */
function generateLargeProject(): PbxprojObject {
  let nextId = 0;
  const objects: PbxprojObject = {};

  const rootObjectId = id(nextId++);
  const mainGroupId = id(nextId++);
  const targetIds: string[] = [];
  const mainGroupChildren: string[] = [];

  for (let targetIndex = 0; targetIndex < 5; targetIndex++) {
    const targetName = `Module${targetIndex}`;
    const groupId = id(nextId++);
    const groupChildren: string[] = [];
    const sourceBuildFileIds: string[] = [];

    for (let fileIndex = 0; fileIndex < 160; fileIndex++) {
      const fileRefId = id(nextId++);
      const buildFileId = id(nextId++);
      objects[fileRefId] = {
        isa: "PBXFileReference",
        lastKnownFileType: "sourcecode.swift",
        path: `Sources/${targetName}/Feature ${fileIndex}/View${fileIndex}.swift`,
        sourceTree: "<group>",
      };
      objects[buildFileId] = {
        isa: "PBXBuildFile",
        fileRef: fileRefId,
        ...(fileIndex % 8 === 0 ? { settings: { COMPILER_FLAGS: "-enable-upcoming-feature StrictConcurrency" } } : {}),
      };
      groupChildren.push(fileRefId);
      sourceBuildFileIds.push(buildFileId);
    }

    const sourcesPhaseId = id(nextId++);
    objects[sourcesPhaseId] = {
      isa: "PBXSourcesBuildPhase",
      buildActionMask: 2147483647,
      files: sourceBuildFileIds,
      runOnlyForDeploymentPostprocessing: 0,
    };
    const frameworksPhaseId = id(nextId++);
    objects[frameworksPhaseId] = {
      isa: "PBXFrameworksBuildPhase",
      buildActionMask: 2147483647,
      files: [],
      runOnlyForDeploymentPostprocessing: 0,
    };

    const debugConfigurationId = id(nextId++);
    const releaseConfigurationId = id(nextId++);
    const buildSettings = {
      ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: 12,
      GENERATE_INFOPLIST_FILE: "YES",
      INFOPLIST_KEY_UILaunchScreen_Generation: "YES",
      IPHONEOS_DEPLOYMENT_TARGET: "17.0",
      MARKETING_VERSION: "2.4.1",
      PRODUCT_BUNDLE_IDENTIFIER: `app.rork.bench.${targetName.toLowerCase()}`,
      PRODUCT_NAME: "$(TARGET_NAME)",
      SDKROOT: "iphoneos",
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: "1,2",
    };
    objects[debugConfigurationId] = { isa: "XCBuildConfiguration", buildSettings: { ...buildSettings }, name: "Debug" };
    objects[releaseConfigurationId] = {
      isa: "XCBuildConfiguration",
      buildSettings: { ...buildSettings, SWIFT_COMPILATION_MODE: "wholemodule" },
      name: "Release",
    };
    const configurationListId = id(nextId++);
    objects[configurationListId] = {
      isa: "XCConfigurationList",
      buildConfigurations: [debugConfigurationId, releaseConfigurationId],
      defaultConfigurationIsVisible: 0,
      defaultConfigurationName: "Release",
    };

    const productId = id(nextId++);
    objects[productId] = {
      isa: "PBXFileReference",
      explicitFileType: "wrapper.application",
      includeInIndex: 0,
      path: `${targetName}.app`,
      sourceTree: "BUILT_PRODUCTS_DIR",
    };

    const targetId = id(nextId++);
    objects[targetId] = {
      isa: "PBXNativeTarget",
      buildConfigurationList: configurationListId,
      buildPhases: [sourcesPhaseId, frameworksPhaseId],
      buildRules: [],
      dependencies: [],
      name: targetName,
      productName: targetName,
      productReference: productId,
      productType: "com.apple.product-type.application",
    };
    targetIds.push(targetId);

    objects[groupId] = { isa: "PBXGroup", children: groupChildren, path: targetName, sourceTree: "<group>" };
    mainGroupChildren.push(groupId);
  }

  objects[mainGroupId] = { isa: "PBXGroup", children: mainGroupChildren, sourceTree: "<group>" };
  const projectConfigurationListId = id(nextId++);
  objects[projectConfigurationListId] = {
    isa: "XCConfigurationList",
    buildConfigurations: [],
    defaultConfigurationIsVisible: 0,
    defaultConfigurationName: "Release",
  };
  objects[rootObjectId] = {
    isa: "PBXProject",
    attributes: { BuildIndependentTargetsInParallel: 1, LastUpgradeCheck: 1600 },
    buildConfigurationList: projectConfigurationListId,
    developmentRegion: "en",
    hasScannedForEncodings: 0,
    knownRegions: ["en", "Base"],
    mainGroup: mainGroupId,
    projectDirPath: "",
    projectRoot: "",
    targets: targetIds,
  };

  return {
    archiveVersion: 1,
    classes: {},
    objectVersion: 77,
    objects,
    rootObject: rootObjectId,
  };
}

const fixtures: Record<string, string> = {
  "legacy app": readFileSync(new URL("../tests/fixtures/legacy-groups.pbxproj", import.meta.url), "utf-8"),
  "app (Xcode 16)": readFileSync(new URL("../tests/fixtures/app-xcode16.pbxproj", import.meta.url), "utf-8"),
  "generated app": buildPbxproj(generateLargeProject()),
};

function batchNsPerOp(fn: () => unknown, iterations: number): number {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  return Number(process.hrtime.bigint() - start) / iterations;
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

const BATCHES = 15;
const TARGET_BATCH_NS = 60e6;

type Entry = [label: string, fn: () => unknown];
type Result = [label: string, nsPerOp: number];

/** Runs the entries interleaved and returns nanoseconds per operation each. */
function compare(entries: Entry[]): Result[] {
  const calibrated = entries.map(([label, fn]) => {
    fn();
    const pilot = batchNsPerOp(fn, 3);
    const iterations = Math.max(3, Math.min(30_000, Math.round(TARGET_BATCH_NS / pilot)));
    batchNsPerOp(fn, Math.max(3, iterations >> 2));
    return { fn, iterations, label, samples: [] as number[] };
  });
  for (let batch = 0; batch < BATCHES; batch++) {
    for (const entry of calibrated) {
      entry.samples.push(batchNsPerOp(entry.fn, entry.iterations));
    }
  }
  return calibrated.map(({ label, samples }) => [label, median(samples)]);
}

function formatTime(ns: number): string {
  if (ns < 1e3) {
    return `${ns.toFixed(0)} ns`;
  }
  if (ns < 1e6) {
    return `${(ns / 1e3).toFixed(1)} µs`;
  }
  return `${(ns / 1e6).toFixed(2)} ms`;
}

/** Geometric-mean multiplier vs rork-xcode per operation, printed at the end. */
const summary = new Map<string, number[]>();

for (const [name, text] of Object.entries(fixtures)) {
  // Every library must survive parse → build → parse on the fixture before
  // being timed on it.
  const ours = parseDocument(text);
  if (buildPbxproj(parseDocument(buildPbxproj(ours))) !== buildPbxproj(ours)) {
    throw new Error(`rork-xcode round-trip is unstable on ${name}`);
  }
  const bacons = baconsJson.parse(text);
  baconsJson.parse(baconsJson.build(bacons));
  const classic = xcodeParser.parse(text);
  xcodeParser.parse(xcodeWrite(classic));

  const operations: [operation: string, entries: Entry[]][] = [
    [
      "parse",
      [
        ["rork-xcode", () => parsePbxproj(text)],
        ["@bacons/xcode", () => baconsJson.parse(text)],
        ["xcode", () => xcodeParser.parse(text)],
      ],
    ],
    [
      "build",
      [
        ["rork-xcode", () => buildPbxproj(ours)],
        ["@bacons/xcode", () => baconsJson.build(bacons)],
        ["xcode", () => xcodeWrite(classic)],
      ],
    ],
  ];

  console.log(`\n=== ${name} — ${(text.length / 1024).toFixed(0)} KiB ===`);
  for (const [operation, entries] of operations) {
    const results = compare(entries);
    const best = Math.min(...results.map(([, ns]) => ns));
    const baseline = results.find(([label]) => label === "rork-xcode")![1];
    console.log(`  ${operation}`);
    for (const [label, ns] of results) {
      const marker = ns === best ? "fastest" : `${(ns / best).toFixed(2)}x slower`;
      console.log(`    ${label.padEnd(16)} ${formatTime(ns).padStart(9)}  ${marker}`);
      if (label !== "rork-xcode") {
        const key = `${operation} | ${label}`;
        const entry = summary.get(key) ?? [];
        entry.push(ns / baseline);
        summary.set(key, entry);
      }
    }
  }
}

console.log("\n=== geometric mean vs rork-xcode across the three documents ===");
for (const [key, multipliers] of summary) {
  const geometricMean = Math.exp(multipliers.reduce((total, m) => total + Math.log(m), 0) / multipliers.length);
  console.log(`  ${key.padEnd(24)} ${geometricMean.toFixed(2)}x`);
}
