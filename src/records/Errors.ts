/**
 * Errors raised by record stores. Failures to read or write the store itself
 * are the graph store's `StoreError`, and a write that conflicts with what is
 * stored is its `Conflict`.
 */
import { Schema } from "effect"

export class RecordNotFound extends Schema.TaggedError<RecordNotFound>()("RecordNotFound", {
  id: Schema.String
}) {
  override get message(): string {
    return `no record ${this.id}`
  }
}

export class RecordExists extends Schema.TaggedError<RecordExists>()("RecordExists", {
  id: Schema.String
}) {
  override get message(): string {
    return `record ${this.id} already exists`
  }
}
