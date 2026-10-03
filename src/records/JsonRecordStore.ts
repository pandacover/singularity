/**
 * RecordStore backed by JSON files, one tenant per directory:
 *
 *     <dir>/subjects.json                 { "subjects": [...] }
 *     <dir>/records/<subject>/<id>.json   one record per file
 *
 * Queries read the files they need; local stores hold hundreds of records, so
 * this is cheap. Writes go to a temporary file first and are renamed into
 * place. One store makes them one at a time; there's no locking across
 * processes, so two processes writing the same record at once can race (a
 * hook and a CLI command recording the same session, say).
 */
import { DateTime, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect"
import { Conflict, StoreError } from "../graph/Errors.ts"
import type { RepoIdentity } from "../local/Git.ts"
import { ID } from "../local/Home.ts"
import { RecordExists, RecordNotFound } from "./Errors.ts"
import { exactKeys } from "./Keys.ts"
import { type MemoryUse, type ModelPart, WorkflowRecord } from "./Models.ts"
import { type RecordQuery, RecordStore } from "./RecordStore.ts"
import { extendSubject, matchSubject, type Subject, subjectId, SubjectsFile } from "./Subjects.ts"

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRecord))
const decodeSubjects = Schema.decodeUnknownEffect(Schema.fromJsonString(SubjectsFile))
const encodeRecord = Schema.encodeEffect(WorkflowRecord)

const storeError = (message: string) => (cause: { readonly message: string }) =>
  new StoreError({ message: `${message}: ${cause.message}`, cause })

const lower = (s: string) => s.trim().toLowerCase()

export const matches = (r: WorkflowRecord, q: RecordQuery): boolean => {
  if (q.subject !== undefined && r.subject !== q.subject) return false
  if (q.outcome !== undefined && r.run.outcome !== q.outcome) return false
  if (q.source !== undefined && r.run.source !== q.source) return false
  if (q.annotated !== undefined && (r.model !== null) !== q.annotated) return false
  if (q.kind !== undefined && (r.model === null || lower(r.model.kind.name) !== lower(q.kind))) return false
  if (q.step !== undefined && !(r.model?.steps ?? []).some((s) => lower(s.name) === lower(q.step!))) return false
  if (q.key !== undefined && !exactKeys(r).some((k) => k.value.includes(q.key!))) return false
  return true
}

export const make = Effect.fn("JsonRecordStore.make")(function*(dir: string, tenant: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const writes = yield* Semaphore.make(1)
  const recordsDir = path.join(dir, "records")
  const subjectsFile = path.join(dir, "subjects.json")

  yield* fs.makeDirectory(recordsDir, { recursive: true }).pipe(Effect.mapError(storeError(`can't create ${recordsDir}`)))

  const isFile = (file: string) =>
    fs.stat(file).pipe(Effect.map((info) => info.type === "File"), Effect.orElseSucceed(() => false))

  const write = (file: string, text: string) =>
    fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(`${file}.tmp`, text)),
      Effect.andThen(fs.rename(`${file}.tmp`, file)),
      Effect.mapError(storeError(`can't write ${file}`))
    )

  const readSubjects = Effect.fnUntraced(function*() {
    if (!(yield* isFile(subjectsFile))) return [] as ReadonlyArray<Subject>
    const text = yield* fs.readFileString(subjectsFile).pipe(Effect.mapError(storeError(`can't read ${subjectsFile}`)))
    return (yield* decodeSubjects(text).pipe(Effect.mapError(storeError(`can't read ${subjectsFile}`)))).subjects
  })

  const writeSubjects = (subjects: ReadonlyArray<Subject>) =>
    write(subjectsFile, JSON.stringify({ subjects }, null, 2) + "\n")

  const subjects = Effect.fn("JsonRecordStore.subjects")(function*() {
    return yield* readSubjects()
  })

  const subjectFor = Effect.fn("JsonRecordStore.subjectFor")(
    function*(repo: RepoIdentity, options?: { readonly create?: boolean }) {
      const all = yield* readSubjects()
      const found = matchSubject(all, repo)
      if (found !== undefined) {
        const extended = extendSubject(found, repo)
        if (extended === undefined) return found
        yield* writeSubjects(all.map((s) => (s.id === found.id ? extended : s)))
        return extended
      }
      if (options?.create !== true) return undefined
      const id = subjectId(all, repo)
      const subject: Subject = {
        id,
        name: id,
        root_commits: [...repo.rootCommits],
        remotes: [...repo.remotes],
        paths: [repo.root],
        created_at: DateTime.formatIso(yield* DateTime.now)
      }
      yield* writeSubjects([...all, subject])
      return subject
    },
    writes.withPermits(1)
  )

  const subjectDirs = Effect.fnUntraced(function*(subject?: string) {
    if (subject !== undefined) return ID.test(subject) ? [path.join(recordsDir, subject)] : []
    const names = yield* fs.readDirectory(recordsDir).pipe(Effect.mapError(storeError(`can't list ${recordsDir}`)))
    return names.filter((n) => ID.test(n)).sort().map((n) => path.join(recordsDir, n))
  })

  /** The file of record `id`, if it exists. */
  const locate = Effect.fnUntraced(function*(id: string) {
    if (!ID.test(id)) return undefined
    for (const d of yield* subjectDirs()) {
      const file = path.join(d, `${id}.json`)
      if (yield* isFile(file)) return file
    }
    return undefined
  })

  const readRecord = (file: string) =>
    fs.readFileString(file).pipe(Effect.flatMap(decodeRecord), Effect.mapError(storeError(`can't read ${file}`)))

  const writeRecord = Effect.fnUntraced(function*(file: string, record: WorkflowRecord) {
    const encoded = yield* encodeRecord(record).pipe(Effect.mapError(storeError(`can't encode record ${record.id}`)))
    yield* write(file, JSON.stringify(encoded, null, 2) + "\n")
  })

  const put = Effect.fn("JsonRecordStore.put")(
    function*(record: WorkflowRecord) {
      if (!ID.test(record.id) || !ID.test(record.subject)) {
        return yield* new StoreError({ message: `invalid record or subject id: ${record.id}, ${record.subject}` })
      }
      if (record.tenant !== tenant) {
        return yield* new StoreError({ message: `record ${record.id} belongs to tenant ${record.tenant}, not ${tenant}` })
      }
      if ((yield* locate(record.id)) !== undefined) return yield* new RecordExists({ id: record.id })
      yield* writeRecord(path.join(recordsDir, record.subject, `${record.id}.json`), record)
    },
    writes.withPermits(1)
  )

  const get = Effect.fn("JsonRecordStore.get")(function*(id: string) {
    const file = yield* locate(id)
    if (file === undefined) return yield* new RecordNotFound({ id })
    return yield* readRecord(file)
  })

  const has = Effect.fn("JsonRecordStore.has")(function*(id: string) {
    return (yield* locate(id)) !== undefined
  })

  const find = Effect.fn("JsonRecordStore.find")(function*(query: RecordQuery = {}) {
    const found: Array<WorkflowRecord> = []
    for (const d of yield* subjectDirs(query.subject)) {
      const names = yield* fs.readDirectory(d).pipe(
        Effect.catchTag("PlatformError", (e) => (e.reason._tag === "NotFound" ? Effect.succeed<Array<string>>([]) : Effect.fail(e))),
        Effect.mapError(storeError(`can't list ${d}`))
      )
      for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
        const record = yield* readRecord(path.join(d, name))
        if (matches(record, query)) found.push(record)
      }
    }
    return found.sort((a, b) =>
      (a.run.started_at ?? a.created_at).localeCompare(b.run.started_at ?? b.created_at) || a.id.localeCompare(b.id)
    )
  })

  const update = <E>(id: string, change: (r: WorkflowRecord) => Effect.Effect<WorkflowRecord, E>) =>
    Effect.gen(function*() {
      const file = yield* locate(id)
      if (file === undefined) return yield* new RecordNotFound({ id })
      const updated = yield* change(yield* readRecord(file))
      yield* writeRecord(file, updated)
      return updated
    }).pipe(writes.withPermits(1))

  const annotate = Effect.fn("JsonRecordStore.annotate")(
    function*(id: string, model: ModelPart, options?: { readonly replace?: boolean }) {
      return yield* update(id, (r) =>
        r.model !== null && options?.replace !== true
          ? Effect.fail(new Conflict({ message: `record ${id} already has the model's reading` }))
          : Effect.succeed({ ...r, model }))
    }
  )

  const addFeedback = Effect.fn("JsonRecordStore.addFeedback")(function*(id: string, memory: MemoryUse) {
    return yield* update(id, (r) =>
      Effect.succeed({
        ...r,
        memory: r.memory === null ? memory : { ...r.memory, items: [...r.memory.items, ...memory.items] }
      }))
  })

  return RecordStore.of({ tenant, subjects, subjectFor, put, get, has, find, annotate, addFeedback })
})

/** A RecordStore for `tenant`, keeping its records under `dir` (created if missing). */
export const layer = (dir: string, tenant: string): Layer.Layer<RecordStore, StoreError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(RecordStore, make(dir, tenant))
