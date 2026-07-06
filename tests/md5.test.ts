import { createHash } from "node:crypto";

import { md5Hex } from "../src/md5";

function referenceMd5(text: string): string {
  return createHash("md5").update(text, "utf-8").digest("hex").toUpperCase();
}

test("matches the RFC 1321 test vectors", () => {
  // The suite from RFC 1321 appendix A.5, uppercased to our output form.
  expect(md5Hex("")).toBe("D41D8CD98F00B204E9800998ECF8427E");
  expect(md5Hex("a")).toBe("0CC175B9C0F1B6A831C399E269772661");
  expect(md5Hex("abc")).toBe("900150983CD24FB0D6963F7D28E17F72");
  expect(md5Hex("message digest")).toBe("F96B697D7CB7938D525A2F31AAF161D0");
  expect(md5Hex("abcdefghijklmnopqrstuvwxyz")).toBe("C3FCD3D76192E4007DFB496CCA67E13B");
  expect(md5Hex("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")).toBe(
    "D174AB98D277D9F5A5611C2C9F419D9F",
  );
  expect(md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890")).toBe(
    "57EDF4A22BE3C955AC49DA2E2107B67A",
  );
});

test("agrees with the platform digest across padding boundaries", () => {
  // Message lengths around the 56-byte and 64-byte marks exercise every
  // padding branch: the bit-length field must land in the right block.
  for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const text = "x".repeat(length);
    expect(md5Hex(text)).toBe(referenceMd5(text));
  }
});

test("agrees with the platform digest on multi-byte UTF-8 text", () => {
  for (const text of ["héllo wörld", "日本語のテキスト", "emoji 🚀 seed", "PBXNativeTarget Ünïcode"]) {
    expect(md5Hex(text)).toBe(referenceMd5(text));
  }
});
