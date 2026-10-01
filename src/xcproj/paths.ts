/**
 * The two path notations of `project.xcproj` documents.
 *
 * File paths say where a reference lives on disk. They are strings like
 * `Sources/App.swift`, optionally prefixed with a base such as
 * `<PRODUCTS>/` or `<USER:SHARED_ROOT>/`.
 *
 * Name paths say where an object lives in the project's file tree, by
 * the names of the references along the way. They are how targets name
 * their products (`Products/App.app`) and how files name the build phases
 * they belong to (`App/compile-sources`). The common encoding is one
 * string of `/`-separated names. Names that cannot be written that way,
 * such as a target called `C/C++ Library`, switch the whole path to an
 * array whose awkward components become `{ "name": "C/C++ Library" }`.
 * A string starting with `id:` is an object id instead of a name path.
 *
 * @module
 */

import type { XcprojValue } from "./types";

/**
 * One component of a decoded name path.
 */
export interface NamePathComponent {
  /** The component's name, or `.` or `..` for a relative component. */
  readonly name: string;

  /** Whether the component is the relative `.` or `..` rather than a child name. */
  readonly relative: boolean;
}

/**
 * The prefix that marks a group tree reference as an object id.
 */
const ID_PREFIX = "id:";

/**
 * Whether a child name can be written as a plain string component.
 */
function isPlainName(name: string): boolean {
  return !name.includes("/") && name !== "." && name !== "..";
}

/**
 * Reads one string component, where `.` and `..` are relative.
 */
function stringComponent(name: string): NamePathComponent {
  return { name, relative: name === "." || name === ".." };
}

/**
 * Decodes a name path from its string or array encoding. Returns
 * `undefined` for an `id:` reference and for malformed values.
 */
export function decodeNamePath(value: XcprojValue | undefined): NamePathComponent[] | undefined {
  if (typeof value === "string") {
    return value.startsWith(ID_PREFIX) ? undefined : value.split("/").map((name) => stringComponent(name));
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const components: NamePathComponent[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      components.push(stringComponent(item));
    } else if (typeof item === "object" && item !== null && !Array.isArray(item) && typeof item["name"] === "string") {
      components.push({ name: item["name"], relative: false });
    } else {
      return undefined;
    }
  }
  return components;
}

/**
 * Encodes a name path the way Xcode does. The path is one `/`-joined
 * string when every component is a plain name and the result cannot be
 * mistaken for an `id:` reference, and an array otherwise.
 */
export function encodeNamePath(components: readonly NamePathComponent[]): XcprojValue {
  if (components.length > 0 && components.every((component) => component.relative || isPlainName(component.name))) {
    const joined = components.map((component) => component.name).join("/");
    if (!joined.startsWith(ID_PREFIX)) {
      return joined;
    }
  }
  return components.map((component) =>
    component.relative || isPlainName(component.name) ? component.name : { name: component.name },
  );
}

/**
 * Builds the name path components of plain child names.
 */
export function childComponents(names: readonly string[]): NamePathComponent[] {
  return names.map((name) => ({ name, relative: false }));
}

/**
 * A file path split into its base and the path relative to it.
 */
export interface DecodedFilePath {
  /**
   * What the path is relative to. `group` is the enclosing group and is
   * the default. `absolute` paths start at the file system root, and the
   * built-in bases `PROJECT`, `DEVELOPER`, `PRODUCTS`, and `SDK` are
   * written as `<PROJECT>/` and so on. A base of the form `USER:NAME` is
   * the source tree named by the build setting `NAME`.
   */
  readonly base: string;

  /** The path relative to the base, unescaped. */
  readonly path: string;
}

/**
 * The bases Xcode writes as `<NAME>/` prefixes.
 */
const BUILT_IN_BASES = new Set(["PROJECT", "DEVELOPER", "PRODUCTS", "SDK"]);

/**
 * Removes the backslash escapes Xcode writes in front of `\` and of one
 * other character.
 */
function unescapePath(text: string, escaped: string): string {
  if (!text.includes("\\")) {
    return text;
  }
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (character === "\\" && (text[i + 1] === "\\" || text[i + 1] === escaped)) {
      result += text[i + 1];
      i++;
    } else {
      result += character;
    }
  }
  return result;
}

/**
 * Escapes `\` and one other character with backslashes.
 */
function escapePath(text: string, escaped: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll(escaped, `\\${escaped}`);
}

/**
 * Splits a file path string into its base and relative path.
 */
export function decodeFilePath(text: string): DecodedFilePath {
  if (text.startsWith("<USER:")) {
    let variable = "";
    for (let i = 6; i < text.length; i++) {
      const character = text[i]!;
      if (character === "\\" && i + 1 < text.length) {
        variable += text[i + 1];
        i++;
      } else if (character === ">") {
        return { base: `USER:${variable}`, path: text.slice(i + 1).replace(/^\//u, "") };
      } else {
        variable += character;
      }
    }
  } else if (text.startsWith("<")) {
    const end = text.indexOf(">/");
    const base = end === -1 ? "" : text.slice(1, end);
    if (BUILT_IN_BASES.has(base)) {
      return { base, path: text.slice(end + 2) };
    }
  }
  return { base: text.startsWith("/") ? "absolute" : "group", path: unescapePath(text, "<") };
}

/**
 * Writes a decoded file path back to its string form.
 */
export function encodeFilePath(file: DecodedFilePath): string {
  if (BUILT_IN_BASES.has(file.base)) {
    return `<${file.base}>/${file.path}`;
  }
  if (file.base.startsWith("USER:")) {
    return `<USER:${escapePath(file.base.slice(5), ">")}>/${file.path}`;
  }
  return escapePath(file.path, "<");
}

/**
 * The last component of a path, ignoring trailing slashes, which is how
 * Xcode derives a reference's default name from its path.
 */
export function lastPathComponent(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") {
    end--;
  }
  const trimmed = path.slice(0, end);
  if (trimmed === "/") {
    return trimmed;
  }
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}
