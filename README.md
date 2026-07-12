# rork-xcode

[![CI](https://github.com/rorkai/rork-xcode/actions/workflows/ci.yml/badge.svg)](https://github.com/rorkai/rork-xcode/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/rork-xcode)](https://www.npmjs.com/package/rork-xcode)

The [fastest](#performance) zero-dependency Xcode project (`project.pbxproj`) parser, builder, and object model for any JavaScript runtime: browsers, Node.js, Bun, Electron, Cloudflare Workers, and React Native. [Scheme files](#schemes) (`.xcscheme`) are covered with the same round-trip guarantees.

```ts
import { parsePbxproj, buildPbxproj } from "rork-xcode";

const project = parsePbxproj(pbxprojText);

for (const [uuid, object] of Object.entries(project.objects)) {
  if (object.isa === "PBXNativeTarget") {
    console.log(uuid, object.name, object.productType);
  }
}

const text = buildPbxproj(project); // byte-stable, Xcode-canonical layout
```

## Why

`project.pbxproj` is the heart of every Xcode project: targets, build phases, build settings, file references. Programs that create or repair Xcode projects increasingly run everywhere at once: an API on an edge runtime, a desktop app's Node process, a CLI inside a build sandbox.

`rork-xcode` is designed for exactly that situation:

- **Zero dependencies.** The pbxproj grammar is a small OpenStep-style property list dialect of dictionaries, arrays, strings, and hex data runs. A dedicated scanner covers it completely, with no general-purpose parser stack, no native addon, and no WASM blob.
- **One artifact, one code path.** A single ESM file with named exports. No environment-conditional entry points, no reliance on ambient globals like `Buffer`. What you test locally is what runs in production, whatever the bundler.
- **Xcode-canonical output.** The serializer reproduces the layout Xcode itself writes (tab indentation, per-isa object sections in sorted order, single-line build-file entries, and derived reference comments like `13B07F86… /* AppDelegate.swift in Sources */`), so diffs against Xcode-saved projects stay minimal and Xcode does not rewrite the file on next save.
- **Round-trip faithful.** Parse → build is byte-identical for Xcode-canonical documents and a fixed point for everything else. Lexical subtleties that plain number conversion would destroy (leading-zero values like `0755`, trailing-zero versions like `5.0`, digit runs longer than the double-precision safe range) are preserved as strings by design.
- **Loud failure modes.** Malformed documents fail with a typed error carrying line and column, and unrepresentable values (`null`, booleans, non-finite numbers) fail with the exact path of the offending value. Nothing is silently dropped.

## Install

```sh
pnpm add rork-xcode
```

## API

### `parsePbxproj(text)`

Parses a `project.pbxproj` document into plain JavaScript values. The leading `// !$*UTF8*$!` marker and all comments are treated as trivia.

| Source shape                                           | JavaScript value |
| ------------------------------------------------------ | ---------------- |
| `{ key = value; ... }`                                 | plain object     |
| `( item, item, ... )`                                  | array            |
| unquoted number that prints back (`46`, `3.14`, `-12`) | `number`         |
| `<48656c6c6f>`                                         | `Uint8Array`     |
| everything else                                        | `string`         |

An unquoted literal becomes a number exactly when the number formats back to the identical text, so serializing can never change a scalar's bytes: leading-zero values (`0755`), trailing-zero versions (`5.0`), bare-dot decimals (`.5`), and digit runs beyond double precision all stay strings. Dictionary keys keep document order. Quoted values are always strings, so `"46"` and `46` remain distinguishable.

```ts
import { parsePbxproj, PbxprojParseError } from "rork-xcode";

try {
  const project = parsePbxproj(text);
} catch (error) {
  if (error instanceof PbxprojParseError) {
    console.error(error.message); // "Expected ';' but found '}' (line 41, column 3)"
    console.error(error.position); // { offset, line, column }
  }
}
```

### `buildPbxproj(root)`

Serializes a document back to pbxproj text. The input is the same shape `parsePbxproj` produces; any dictionary works, and documents carrying a root-level `objects` dictionary get the full Xcode layout treatment: sections grouped by `isa` and sorted, entries sorted by identifier, and reference comments derived from the object graph. Version-like build settings (`SWIFT_VERSION = 5.0`) arrive from the parser as strings and round-trip verbatim.

```ts
import { buildPbxproj, PbxprojBuildError } from "rork-xcode";

try {
  const text = buildPbxproj(project);
} catch (error) {
  if (error instanceof PbxprojBuildError) {
    console.error(error.message); // "Cannot serialize a null value… (at $.objects.AA10….name)"
    console.error(error.path); // "$.objects.AA10….name"
  }
}
```

Booleans are rejected on purpose. The format has no boolean notation (Xcode models flags as the strings `"YES"` and `"NO"`), so writing one would produce a value Xcode misreads.

## Object model

`XcodeProject` gives typed, mutable access to a parsed project. It is a set of lightweight views over the plain parsed document: all state lives in the document itself, a view holds only an object id, and `build()` serializes whatever the document currently says in Xcode's canonical layout. Model calls and direct dictionary access compose freely, and the model adds no measurable overhead over the raw functions (`XcodeProject.parse` and `project.build()` benchmark identically to `parsePbxproj` and `buildPbxproj`).

This document-first design is deliberate, and the library's guarantees fall out of it. There is no inflate step on parse and no deflate step on build, so an untouched project rebuilds byte-identically and an edit changes only the entries it touches. Combined with deterministic identifiers, the same edit sequence produces the same bytes on every run, on every runtime.

```ts
import { XcodeProject } from "rork-xcode";

const project = XcodeProject.parse(pbxprojText);
const text = project.build();
```

### Targets and build settings

`getBuildSetting` resolves hierarchically the way Xcode does, reading the target's default configuration first and the project-level configuration below it. Writes go to every configuration of the target, so Debug and Release stay consistent.

```ts
const app = project.findMainAppTarget("ios"); // "macos" | "tvos" | "watchos" | "visionos"
app?.getBuildSetting("PRODUCT_BUNDLE_IDENTIFIER"); // "com.example.app"
app?.getBuildSetting("SDKROOT"); // inherited from the project configuration
app?.setBuildSetting("MARKETING_VERSION", "1.2.0");
app?.removeBuildSetting("CODE_SIGN_IDENTITY");

for (const target of project.nativeTargets()) {
  console.log(target.name, target.productType);
}
```

`resolveBuildSetting` reads the same layers and expands the `$(NAME)` and `${NAME}` references in the value. Referenced settings resolve through the chain, `$(inherited)` continues from the next layer down, and `$(TARGET_NAME)` falls back to the target's name, so the template's `PRODUCT_NAME = "$(TARGET_NAME)"` resolves without any setup. References the document cannot answer (build-system paths like `$(BUILT_PRODUCTS_DIR)`) stay verbatim unless a caller-supplied lookup answers them, so nothing is invented.

```ts
app?.resolveBuildSetting("PRODUCT_NAME"); // "DemoApp", from PRODUCT_NAME = "$(TARGET_NAME)"
app?.resolveBuildSetting("WIDGET_ID"); // "com.example.demo.widget", through PRODUCT_BUNDLE_IDENTIFIER
```

`project.targets()` returns every target kind. Aggregate targets (`PBXAggregateTarget`) and legacy external-build-tool targets (`PBXLegacyTarget`) share the full target surface, from configurations and build settings to phases and dependency wiring.

```ts
for (const target of project.targets()) {
  if (target instanceof LegacyTarget) {
    console.log(target.name, target.buildToolPath);
  }
}
```

### Scaffolding a target

`addNativeTarget` creates the configurations, the product reference in the Products group, and the standard Sources, Frameworks, and Resources phases. Dependencies wire the container proxy pair Xcode uses; `embed` picks the right copy-files phase and destination for the product type (foundation extensions, ExtensionKit extensions, App Clips, watch content).

```ts
import { ProductType } from "rork-xcode";

const widget = project.addNativeTarget({
  name: "DemoWidget",
  productType: ProductType.appExtension,
  buildSettings: { PRODUCT_BUNDLE_IDENTIFIER: "com.example.app.widget" },
});
widget.setBuildSetting("IPHONEOS_DEPLOYMENT_TARGET", "18.0");

app.addDependency(widget);
app.embed(widget); // "Embed Foundation Extensions", dstSubfolderSpec 13

// Xcode 16 synchronized folder, with the scaffolded Info.plist excluded
// so the build does not copy it twice.
const folder = widget.addSyncGroup("DemoWidget");
folder.addMembershipExceptions(widget, ["Info.plist"]);
```

### Swift packages

```ts
const pkg = project.addSwiftPackage({
  repositoryURL: "https://github.com/example/example-kit",
  requirement: { kind: "upToNextMajorVersion", minimumVersion: "2.0.0" },
});

// Wires the product dependency and its Frameworks-phase build file.
app.addSwiftPackageProduct({ productName: "ExampleKit", packageReference: pkg });

// Local (path-based) packages and system frameworks work the same way.
const local = project.addLocalSwiftPackage("Packages/DesignSystem");
app.addSwiftPackageProduct({ productName: "DesignSystem", packageReference: local });
app.addSystemFramework("Messages");
```

### Files, groups, and phases

```ts
import { Isa } from "rork-xcode";

// Classic (non-synchronized) file management, with nested group creation.
const mainGroup = project.rootProject.mainGroup();
const generated = mainGroup?.ensureGroup("Sources/Generated");
const file = generated?.createFile("Config.swift");
if (file) app.ensureSourcesPhase().ensureBuildFile(file);

project.findFileReference("Sources/Generated/Config.swift"); // resolves through the group tree

// Phases expose their build files for reorganization, and script phases
// create with the usual defaults.
const embedPhase = app.findBuildPhase(Isa.copyFilesBuildPhase, "Embed Foundation Extensions");
embedPhase?.buildFileIds;
app.ensureShellScriptPhase("Lint", { shellScript: "lint\n" });
```

### Validation

Projects rot over time. References outlive the objects they pointed at, orphans pile up, an entry loses its `isa`. `validate()` finds these problems and returns them as data. `pruneOrphans()` deletes everything the root object cannot reach, and it errs on the safe side. If anything still references an object, it stays.

```ts
for (const issue of project.validate()) {
  console.warn(issue.kind, issue.message);
}
project.pruneOrphans(); // returns the removed ids
```

### Removal

`removeObject` deletes one object and strips every reference to it from the rest of the document. `removeTarget` composes it into a full teardown: the target's phases and build files, configurations, product reference and its embeddings, dependency objects other targets hold on it, membership exceptions, and synchronized folders no remaining target links. On-disk sources are untouched.

```ts
const widget = project.findTarget("DemoWidget");
if (widget) project.removeTarget(widget);

project.referrersOf(app.id); // every object referencing an id, for custom teardowns
```

### Renaming

`renameTarget` renames a target and every place the document knows it by name. That covers the target's `name` and `productName`, its product file reference, the `remoteInfo` of container proxies pointing at it, `TEST_TARGET_NAME` values naming it, and the path segments of `TEST_HOST` and `BUNDLE_LOADER` that name the target or its product. Names match whole, so renaming `DemoApp` leaves `DemoAppTests` alone, and a `PRODUCT_NAME` of `$(TARGET_NAME)` follows by itself. On-disk renames (source folders, entitlements files) and the group paths pointing at those folders stay with the caller.

```ts
const app = project.findMainAppTarget("ios");
if (app) project.renameTarget(app, "RenamedApp");
```

Scheme files live next to the project rather than inside it, so the scheme model carries the counterpart (see [Schemes](#schemes)).

### Escape hatch

Every view exposes its raw dictionary, so anything the typed surface does not cover stays one property away, and `project.objects()` iterates every object with its typed view:

```ts
app.properties["productName"] = "RenamedApp";

for (const [id, object] of project.objects()) {
  if (object.isa === "PBXShellScriptBuildPhase") {
    console.log(id, object.getString("name"));
  }
}
```

### Semantics

- **A view class for every kind.** Every `isa` Xcode writes has its own class, and each class declares its `isa` through a static field the view factory dispatches on. Targets of every kind, groups, variant and version groups, synchronized folders and their exception sets, every build phase kind, build rules, build files, build styles, configurations and configuration lists, file references, target dependencies, container item proxies, reference proxies, and Swift package references and products all come back typed. Kinds outside the vocabulary fall back to a generic `XcodeObject` with the same read and write access, so nothing in a document is out of reach.
- **Isa literals type the returns.** Creation and lookup take the isa and give back the exact class for it, with no cast at the call site. `project.add(Isa.fileReference, ...)` is a `FileReference`, `target.ensureBuildPhase(Isa.copyFilesBuildPhase, ...)` is a `CopyFilesBuildPhase`, and `target.findBuildPhase(Isa.shellScriptBuildPhase)` is a `ShellScriptBuildPhase | undefined`. A dynamic string falls back to the generic view type.
- **`is()` narrowing.** Every view class carries a static type guard for discriminating mixed objects: `if (NativeTarget.is(object))` narrows the way `instanceof` does, subclasses included. Relationships resolve typed too, from `dependency.target()` and `buildFile.productDependency()` to `configuration.buildSettings` as a live typed dictionary.
- **Typed, open property shapes.** Known keys autocomplete (`target.properties.productType`) and the shape stays open, so keys like `INFOPLIST_KEY_*` settings remain first-class. The shapes describe well-formed documents. When reading untrusted input, use the narrowing accessors, which never trust them.
- **Two verb families.** `add*` wires something to its owner (a dependency, a package, a framework, a synchronized folder) and is idempotent, so re-adding returns the existing wiring. `ensure*` returns a structural container, creating it when missing (a build phase, a group chain, the Products group). Both families can therefore run unconditionally in scaffold and repair flows.
- **Deterministic identifiers.** New objects get ids derived from what they are (`XX` + 20 digest characters + `XX`, from an embedded hash), so programmatic edits are reproducible run to run and diffs stay minimal. Collisions within a document resolve deterministically, and identical edit sequences produce byte-identical documents.
- **Soft reads, loud writes.** Real-world projects can be malformed, so lookups return `undefined` where a document could omit something. Operations that cannot proceed without structure (no root project object, an unknown product type, a view whose object was deleted) throw `XcodeModelError`.
- **Identity-mapped views.** Two lookups of the same id return the same instance, so views compare with `===`.

## Schemes

`.xcscheme` files describe how Xcode builds, runs, tests, and archives a target. They are not property lists but a small XML dialect of their own, and the scheme module covers it with the same contract as the pbxproj functions. An Xcode-written scheme rebuilds byte for byte, any other input reaches Xcode's canonical layout in one build, and malformed input fails with a typed error carrying line and column.

`Xcscheme` is the model. Renames are one call per move. `renameTarget` is the scheme-file side of the project model's `renameTarget` and touches only the named target's references, and `renameContainer` follows a rename of the `.xcodeproj` directory itself. Both return whether anything changed, so callers can skip rewriting untouched files:

```ts
import { Xcscheme } from "rork-xcode";

const scheme = Xcscheme.parse(xcschemeText);

scheme.renameTarget("DemoApp", "RenamedApp"); // DemoAppTests stays untouched
scheme.renameContainer("DemoApp", "RenamedApp"); // container:RenamedApp.xcodeproj

const text = scheme.build();
```

For anything else, buildable references come back as typed views through `scheme.buildableReferences()`, with property access to the blueprint name, buildable name, container, and identifier.

`Xcscheme.create` produces the scheme Xcode's own "New Scheme" action writes for an application target, wired to the target's object id from the project document:

```ts
const scheme = Xcscheme.create({
  appName: "DemoApp",
  blueprintIdentifier: app.id,
});
const text = scheme.build();
```

Underneath, the document is a plain tree of elements with ordered attributes and children, reachable through `scheme.root` and `scheme.elements(name)`, so anything the typed surface does not cover stays one property away. `parseXcscheme` and `buildXcscheme` remain available for working with the tree directly. Attribute order is preserved and meaningful, which is how byte-identical round-trips fall out. Comments are kept, attribute values resolve the character references Xcode writes (`&quot;`, `&amp;`, `&#10;` and friends), and the writer re-escapes them identically.

## Workspaces

A `.xcworkspace` directory carries a `contents.xcworkspacedata` file listing the projects and folders the workspace shows, in the same XML dialect scheme files use, with the same round-trip contract. An Xcode-written file rebuilds byte for byte, any other input reaches the canonical layout in one build, and malformed input fails with a typed error carrying line and column.

`Xcworkspace` is the model. Its flagship read resolves which projects the workspace references, so tooling stops globbing directory trees and asks the file that already knows:

```ts
import { Xcworkspace } from "rork-xcode";

const workspace = Xcworkspace.parse(xcworkspacedataText);

workspace.projectFilePaths(); // ["DemoApp.xcodeproj", "Pods/Pods.xcodeproj"]

workspace.addFileRef("group:Vendor/Vendor.xcodeproj");
const text = workspace.build();
```

Group locations compose through their enclosing groups, container locations anchor at the workspace's directory, and absolute locations pass through. The resolution is textual, because the library never touches the filesystem, so locations only a running Xcode can resolve (`self` and `developer`) stay out of the list. `Xcworkspace.create` produces the document Xcode writes for a new workspace, file references come back as typed views through `fileRefs()`, and `parseXcworkspace` and `buildXcworkspace` remain available for working with the tree directly.

## Xcconfig files

Build settings do not only live in the pbxproj. Projects push them into `.xcconfig` files referenced through `baseConfigurationReference`, and the xcconfig module reads and writes that format with the fidelity the rest of the library promises. The format is hand-authored with no canonical layout, so the contract here is losslessness. Parsing and building an untouched file reproduces it byte for byte, including comments, blank lines, column alignment, and line endings. Malformed lines fail loudly with a typed error carrying line and column rather than being dropped, so a file the parser accepts is a file it fully understood.

`Xcconfig` is the model. Reads follow the file top to bottom the way Xcode does, and writes edit single lines while leaving every other byte alone:

```ts
import { Xcconfig } from "rork-xcode";

const config = Xcconfig.parse(xcconfigText);

config.get("PRODUCT_BUNDLE_IDENTIFIER"); // last unconditional assignment wins
config.set("MARKETING_VERSION", "1.2.0"); // rewrites in place, appends when new
const settings = config.settings(); // flattened, the way Xcode reads the file

const text = config.build();
```

`#include` directives are exposed as data because the library never touches the filesystem. Flattening resolves them through a caller-supplied lookup and applies each file at its directive's position, cycle-safe, so lines after an include override it exactly like textual inclusion. Position matters: an include hoisted or reordered changes what the file means, so the model never moves one.

```ts
const settings = config.settings({
  resolveInclude: (path, optional) => loadedConfigs.get(path),
});
```

Conditional assignments like `OTHER_LDFLAGS[sdk=iphoneos*][arch=arm64]` are parsed structurally with their conditions preserved verbatim on round-trip, unknown condition names included. Passing a build context applies them during flattening, with every condition required to match and trailing `*` wildcards honored; without a context they stay out, which mirrors reading the file with no build in mind. `$(inherited)` references splice in the value accumulated earlier in the chain and stay literal when there is none, so lower layers can still resolve them:

```ts
const settings = config.settings({
  context: { sdk: "iphoneos", arch: "arm64", config: "Release" },
});
```

Registering a file on the project makes `getBuildSetting` resolve through it in Xcode's order of target settings, then the target's xcconfig, then project settings, then the project's xcconfig:

```ts
project.registerXcconfig(reference, Xcconfig.parse(text));
app.getBuildSetting("SDKROOT"); // now sees values the xcconfig defines
```

## Build-setting references

Values reference other build settings as `$(NAME)` and `${NAME}`, in the pbxproj, in xcconfig files, and in Info.plist templates. The syntax is Xcode's own, down to the `:` operators, and Xcode's app templates write values in exactly this shape, for example `PRODUCT_BUNDLE_IDENTIFIER = com.yourcompany.$(PRODUCT_NAME:rfc1034identifier)`. `expandBuildSettingReferences` evaluates the syntax through a caller-supplied lookup, so the same code serves all three formats. Substituted text expands recursively, names may themselves contain references (`$(SETTING_$(VARIANT))`), cycles stay finite, and a reference the lookup cannot answer stays verbatim, so partial resolution loses no information.

```ts
import { expandBuildSettingReferences } from "rork-xcode";

// A value as found in a project file. The references and their operators
// are part of the document, so the expander takes them from the text
// rather than from options.
const found = "com.example.$(PRODUCT_NAME:rfc1034identifier)";

expandBuildSettingReferences(found, (name) => (name === "PRODUCT_NAME" ? "My App" : undefined));
// "com.example.My-App"
```

The `:` operators are honored for `lower`, `upper`, `rfc1034identifier` (the mapping into RFC 1034 host-name characters that bundle identifiers need), `c99extidentifier`, and `default=`. A reference carrying any other operator stays verbatim rather than expanding to a wrongly transformed value. The model composes the expander with settings resolution as `target.resolveBuildSetting(key)`, described under [Targets and build settings](#targets-and-build-settings).

## Performance

`rork-xcode` is measured against the pbxproj parsers on npm, [`@bacons/xcode`](https://www.npmjs.com/package/@bacons/xcode) (its `/json` parse/build entry point) and [`xcode`](https://www.npmjs.com/package/xcode) (the long-standing package used by native build tooling), on three documents: two real Xcode-written projects from the test suite and a deterministically generated five-target app with 800 source files. It is the fastest at both operations on every document, with zero dependencies.

<p align="center">
  <img src="assets/performance.svg" alt="Benchmark chart comparing rork-xcode with the @bacons/xcode and xcode packages. Bars show time relative to rork-xcode as the geometric mean over three project documents. Parsing, @bacons/xcode takes 1.3 times as long and xcode 21 times. Building, xcode takes 1.6 times as long and @bacons/xcode 9 times." width="880" />
</p>

| Operation | Document                | `rork-xcode` | `@bacons/xcode`  | `xcode`          |
| --------- | ----------------------- | ------------ | ---------------- | ---------------- |
| parse     | legacy app (7 KiB)      | **13.9 µs**  | 17.8 µs (1.3×)   | 297.7 µs (21.4×) |
| parse     | app, Xcode 16 (20 KiB)  | **43.7 µs**  | 54.4 µs (1.2×)   | 795.0 µs (18.2×) |
| parse     | generated app (471 KiB) | **0.84 ms**  | 1.20 ms (1.4×)   | 19.74 ms (23.6×) |
| build     | legacy app              | **15.9 µs**  | 43.1 µs (2.7×)   | 29.6 µs (1.9×)   |
| build     | app, Xcode 16           | **37.5 µs**  | 113.6 µs (3.0×)  | 71.3 µs (1.9×)   |
| build     | generated app           | **0.98 ms**  | 85.98 ms (87.7×) | 1.20 ms (1.2×)   |

Measured on an Apple M5 Max, Node.js 24, single thread, with `@bacons/xcode` 1.0.0-alpha.33 and `xcode` 3.0.1. Multipliers are relative to `rork-xcode` on the same row; the ordering also holds on Bun. Reproduce with `pnpm bench:compare`, which interleaves the libraries in round-robin batches and reports the median, after verifying that every library round-trips every fixture.

### Key performance features

- **Single-pass scanner.** One cursor over the input string with table-driven character classification. There is no tokenizer stage and no intermediate token objects.
- **Comments skip in bulk.** Reference comments are a sizable share of a canonical document's bytes, so comment bodies are jumped with `indexOf` instead of being scanned per character.
- **Linear comment derivation.** Building the `/* … */` annotations uses reverse indexes over the object graph (build file → phase, configuration list → owner), so serialization stays linear on projects with thousands of objects.
- **Memoized rendering.** Quoting decisions for the repeated key vocabulary and rendered uuid references are cached per document, halving the quote scans on reference-heavy sections.

## Verification

- The committed fixture corpus spans project generations from Xcode 3 to Xcode 16, captured from real projects with identifiers neutralized: synchronized folders with both exception-set kinds, classic groups, variant groups, aggregate and legacy targets, reference proxies, build rules, Swift packages, and a ~100 KiB multiplatform framework project.
- Documents already in current Xcode's layout must round-trip byte for byte, and documents from other tool generations must normalize to a byte-stable fixed point with unchanged values.
- On macOS, the suite cross-validates every fixture and its rebuilt form with `plutil`, Apple's own property list parser and the empirical ground truth for what Apple tooling accepts.
- A corpus sweep (`pnpm corpus`) walks every Xcode project, scheme, and xcconfig on the machine, verifies each one parses and reaches a byte-stable fixed point (byte-exact losslessness for xcconfig, which has no canonical layout), exercises the object model against every project, and cross-validates a sample against plutil's own reading.
- CI runs the full gate on Linux and macOS, and executes the built artifact on the oldest supported Node to enforce the `engines` floor.

## Releasing

Releases publish to npm from CI with [provenance](https://docs.npmjs.com/generating-provenance-statements) via [trusted publishing](https://docs.npmjs.com/trusted-publishers); no long-lived tokens are stored in the repository.

1. Bump `version` in `package.json` and merge to `main`.
2. Create a GitHub release with an `X.Y.Z` tag matching the new version.
3. The release workflow verifies the tag, runs the full gate (including
   plutil cross-validation on the macOS runner), and publishes.

## License

Apache-2.0
