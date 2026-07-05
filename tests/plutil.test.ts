import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPbxproj, type PbxprojObject } from "../src/index";

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
  it("accepts both committed fixtures", () => {
    for (const name of ["app-xcode16.pbxproj", "legacy-groups.pbxproj"]) {
      lintWithPlutil(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8"));
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
