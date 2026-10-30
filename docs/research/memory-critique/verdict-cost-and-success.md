# Singularity judged on both halves of its goal

Written 2026-10-14. Luv's goal for Singularity is both at once: **use fewer resources** and **finish tasks well, avoiding mistakes**. This scores every eval in the repo on both halves. Numbers are from the eval write-ups under `apps/cli/examples/`. The markdownlint numbers were also rechecked against the raw logs in `examples/markdownlint/results/`. Background research: [Procedural memory for coding agents](/mnt/project-files/procedural-memory-research/reports/Procedural%20memory%20for%20coding%20agents.md).

## Scorecard

| Test | Like real use? | Success and mistakes | Cost |
|---|---|---|---|
| excalidraw, 9 single tasks (`PREREGISTRATION-v1.md`) | No: memory built by hand on the repo it was tuned on | 32 of 33 runs passed | Never worse than no memory: 4% to 85% fewer tokens |
| excalidraw, 4 learned changes in one task (`v1-long`) | No: same lab setup | 4 of 4 runs passed in both arms. The keyboard-test trap was avoided on the first try in 3 of 4 runs with memory and 0 of 4 without | **78% fewer tokens, 63% fewer dollars** |
| excalidraw, 2 of 4 changes learned (`v1-long-mixed`) | No: same lab setup | 4 of 4 runs passed in both arms | 39% fewer tokens, 38% fewer dollars, all saved on the learned changes |
| validator.js, new kinds of task (`v1-new-kinds`) | Partly: a second repo | 6 of 6 passed in both arms | About the same (within noise) |
| excalidraw bug fixes, new kinds (`v1-new-kinds`) | Partly | 6 of 6 passed in both arms. One wrong workflow was handed over and ignored | About the same (within noise) |
| markdownlint, 12 tasks as installed (`long-daily`) | **Yes**: empty memory, learns by itself | 12 of 12 in both arms. In the rerun, **11 of 12 passed, and memory caused the one failure** | Agents 9 to 13% dearer. **76 to 79% dearer with learning counted** |
| web benchmark, memory v2 (`new-job/RESULTS-v2.md`) | Partly: sealed, but the fixes were made after seeing it | 59 of 64 passed against 57 without memory. Traps hit 3 times against 5. Memory harmed 2 chores. A one-page guide did best (23 of 23) | Median tokens about 20% lower in the test phase (111k against 138k). Only 10% fewer turns on repeat chores, short of its 20% bar |

**Update, same day:** the edges measurement ran in a cloud session on 2026-10-13 (branch `edges-measurement-cloud`, commit `5789fa9`). It reran `long-four-changes` with rebuilt memory on Claude Code 2.1.296: 8 runs per arm, all passed, and the median tokens were 1,180k with no memory against 1,188k with memory. All four arms landed within 7% of each other. So the "78% fewer tokens" headline did not reproduce in that rerun. One likely cause: memory's closing command ran past Claude Code's 120 s timeout in 14 of 24 memory runs, and the agent spent turns waiting on it.

## Verdict on each half

**Success and fewer mistakes: mostly holds, but the gain is small.** Memory rarely breaks a task: there was one failure it caused in markdownlint and two harmed chores on the web. Its clearest value is avoiding known traps, like the keyboard-test trap and the web traps. Even so, there is no clear gain in pass rate in any test. The biggest is 2 extra passes out of 64 on the web, and a one-page guide still beat it.

**Fewer resources: holds only in the lab.** It saves a lot when the same kinds of change come back and memory was built well (excalidraw). On new kinds of task it costs about the same as no memory. In real daily use it costs more, mainly because learning cost $2.6, about two thirds of the no-memory bill.

**Both together: met in the lab, not yet in daily use.** No test so far has shown both halves in conditions like a real user's.

## Why the halves pull apart today

- What saves tokens is the long workflow hand-over. That same hand-over causes the mistakes: wrong picks, wrong values, stale steps.
- What prevents mistakes is the short trap warnings. Those are cheap and git history doesn't contain them.
- So the redesign the research suggests serves both halves at once: short verified warnings, at most one confident workflow, and nothing shown when the match is weak.

## A fair test that would prove both

1. **A repo memory has never seen**, with real history. Memory learns from its first N real commits and is tested on the next 20 or more tasks, where some kinds repeat and some don't.
2. **Five arms:** no memory, the last related commits from git, the closest past commit's diff, a short hand-written guide, and Singularity.
3. **3 or more runs per task per arm.** That is enough for big gains. Small gains of a few points need about 9 runs ([arXiv 2602.07150](https://arxiv.org/html/2602.07150v2)).
4. **Measure both halves:**
   - Success: pass rate on hidden tests.
   - Mistakes: traps hit, failed commands, turns spent redoing work.
   - Cost: all-in dollars and tokens, with learning counted.
5. **Bars set before any run.** Singularity passes only if:
   - its success is no lower than any arm's;
   - it hits fewer traps than no memory;
   - its all-in cost is no higher than the cheapest arm with the same success.

   Report harms first, by task.

If Singularity clears that bar, the claim "fewer tokens and fewer mistakes" is earned. If it clears only the mistakes half, the honest product is a trap-warning layer, which is still worth shipping.
