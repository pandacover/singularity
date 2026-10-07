/**
 * MemoryStore backed by JSON files:
 *
 *     <dir>/memory.json                 { head, next_candidate }
 *     <dir>/versions/000003.json        each committed version, in full
 *     <dir>/candidates/c000004.json     each proposed build: its edits, replay and status
 *
 * Reads load the version they need; local graphs are small. Writes go
 * through a temporary file and one at a time within a store; there's no
 * locking across processes.
 */
import { DateTime, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect"
import { CandidateNotFound, Conflict, StoreError } from "../graph/Errors.ts"
import { ID } from "../local/Home.ts"
import { type GraphEdits, type Item, MemoryGraph, applyEdits, emptyGraph, items, reaches } from "./Models.ts"
import { type At, MemoryCandidate, MemoryStore, type ProposeOptions } from "./MemoryStore.ts"

const HeadFile = Schema.Struct({ head: Schema.Int, next_candidate: Schema.Int })
const VersionFile = Schema.Struct({ version: Schema.Int, candidate: Schema.NullOr(Schema.String), graph: MemoryGraph })

const decodeHead = Schema.decodeUnknownEffect(Schema.fromJsonString(HeadFile))
const decodeVersion = Schema.decodeUnknownEffect(Schema.fromJsonString(VersionFile))
const decodeCandidate = Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryCandidate))
const encodeVersion = Schema.encodeEffect(VersionFile)
const encodeCandidate = Schema.encodeEffect(MemoryCandidate)

const storeError = (message: string) => (cause: { readonly message: string }) =>
  new StoreError({ message: `${message}: ${cause.message}`, cause })

const pad = (n: number) => String(n).padStart(6, "0")

export const make = Effect.fn("JsonMemoryStore.make")(function*(dir: string, tenant: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const writes = yield* Semaphore.make(1)
  const headFile = path.join(dir, "memory.json")
  const versionFile = (v: number) => path.join(dir, "versions", `${pad(v)}.json`)
  const candidateFile = (id: string) => path.join(dir, "candidates", `${id}.json`)

  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false))
  const read = <A>(file: string, decode: (text: string) => Effect.Effect<A, Schema.SchemaError>) =>
    fs.readFileString(file).pipe(Effect.flatMap(decode), Effect.mapError(storeError(`can't read ${file}`)))
  const write = (file: string, text: string) =>
    fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(`${file}.tmp`, text)),
      Effect.andThen(fs.rename(`${file}.tmp`, file)),
      Effect.mapError(storeError(`can't write ${file}`))
    )
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"

  // Version 0 is the empty graph.
  if (!(yield* exists(headFile))) {
    const v0 = yield* encodeVersion({ version: 0, candidate: null, graph: emptyGraph }).pipe(Effect.mapError(storeError("can't encode")))
    yield* write(versionFile(0), json(v0))
    yield* write(headFile, json({ head: 0, next_candidate: 1 }))
  }

  const readHead = () => read(headFile, decodeHead)

  const loadVersion = Effect.fnUntraced(function*(version: number) {
    const file = versionFile(version)
    if (!(yield* exists(file))) return yield* new StoreError({ message: `no memory version ${version}` })
    return (yield* read(file, decodeVersion)).graph
  })

  const getCandidate = Effect.fnUntraced(function*(id: string) {
    const file = candidateFile(id)
    if (!ID.test(id) || !(yield* exists(file))) return yield* new CandidateNotFound({ graphId: "memory", candidateId: id })
    return yield* read(file, decodeCandidate)
  })

  const graph = Effect.fn("JsonMemoryStore.graph")(function*(at?: At) {
    if (at === undefined) return yield* loadVersion((yield* readHead()).head)
    if (typeof at === "number") return yield* loadVersion(at)
    const c = yield* getCandidate(at)
    return applyEdits(yield* loadVersion(c.base_version), c.edits)
  })

  const head = Effect.fn("JsonMemoryStore.head")(function*() {
    return (yield* readHead()).head
  })

  const kinds = Effect.fn("JsonMemoryStore.kinds")(
    function*(subject: string, options?: { readonly at?: At; readonly tools?: ReadonlySet<string> }) {
      return (yield* graph(options?.at)).kinds.filter((k) => reaches(k.reach, subject, options?.tools))
    }
  )

  const warnings = Effect.fn("JsonMemoryStore.warnings")(
    function*(subject: string, options?: { readonly at?: At; readonly tools?: ReadonlySet<string> }) {
      return (yield* graph(options?.at)).warnings.filter((w) => reaches(w.reach, subject, options?.tools))
    }
  )

  const steps = Effect.fn("JsonMemoryStore.steps")(function*(ids: Iterable<string>, at?: At) {
    const wanted = new Set(ids)
    return (yield* graph(at)).steps.filter((s) => wanted.has(s.id))
  })

  const item = Effect.fn("JsonMemoryStore.item")(function*(id: string, at?: At) {
    return items(yield* graph(at)).find((i): i is Item => i.id === id)
  })

  const propose = Effect.fn("JsonMemoryStore.propose")(
    function*(edits: GraphEdits, options: ProposeOptions) {
      const h = yield* readHead()
      const candidate: MemoryCandidate = {
        id: `c${pad(h.next_candidate)}`,
        base_version: options.baseVersion ?? h.head,
        edits,
        rationale: options.rationale,
        records: [...options.records],
        replay: options.replay ?? null,
        status: "pending",
        reason: "",
        committed_version: null,
        created_at: DateTime.formatIso(yield* DateTime.now)
      }
      yield* write(headFile, json({ ...h, next_candidate: h.next_candidate + 1 }))
      const encoded = yield* encodeCandidate(candidate).pipe(Effect.mapError(storeError("can't encode candidate")))
      yield* write(candidateFile(candidate.id), json(encoded))
      return candidate
    },
    writes.withPermits(1)
  )

  const pending = Effect.fnUntraced(function*(id: string) {
    const c = yield* getCandidate(id)
    if (c.status !== "pending") return yield* new Conflict({ message: `candidate ${id} is already ${c.status}` })
    return c
  })

  const saveCandidate = (c: MemoryCandidate) =>
    encodeCandidate(c).pipe(Effect.mapError(storeError("can't encode candidate")), Effect.flatMap((e) => write(candidateFile(c.id), json(e))))

  const commit = Effect.fn("JsonMemoryStore.commit")(
    function*(id: string) {
      const c = yield* pending(id)
      const h = yield* readHead()
      if (c.base_version !== h.head) {
        return yield* new Conflict({ message: `candidate ${id} is based on version ${c.base_version}, but the head is ${h.head}` })
      }
      const version = h.head + 1
      const next = applyEdits(yield* loadVersion(h.head), c.edits)
      const encoded = yield* encodeVersion({ version, candidate: id, graph: next }).pipe(Effect.mapError(storeError("can't encode")))
      yield* write(versionFile(version), json(encoded))
      yield* saveCandidate({ ...c, status: "committed", committed_version: version })
      yield* write(headFile, json({ ...(yield* readHead()), head: version }))
      return version
    },
    writes.withPermits(1)
  )

  const reject = Effect.fn("JsonMemoryStore.reject")(
    function*(id: string, reason: string) {
      const c = yield* pending(id)
      yield* saveCandidate({ ...c, status: "rejected", reason })
    },
    writes.withPermits(1)
  )

  const candidates = Effect.fn("JsonMemoryStore.candidates")(function*(status?: MemoryCandidate["status"]) {
    const d = path.join(dir, "candidates")
    if (!(yield* exists(d))) return [] as ReadonlyArray<MemoryCandidate>
    const names = (yield* fs.readDirectory(d).pipe(Effect.mapError(storeError(`can't list ${d}`)))).filter((n) => n.endsWith(".json")).sort()
    const all = yield* Effect.forEach(names, (n) => read(path.join(d, n), decodeCandidate))
    return status === undefined ? all : all.filter((c) => c.status === status)
  })

  return MemoryStore.of({ tenant, head, graph, kinds, warnings, steps, item, propose, commit, reject, candidates })
})

/** A MemoryStore for `tenant`, keeping its graph under `dir` (created if missing). */
export const layer = (dir: string, tenant: string): Layer.Layer<MemoryStore, StoreError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(MemoryStore, make(dir, tenant))
