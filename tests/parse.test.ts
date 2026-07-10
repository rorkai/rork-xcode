import { parsePbxproj, PbxprojParseError } from "../src/index";

test("parses a flat dictionary", () => {
  expect(parsePbxproj("{ key = value; }")).toEqual({ key: "value" });
});

test("parses nested dictionaries", () => {
  expect(parsePbxproj("{ outer = { inner = 42; }; }")).toEqual({ outer: { inner: 42 } });
});

test("parses arrays with and without trailing commas", () => {
  expect(parsePbxproj("{ items = (one, two, three); }")).toEqual({ items: ["one", "two", "three"] });
  expect(parsePbxproj("{ items = (one, two, three, ); }")).toEqual({ items: ["one", "two", "three"] });
});

test("parses quoted keys and values", () => {
  expect(parsePbxproj('{ "quoted key" = "quoted value"; }')).toEqual({ "quoted key": "quoted value" });
  expect(parsePbxproj("{ path = 'single quoted'; }")).toEqual({ path: "single quoted" });
});

test("quoted digit runs stay strings", () => {
  expect(parsePbxproj('{ version = "46"; }')).toEqual({ version: "46" });
});

test("parses data runs into Uint8Array", () => {
  const parsed = parsePbxproj("{ data = <ABCD 1234>; }") as { data: Uint8Array };
  expect(parsed.data).toBeInstanceOf(Uint8Array);
  expect([...parsed.data]).toEqual([0xab, 0xcd, 0x12, 0x34]);
});

test("skips line and block comments as trivia", () => {
  const parsed = parsePbxproj(`// !$*UTF8*$!
{
  /* leading */ archiveVersion = 1; // trailing
  objectVersion = 46;
}`);
  expect(parsed).toEqual({ archiveVersion: 1, objectVersion: 46 });
});

test("parses empty dictionaries and arrays", () => {
  expect(parsePbxproj("{}")).toEqual({});
  expect(parsePbxproj("{ items = (); }")).toEqual({ items: [] });
});

test("parses an array document root", () => {
  expect(parsePbxproj("(a, b)")).toEqual(["a", "b"]);
});

describe("unquoted literal interpretation", () => {
  it("keeps identifiers, uuids, and paths as strings", () => {
    expect(parsePbxproj("{ v = hello_world; }")).toEqual({ v: "hello_world" });
    expect(parsePbxproj("{ v = 13B07F961A680F5B00A75B9A; }")).toEqual({ v: "13B07F961A680F5B00A75B9A" });
    expect(parsePbxproj("{ v = path/to/file.swift; }")).toEqual({ v: "path/to/file.swift" });
  });

  it("parses plain digit runs as numbers", () => {
    expect(parsePbxproj("{ v = 0; }")).toEqual({ v: 0 });
    expect(parsePbxproj("{ v = 46; }")).toEqual({ v: 46 });
    expect(parsePbxproj("{ v = 2147483647; }")).toEqual({ v: 2147483647 });
  });

  it("keeps leading-zero digit runs as strings", () => {
    expect(parsePbxproj("{ v = 0755; }")).toEqual({ v: "0755" });
    expect(parsePbxproj("{ v = 00; }")).toEqual({ v: "00" });
    expect(parsePbxproj("{ v = 0940; }")).toEqual({ v: "0940" });
  });

  it("keeps digit runs beyond MAX_SAFE_INTEGER as strings", () => {
    expect(parsePbxproj("{ v = 9007199254740991; }")).toEqual({ v: 9007199254740991 });
    expect(parsePbxproj("{ v = 9007199254740993; }")).toEqual({ v: "9007199254740993" });
  });

  it("parses decimals but keeps trailing-zero decimals as strings", () => {
    expect(parsePbxproj("{ v = 3.14; }")).toEqual({ v: 3.14 });
    expect(parsePbxproj("{ v = 5.0; }")).toEqual({ v: "5.0" });
    expect(parsePbxproj("{ v = 18.0; }")).toEqual({ v: "18.0" });
  });

  it("converts signed values exactly when the number prints back identically", () => {
    expect(parsePbxproj("{ v = -12; }")).toEqual({ v: -12 });
    expect(parsePbxproj("{ v = -3.14; }")).toEqual({ v: -3.14 });
    expect(parsePbxproj("{ v = -0; }")).toEqual({ v: "-0" });
    expect(parsePbxproj("{ v = -ObjC; }")).toEqual({ v: "-ObjC" });
  });

  it("keeps every lexical form a number cannot reproduce as a string", () => {
    expect(parsePbxproj("{ v = 1.0.0; }")).toEqual({ v: "1.0.0" });
    // A bare-dot decimal converts to 0.5, which prints back as "0.5", a
    // different byte sequence, so the literal stays a string.
    expect(parsePbxproj("{ v = .5; }")).toEqual({ v: ".5" });
    expect(parsePbxproj("{ v = 5.; }")).toEqual({ v: "5." });
  });
});

describe("malformed input", () => {
  it("reports the line and column of the failure", () => {
    try {
      parsePbxproj("{\n  key = ;\n}");
      expect.unreachable("parse should have thrown");
    } catch (error) {
      assert(error instanceof PbxprojParseError);
      expect(error.message).toContain("line 2");
      expect(error.position.line).toBe(2);
    }
  });

  it("rejects unterminated structures", () => {
    expect(() => parsePbxproj("{ key = value; ")).toThrow(PbxprojParseError);
    expect(() => parsePbxproj("{ items = (a, b; }")).toThrow(PbxprojParseError);
    expect(() => parsePbxproj('{ key = "unterminated; }')).toThrow(PbxprojParseError);
    expect(() => parsePbxproj("{ data = <AB; }")).toThrow(PbxprojParseError);
  });

  it("rejects missing separators and empty input", () => {
    expect(() => parsePbxproj("{ key value; }")).toThrow(PbxprojParseError);
    expect(() => parsePbxproj("")).toThrow(PbxprojParseError);
    expect(() => parsePbxproj("plain")).toThrow(PbxprojParseError);
  });

  // Apple's parser rejects both of these. Being lenient would silently
  // reshape malformed documents instead of surfacing them.
  it("rejects array items separated by whitespace only", () => {
    expect(() => parsePbxproj("{ items = (a b); }")).toThrow(PbxprojParseError);
  });

  it("rejects data runs with an odd number of hex digits", () => {
    expect(() => parsePbxproj("{ data = <ABC>; }")).toThrow(PbxprojParseError);
  });

  it("rejects unterminated block comments before or inside the root value", () => {
    expect(() => parsePbxproj("{ a = /* never closed")).toThrow("Unterminated block comment");
    expect(() => parsePbxproj("/* header { }")).toThrow("Unterminated block comment");
    // Content after the root value is never read, so a trailing unterminated
    // comment does not fail (Apple's parser accepts it too).
    expect(parsePbxproj("{ a = 1; } /* trailing")).toEqual({ a: 1 });
  });
});

test("a literal __proto__ key cannot pollute prototypes", () => {
  const parsed = parsePbxproj('{ __proto__ = { polluted = "yes"; }; }') as Record<string, unknown>;
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
});
