/**
 * Contract tests for GraphStore, plus compatibility with the Python version's files.
 *
 * Every backend in `backends` runs the contract tests against a fresh, empty
 * store per test. To test another backend (a graph database), add it there.
 */
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Equal, FileSystem, Layer, Path, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
  Candidate,
  Conflict,
  Edge,
  EdgeFacts,
  edgeKey,
  EditSet,
  type Graph,
  GraphExists,
  GraphInfo,
  GraphJson,
  GraphNotFound,
  GraphStore,
  type GraphStoreError,
  InvalidEdit,
  JsonGraphStore,
  Node,
  NodeNotFound
} from "../../src/graph/index.ts"

interface Backend {
  readonly name: string
  /** Builds a new, empty store each time it is provided. */
  readonly layer: Layer.Layer<GraphStore, unknown>
}

const jsonInTempDir = Layer.unwrap(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "graph-store-" })
    return JsonGraphStore.layer(path.join(dir, "graphs"))
  })
).pipe(Layer.provide(NodeServices.layer))

const backends: ReadonlyArray<Backend> = [{ name: "json", layer: jsonInTempDir }]

/** start -> find_config -> run_tests -> end */
const chainEdits = () =>
  new EditSet({
    add_nodes: [
      new Node({ id: "start", type: "start", description: "Task begins" }),
      new Node({
        id: "find_config",
        type: "action",
        description: "Find the config file",
        command_patterns: [String.raw`\b(rg|grep|find)\b.*config`]
      }),
      new Node({
        id: "run_tests",
        type: "action",
        description: "Run the test suite",
        command_patterns: [String.raw`\b(pytest|yarn test|npm test)\b`]
      }),
      new Node({ id: "end", type: "end", description: "Task done" })
    ],
    add_edges: [
      new Edge({ source: "start", target: "find_config", guidance: "Locate config before editing" }),
      new Edge({
        source: "find_config",
        target: "run_tests",
        condition: "Config change made",
        pitfalls: "Don't run the full suite first",
        facts: {
          excalidraw: new EdgeFacts({
            commands: ["yarn test:app --watch=false"],
            dead_ends: ["jest.config.js does not exist"]
          })
        }
      }),
      new Edge({ source: "run_tests", target: "end" })
    ]
  })

const seeded = Effect.gen(function*() {
  const store = yield* GraphStore
  yield* store.createGraph("g", "test graph")
  const candidate = yield* store.propose("g", chainEdits())
  yield* store.commit("g", candidate.id, { score: 1.0 })
  return store
})

const nodeIds = (graph: Graph) => new Set(graph.nodes.keys())

for (const backend of backends) {
  describe(`GraphStore contract (${backend.name})`, () => {
    const test = (name: string, body: Effect.Effect<void, unknown, GraphStore>) =>
      it.effect(name, () => body.pipe(Effect.provide(backend.layer)))

    test(
      "create and list",
      Effect.gen(function*() {
        const store = yield* GraphStore
        const info = yield* store.createGraph("g", "desc")
        assert.deepStrictEqual([info.graph_id, info.head], ["g", 0])
        assert.deepStrictEqual((yield* store.listGraphs()).map((i) => i.graph_id), ["g"])
        assert.strictEqual((yield* store.snapshot("g")).nodes.size, 0)
        assert.instanceOf(yield* Effect.flip(store.createGraph("g")), GraphExists)
        assert.instanceOf(yield* Effect.flip(store.head("missing")), GraphNotFound)
      })
    )

    test(
      "commit round trips all fields",
      Effect.gen(function*() {
        const store = yield* seeded
        assert.strictEqual(yield* store.head("g"), 1)
        const g = yield* store.snapshot("g")
        assert.deepStrictEqual(nodeIds(g), new Set(["start", "find_config", "run_tests", "end"]))
        const edge = g.edges.get(edgeKey("find_config", "run_tests"))
        assert.isDefined(edge)
        assert.deepStrictEqual(edge.facts["excalidraw"]?.commands, ["yarn test:app --watch=false"])
        assert.strictEqual(edge.pitfalls, "Don't run the full suite first")
        assert.strictEqual(g.nodes.get("run_tests")?.type, "action")
      })
    )

    test(
      "neighborhood hops and direction",
      Effect.gen(function*() {
        const store = yield* seeded
        const out2 = yield* store.neighborhood("g", ["start"], { hops: 2 })
        assert.deepStrictEqual(nodeIds(out2), new Set(["start", "find_config", "run_tests"]))
        assert.deepStrictEqual(
          new Set(out2.edges.keys()),
          new Set([edgeKey("start", "find_config"), edgeKey("find_config", "run_tests")])
        )
        assert.deepStrictEqual(nodeIds(yield* store.neighborhood("g", ["end"], { hops: 1 })), new Set(["end"]))
        assert.deepStrictEqual(
          nodeIds(yield* store.neighborhood("g", ["end"], { hops: 1, direction: "in" })),
          new Set(["end", "run_tests"])
        )
        assert.instanceOf(yield* Effect.flip(store.neighborhood("g", ["nope"])), NodeNotFound)
      })
    )

    test(
      "match nodes and get nodes",
      Effect.gen(function*() {
        const store = yield* seeded
        const matched = (command: string) =>
          store.matchNodes("g", command).pipe(Effect.map((nodes) => nodes.map((node) => node.id)))
        assert.deepStrictEqual(yield* matched("yarn test --watch=false"), ["run_tests"])
        assert.deepStrictEqual(yield* matched("rg -n config packages/"), ["find_config"])
        assert.deepStrictEqual(yield* matched("ls"), [])
        assert.deepStrictEqual(new Set((yield* store.getNodes("g", ["start", "missing"])).keys()), new Set(["start"]))
      })
    )

    test(
      "candidate view does not touch head",
      Effect.gen(function*() {
        const store = yield* seeded
        const candidate = yield* store.propose(
          "g",
          new EditSet({
            add_nodes: [new Node({ id: "lint", type: "action", description: "Run linter" })],
            add_edges: [new Edge({ source: "run_tests", target: "lint" })]
          })
        )
        assert.strictEqual(candidate.status, "pending")
        assert.strictEqual(candidate.base_version, 1)
        assert.isTrue((yield* store.snapshot("g", { at: candidate.id })).nodes.has("lint"))
        assert.isTrue((yield* store.neighborhood("g", ["run_tests"], { hops: 1, at: candidate.id })).nodes.has("lint"))
        assert.isFalse((yield* store.snapshot("g")).nodes.has("lint"))
        assert.strictEqual(yield* store.head("g"), 1)
      })
    )

    test(
      "reject keeps rejection memory",
      Effect.gen(function*() {
        const store = yield* seeded
        const candidate = yield* store.propose("g", new EditSet({ delete_nodes: ["find_config"] }), {
          rationale: "seems unused"
        })
        yield* store.reject("g", candidate.id, "validation score dropped 0.8 -> 0.6", { score: 0.6 })
        const rejected = yield* store.candidates("g", "rejected")
        assert.deepStrictEqual(rejected.map((c) => [c.id, c.reason, c.rationale]), [
          [candidate.id, "validation score dropped 0.8 -> 0.6", "seems unused"]
        ])
        assert.isTrue((yield* store.snapshot("g")).nodes.has("find_config"))
        assert.instanceOf(yield* Effect.flip(store.commit("g", candidate.id)), Conflict)
      })
    )

    test(
      "commit conflicts when head moved",
      Effect.gen(function*() {
        const store = yield* seeded
        const state = (id: string) => new EditSet({ add_nodes: [new Node({ id, type: "state", description: id })] })
        const a = yield* store.propose("g", state("a"))
        const b = yield* store.propose("g", state("b"))
        assert.strictEqual(yield* store.commit("g", a.id), 2)
        assert.instanceOf(yield* Effect.flip(store.commit("g", b.id)), Conflict)
        assert.isFalse((yield* store.snapshot("g")).nodes.has("b"))
      })
    )

    // Not in the Python suite: Python calls never overlapped, fibers can.
    test(
      "concurrent proposals get their own candidates",
      Effect.gen(function*() {
        const store = yield* seeded
        const ids = ["a", "b", "c", "d", "e", "f"]
        const proposed = yield* Effect.forEach(
          ids,
          (id) => store.propose("g", new EditSet({ add_nodes: [new Node({ id, type: "state", description: id })] })),
          { concurrency: "unbounded" }
        )
        const pending = yield* store.candidates("g", "pending")
        assert.strictEqual(new Set(proposed.map((c) => c.id)).size, ids.length)
        assert.deepStrictEqual(new Set(pending.map((c) => c.edits.add_nodes[0]?.id)), new Set(ids))
      })
    )

    test(
      "invalid edits are refused",
      Effect.gen(function*() {
        const store = yield* seeded
        const error = yield* Effect.flip(
          store.propose(
            "g",
            new EditSet({ add_edges: [new Edge({ source: "start", target: "ghost" })], delete_nodes: ["nope"] })
          )
        )
        assert.instanceOf(error, InvalidEdit)
        assert.strictEqual(error.errors.length, 2)
        assert.instanceOf(yield* Effect.flip(store.propose("g", new EditSet({}))), InvalidEdit)
        const badPattern = new Node({ id: "bad", type: "action", description: "x", command_patterns: ["(unclosed"] })
        assert.instanceOf(yield* Effect.flip(store.propose("g", new EditSet({ add_nodes: [badPattern] }))), InvalidEdit)
        assert.deepStrictEqual(yield* store.candidates("g", "pending"), [])
      })
    )

    test(
      "delete node removes its edges",
      Effect.gen(function*() {
        const store = yield* seeded
        const candidate = yield* store.propose("g", new EditSet({ delete_nodes: ["find_config"] }))
        yield* store.commit("g", candidate.id)
        assert.deepStrictEqual(new Set((yield* store.snapshot("g")).edges.keys()), new Set([edgeKey("run_tests", "end")]))
      })
    )

    test(
      "add existing replaces attributes",
      Effect.gen(function*() {
        const store = yield* seeded
        const revised = new Edge({ source: "start", target: "find_config", guidance: "Check packages/excalidraw first" })
        const candidate = yield* store.propose("g", new EditSet({ add_edges: [revised] }))
        yield* store.commit("g", candidate.id)
        const edge = (yield* store.snapshot("g")).edges.get(edgeKey("start", "find_config"))
        assert.strictEqual(edge?.guidance, "Check packages/excalidraw first")
      })
    )

    test(
      "diff reproduces history",
      Effect.gen(function*() {
        const store = yield* seeded
        const candidate = yield* store.propose(
          "g",
          new EditSet({
            delete_nodes: ["find_config"],
            add_nodes: [new Node({ id: "lint", type: "action", description: "Run linter" })],
            add_edges: [new Edge({ source: "start", target: "run_tests" }), new Edge({ source: "run_tests", target: "lint" })]
          })
        )
        yield* store.commit("g", candidate.id)
        const d = yield* store.diff("g", 1, 2)
        assert.deepStrictEqual(d.add_nodes.map((node) => node.id), ["lint"])
        assert.deepStrictEqual(d.delete_nodes, ["find_config"])
        assert.deepStrictEqual(d.delete_edges, [
          { source: "find_config", target: "run_tests" },
          { source: "start", target: "find_config" }
        ])

        // Replaying the diff on version 1 gives version 2.
        const replay = yield* store.propose("g", d, { baseVersion: 1 })
        const replayed = yield* store.snapshot("g", { at: replay.id })
        assert.isTrue(Equal.equals(replayed, yield* store.snapshot("g", { at: 2 })))
      })
    )
  })
}

// --- compatibility with the Python version ---
//
// fixtures/make_python_store.py wrote fixtures/python-store with the Python
// JsonGraphStore, and recorded in fixtures/python-results.json what the Python
// store returned for a set of reads and failing calls.

const G = "excalidraw-tasks"

/** `at` in the results file: null for head. */
const AtJson = Schema.NullOr(Schema.Union([Schema.Int, Schema.String]))

const ErrorCall = Schema.Struct({
  op: Schema.String,
  args: Schema.Struct({
    graph_id: Schema.String,
    candidate_id: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.String),
    at: Schema.optionalKey(AtJson),
    node_ids: Schema.optionalKey(Schema.Array(Schema.String)),
    edits: Schema.optionalKey(EditSet),
    base_version: Schema.optionalKey(Schema.Int),
    from_version: Schema.optionalKey(Schema.Int),
    to_version: Schema.optionalKey(Schema.Int)
  }),
  error: Schema.String,
  message: Schema.String
})

/** Expected values stay as the JSON Python wrote; the TypeScript results are encoded to compare with them. */
const PythonResults = Schema.Struct({
  list_graphs: Schema.Unknown,
  head: Schema.Int,
  snapshots: Schema.Record(Schema.String, Schema.Unknown),
  candidate_views: Schema.Record(Schema.String, Schema.Unknown),
  candidates: Schema.Unknown,
  candidate_ids_by_status: Schema.Struct({
    pending: Schema.Array(Schema.String),
    committed: Schema.Array(Schema.String),
    rejected: Schema.Array(Schema.String)
  }),
  neighborhoods: Schema.Array(Schema.Struct({
    node_ids: Schema.Array(Schema.String),
    hops: Schema.Int,
    direction: Schema.Literals(["out", "in", "both"]),
    at: AtJson,
    result: Schema.Unknown
  })),
  match_nodes: Schema.Array(Schema.Struct({ command: Schema.String, at: AtJson, result: Schema.Unknown })),
  get_nodes: Schema.Array(Schema.Struct({ node_ids: Schema.Array(Schema.String), at: AtJson, result: Schema.Unknown })),
  diffs: Schema.Array(Schema.Struct({ from: Schema.Int, to: Schema.Int, result: Schema.Unknown })),
  errors: Schema.Array(ErrorCall)
})

const encodeGraph = Schema.encodeSync(GraphJson)
const encodeNode = Schema.encodeSync(Node)
const encodeCandidate = Schema.encodeSync(Candidate)
const encodeEditSet = Schema.encodeSync(EditSet)
const encodeInfo = Schema.encodeSync(GraphInfo)

const fixturesDir = Effect.gen(function*() {
  const path = yield* Path.Path
  return yield* path.fromFileUrl(new URL("fixtures", import.meta.url))
})

/** Relative paths of the files under `dir`, sorted. */
const listFiles = Effect.fnUntraced(function*(dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files: Array<string> = []
  for (const entry of yield* fs.readDirectory(dir, { recursive: true })) {
    if ((yield* fs.stat(path.join(dir, entry))).type === "File") files.push(entry.replaceAll("\\", "/"))
  }
  return files.sort()
})

/** The two directories hold the same files, byte for byte. */
const assertSameFiles = Effect.fnUntraced(function*(actualDir: string, expectedDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = yield* listFiles(expectedDir)
  assert.deepStrictEqual(yield* listFiles(actualDir), files)
  for (const file of files) {
    const actual = yield* fs.readFile(path.join(actualDir, file))
    const expected = yield* fs.readFile(path.join(expectedDir, file))
    if (!Equal.equals(actual, expected)) {
      // Shows a readable diff first.
      assert.strictEqual(new TextDecoder().decode(actual), new TextDecoder().decode(expected), file)
    }
    assert.isTrue(Equal.equals(actual, expected), `${file} differs byte for byte`)
  }
})

/** The failing call recorded as `op` and `args` by the Python script. */
const callStore = (
  store: GraphStore["Service"],
  { args, op }: typeof ErrorCall.Type
): Effect.Effect<unknown, GraphStoreError> => {
  const id = args.graph_id
  switch (op) {
    case "head":
      return store.head(id)
    case "create_graph":
      return store.createGraph(id)
    case "get_candidate":
      return store.getCandidate(id, args.candidate_id ?? "")
    case "snapshot":
      return store.snapshot(id, { at: args.at ?? undefined })
    case "neighborhood":
      return store.neighborhood(id, args.node_ids ?? [])
    case "commit":
      return store.commit(id, args.candidate_id ?? "")
    case "reject":
      return store.reject(id, args.candidate_id ?? "", args.reason ?? "")
    case "propose":
      return store.propose(id, args.edits ?? new EditSet({}), { baseVersion: args.base_version })
    case "diff":
      return store.diff(id, args.from_version ?? 0, args.to_version ?? 0)
  }
  return Effect.die(`unknown op ${op}`)
}

// Must match build() in fixtures/make_python_store.py: same operations, same times.
const BASE_TIME = Date.UTC(2026, 9, 1, 12)
const OFFSETS_MS = [0, 1250, 61001, 3600000, 3600999, 7200500, 86400000]

const buildFixtureStore = Effect.gen(function*() {
  const store = yield* GraphStore
  let proposals = 0
  const propose = (edits: EditSet, options?: { readonly baseVersion?: number; readonly rationale?: string }) =>
    TestClock.setTime(BASE_TIME + OFFSETS_MS[proposals++]).pipe(Effect.andThen(store.propose(G, edits, options)))

  yield* store.createGraph(G, "Procedures for excalidraw tasks")
  yield* store.createGraph("empty")

  const c1 = yield* propose(
    new EditSet({
      add_nodes: [
        new Node({ id: "start", type: "start", description: "Task begins" }),
        new Node({
          id: "find_config",
          type: "action",
          description: "Find the config file",
          command_patterns: [String.raw`\b(rg|grep|find)\b.*config`]
        }),
        new Node({
          id: "run_tests",
          type: "action",
          description: "Run the test suite",
          command_patterns: [String.raw`\b(pytest|yarn test|npm test)\b`, String.raw`^vitest\s`],
          script: "scripts/run-tests.sh"
        }),
        new Node({
          id: "think",
          type: "reasoning",
          description: "Décider quoi faire — \"quoted\" \\ back\\slash\nnew line\ttab 🚀"
        }),
        new Node({ id: "end", type: "end", description: "Task done" })
      ],
      add_edges: [
        new Edge({ source: "start", target: "find_config", guidance: "Locate config before editing" }),
        new Edge({
          source: "find_config",
          target: "run_tests",
          relation: "triggers",
          condition: "Config change made",
          pitfalls: "Don't run the full suite first",
          facts: {
            excalidraw: new EdgeFacts({
              paths: ["packages/excalidraw/vitest.config.mts"],
              commands: ["yarn test:app --watch=false"],
              dead_ends: ["jest.config.js does not exist"]
            }),
            "9": new EdgeFacts({ paths: ["Makefile"] }),
            "10": new EdgeFacts({ commands: ["make test"] }),
            Zeta: new EdgeFacts({}),
            "-dash": new EdgeFacts({ dead_ends: ["ü"] })
          }
        }),
        new Edge({ source: "find_config", target: "think", relation: "provides_input_for" }),
        new Edge({ source: "think", target: "run_tests", relation: "converges_to" }),
        new Edge({ source: "run_tests", target: "end" })
      ]
    }),
    { rationale: "initial procedure" }
  )
  yield* store.commit(G, c1.id, { score: 1.0 })

  const c2 = yield* propose(new EditSet({ delete_nodes: ["think"] }), { rationale: "seems unused" })
  yield* store.reject(G, c2.id, "validation score dropped 0.8 -> 0.6", { score: 0.6 })

  const c3 = yield* propose(
    new EditSet({
      add_nodes: [
        new Node({ id: "lint", type: "action", description: "Run linter", command_patterns: [String.raw`\b(eslint|yarn lint)\b`] })
      ],
      add_edges: [
        new Edge({ source: "run_tests", target: "lint", guidance: "Lint after tests pass" }),
        new Edge({ source: "lint", target: "end" })
      ],
      delete_edges: [{ source: "run_tests", target: "end" }]
    }),
    { rationale: "lint before finishing" }
  )
  yield* store.commit(G, c3.id, { score: 0.1 + 0.2 })

  yield* propose(new EditSet({ add_nodes: [new Node({ id: "x", type: "state", description: "pending state" })] }), {
    baseVersion: 1,
    rationale: "stale base"
  })

  const c5 = yield* propose(
    new EditSet({ add_edges: [new Edge({ source: "start", target: "run_tests", condition: "Config already known" })] })
  )
  yield* store.reject(G, c5.id, "", { score: 2.5e-05 })

  yield* propose(
    new EditSet({
      add_nodes: [new Node({ id: "start", type: "start", description: "Task begins (revised)" })],
      add_edges: [
        new Edge({
          source: "start",
          target: "find_config",
          guidance: "Check packages/excalidraw first",
          facts: { excalidraw: new EdgeFacts({ paths: ["packages/excalidraw"] }) }
        })
      ]
    }),
    { rationale: "revise start" }
  )

  const c7 = yield* propose(
    new EditSet({ delete_edges: [{ source: "find_config", target: "think" }], delete_nodes: ["think"] })
  )
  yield* store.commit(G, c7.id)
})

describe("JsonGraphStore and the Python version", () => {
  it.effect("reads a store written by the Python version with identical results", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const fixtures = yield* fixturesDir
      const expected = yield* fs.readFileString(path.join(fixtures, "python-results.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PythonResults)))
      )
      // Read a copy, so a bug that writes can't change the fixture.
      const root = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "graph-store-" }), "graphs")
      yield* fs.copy(path.join(fixtures, "python-store"), root)

      yield* Effect.gen(function*() {
        const store = yield* GraphStore
        const at = (value: typeof AtJson.Type) => value ?? undefined

        assert.deepStrictEqual((yield* store.listGraphs()).map((info) => encodeInfo(info)), expected.list_graphs)
        assert.strictEqual(yield* store.head(G), expected.head)
        for (const [version, graph] of Object.entries(expected.snapshots)) {
          assert.deepStrictEqual(encodeGraph(yield* store.snapshot(G, { at: Number(version) })), graph, `version ${version}`)
        }
        assert.deepStrictEqual(encodeGraph(yield* store.snapshot(G)), expected.snapshots[String(expected.head)])
        for (const [id, graph] of Object.entries(expected.candidate_views)) {
          assert.deepStrictEqual(encodeGraph(yield* store.snapshot(G, { at: id })), graph, id)
        }

        const candidates = yield* store.candidates(G)
        assert.deepStrictEqual(candidates.map((c) => encodeCandidate(c)), expected.candidates)
        for (const status of ["pending", "committed", "rejected"] as const) {
          const ids = (yield* store.candidates(G, status)).map((c) => c.id)
          assert.deepStrictEqual(ids, expected.candidate_ids_by_status[status], status)
        }
        for (const c of candidates) {
          assert.deepStrictEqual(encodeCandidate(yield* store.getCandidate(G, c.id)), encodeCandidate(c))
        }

        for (const query of expected.neighborhoods) {
          const { direction, hops, node_ids } = query
          const graph = yield* store.neighborhood(G, node_ids, { hops, direction, at: at(query.at) })
          assert.deepStrictEqual(encodeGraph(graph), query.result, JSON.stringify(query))
        }
        for (const query of expected.match_nodes) {
          const nodes = yield* store.matchNodes(G, query.command, { at: at(query.at) })
          assert.deepStrictEqual(nodes.map((node) => node.id), query.result, JSON.stringify(query))
        }
        for (const query of expected.get_nodes) {
          const nodes = yield* store.getNodes(G, query.node_ids, { at: at(query.at) })
          assert.deepStrictEqual(Array.from(nodes.values(), (node) => encodeNode(node)), query.result)
        }
        for (const query of expected.diffs) {
          assert.deepStrictEqual(encodeEditSet(yield* store.diff(G, query.from, query.to)), query.result)
        }
        for (const call of expected.errors) {
          const error = yield* Effect.flip(callStore(store, call))
          assert.deepStrictEqual({ error: error._tag, message: error.message }, { error: call.error, message: call.message })
        }
      }).pipe(Effect.provide(JsonGraphStore.layer(root)))

      // Reads and failed calls leave the files as they were.
      yield* assertSameFiles(root, path.join(fixtures, "python-store"))
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("writes the same files as the Python version", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "graph-store-" }), "graphs")
      yield* buildFixtureStore.pipe(Effect.provide(JsonGraphStore.layer(root)))
      yield* assertSameFiles(root, path.join(yield* fixturesDir, "python-store"))
    }).pipe(Effect.provide(NodeServices.layer)))
})
