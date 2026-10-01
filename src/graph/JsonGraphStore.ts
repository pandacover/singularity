/**
 * GraphStore backed by JSON files, in the Python version's format.
 *
 * Layout, one directory per graph:
 *
 *     <root>/<graph_id>/graph.json              id, description, head version
 *     <root>/<graph_id>/versions/000003.json    full snapshot of each committed version
 *     <root>/<graph_id>/candidates/c000007.json one file per proposed candidate
 *
 * Reads load the snapshot they need; graphs are small enough that this is cheap.
 * Writes are atomic per file, and one store makes them one operation at a time,
 * but there is no locking across processes, so two processes committing to the
 * same graph at the same moment can race.
 */
import { DateTime, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect"
import { CandidateNotFound, Conflict, GraphExists, GraphNotFound, InvalidEdit, StoreError } from "./Errors.ts"
import { type At, GraphStore, type NeighborhoodOptions, type ProposeOptions, type ReadOptions, type ScoreOptions } from "./GraphStore.ts"
import { Candidate, type CandidateStatus, type EditSet, Graph, GraphInfo, GraphJson, type Node } from "./Models.ts"
import * as Ops from "./Ops.ts"
import { compareCodePoints, formatJson, isoformat, repr, zeroPad6 } from "./PythonCompat.ts"

/** Graph and candidate ids, which are also directory and file names. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** graph.json */
const GraphFile = Schema.Struct({
  graph_id: Schema.String,
  description: Schema.String,
  head: Schema.Int,
  next_candidate: Schema.Int
})
type GraphFile = typeof GraphFile.Type

/** versions/000003.json */
const VersionFile = Schema.Struct({
  version: Schema.Int,
  candidate_id: Schema.NullOr(Schema.String),
  score: Schema.NullOr(Schema.Finite),
  graph: GraphJson
})

const decodeGraphFile = Schema.decodeUnknownEffect(Schema.fromJsonString(GraphFile))
const decodeVersionFile = Schema.decodeUnknownEffect(Schema.fromJsonString(VersionFile))
const decodeCandidate = Schema.decodeUnknownEffect(Schema.fromJsonString(Candidate))
const encodeGraphFile = Schema.encodeEffect(GraphFile)
const encodeVersionFile = Schema.encodeEffect(VersionFile)
const encodeCandidate = Schema.encodeEffect(Candidate)

/** Python wrote scores as floats and each edge's facts sorted by repo. */
const JSON_FIELDS = { floats: new Set(["score"]), sorted: new Set(["facts"]) }

const storeError = (message: string) => (cause: { readonly message: string }) =>
  new StoreError({ message: `${message}: ${cause.message}`, cause })

/** Python wrote any score; JSON (and so the TypeScript reader) only has finite numbers. */
const checkScore = (score: number | undefined) =>
  score === undefined || Number.isFinite(score)
    ? Effect.succeed(score ?? null)
    : Effect.fail(new StoreError({ message: `score must be a finite number, got ${score}` }))

export const make = Effect.fn("JsonGraphStore.make")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  // One write operation at a time, as in the single-threaded Python version.
  const writes = yield* Semaphore.make(1)

  yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.mapError(storeError(`can't create ${root}`)))

  const infoPath = (graphId: string) => path.join(root, graphId, "graph.json")
  const versionPath = (graphId: string, version: number) =>
    path.join(root, graphId, "versions", `${zeroPad6(version)}.json`)
  const candidatePath = (graphId: string, candidateId: string) =>
    path.join(root, graphId, "candidates", `${candidateId}.json`)

  // Like Python's Path.exists() and Path.is_file(), which return False on any error.
  const exists = (file: string) => fs.stat(file).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
  const isFile = (file: string) =>
    fs.stat(file).pipe(Effect.map((info) => info.type === "File"), Effect.orElseSucceed(() => false))

  const read = <A>(file: string, decode: (text: string) => Effect.Effect<A, Schema.SchemaError>) =>
    fs.readFileString(file).pipe(Effect.flatMap(decode), Effect.mapError(storeError(`can't read ${file}`)))

  /** Writes to a temporary file, then renames it over `file`. */
  const write = (file: string, json: Effect.Effect<unknown, Schema.SchemaError>) =>
    json.pipe(
      Effect.flatMap((value) => fs.writeFileString(`${file}.tmp`, formatJson(value, JSON_FIELDS))),
      Effect.andThen(fs.rename(`${file}.tmp`, file)),
      Effect.mapError(storeError(`can't write ${file}`))
    )

  const readInfo = Effect.fnUntraced(function*(graphId: string) {
    const file = infoPath(graphId)
    if (!ID.test(graphId) || !(yield* isFile(file))) return yield* new GraphNotFound({ graphId })
    return yield* read(file, decodeGraphFile)
  })

  const writeInfo = (graphId: string, info: GraphFile) => write(infoPath(graphId), encodeGraphFile(info))

  const loadVersion = Effect.fnUntraced(function*(graphId: string, version: number) {
    yield* readInfo(graphId)
    const file = versionPath(graphId, version)
    if (!(yield* isFile(file))) return yield* new StoreError({ message: `${graphId} has no version ${version}` })
    return (yield* read(file, decodeVersionFile)).graph
  })

  const writeVersion = (
    graphId: string,
    version: number,
    graph: Graph,
    candidateId: string | null,
    score: number | null
  ) => write(versionPath(graphId, version), encodeVersionFile({ version, candidate_id: candidateId, score, graph }))

  const writeCandidate = (candidate: Candidate) =>
    write(candidatePath(candidate.graph_id, candidate.id), encodeCandidate(candidate))

  const getCandidate = Effect.fn("JsonGraphStore.getCandidate")(function*(graphId: string, candidateId: string) {
    yield* readInfo(graphId)
    const file = candidatePath(graphId, candidateId)
    if (!ID.test(candidateId) || !(yield* isFile(file))) {
      return yield* new CandidateNotFound({ graphId, candidateId })
    }
    return yield* read(file, decodeCandidate)
  })

  /** The graph a read sees. */
  const resolve = Effect.fnUntraced(function*(graphId: string, at: At) {
    if (at === undefined) return yield* loadVersion(graphId, (yield* readInfo(graphId)).head)
    if (typeof at === "number") return yield* loadVersion(graphId, at)
    const candidate = yield* getCandidate(graphId, at)
    return yield* Effect.fromResult(Ops.applyEdits(yield* loadVersion(graphId, candidate.base_version), candidate.edits))
  })

  const pending = Effect.fnUntraced(function*(graphId: string, candidateId: string) {
    const candidate = yield* getCandidate(graphId, candidateId)
    if (candidate.status !== "pending") {
      return yield* new Conflict({ message: `candidate ${candidateId} is already ${candidate.status}` })
    }
    return candidate
  })

  // --- graphs ---

  const createGraph = Effect.fn("JsonGraphStore.createGraph")(function*(graphId: string, description = "") {
    if (!ID.test(graphId)) return yield* new StoreError({ message: `invalid graph id ${repr(graphId)}` })
    const dir = path.join(root, graphId)
    if (yield* exists(dir)) return yield* new GraphExists({ graphId })
    yield* fs.makeDirectory(path.join(dir, "versions"), { recursive: true }).pipe(
      Effect.andThen(fs.makeDirectory(path.join(dir, "candidates"))),
      Effect.mapError(storeError(`can't create ${dir}`))
    )
    yield* writeVersion(graphId, 0, Graph.fromArrays([], []), null, null)
    yield* writeInfo(graphId, { graph_id: graphId, description, head: 0, next_candidate: 1 })
    return new GraphInfo({ graph_id: graphId, description, head: 0 })
  }, writes.withPermits(1))

  const listGraphs = Effect.fn("JsonGraphStore.listGraphs")(function*() {
    const names = yield* fs.readDirectory(root).pipe(Effect.mapError(storeError(`can't list ${root}`)))
    const infos: Array<GraphInfo> = []
    for (const name of names.sort(compareCodePoints)) {
      // Python failed with GraphNotFound on a directory whose name isn't a graph id.
      if (!ID.test(name) || !(yield* isFile(infoPath(name)))) continue
      const { description, graph_id, head } = yield* read(infoPath(name), decodeGraphFile)
      infos.push(new GraphInfo({ graph_id, description, head }))
    }
    return infos
  })

  const head = Effect.fn("JsonGraphStore.head")(function*(graphId: string) {
    return (yield* readInfo(graphId)).head
  })

  // --- reads ---

  const getNodes = Effect.fn("JsonGraphStore.getNodes")(
    function*(graphId: string, nodeIds: Iterable<string>, options?: ReadOptions) {
      const graph = yield* resolve(graphId, options?.at)
      const found = new Map<string, Node>()
      for (const id of nodeIds) {
        const node = graph.nodes.get(id)
        if (node !== undefined) found.set(id, node)
      }
      return found
    }
  )

  const matchNodes = Effect.fn("JsonGraphStore.matchNodes")(
    function*(graphId: string, command: string, options?: ReadOptions) {
      return Ops.matchNodes(yield* resolve(graphId, options?.at), command)
    }
  )

  const neighborhood = Effect.fn("JsonGraphStore.neighborhood")(
    function*(graphId: string, nodeIds: Iterable<string>, options?: NeighborhoodOptions) {
      const graph = yield* resolve(graphId, options?.at)
      return yield* Effect.fromResult(Ops.neighborhood(graph, nodeIds, options?.hops, options?.direction))
    }
  )

  const snapshot = Effect.fn("JsonGraphStore.snapshot")(function*(graphId: string, options?: ReadOptions) {
    return yield* resolve(graphId, options?.at)
  })

  // --- evolution ---

  const propose = Effect.fn("JsonGraphStore.propose")(
    function*(graphId: string, edits: EditSet, options?: ProposeOptions) {
      const info = yield* readInfo(graphId)
      const base = options?.baseVersion ?? info.head
      if (edits.isEmpty()) return yield* new InvalidEdit({ errors: ["edit set is empty"] })
      // Validate only.
      yield* Effect.fromResult(Ops.applyEdits(yield* loadVersion(graphId, base), edits))

      const candidate = new Candidate({
        id: `c${zeroPad6(info.next_candidate)}`,
        graph_id: graphId,
        base_version: base,
        edits,
        rationale: options?.rationale ?? "",
        created_at: isoformat(DateTime.formatIso(yield* DateTime.now))
      })
      yield* writeInfo(graphId, { ...info, next_candidate: info.next_candidate + 1 })
      yield* writeCandidate(candidate)
      return candidate
    },
    writes.withPermits(1)
  )

  const commit = Effect.fn("JsonGraphStore.commit")(
    function*(graphId: string, candidateId: string, options?: ScoreOptions) {
      const score = yield* checkScore(options?.score)
      const candidate = yield* pending(graphId, candidateId)
      const info = yield* readInfo(graphId)
      if (candidate.base_version !== info.head) {
        return yield* new Conflict({
          message: `candidate ${candidateId} is based on version ${candidate.base_version}, but head is ${info.head}`
        })
      }
      const graph = yield* Effect.fromResult(Ops.applyEdits(yield* loadVersion(graphId, info.head), candidate.edits))
      const version = info.head + 1
      yield* writeVersion(graphId, version, graph, candidateId, score)
      yield* writeCandidate(new Candidate({ ...candidate, status: "committed", score, committed_version: version }))
      const latest = yield* readInfo(graphId)
      yield* writeInfo(graphId, { ...latest, head: version })
      return version
    },
    writes.withPermits(1)
  )

  const reject = Effect.fn("JsonGraphStore.reject")(
    function*(graphId: string, candidateId: string, reason: string, options?: ScoreOptions) {
      const score = yield* checkScore(options?.score)
      const candidate = yield* pending(graphId, candidateId)
      yield* writeCandidate(new Candidate({ ...candidate, status: "rejected", reason, score }))
    },
    writes.withPermits(1)
  )

  const candidates = Effect.fn("JsonGraphStore.candidates")(function*(graphId: string, status?: CandidateStatus) {
    yield* readInfo(graphId)
    const dir = path.join(root, graphId, "candidates")
    const names = yield* fs.readDirectory(dir).pipe(
      // Python's glob() finds nothing in a missing directory.
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed<Array<string>>([]) : Effect.fail(error)),
      Effect.mapError(storeError(`can't list ${dir}`))
    )
    const files = names.filter((name) => name.endsWith(".json")).sort(compareCodePoints)
    const found = yield* Effect.forEach(files, (name) => read(path.join(dir, name), decodeCandidate))
    return status === undefined ? found : found.filter((candidate) => candidate.status === status)
  })

  const diff = Effect.fn("JsonGraphStore.diff")(function*(graphId: string, fromVersion: number, toVersion: number) {
    return Ops.diff(yield* loadVersion(graphId, fromVersion), yield* loadVersion(graphId, toVersion))
  })

  return GraphStore.of({
    createGraph,
    listGraphs,
    head,
    getNodes,
    matchNodes,
    neighborhood,
    snapshot,
    propose,
    commit,
    reject,
    getCandidate,
    candidates,
    diff
  })
})

/** A GraphStore that keeps graphs in JSON files under `root`, which is created if missing. */
export const layer = (root: string): Layer.Layer<GraphStore, StoreError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(GraphStore, make(root))
