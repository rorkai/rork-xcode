/**
 * Expansion of `$(NAME)` and `${NAME}` build-setting references.
 *
 * Values in the pbxproj, in xcconfig files, and in Info.plist templates
 * reference other build settings, and every consumer that needs the
 * resolved string ends up re-implementing the substitution informally.
 * The expander here is a pure function over a caller-supplied lookup, so
 * the same code serves all three formats. The model composes it with
 * settings resolution in `Target.resolveBuildSetting`.
 *
 * @module
 */

/**
 * The value a reference expands to, or `undefined` to leave the
 * reference in place. Returning the empty string expands to nothing,
 * which is how Xcode itself treats settings that exist but are empty.
 */
export type BuildSettingLookup = (name: string) => string | undefined;

export interface ExpandBuildSettingOptions {
  /**
   * Whether lookup answers are expanded again, which is the default and
   * suits lookups reading raw stored values. A lookup that resolves
   * references itself, like the model's layered resolution, turns this
   * off so text it deliberately left verbatim is not reinterpreted in
   * the outer value's context.
   */
  expandLookupValues?: boolean;
}

/**
 * Expands every `$(NAME)` and `${NAME}` reference in a value through the
 * lookup. Substituted text is expanded again, so references are followed
 * through chains of values, and reference names may themselves contain
 * references (`$(SETTING_$(VARIANT))`), which expand innermost first.
 *
 * A lookup answer of `undefined` leaves the reference in the output
 * verbatim, so partial resolution loses no information. A reference
 * whose expansion would recurse into itself also stays verbatim, which
 * keeps cyclic definitions finite. Xcode's `:` operators are honored for
 * the forms below, and a reference carrying any other operator stays
 * verbatim rather than expanding to a wrongly transformed value.
 *
 * The supported operators are `lower` and `upper` for case mapping,
 * `rfc1034identifier` and `c99extidentifier` for the identifier
 * mappings bundle identifiers and product module names use, and
 * `default=value` for substituting a fallback when the setting resolves
 * empty or is not known to the lookup.
 */
export function expandBuildSettingReferences(
  value: string,
  lookup: BuildSettingLookup,
  options?: ExpandBuildSettingOptions,
): string {
  return expand(value, lookup, options?.expandLookupValues !== false, new Set());
}

const CODE_DOLLAR = 36;

/**
 * One expansion pass over a value. Active names carry the references
 * currently being expanded up the call stack, so a cycle is detected the
 * moment a name would expand inside its own expansion.
 */
function expand(
  value: string,
  lookup: BuildSettingLookup,
  expandLookupValues: boolean,
  active: ReadonlySet<string>,
): string {
  if (!value.includes("$")) {
    return value;
  }

  let out = "";
  let index = 0;
  while (index < value.length) {
    const open = value.charCodeAt(index) === CODE_DOLLAR ? value[index + 1] : undefined;
    if (open !== "(" && open !== "{") {
      out += value[index];
      index++;
      continue;
    }

    const end = findClosingDelimiter(value, index + 2, open === "(" ? ")" : "}");
    if (end === -1) {
      out += value.slice(index);
      break;
    }

    const reference = value.slice(index, end + 1);
    // Composed names expand innermost first, so $(SETTING_$(VARIANT))
    // resolves the variant before looking the full name up.
    const inner = expand(value.slice(index + 2, end), lookup, expandLookupValues, active);
    out += expandReference(reference, inner, lookup, expandLookupValues, active);
    index = end + 1;
  }
  return out;
}

/**
 * Finds the index of the closing delimiter matching an opener at
 * `start - 1`, honoring nested delimiters of the same kind, or -1 when
 * the reference is unterminated.
 */
function findClosingDelimiter(value: string, start: number, close: string): number {
  const open = close === ")" ? "(" : "{";
  let depth = 0;
  for (let i = start; i < value.length; i++) {
    const ch = value[i];
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      if (depth === 0) {
        return i;
      }
      depth--;
    }
  }
  return -1;
}

/**
 * Expands one reference whose name and operators have already had their
 * own references resolved. Returns the original reference text whenever
 * the expansion cannot honestly produce a value.
 */
function expandReference(
  reference: string,
  inner: string,
  lookup: BuildSettingLookup,
  expandLookupValues: boolean,
  active: ReadonlySet<string>,
): string {
  const colon = inner.indexOf(":");
  const name = colon === -1 ? inner : inner.slice(0, colon);
  if (active.has(name)) {
    return reference;
  }

  const raw = lookup(name);
  const nested = new Set(active);
  nested.add(name);
  let value = raw;
  if (raw != null && expandLookupValues) {
    value = expand(raw, lookup, expandLookupValues, nested);
  }

  if (colon !== -1) {
    for (const operator of splitOperators(inner.slice(colon + 1))) {
      if (operator.startsWith("default=")) {
        if (value == null || value === "") {
          value = operator.slice("default=".length);
        }
      } else if (value != null) {
        const applied = applyOperator(operator, value);
        if (applied == null) {
          return reference;
        }
        value = applied;
      } else if (applyOperator(operator, "") == null) {
        return reference;
      }
    }
  }

  return value ?? reference;
}

/**
 * Splits an operator chain at colons, keeping a `default=` value intact
 * even when it contains colons of its own, the way Xcode consumes the
 * rest of the reference as the default.
 */
function splitOperators(operators: string): string[] {
  const parts: string[] = [];
  let rest = operators;
  while (rest.length > 0) {
    if (rest.startsWith("default=")) {
      parts.push(rest);
      break;
    }
    const colon = rest.indexOf(":");
    if (colon === -1) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, colon));
    rest = rest.slice(colon + 1);
  }
  return parts;
}

/**
 * Applies one operator to a resolved value, or returns `undefined` for
 * operators the expander does not know, which the caller turns into a
 * verbatim reference.
 */
function applyOperator(operator: string, value: string): string | undefined {
  switch (operator) {
    case "lower":
      return value.toLowerCase();
    case "upper":
      return value.toUpperCase();
    case "rfc1034identifier":
      return value.replaceAll(/[^A-Za-z0-9-]/gu, "-");
    case "c99extidentifier":
      return value.replaceAll(/[^A-Za-z0-9_]/gu, "_");
    default:
      return undefined;
  }
}
