# rork-xcode

[![CI](https://github.com/rorkai/rork-xcode/actions/workflows/ci.yml/badge.svg)](https://github.com/rorkai/rork-xcode/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/rork-xcode)](https://www.npmjs.com/package/rork-xcode)

Zero-dependency Xcode project (`project.pbxproj`) parser and builder for any JavaScript runtime: browsers, Node.js, Bun, Electron, Cloudflare Workers, and React Native.

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

`project.pbxproj` is the heart of every Xcode project: targets, build phases, build settings, file references. Programs that create or repair Xcode projects increasingly run everywhere at once — an API on an edge runtime, a desktop app's Node process, a CLI inside a build sandbox.

`rork-xcode` is designed for exactly that situation:

- **Zero dependencies.** The pbxproj grammar is a small OpenStep-style property list dialect: dictionaries, arrays, strings, and hex data runs. A dedicated scanner covers it completely — no general-purpose parser stack, no native addon, no WASM blob.
- **One artifact, one code path.** A single ESM file with named exports. No environment-conditional entry points, no reliance on ambient globals like `Buffer`. What you test locally is what runs in production, whatever the bundler.
- **Xcode-canonical output.** The serializer reproduces the layout Xcode itself writes — tab indentation, per-isa object sections in sorted order, single-line build-file entries, and derived reference comments (`13B07F86… /* AppDelegate.swift in Sources */`) — so diffs against Xcode-saved projects stay minimal and Xcode does not rewrite the file on next save.
- **Round-trip faithful.** Parse → build is byte-identical for Xcode-canonical documents and a fixed point for everything else. Lexical subtleties that plain number conversion would destroy — leading-zero values like `0755`, trailing-zero versions like `5.0`, digit runs longer than the double-precision safe range — are preserved as strings by design.
- **Loud failure modes.** Malformed documents fail with a typed error carrying line and column; unrepresentable values (`null`, booleans, non-finite numbers) fail with the exact path of the offending value. Nothing is silently dropped.

## Install

```sh
pnpm add rork-xcode
```

## API

### `parsePbxproj(text)`

Parses a `project.pbxproj` document into plain JavaScript values. The leading `// !$*UTF8*$!` marker and all comments are treated as trivia.

| Source shape                                | JavaScript value |
| ------------------------------------------- | ---------------- |
| `{ key = value; ... }`                      | plain object     |
| `( item, item, ... )`                       | array            |
| unquoted digit run (`46`)                   | `number`         |
| unquoted decimal not ending in `0` (`3.14`) | `number`         |
| `<48656c6c6f>`                              | `Uint8Array`     |
| everything else                             | `string`         |

Dictionary keys keep document order. Quoted values are always strings, so `"46"` and `46` remain distinguishable.

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

Serializes a document back to pbxproj text. The input is the same shape `parsePbxproj` produces; any dictionary works, and documents carrying a root-level `objects` dictionary get the full Xcode layout treatment: sections grouped by `isa` and sorted, entries sorted by identifier, reference comments derived from the object graph, and version-like build settings (`SWIFT_VERSION = 5.0`) rendered with their trailing zero.

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

Booleans are rejected on purpose: the format has no boolean notation — Xcode models flags as the strings `"YES"` and `"NO"` — so writing one would produce a value Xcode misreads.

## Verification

- Golden-file tests assert byte-exact round-trips over real project documents, including Xcode 16 file-system-synchronized groups.
- On macOS, the suite cross-validates output with `plutil`, Apple's own property list parser — the empirical ground truth for what Apple tooling accepts.
- CI runs the full gate on Linux and macOS, and executes the built artifact on the oldest supported Node to enforce the `engines` floor.

## License

Apache-2.0
