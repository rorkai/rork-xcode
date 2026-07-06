/**
 * The base view class of the object model.
 *
 * Views are lightweight, identity-mapped facades over entries of the
 * document's `objects` dictionary. All state lives in the parsed document
 * itself; a view holds only its id and a reference back to the project, so
 * document text produced from the model reflects every mutation with no
 * separate serialization step.
 *
 * @module
 */

import type { PbxprojObject, PbxprojValue } from "../types";
import type { XcodeProject } from "./project";
import { asString } from "./values";

/**
 * A typed handle on one object of the document.
 *
 * Two lookups of the same id return the same view instance (the project
 * keeps an identity map), so views compare with `===`.
 *
 * The type parameter describes the property shape of a well-formed object
 * of this kind; subclasses fix it to their kind's interface so
 * `properties` autocompletes. The shape is a description, not a runtime
 * guarantee: malformed documents can hold anything, which is why the
 * model's own logic reads through narrowing accessors instead.
 */
export class XcodeObject<Properties extends PbxprojObject = PbxprojObject> {
  /** The project this object belongs to. */
  readonly project: XcodeProject;

  /** The object's 24-character identifier (its key in `objects`). */
  readonly id: string;

  /**
   * Views are created by the project's identity map; use
   * {@link XcodeProject.get} or a typed query instead of constructing
   * views directly.
   */
  constructor(project: XcodeProject, id: string) {
    this.project = project;
    this.id = id;
  }

  /**
   * The object's raw dictionary inside the document. Mutations through the
   * model write here, and direct writes are equally valid; the model adds
   * no caching over these properties.
   *
   * The typed shape is asserted, not checked: it describes what a
   * well-formed object of this kind carries (see `properties.ts`).
   */
  get properties(): Properties {
    return this.project.propertiesOf(this.id) as Properties;
  }

  /**
   * The object's `isa` kind name, or the empty string when the field is
   * missing or malformed.
   */
  get isa(): string {
    return asString(this.properties["isa"]) ?? "";
  }

  /**
   * Reads a property expected to be a string. Returns `undefined` when the
   * property is absent or holds another type.
   */
  getString(key: string): string | undefined {
    return asString(this.properties[key]);
  }

  /**
   * Writes one property of the object.
   *
   * The write goes through the untyped document dictionary: generic types
   * cannot be indexed for writing, and the typed shape on `properties` is
   * descriptive rather than enforced.
   */
  set(key: string, value: PbxprojValue): void {
    this.project.propertiesOf(this.id)[key] = value;
  }

  /**
   * The views of the objects referenced by an id-list property, resolved in
   * list order. Dangling ids and non-string entries of malformed documents
   * are skipped.
   */
  protected referencedViews(key: string): XcodeObject[] {
    const items = this.properties[key];
    if (!Array.isArray(items)) {
      return [];
    }
    const views: XcodeObject[] = [];
    for (const item of items) {
      const view = typeof item === "string" ? this.project.get(item) : undefined;
      if (view != null) {
        views.push(view);
      }
    }
    return views;
  }

  /**
   * Removes the object from the document and strips every reference to it:
   * string properties naming the id are deleted, id lists drop it, and
   * nested dictionaries keyed by object id (such as the root project's
   * `TargetAttributes`) drop its entry.
   *
   * This is the low-level removal; it does not cascade to objects that only
   * made sense alongside this one. Higher-level operations like
   * {@link XcodeProject.removeTarget} compose it into full teardowns.
   */
  removeFromProject(): void {
    this.project.removeObject(this.id);
  }
}
