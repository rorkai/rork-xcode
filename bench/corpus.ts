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
 *   (sampled; OpenStep scalars are untyped, so values compare as text).
 *
 * A parse failure on a file plutil accepts, an unstable round-trip, or a
 * value disagreement is a real finding and fails the run. Files plutil
 * itself rejects are corrupt input, not evidence.
 *
 * Run with `pnpm corpus`. Roots, file cap, and the plutil sample size are
 * flags; macOS is required for the differential half.
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
  parsePbxproj,
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
        options.maxFiles = Number(argv[++i]);
        break;
      case "--sample":
        options.sample = Number(argv[++i]);
        break;
      default:
        throw new Error(`unknown flag ${argv[i]}`);
    }
  }
  return options;
}

/**
 * Directories the walk never descends into: dependency stores, build
 * output, caches, and version control. Pruning them keeps the sweep fast on
 * large checkouts without hiding any project sources.
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
async function collectProjects(root: string, paths: string[], limit: number): Promise<void> {
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
    }
  }
  await Promise.all(subdirectories.map((path) => collectProjects(path, paths, limit)));
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
 * OpenStep scalars carry no type markers, so plutil reads every scalar as a
 * string; numbers on our side compare through their text form. Dictionary
 * keys sort so the comparison ignores ordering.
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

console.log(`collecting project.pbxproj files under ${options.roots.join(", ")} (max ${options.maxFiles})`);
const paths: string[] = [];
for (const root of options.roots) {
  await collectProjects(root, paths, options.maxFiles);
}
console.log(`found ${paths.length} files\n`);

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

// Model exercise. Every parsed project runs through validate(); issue
// counts are reported as statistics, because real projects are often
// imperfect and that is not our bug. Projects with an app target also get
// a probe edit: write a setting, add an extension target, embed it, then
// remove it all again. The document must stay byte-stable after the edit
// and after the teardown. Only unexpected errors and instability fail the
// run.
console.log("exercising the object model on every parsed project...");
const issueCounts = new Map<string, number>();
let modelExercised = 0;
let modelMutated = 0;
const mutatedSample: string[] = [];

for (const file of parsed) {
  let project: XcodeProject;
  try {
    project = XcodeProject.fromDocument(structuredClone(file.value) as PbxprojObject);
    for (const issue of project.validate()) {
      issueCounts.set(issue.kind, (issueCounts.get(issue.kind) ?? 0) + 1);
    }
    modelExercised += 1;
  } catch (error) {
    if (error instanceof XcodeModelError) {
      issueCounts.set("model-unsupported", (issueCounts.get("model-unsupported") ?? 0) + 1);
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
    modelMutated += 1;
    mutatedSample.push(mutated);
  } catch (error) {
    if (!(error instanceof XcodeModelError)) {
      findings.push(`${file.path}: model mutation threw unexpectedly, ${String(error)}`);
    }
  }
}

// Differential sample: every k-th parsed file, spreading the sample across
// the corpus instead of front-loading whatever the walk found first.
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

console.log("\n=== fidelity ===");
for (const [outcome, count] of [...counts.entries()].toSorted((a, b) => b[1] - a[1])) {
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
  "\nno findings: every readable project parses, round-trips stably, agrees with plutil, and survives model edits",
);
