# Roadmap

This roadmap collects the work we consider worth doing next, in rough order.
It is a statement of intent, not a schedule. Items graduate by shipping in a
minor release, and anything here can be reshuffled when real usage teaches us
something new.

Two principles decide what belongs on this list. The library owns Apple's
project file formats and the object model over them, end to end, with byte
fidelity and zero dependencies. And anything a consumer must hand-roll twice
is a candidate for first-class API.

## Near term

### Build-setting reference expansion

Values like `$(PRODUCT_BUNDLE_IDENTIFIER).widget` appear in build settings
and in Info.plist templates, and every consumer that needs the resolved
string re-implements the expansion informally. A small
`expandBuildSettingReferences(value, lookup)` should handle `$(VAR)` and
`${VAR}` forms, recursive expansion, and `$(inherited)` chains, so it
composes with the settings resolution the xcconfig module shipped.

## Mid term

### Workspace files

`contents.xcworkspacedata` is the remaining member of the file-format family
next to the pbxproj and xcscheme. Parsing it lets tooling resolve which
projects a workspace references instead of globbing the directory tree, and
the writer follows the same canonical-output rules as the scheme module.

### Parser fuzzing in CI

The corpus sweep proves fidelity on real projects. A fuzz harness proves the
inverse property: arbitrary bytes never crash the parsers, they only produce
the typed parse errors. That guarantee matters for anyone running the
library against untrusted uploads, and it is cheap to maintain once wired
into CI.

## Toward 1.0

The isa vocabulary is complete and the mutation surface has stabilized, so
1.0 is less about features and more about formalizing the contract:

- Reference expansion above lands, since it may still reshape parts of the
  settings API.
- One documentation pass over the public surface, with the README examples
  verified against the shipped types.
- From 1.0 on, semver majors gate every breaking change, including
  type-level ones such as parameter narrowing.

## Non-goals

Some things stay out deliberately. The library does not touch the
filesystem, spawn `xcodebuild`, or talk to the network. It does not scaffold
whole applications or own opinions about project layout beyond what Xcode's
own formats encode. And it stays a single zero-dependency artifact — any
feature that would require a runtime dependency needs a very good reason to
exist here at all.
