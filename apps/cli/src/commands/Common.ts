/**
 * What the local memory commands share: where the home is, and the stores in it.
 */
import { Effect, Layer, Option } from "effect"
import { Flag } from "effect/cli"
import { loadHome } from "../local/Home.ts"
import * as JsonRecordStore from "../records/JsonRecordStore.ts"

export const homeFlag = Flag.String("home").pipe(
  Flag.optional,
  Flag.withDescription("memory home (default: $SINGULARITY_HOME, or ~/.singularity)")
)

/** The record store of the home's tenant. */
export const recordsLayer = (home: Option.Option<string>) =>
  Layer.unwrap(loadHome(Option.getOrUndefined(home)).pipe(Effect.map((h) => JsonRecordStore.layer(h.tenantDir, h.tenant))))
