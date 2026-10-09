# What was built overnight (2026-10-09)

Branch `one-layer`, nothing committed. The design is `DESIGN-one-layer.md`.

## One API

`src/layer/Api.ts`: `start`, `step`, `end`, `learn`, the same for code, web
and any future kind of work. Ways in:

- **Hooks**: `src/workflows/hook.ts` sends every event through the layer.
  Code sessions take exactly the path they took before: the measured memory
  (`v1-finish`) gives byte-identical hand-overs through the new door (both
  parts at task start, and the mid-task warning), checked against `HEAD`.
- **CLI**: `node src/cli.ts layer start|step|end|learn`, a JSON request on
  stdin, a JSON answer on stdout. For agents without hooks, and harnesses.
- **MCP**: designed, not built.

## The web reader (`src/web/`)

| Module | What it does |
|---|---|
| `Snapshot.ts` | reads Playwright's accessibility snapshot: roles, names, references, parents, messages |
| `Places.ts` | a place on a page: the page's address as a pattern, and the named regions around a control; the task's values as blanks; finding a place again in a live page |
| `Extract.ts` | a browser session's actions, each placed in the snapshot it was taken from; what pages said |
| `Records.ts` | web records, successful or not, with the check's feedback |
| `Session.ts`, `Start.ts`, `Step.ts`, `End.ts`, `HookStep.ts` | the four calls for web sessions: the hand-over at the start, pointers and warnings after each browser call, the record at the end |
| `Induce.ts` | learning: one model call reads an app's sessions and proposes workflows, the graph and pitfalls (same format as code memory), checked mechanically |
| `Learn.ts` | the schedule (first build after 2 sessions, a round every 3), cues (shared with code), the replay gate |
| `Bench.ts`, `Report.ts`, `Awm.ts`, `StaticHook.ts` | the benchmark's harness, its report, the AWM baseline, the static hand-over for baselines |

Shared changes, kept compatible: `Place` may say `kind: "web"`; a trigger may
watch `page` or `action`. Code never produces either.

## Checks, all free

- `npx tsc` clean; `npx vitest run`: 258 passed (9 new, `test/web/web.test.ts`).
- Code hand-overs through the new door: byte-identical to before.
- A practice app of my own (`examples/practice-web`): the whole loop with
  Haiku: memory built itself after two sessions, pointed at the right
  controls when their pages opened; the none, guide and AWM paths work.

## Using it

```
# Memory for a web app, by hand
echo '{"session_id":"s1","prompt":"Refund order 4821 at http://localhost:5101","cwd":"."}' | node src/cli.ts layer start
echo '{"session_id":"s1","transcript_path":"...jsonl","cwd":".","outcome":{"success":true,"feedback":"Done"}}' | node src/cli.ts layer end
echo '{"subject":"web-localhost-5101"}' | node src/cli.ts layer learn

# The benchmark
node src/cli.ts web-bench run --runner RUNNER.cmd --out DIR --condition memory --home HOME
node src/cli.ts web-bench report --results DIR... --reveal reveal.json --out REPORT.md
```
