import { expandBuildSettingReferences } from "../src/index";

/**
 * A lookup over a fixed table, answering `undefined` for names outside
 * it the way the model answers for settings the document does not
 * define.
 */
function tableLookup(table: Record<string, string>): (name: string) => string | undefined {
  return (name) => table[name];
}

describe("reference forms", () => {
  it("expands both delimiter forms inside surrounding text", () => {
    const lookup = tableLookup({ NAME: "Demo", KIND: "app" });
    expect(expandBuildSettingReferences("$(NAME)-${KIND}.bundle", lookup)).toBe("Demo-app.bundle");
  });

  it("leaves plain text and bare dollars untouched", () => {
    const lookup = tableLookup({});
    expect(expandBuildSettingReferences("cost is $5 for a+b", lookup)).toBe("cost is $5 for a+b");
  });

  it("leaves an unterminated reference verbatim", () => {
    const lookup = tableLookup({ NAME: "Demo" });
    expect(expandBuildSettingReferences("$(NAME", lookup)).toBe("$(NAME");
  });

  it("expands composed names innermost first", () => {
    const lookup = tableLookup({ VARIANT: "RELEASE", PATH_RELEASE: "/out" });
    expect(expandBuildSettingReferences("$(PATH_$(VARIANT))", lookup)).toBe("/out");
  });
});

describe("resolution and recursion", () => {
  it("expands references inside looked-up values", () => {
    const lookup = tableLookup({
      PRODUCT_BUNDLE_IDENTIFIER: "com.example.$(PRODUCT_NAME)",
      PRODUCT_NAME: "Demo",
    });
    expect(expandBuildSettingReferences("$(PRODUCT_BUNDLE_IDENTIFIER).widget", lookup)).toBe("com.example.Demo.widget");
  });

  it("keeps unresolved references verbatim", () => {
    const lookup = tableLookup({ TARGET_NAME: "Demo" });
    expect(expandBuildSettingReferences("$(BUILT_PRODUCTS_DIR)/$(TARGET_NAME).app", lookup)).toBe(
      "$(BUILT_PRODUCTS_DIR)/Demo.app",
    );
  });

  it("expands an empty answer to nothing", () => {
    const lookup = tableLookup({ SUFFIX: "" });
    expect(expandBuildSettingReferences("Demo$(SUFFIX)", lookup)).toBe("Demo");
  });

  it("keeps a self-referencing definition finite and verbatim", () => {
    const lookup = tableLookup({ LOOP: "$(LOOP) again" });
    expect(expandBuildSettingReferences("$(LOOP)", lookup)).toBe("$(LOOP) again");
  });

  it("keeps mutually recursive definitions finite", () => {
    const lookup = tableLookup({ A: "$(B)", B: "$(A)" });
    expect(expandBuildSettingReferences("$(A)", lookup)).toBe("$(A)");
  });

  it("expands the same name independently outside a cycle", () => {
    const lookup = tableLookup({ NAME: "Demo" });
    expect(expandBuildSettingReferences("$(NAME)/$(NAME)", lookup)).toBe("Demo/Demo");
  });
});

describe("operators", () => {
  it("maps case with lower and upper", () => {
    const lookup = tableLookup({ NAME: "Demo" });
    expect(expandBuildSettingReferences("$(NAME:lower)", lookup)).toBe("demo");
    expect(expandBuildSettingReferences("$(NAME:upper)", lookup)).toBe("DEMO");
  });

  it("maps identifiers the way bundle identifiers use them", () => {
    const lookup = tableLookup({ PRODUCT_NAME: "My App 2.0" });
    expect(expandBuildSettingReferences("com.example.$(PRODUCT_NAME:rfc1034identifier)", lookup)).toBe(
      "com.example.My-App-2-0",
    );
    expect(expandBuildSettingReferences("$(PRODUCT_NAME:c99extidentifier)", lookup)).toBe("My_App_2_0");
  });

  it("substitutes a default for empty and unresolved settings", () => {
    const lookup = tableLookup({ EMPTY: "" });
    expect(expandBuildSettingReferences("$(EMPTY:default=fallback)", lookup)).toBe("fallback");
    expect(expandBuildSettingReferences("$(ABSENT:default=fallback)", lookup)).toBe("fallback");
    expect(expandBuildSettingReferences("$(ABSENT:default=)", lookup)).toBe("");
  });

  it("keeps a resolved value over its default", () => {
    const lookup = tableLookup({ NAME: "Demo" });
    expect(expandBuildSettingReferences("$(NAME:default=Other)", lookup)).toBe("Demo");
  });

  it("chains operators left to right", () => {
    const lookup = tableLookup({ NAME: "Demo App" });
    expect(expandBuildSettingReferences("$(NAME:rfc1034identifier:lower)", lookup)).toBe("demo-app");
  });

  it("consumes the rest of the reference as the default value", () => {
    const lookup = tableLookup({});
    expect(expandBuildSettingReferences("$(ABSENT:default=a:b)", lookup)).toBe("a:b");
  });

  it("leaves references with unknown operators verbatim", () => {
    const lookup = tableLookup({ NAME: "Demo" });
    expect(expandBuildSettingReferences("$(NAME:dir)", lookup)).toBe("$(NAME:dir)");
    expect(expandBuildSettingReferences("$(ABSENT:dir)", lookup)).toBe("$(ABSENT:dir)");
  });
});
