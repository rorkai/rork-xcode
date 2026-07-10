import { parsePbxproj } from "../src/index";

function parseValue(source: string): unknown {
  return (parsePbxproj(`{ v = ${source}; }`) as { v: unknown }).v;
}

test("decodes standard escapes", () => {
  expect(parseValue(String.raw`"a\nb"`)).toBe("a\nb");
  expect(parseValue(String.raw`"a\tb"`)).toBe("a\tb");
  expect(parseValue(String.raw`"a\rb"`)).toBe("a\rb");
  expect(parseValue(String.raw`"a\\b"`)).toBe("a\\b");
  expect(parseValue(String.raw`"say \"hi\""`)).toBe('say "hi"');
  expect(parseValue(String.raw`"it\'s"`)).toBe("it's");
  expect(parseValue(String.raw`"\a\b\f\v"`)).toBe("\u0007\b\f\v");
});

test("decodes \\Uxxxx unicode escapes", () => {
  expect(parseValue(String.raw`"\U0041"`)).toBe("A");
  expect(parseValue(String.raw`"\U00e9"`)).toBe("é");
  expect(parseValue(String.raw`"caf\U00e9"`)).toBe("café");
});

test("preserves a backslash before malformed unicode escapes", () => {
  expect(parseValue(String.raw`"\U00"`)).toBe("\\U00");
});

test("decodes octal escapes, ASCII range directly", () => {
  expect(parseValue(String.raw`"\101"`)).toBe("A"); // 0o101 = 65
  expect(parseValue(String.raw`"\12"`)).toBe("\n"); // 0o12 = 10
  expect(parseValue(String.raw`"\0"`)).toBe("\0");
});

test("maps octal escapes at or above 0x80 through the NeXTSTEP character set", () => {
  // 0o200 = 0x80 decodes to a no-break space and 0o341 = 0xE1 to Æ. Latin-1
  // would give a control character and á respectively, so the NeXTSTEP
  // mapping is the difference under test.
  expect(parseValue(String.raw`"\200"`)).toBe("\u00A0");
  expect(parseValue(String.raw`"\341"`)).toBe("\u00C6");
});

test("preserves unknown escapes as both characters", () => {
  expect(parseValue(String.raw`"a\qb"`)).toBe("a\\qb");
});

test("passes non-ASCII text through untouched", () => {
  expect(parseValue('"héllo wörld"')).toBe("héllo wörld");
  expect(parseValue('"日本語"')).toBe("日本語");
  expect(parseValue('"emoji 🚀 path"')).toBe("emoji 🚀 path");
});
