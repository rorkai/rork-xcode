import { buildPbxproj, parsePbxproj, PbxprojBuildError } from "../src/index";

test("starts with the encoding marker and ends with a newline", () => {
  const text = buildPbxproj({ archiveVersion: 1 });
  expect(text.startsWith("// !$*UTF8*$!\n")).toBe(true);
  expect(text.endsWith("}\n")).toBe(true);
});

test("quotes values exactly when the unquoted alphabet requires it", () => {
  const text = buildPbxproj({
    plain: "hello",
    path: "path/to/file.swift",
    variable: "$(TARGET_NAME)",
    hyphenated: "foo-bar",
    spaced: "two words",
    empty: "",
    tree: "<group>",
  });
  expect(text).toContain("plain = hello;");
  expect(text).toContain("path = path/to/file.swift;");
  expect(text).toContain('variable = "$(TARGET_NAME)";');
  expect(text).toContain('hyphenated = "foo-bar";');
  expect(text).toContain('spaced = "two words";');
  expect(text).toContain('empty = "";');
  expect(text).toContain('tree = "<group>";');
});

test("escapes control characters and quotes inside quoted strings", () => {
  const text = buildPbxproj({ script: 'echo "hi"\nexit 0\n' });
  expect(text).toContain(String.raw`script = "echo \"hi\"\nexit 0\n";`);
});

test("renders version-like build settings with a trailing .0 when integral", () => {
  const text = buildPbxproj({
    SWIFT_VERSION: 5,
    MARKETING_VERSION: 1,
    IPHONEOS_DEPLOYMENT_TARGET: 18,
    buildActionMask: 2147483647,
    dstSubfolderSpec: 13,
  });
  expect(text).toContain("SWIFT_VERSION = 5.0;");
  expect(text).toContain("MARKETING_VERSION = 1.0;");
  expect(text).toContain("IPHONEOS_DEPLOYMENT_TARGET = 18.0;");
  expect(text).toContain("buildActionMask = 2147483647;");
  expect(text).toContain("dstSubfolderSpec = 13;");
});

test("renders data values as uppercase hex runs", () => {
  const text = buildPbxproj({ blob: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) });
  expect(text).toContain("blob = <DEADBEEF>;");
});

test("groups the objects dictionary into sorted isa sections", () => {
  const text = buildPbxproj({
    objects: {
      B2: { isa: "XCBuildConfiguration", buildSettings: {}, name: "Debug" },
      A1: {
        isa: "PBXSourcesBuildPhase",
        buildActionMask: 2147483647,
        files: [],
        runOnlyForDeploymentPostprocessing: 0,
      },
    },
    rootObject: "A1",
  });
  const sourcesSection = text.indexOf("/* Begin PBXSourcesBuildPhase section */");
  const configSection = text.indexOf("/* Begin XCBuildConfiguration section */");
  expect(sourcesSection).toBeGreaterThan(-1);
  expect(configSection).toBeGreaterThan(sourcesSection);
  expect(text).toContain("/* End PBXSourcesBuildPhase section */");
});

test("annotates references with comments derived from the object graph", () => {
  const text = buildPbxproj({
    objects: {
      F1: { isa: "PBXFileReference", path: "App.swift", sourceTree: "<group>" },
      B1: { isa: "PBXBuildFile", fileRef: "F1" },
      P1: {
        isa: "PBXSourcesBuildPhase",
        buildActionMask: 2147483647,
        files: ["B1"],
        runOnlyForDeploymentPostprocessing: 0,
      },
    },
    rootObject: "P1",
  });
  expect(text).toContain("B1 /* App.swift in Sources */ = {isa = PBXBuildFile; fileRef = F1 /* App.swift */; };");
  expect(text).toContain("B1 /* App.swift in Sources */,");
});

test("remoteGlobalIDString renders without a reference comment", () => {
  const text = buildPbxproj({
    objects: {
      T1: {
        isa: "PBXNativeTarget",
        buildConfigurationList: "",
        buildPhases: [],
        buildRules: [],
        dependencies: [],
        name: "Demo",
        productType: "com.apple.product-type.application",
      },
      C1: {
        isa: "PBXContainerItemProxy",
        containerPortal: "R1",
        proxyType: 1,
        remoteGlobalIDString: "T1",
        remoteInfo: "Demo",
      },
    },
    rootObject: "R1",
  });
  expect(text).toContain("remoteGlobalIDString = T1;");
  expect(text).not.toContain("remoteGlobalIDString = T1 /*");
});

test("root-level empty dictionaries render multi-line; nested ones collapse to {}", () => {
  // Only immediate root keys (like `classes`) render empty dictionaries
  // multi-line; anything deeper uses the inline `{}` form.
  const text = buildPbxproj({ classes: {}, extras: { empty: {} } });
  expect(text).toContain("classes = {\n\t};");
  expect(text).toContain("empty = {};");
});

test("cyclic build-file references terminate with a null comment", () => {
  // Malformed projects can point build files at each other; comment
  // derivation must fall back instead of recursing until stack overflow.
  const text = buildPbxproj({
    objects: {
      B1: { isa: "PBXBuildFile", fileRef: "B2" },
      B2: { isa: "PBXBuildFile", fileRef: "B1" },
      P1: {
        isa: "PBXSourcesBuildPhase",
        buildActionMask: 2147483647,
        files: ["B1", "B2"],
        runOnlyForDeploymentPostprocessing: 0,
      },
    },
    rootObject: "P1",
  });
  // The inner lookup of the cycle short-circuits to the (null) fallback.
  expect(text).toContain("B2 /* (null) in Sources */");
});

test("rejects values the format cannot carry, naming their path", () => {
  try {
    buildPbxproj({ objects: { A1: { isa: "PBXGroup", children: [], name: null } } } as never);
    expect.unreachable("build should have thrown");
  } catch (error) {
    assert(error instanceof PbxprojBuildError);
    expect(error.path).toBe("$.objects.A1.name");
    expect(error.message).toContain("null");
  }

  expect(() => buildPbxproj({ flag: true } as never)).toThrow(PbxprojBuildError);
  expect(() => buildPbxproj({ big: 1n } as never)).toThrow(PbxprojBuildError);
  expect(() => buildPbxproj({ bad: Number.NaN })).toThrow(PbxprojBuildError);
  expect(() => buildPbxproj([] as never)).toThrow(PbxprojBuildError);
});

test("build output parses back to the same document", () => {
  const document = {
    archiveVersion: 1,
    classes: {},
    objectVersion: 77,
    objects: {
      F1: { isa: "PBXFileReference", lastKnownFileType: "sourcecode.swift", path: "App.swift", sourceTree: "<group>" },
    },
    rootObject: "F1",
  };
  expect(parsePbxproj(buildPbxproj(document))).toEqual(document);
});
