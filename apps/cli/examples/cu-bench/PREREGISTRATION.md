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

## Amendment 1, after round 1 and before any later run (2026-10-31, 00:25 UTC)

Round 1 (Sonnet, 216 runs, `C:\singularity-workspaces\cu-bench-runs`): every arm passed 72 of 72, so bars 1, 2 and 4 can't tell the arms apart. The privacy audit (bar 5) failed: names from the apps' data, a patient picker's options, were written to memory's files in plain text once two sessions saw them. None reached a hand-over (51 hand-overs checked). Memory now keeps a choice's words (options) and words in list rows and tables as fingerprints only (`Trail.ts` `ownWords`, with a test); re-storing round 1's sessions with the fix gives an audit with nothing found.

Before round 2, the memory builder read `reveal` to run the audit: chore kinds, the seed list, and cu01's full text and traps (cu02's only after round 2, to look at the one Haiku chore that differed); the only code change between rounds is the fix above, to what memory stores. The fix changes memory's code, so what it touches runs again, and a weaker agent is added because Sonnet passed everything:

1. **Sonnet, memory again** (`memory-fixed-<k>`), three replicates, fresh homes, against round 1's none and guide.
2. **Haiku** (`--model haiku --effort medium`): none, memory and guide, three replicates each, fresh homes. Same benchmark, same bars.

Instance k (port bases 5300, 5400, 5500) runs Sonnet memory replicate k, then Haiku memory, none and guide replicate k. Code: the commit in `FREEZE-2.txt`.
