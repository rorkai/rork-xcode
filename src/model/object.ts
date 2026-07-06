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
 */
export class XcodeObject {
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
   */
  get properties(): PbxprojObject {
    return this.project.propertiesOf(this.id);
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
   */
  set(key: string, value: PbxprojValue): void {
    this.properties[key] = value;
  }
}
