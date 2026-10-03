/**
 * WorkflowStore backed by JSON files:
 *
 *     <dir>/workflows.json              { head, next_candidate }
 *     <dir>/versions/000003.json        each committed version, in full
 *     <dir>/candidates/c000004.json     each proposal: its memory, what checked it, its status
 *
 * Writes go through a temporary file and one at a time within a store; there's
 * no locking across processes.
 */
import { DateTime, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect"
import { CandidateNotFound, Conflict, StoreError } from "../graph/Errors.ts"
import { ID } from "../local/Home.ts"
import { emptyMemory, WorkflowMemory } from "./Models.ts"
import { type At, type ProposeOptions, WorkflowCandidate, WorkflowStore } from "./WorkflowStore.ts"

const HeadFile = Schema.Struct({ head: Schema.Int, next_candidate: Schema.Int })
const VersionFile = Schema.Struct({ version: Schema.Int, candidate: Schema.NullOr(Schema.String), memory: WorkflowMemory })

const decodeHead = Schema.decodeUnknownEffect(Schema.fromJsonString(HeadFile))
const decodeVersion = Schema.decodeUnknownEffect(Schema.fromJsonString(VersionFile))
const decodeCandidate = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowCandidate))
const encodeVersion = Schema.encodeEffect(VersionFile)
const encodeCandidate = Schema.encodeEffect(WorkflowCandidate)

const storeError = (message: string) => (cause: { readonly message: string }) =>
  new StoreError({ message: `${message}: ${cause.message}`, cause })

const pad = (n: number) => String(n).padStart(6, "0")

export const make = Effect.fn("JsonWorkflowStore.make")(function*(dir: string, tenant: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const writes = yield* Semaphore.make(1)
  const headFile = path.join(dir, "workflows.json")
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

  // Version 0 is the empty memory.
  if (!(yield* exists(headFile))) {
    const v0 = yield* encodeVersion({ version: 0, candidate: null, memory: emptyMemory(tenant) }).pipe(Effect.mapError(storeError("can't encode")))
    yield* write(versionFile(0), json(v0))
    yield* write(headFile, json({ head: 0, next_candidate: 1 }))
  }

  const readHead = () => read(headFile, decodeHead)

  const loadVersion = Effect.fnUntraced(function*(version: number) {
    const file = versionFile(version)
    if (!(yield* exists(file))) return yield* new StoreError({ message: `no workflow memory version ${version}` })
    return (yield* read(file, decodeVersion)).memory
  })

  const getCandidate = Effect.fnUntraced(function*(id: string) {
    const file = candidateFile(id)
    if (!ID.test(id) || !(yield* exists(file))) return yield* new CandidateNotFound({ graphId: "workflows", candidateId: id })
    return yield* read(file, decodeCandidate)
  })

  const memory = Effect.fn("JsonWorkflowStore.memory")(function*(at?: At) {
    if (at === undefined) return yield* loadVersion((yield* readHead()).head)
    if (typeof at === "number") return yield* loadVersion(at)
    return (yield* getCandidate(at)).memory
  })

  const head = Effect.fn("JsonWorkflowStore.head")(function*() {
    return (yield* readHead()).head
  })

  const saveCandidate = (c: WorkflowCandidate) =>
    encodeCandidate(c).pipe(Effect.mapError(storeError("can't encode candidate")), Effect.flatMap((e) => write(candidateFile(c.id), json(e))))

  const propose = Effect.fn("JsonWorkflowStore.propose")(
    function*(proposed: WorkflowMemory, options: ProposeOptions) {
      const h = yield* readHead()
      const candidate: WorkflowCandidate = {
        id: `c${pad(h.next_candidate)}`,
        base_version: options.baseVersion ?? h.head,
        memory: proposed,
        rationale: options.rationale,
        records: [...options.records],
        model: options.model ?? null,
        cost_usd: options.costUsd ?? null,
        report: options.report ?? null,
        status: "pending",
        reason: "",
        committed_version: null,
        created_at: DateTime.formatIso(yield* DateTime.now)
      }
      yield* write(headFile, json({ ...h, next_candidate: h.next_candidate + 1 }))
      yield* saveCandidate(candidate)
      return candidate
    },
    writes.withPermits(1)
  )

  const pending = Effect.fnUntraced(function*(id: string) {
    const c = yield* getCandidate(id)
    if (c.status !== "pending") return yield* new Conflict({ message: `candidate ${id} is already ${c.status}` })
    return c
  })

  const commit = Effect.fn("JsonWorkflowStore.commit")(
    function*(id: string) {
      const c = yield* pending(id)
      const h = yield* readHead()
      if (c.base_version !== h.head) {
        return yield* new Conflict({ message: `candidate ${id} is based on version ${c.base_version}, but the head is ${h.head}` })
      }
      const version = h.head + 1
      const encoded = yield* encodeVersion({ version, candidate: id, memory: c.memory }).pipe(Effect.mapError(storeError("can't encode")))
      yield* write(versionFile(version), json(encoded))
      yield* saveCandidate({ ...c, status: "committed", committed_version: version })
      yield* write(headFile, json({ ...(yield* readHead()), head: version }))
      return version
    },
    writes.withPermits(1)
  )

  const reject = Effect.fn("JsonWorkflowStore.reject")(
    function*(id: string, reason: string) {
      const c = yield* pending(id)
      yield* saveCandidate({ ...c, status: "rejected", reason })
    },
    writes.withPermits(1)
  )

  const candidates = Effect.fn("JsonWorkflowStore.candidates")(function*(status?: WorkflowCandidate["status"]) {
    const d = path.join(dir, "candidates")
    if (!(yield* exists(d))) return [] as ReadonlyArray<WorkflowCandidate>
    const names = (yield* fs.readDirectory(d).pipe(Effect.mapError(storeError(`can't list ${d}`)))).filter((n) => n.endsWith(".json")).sort()
    const all = yield* Effect.forEach(names, (n) => read(path.join(d, n), decodeCandidate))
    return status === undefined ? all : all.filter((c) => c.status === status)
  })

  return WorkflowStore.of({ tenant, head, memory, propose, commit, reject, candidates })
})

/** A WorkflowStore for `tenant`, keeping its memory under `dir` (created if missing). */
export const layer = (dir: string, tenant: string): Layer.Layer<WorkflowStore, StoreError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(WorkflowStore, make(dir, tenant))

/** Where a home's tenant keeps memory v1. */
export const workflowsDir = (tenantDir: string, path: Path.Path): string => path.join(tenantDir, "workflows")
