import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPbxproj, parsePbxproj, type PbxprojObject } from "../src/index";

function lintWithPlutil(text: string): void {
  const dir = mkdtempSync(join(tmpdir(), "rork-xcode-"));
  const file = join(dir, "project.pbxproj");
  try {
    writeFileSync(file, text);
    execFileSync("plutil", ["-lint", file], { stdio: "pipe" });
    // -convert exercises full value decoding, not just syntax.
    execFileSync("plutil", ["-convert", "json", "-o", "/dev/null", file], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Cross-validation against Apple's own parser.
 *
 * `plutil` ships with macOS and reads the same OpenStep-style property list
 * grammar Xcode does, so it is the empirical ground truth for whether our
 * output is acceptable to Apple tooling. Runs only where plutil exists.
 */
describe.skipIf(process.platform !== "darwin")("plutil cross-validation", () => {
  it("accepts every committed fixture and its rebuilt form", () => {
    const dir = new URL("fixtures/", import.meta.url);
    const names = readdirSync(dir).filter((name) => name.endsWith(".pbxproj"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const original = readFileSync(new URL(name, dir), "utf-8");
      lintWithPlutil(original);
      lintWithPlutil(buildPbxproj(parsePbxproj(original) as PbxprojObject));
    }
  });

  it("accepts escape-heavy writer output", () => {
    const document: PbxprojObject = {
      objects: {
        S1: {
          isa: "PBXShellScriptBuildPhase",
          buildActionMask: 2147483647,
          files: [],
          name: 'Quotes "and" backslashes \\ and\nnewlines\tand tabs',
          runOnlyForDeploymentPostprocessing: 0,
          shellPath: "/bin/sh",
          shellScript: 'if [ "$CONFIGURATION" = "Release" ]; then\n  echo "done" > "$HOME/out.log"\nfi\n',
        },
      },
      rootObject: "S1",
    };
    lintWithPlutil(buildPbxproj(document));
  });
});
