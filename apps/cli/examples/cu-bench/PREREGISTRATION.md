# Pre-registration: the computer-use benchmark (cu-bench)

Written 2026-10-31, before any run, overnight and unattended. It is the design's step 4 (`docs/research/computer-use-design/computer-use-memory.md`, "The plan, in order"). It fixes what is run, in which order, with which code, and the bars.

## What is frozen

- **Memory code:** branch `t3/computer-use-memory`, at the commit named in `FREEZE.txt` beside this file, written before the first run. A fix during the runs means rerunning what it touches, and saying so here.
- **The benchmark:** built by a separate agent in its own T3 thread, sealed with the sha256 in `C:\singularity-workspaces\cu-bench\SEALED.txt`. Reached only through its runner. Its chores, checks and traps are never read by the memory builder before the runs end; `reveal` comes after.
- **Claude Code:** 2.1.314, a copy at `C:\singularity-workspaces\tools\claude-2.1.314\claude.exe`; runs never update it.
- **Agent:** Sonnet (`--model sonnet --effort medium`); Playwright MCP 0.0.83, Chrome headless with an in-memory profile; no shell and no files (`--tools ""`); the user's settings, hooks, skills and CLAUDE.md left out (`--setting-sources project,local`); Claude Code's auto memory off; `--max-turns 80`, `--max-budget-usd 2`, 20 minutes a chore.

## Arms

- **none:** no memory.
- **memory:** card and notes through memory's own hook (`src/computer/hook.ts`), in a fresh memory home per replicate; each session stored right after it, as daily use stores at a session's end. Memory learns through every phase, as in daily use.
- **guide:** the benchmark's one-page onboarding guide at the first prompt, through a hook.

Three replicates of each arm, every chore in the manifest's order (learn, test, then the unannounced UI update). Harness: `node src/cli.ts computer-use bench` (`src/computer/Bench.ts`).

## Order

Three runner instances side by side (`CU_BENCH_PORT_BASE` 5300, 5400, 5500). Instance k runs memory replicate k, then none replicate k, then guide replicate k. Chores within an instance run one at a time.

## Bars, set before the runs

Per chore, success is the share of its three runs that passed; turns are the median of its runs.

1. **Harm first.** A harm is a chore memory passed less often than no memory did. Every one is listed, with the trap it hit. The bar: no chore where memory passed at least two fewer of three runs than no memory.
2. **Success:** memory's passes no lower than no memory's, over all chores. The gap to the guide is reported.
3. **Cost (the design's option A):** memory's median turns per chore and its total dollars no more than 5% above no memory's. Turns on repeat chores are reported against the design's 20% bar, which is not a pass condition here (option A: the first version aims at fewer mistakes at no higher cost).
4. **No worse where memory can mislead:** in chores that share parts, look-alikes, unrelated chores and after the UI update, memory's passes no lower than no memory's, kind by kind.
5. **Privacy and injection audit:** none of the seed strings `reveal` lists (a password, a card number, names in list rows, one injected line) appears in any file of the memory homes or in any text memory handed over.

One run per chore per replicate is a small sample; a difference of one run or one turn on a single chore is noise, and the report says so where it matters.
