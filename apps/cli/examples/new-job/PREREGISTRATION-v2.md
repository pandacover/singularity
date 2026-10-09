# Pre-registration: the "new job" benchmark, second version of web memory

Written 2026-10-09, after the first run failed the bars (`RESULTS.md`) and
before any run of the second version. The user asked for three fixes and a
rerun of the same benchmark.

## Read this first: this rerun is not a sealed test

The first run was sealed: I never saw the benchmark before every run was
done. That is no longer true. I have read the benchmark's `reveal` (its traps,
rules and chore kinds) and every run's outcome and feedback, and the three
fixes below were designed from the first run's failures.

So this rerun can show whether the fixes fix what they were aimed at. It
can't show that they work on apps, traps and rules nobody has seen; only a
new sealed benchmark, built by another agent, can. A good result here is a
reason to build one, not a result to report on its own.

What keeps it honest within those limits:

- The fixes are general mechanisms, written and tested on my own practice app
  (`examples/practice-web`). No name, page or rule of the benchmark is in the
  code or in a prompt.
- The same bars, the same order, the same runner, the same agent and Claude
  Code binary, and the same report code (`examples/new-job/final.ts`), with
  memory's runs swapped for the second version's.
- The baseline is the same pre-registered one: no memory, both passes of
  last night. A third pass without memory runs alongside, only to show
  whether anything drifted since; it is not pooled into the baseline.

## What changed in memory (the second version)

From the three ways the first version failed (`RESULTS.md`, section 4):

1. **Every rule of the app, at the start of every task.** Before, a rule came
   only with the workflow that carried it, so when the task's wording picked
   no workflow, rules memory knew never reached the agent (T07). Now the
   app's rules (up to 4,500 characters) come first in every hand-over, with
   or without a workflow (`src/web/Start.ts`).
2. **What earlier sessions left alone.** Memory recorded what sessions
   clicked, so a field a form opens with already set (a ticked box) never
   made it into the steps, and the agent, given the steps, left it as it was
   (L08, L14). Now:
   - each session's record keeps, for every form it sent, the fields that
     were already set when it first saw them (in a dialog or behind a
     disclosure too), and whether it changed them; and each action on a field
     what the field was before (`src/web/Extract.ts`);
   - the model that learns sees them, and is told to name such a field in the
     steps and say it starts set; to say when to change it only where
     sessions changed it; and never to tell the agent to leave it as it is
     just because earlier tasks didn't need it changed (`src/web/Induce.ts`);
   - without a model, memory writes a note per page on its settings that
     start made (ticked boxes, chosen options; not text already in a box)
     and how often sessions changed each, handed over at the start and again
     when a page shows the field (`src/web/Presets.ts`);
   - the hand-over says the steps are not a script: read each page and form
     before acting on it.
3. **Learning right after a failure that came with feedback,** whatever the
   count, instead of waiting for the third new session (`src/web/Learn.ts`).
   And when the replay turns a revision's workflows down, its rules are kept
   anyway: the replay can judge workflows, not rules.

Code memory is untouched.

## What is frozen

- **Memory code**: `apps/cli/src`, hashed the same way as the first freeze
  (`runs/new-job/hash-src.mjs`): 159 files, sha256
  `0c25b98fe073adb763e4f14aa8b7cbaa38f9312e5841d54c6d47c2892ec4333d`, frozen
  at 11:46 UTC (`FREEZE-v2.txt`). The run script stops if it changes. The
  first version's code is kept, hash-checked, at
  `C:\singularity-workspaces\new-job-v2\frozen-src-v1`.
- **Tried first on the practice app only** (`C:\singularity-workspaces\practice-v2c`):
  8 chores, two of them with a silent rule on a field that starts set. Each
  failed once, memory learned at once, and the next chore of its kind passed.
- **The benchmark**: unchanged; its seal (`8e65d2f9…`) is checked again before
  the first run.
- **Claude Code** 2.1.295 (the pinned copy), **Sonnet** at medium effort,
  Playwright MCP 0.0.83, browser tools only, `--max-turns 80`,
  `--max-budget-usd 2`, 20 minutes per chore. Memory's learning: Sonnet, high
  effort; frozen in the test phase.

## Order (`runs/new-job/run-v2.sh`)

One run per chore and condition, one at a time, as before; memory first in
each phase, so that its runs are done if a usage limit stops the rest:

1. memory v2, learn phase; no memory (third pass), learn phase
2. memory v2, test phase; no memory (third pass), test phase
3. memory v2, update phase; no memory (third pass), update phase
4. the second pass of memory v2, as last night's: the test phase from a copy
   of the memory as it was after the first test pass, frozen; the update
   phase from another copy of it, learning as in daily use.

The script checks the seal and the freeze before it starts, and every step
runs twice, so a chore lost to a crashed runner call runs on the second try.

Then `final.ts` for the bars, and the same report against the first version.

## Bars

The same as `DESIGN-one-layer.md`, computed the same way (`PREREGISTRATION.md`,
amendment): both passes count; per chore, success is the share of its runs
that passed and turns are the median of its runs; harm is a chore memory
passed less often than no memory did.
