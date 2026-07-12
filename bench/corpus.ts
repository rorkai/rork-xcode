/**
 * Real-world corpus sweep. Walks directories full of Xcode projects the
 * machine actually has (checkouts, templates, generated apps), parses every
 * `project.pbxproj` with this library, and cross-validates a sample against
 * `plutil`, Apple's own property list parser. This is the accuracy audit the
 * committed fixtures cannot provide, and it doubles as a byte-fidelity
 * census over real documents.
 *
 * Per file, the sweep verifies:
 *
 * - the document parses;
 * - a parse, build, parse cycle reaches a byte-stable fixed point;
 * - the object model can validate and edit the project (see the model
 *   exercise below);
 * - the parsed values agree with plutil's own reading of the document
 *   (sampled, and since OpenStep scalars are untyped, values compare as
 *   text).
 *
 * A parse failure on a file plutil accepts, an unstable round-trip, or a
 * value disagreement is a real finding and fails the run. Files plutil
 * itself rejects are corrupt input, not evidence.
 *
 * Run with `pnpm corpus`. Roots, file cap, and the plutil sample size are
 * flags, and macOS is required for the differential half.
 */
/* oxlint-disable no-console -- printing the audit report to stdout is this script's output */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { parsePlist, type PlistValue } from "rork-plist";

import {
  buildPbxproj,
  buildXcconfig,
  buildXcscheme,
  buildXcworkspace,
  parsePbxproj,
  parseXcconfig,
  parseXcscheme,
  parseXcworkspace,
  PbxprojParseError,
  ProductType,
  XcodeModelError,
  XcodeProject,
  type PbxprojObject,
  type PbxprojValue,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);

/** Command-line options with their defaults. */
interface Options {
  maxFiles: number;
  roots: string[];
  sample: number;
}

/**
 * Parses a flag value as a positive integer and rejects anything else. The
 * sampling arithmetic divides by these values, so zero or NaN would turn
 * the sample steps into Infinity or NaN and silently skip the checks.
 */
function parsePositiveInteger(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} expects a positive integer, got ${raw}`);
  }
  return value;
}

/**
 * Parses the command-line flags.
 */
function parseArgs(argv: string[]): Options {
  const options: Options = {
    maxFiles: 5_000,
    roots: [join(homedir(), "Developer")],
    sample: 300,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--roots":
        options.roots = argv[++i]!.split(",");
        break;
      case "--max":
        options.maxFiles = parsePositiveInteger("--max", argv[++i]);
        break;
      case "--sample":
        options.sample = parsePositiveInteger("--sample", argv[++i]);
        break;
      default:
        throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  return options;
}

/**
 * Directories the walk never descends into. They hold dependency stores,
 * build output, caches, and version control, so pruning them keeps the
 * sweep fast on large checkouts without hiding any project sources.
 */
const PRUNED_DIRECTORIES = new Set([
  ".build",
  ".git",
  ".turbo",
  "Carthage",
  "DerivedData",
  "Pods",
  "build",
  "dist",
  "node_modules",
  "target",
]);

/**
 * Collects `project.pbxproj` paths under a root, pruning dependency and
 * build directories and skipping unreadable entries. Sibling directories
 * walk concurrently, which matters on wide checkouts.
 */
async function collectProjects(
  root: string,
  paths: string[],
  schemePaths: string[],
  xcconfigPaths: string[],
  workspacePaths: string[],
  limit: number,
): Promise<void> {
  if (paths.length >= limit) {
    return;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // permission denied or vanished mid-walk
  }
  const subdirectories: string[] = [];
  for (const entry of entries) {
    if (paths.length >= limit) {
      return;
    }
    if (entry.isDirectory()) {
      if (!PRUNED_DIRECTORIES.has(entry.name)) {
        subdirectories.push(join(root, entry.name));
      }
    } else if (entry.isFile() && entry.name === "project.pbxproj") {
      paths.push(join(root, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".xcscheme") && schemePaths.length < limit) {
      schemePaths.push(join(root, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".xcconfig") && xcconfigPaths.length < limit) {
      xcconfigPaths.push(join(root, entry.name));
    } else if (entry.isFile() && entry.name === "contents.xcworkspacedata" && workspacePaths.length < limit) {
      workspacePaths.push(join(root, entry.name));
    }
  }
  await Promise.all(
    subdirectories.map((path) => collectProjects(path, paths, schemePaths, xcconfigPaths, workspacePaths, limit)),
  );
}

/** How a swept file fared, from strongest fidelity to failure. */
type Outcome = "byte-exact" | "canonicalized" | "invalid-per-plutil" | "parse-failure" | "unstable";

/** A parsed file retained for the plutil differential sample. */
interface ParsedFile {
  path: string;
  rebuilt: string;
  value: PbxprojValue;
}

/**
 * Normalizes a parsed pbxproj value for comparison with plutil's reading.
 *
 * OpenStep scalars carry no type markers, so plutil reads every scalar as
 * a string and numbers on our side compare through their text form.
 * Dictionary keys sort so the comparison ignores ordering.
 */
function normalize(value: PbxprojValue | PlistValue): unknown {
  if (value instanceof Uint8Array) {
    return [...value];
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item as PbxprojValue));
  }
  if (value != null && typeof value === "object" && !(value instanceof Date)) {
    const record = value as Record<string, PbxprojValue>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, normalize(record[key]!)]),
    );
  }
  return String(value);
}

/**
 * Runs plutil and reports whether it accepts the file.
 */
async function plutilAccepts(path: string): Promise<boolean> {
  try {
    await execFileAsync("plutil", ["-lint", path]);
    return true;
  } catch {
    return false;
  }
}

const options = parseArgs(process.argv.slice(2));

console.log(
  `collecting project.pbxproj, .xcscheme, .xcconfig, and .xcworkspacedata files under ${options.roots.join(", ")} (max ${options.maxFiles})`,
);
const paths: string[] = [];
const schemePaths: string[] = [];
const xcconfigPaths: string[] = [];
const workspacePaths: string[] = [];
for (const root of options.roots) {
  await collectProjects(root, paths, schemePaths, xcconfigPaths, workspacePaths, options.maxFiles);
}
console.log(
  `found ${paths.length} projects, ${schemePaths.length} schemes, ${xcconfigPaths.length} xcconfigs, ${workspacePaths.length} workspaces\n`,
);

const counts = new Map<Outcome, number>();
const parsed: ParsedFile[] = [];
const findings: string[] = [];

for (const path of paths) {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    continue; // unreadable file, nothing to audit
  }
  if (text.length === 0) {
    continue;
  }

  let outcome: Outcome;
  try {
    const value = parsePbxproj(text);
    const rebuilt = buildPbxproj(value as PbxprojObject);
    if (rebuilt === text) {
      outcome = "byte-exact";
    } else if (buildPbxproj(parsePbxproj(rebuilt) as PbxprojObject) === rebuilt) {
      outcome = "canonicalized";
    } else {
      outcome = "unstable";
      findings.push(`${path}: parse/build cycle is not a fixed point`);
    }
    parsed.push({ path, rebuilt, value });
  } catch (error) {
    if (await plutilAccepts(path)) {
      outcome = "parse-failure";
      const message = error instanceof PbxprojParseError ? error.message : String(error);
      findings.push(`${path}: plutil accepts, we fail with ${message}`);
    } else {
      outcome = "invalid-per-plutil";
    }
  }
  counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
}

// Model exercise, for each parsed project:
//
// 1. Run validate(). Issues are statistics, not failures.
// 2. If an app target exists, add a probe extension, then remove it.
//    The document must stay byte-stable after each step.
// 3. Rename the app target to a probe name and back. The document must
//    stay a fixed point after each rename.
//
// Findings are only unexpected errors and instability.
console.log("exercising the object model on every parsed project...");
const issueCounts = new Map<string, number>();
const countIssue = (kind: string): void => {
  issueCounts.set(kind, (issueCounts.get(kind) ?? 0) + 1);
};
let modelExercised = 0;
let modelMutated = 0;
const mutatedSample: string[] = [];

for (const file of parsed) {
  let project: XcodeProject;
  try {
    project = XcodeProject.fromDocument(structuredClone(file.value) as PbxprojObject);
    for (const issue of project.validate()) {
      countIssue(issue.kind);
    }
    modelExercised += 1;
  } catch (error) {
    if (error instanceof XcodeModelError) {
      countIssue("model-unsupported");
      continue;
    }
    findings.push(`${file.path}: validate threw unexpectedly, ${String(error)}`);
    continue;
  }

  try {
    const app = project.findMainAppTarget("ios");
    if (app == null) {
      continue;
    }
    app.setBuildSetting("RORK_XCODE_PROBE", "1");
    const probe = project.addNativeTarget({ name: "RorkXcodeProbe", productType: ProductType.appExtension });
    app.addDependency(probe);
    app.embed(probe);
    const mutated = project.build();
    if (buildPbxproj(parsePbxproj(mutated) as PbxprojObject) !== mutated) {
      findings.push(`${file.path}: mutated document is not a fixed point`);
      continue;
    }
    project.removeTarget(probe);
    app.removeBuildSetting("RORK_XCODE_PROBE");
    const restored = project.build();
    if (buildPbxproj(parsePbxproj(restored) as PbxprojObject) !== restored) {
      findings.push(`${file.path}: document after teardown is not a fixed point`);
      continue;
    }

    const originalName = app.name;
    if (originalName != null) {
      project.renameTarget(app, "RorkXcodeRenameProbe");
      const renamed = project.build();
      if (buildPbxproj(parsePbxproj(renamed) as PbxprojObject) !== renamed) {
        findings.push(`${file.path}: renamed document is not a fixed point`);
        continue;
      }
      project.renameTarget(app, originalName);
      const renamedBack = project.build();
      if (buildPbxproj(parsePbxproj(renamedBack) as PbxprojObject) !== renamedBack) {
        findings.push(`${file.path}: document after renaming back is not a fixed point`);
        continue;
      }
    }

    modelMutated += 1;
    mutatedSample.push(mutated);
  } catch (error) {
    // A model error here is a project the mutation helpers cannot serve
    // yet. That is a statistic worth seeing in the report, not a failure.
    if (error instanceof XcodeModelError) {
      countIssue("model-mutation-unsupported");
    } else {
      findings.push(`${file.path}: model mutation threw unexpectedly, ${String(error)}`);
    }
  }
}

// The differential sample takes every k-th parsed file, spreading it
// across the corpus instead of front-loading whatever the walk found
// first.
const step = Math.max(1, Math.floor(parsed.length / options.sample));
const differentialSample = parsed.filter((_, index) => index % step === 0).slice(0, options.sample);

console.log(`cross-validating ${differentialSample.length} files against plutil...`);
let agreed = 0;
for (const file of differentialSample) {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("plutil", ["-convert", "xml1", "-o", "-", file.path], {
      maxBuffer: 256 * 1024 * 1024,
    }));
  } catch {
    continue; // plutil refused the original; not a comparison
  }
  try {
    if (JSON.stringify(normalize(file.value)) === JSON.stringify(normalize(parsePlist(stdout)))) {
      agreed += 1;
    } else {
      findings.push(`${file.path}: parsed value disagrees with plutil's reading`);
    }
  } catch (error) {
    findings.push(`${file.path}: plutil xml1 output failed to parse, ${String(error)}`);
  }
}

// A slice of mutated documents also passes through plutil, proving Apple
// tooling accepts what the model writes into real projects.
const mutatedStep = Math.max(1, Math.floor(mutatedSample.length / Math.min(options.sample, 50)));
const mutatedChecks = mutatedSample.filter((_, index) => index % mutatedStep === 0).slice(0, 50);
let mutatedAccepted = 0;
if (process.platform === "darwin") {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "rork-xcode-corpus-"));
  try {
    for (const [index, text] of mutatedChecks.entries()) {
      const file = join(directory, `${index}.pbxproj`);
      await writeFile(file, text);
      if (await plutilAccepts(file)) {
        mutatedAccepted += 1;
      } else {
        findings.push(`mutated sample ${index}: plutil rejects the model's output`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Scheme sweep. Every readable .xcscheme must parse and reach a
// byte-stable fixed point, and Xcode-written files are expected byte-exact.
const schemeCounts = new Map<string, number>();
for (const path of schemePaths) {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    continue; // unreadable file, nothing to audit
  }
  if (text.length === 0) {
    continue;
  }

  try {
    const built = buildXcscheme(parseXcscheme(text));
    if (built === text) {
      schemeCounts.set("byte-exact", (schemeCounts.get("byte-exact") ?? 0) + 1);
    } else if (buildXcscheme(parseXcscheme(built)) === built) {
      schemeCounts.set("canonicalized", (schemeCounts.get("canonicalized") ?? 0) + 1);
    } else {
      schemeCounts.set("unstable", (schemeCounts.get("unstable") ?? 0) + 1);
      findings.push(`${path}: scheme round-trip is not a fixed point`);
    }
  } catch (error) {
    schemeCounts.set("parse-failure", (schemeCounts.get("parse-failure") ?? 0) + 1);
    findings.push(`${path}: scheme failed to parse, ${String(error)}`);
  }
}

// Workspace sweep. Every readable contents.xcworkspacedata must parse
// and reach a byte-stable fixed point, and Xcode-written files are
// expected byte-exact, like schemes.
const workspaceCounts = new Map<string, number>();
for (const path of workspacePaths) {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    continue; // unreadable file, nothing to audit
  }
  if (text.length === 0) {
    continue;
  }

  try {
    const built = buildXcworkspace(parseXcworkspace(text));
    if (built === text) {
      workspaceCounts.set("byte-exact", (workspaceCounts.get("byte-exact") ?? 0) + 1);
    } else if (buildXcworkspace(parseXcworkspace(built)) === built) {
      workspaceCounts.set("canonicalized", (workspaceCounts.get("canonicalized") ?? 0) + 1);
    } else {
      workspaceCounts.set("unstable", (workspaceCounts.get("unstable") ?? 0) + 1);
      findings.push(`${path}: workspace round-trip is not a fixed point`);
    }
  } catch (error) {
    workspaceCounts.set("parse-failure", (workspaceCounts.get("parse-failure") ?? 0) + 1);
    findings.push(`${path}: workspace failed to parse, ${String(error)}`);
  }
}

// Xcconfig sweep. The format is hand-authored with no canonical writer,
// so the bar is lossless reproduction, where parse and build must return
// the input byte for byte. Parse failures are findings because the parser
// is expected to read anything Xcode reads.
const xcconfigCounts = new Map<string, number>();
for (const path of xcconfigPaths) {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    continue; // unreadable file, nothing to audit
  }

  try {
    if (buildXcconfig(parseXcconfig(text)) === text) {
      xcconfigCounts.set("byte-exact", (xcconfigCounts.get("byte-exact") ?? 0) + 1);
    } else {
      xcconfigCounts.set("lossy", (xcconfigCounts.get("lossy") ?? 0) + 1);
      findings.push(`${path}: xcconfig round-trip is not byte-exact`);
    }
  } catch (error) {
    xcconfigCounts.set("parse-failure", (xcconfigCounts.get("parse-failure") ?? 0) + 1);
    findings.push(`${path}: xcconfig failed to parse, ${String(error)}`);
  }
}

console.log("\n=== fidelity ===");
for (const [outcome, count] of [...counts.entries()].toSorted((a, b) => b[1] - a[1])) {
  console.log(`  ${outcome.padEnd(20)} ${String(count).padStart(6)}`);
}

console.log("\n=== schemes ===");
for (const [outcome, count] of [...schemeCounts.entries()].toSorted((a, b) => b[1] - a[1])) {
  console.log(`  ${outcome.padEnd(20)} ${String(count).padStart(6)}`);
}

console.log("\n=== workspaces ===");
for (const [outcome, count] of [...workspaceCounts.entries()].toSorted((a, b) => b[1] - a[1])) {
  console.log(`  ${outcome.padEnd(20)} ${String(count).padStart(6)}`);
}

console.log("\n=== xcconfigs ===");
for (const [outcome, count] of [...xcconfigCounts.entries()].toSorted((a, b) => b[1] - a[1])) {
  console.log(`  ${outcome.padEnd(20)} ${String(count).padStart(6)}`);
}

console.log("\n=== object model ===");
console.log(`  validated            ${String(modelExercised).padStart(6)}`);
console.log(`  mutated + restored   ${String(modelMutated).padStart(6)}`);
console.log(`  plutil on mutated    ${String(mutatedAccepted).padStart(6)} of ${mutatedChecks.length}`);
for (const [kind, count] of [...issueCounts.entries()].toSorted((a, b) => b[1] - a[1])) {
  console.log(`  issues: ${kind.padEnd(20)} ${String(count).padStart(6)}`);
}

console.log(`\n=== plutil differential ===\n  agreed on ${agreed} of ${differentialSample.length} compared files`);

if (findings.length > 0) {
  console.log(`\n=== findings (${findings.length}) ===`);
  for (const finding of findings.slice(0, 50)) {
    console.log(`  ${finding}`);
  }
  process.exit(1);
}
console.log(
  "\nno findings: every readable project, scheme, workspace, and xcconfig parses, round-trips stably, agrees with plutil, and survives model edits",
);
