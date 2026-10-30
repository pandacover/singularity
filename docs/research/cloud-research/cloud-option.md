# What we've learned, and what a cloud option would add

Written 2026-10-15. Part 1 sums up what the project has learned about Singularity's memory. Part 2 looks at what a cloud option would make possible, and judges each idea against Luv's goal: **fewer resources and successful runs that avoid mistakes, both at once**.

Sources: [critique](/mnt/project-files/memory-critique/critique.md), [scorecard](/mnt/project-files/memory-critique/verdict-cost-and-success.md), [research report](/mnt/project-files/procedural-memory-research/reports/Procedural%20memory%20for%20coding%20agents.md), the "Saved scripts experiment" thread, and `apps/cli/examples/scripts/RESULTS.md` on branch `claude/saved-scripts-experiment-qx8kwz` (PR #30). Prices were checked on the web on 2026-10-15 and are linked.

## Part 1: what we've learned

### About the old memory (workflows)

1. **It won in the lab, not in daily use.** The "28.5 to 9.5 turns" headline used hand-built memory on the repo it was tuned on. A rerun with 8 runs per arm landed within 7% of no memory. In the installed markdownlint test it cost 76 to 79% more all-in.
2. **Learning was the biggest cost.** About $2.6 per 12 tasks, two thirds of the no-memory bill, and half the rounds were thrown away.
3. **Matching words picked badly.** Look-alike prompts got the wrong workflow, and paraphrased prompts got nothing.
4. **Wrong or stale text causes mistakes.** Blanks filled by position got wrong values. Steps named folders that had been renamed. Memory caused one task failure by giving the wrong command order.
5. **Git history is a free rival.** Agents without memory read past commits themselves and got cheaper over time.
6. **Trap warnings were the clearest win.** Known mistakes are knowledge git does not hold.

### What the research says

1. Show **at most one** item, and show **nothing** when unsure. Coding results peaked at exactly one past experience.
2. Retrieval quality decides most of the outcome. Exact word matching is the weakest kind. Embeddings of a short, name-free summary held up best when wording changed.
3. Check anything that names code against today's code before showing it (GitHub Copilot Memory does this), and expire what goes unused.
4. Measure on held-out commits in time order, against a git-history arm, with all costs counted.

### What the current direction (saved scripts) shows so far

Saved scripts hand over the one past commit most like the new task, read from git at use time. There is no learning step and no model call. Search is word coverage times cosine, with nothing shown below a score of 0.38 (`src/scripts/Search.ts`).

| Test (same machine per row) | No memory | Saved scripts |
|---|---|---|
| markdownlint, 12 tasks | 7 of 12 passed, $3.06, 6.25M tokens | 12 of 12 passed, $2.65, 4.84M tokens |
| excalidraw long-mixed, 4 runs | 1,051k median tokens | 489k median tokens |
| excalidraw long-four, 8 runs | 1,180k | 1,079k (within noise) |

Both halves of the goal moved the right way here, but with one pass on markdownlint the pass gap is suggestive only. Staleness checks, retiring and a mid-task `recall` note have since been added and the evals are rerunning.

**Open weak spots that a cloud option could touch:** search is still word based; memory is per repo, so a pattern from one project can't help another; hand-overs get cut at 9,800 characters; and each user's memory starts empty.

## Part 2: what a cloud option would enable

Each idea below lists what it adds, what it costs, and whether it serves the goal. "Local alternative" says whether the same gain is possible without the cloud, because if it is, the cloud is not the reason to do it.

### 1. Better search with embeddings and a reranker

- **What:** embed each saved task (or a short, name-free summary of it) and search by meaning. Then let a reranker pick the single best one and decide whether to abstain.
- **Why it fits:** the research's strongest finding is that picking the right item matters most. Embeddings fix both failure types we saw: paraphrases that match nothing and look-alikes that match wrongly.
- **Cost:** small. `voyage-code-3` embeddings are about [$0.18 per million tokens](https://www.getmaxim.ai/bifrost/llm-cost-calculator/provider/voyage/model/voyage-code-3.md). Cohere Rerank 3.5 is about [$0.001 per search](https://openrouter.ai/cohere/rerank-v3.5). A day of tasks would cost cents.
- **Local alternative: yes.** Small embedding models run on device, and vector search fits in SQLite (for example [sqlite-vec](https://builders.mozilla.org/project/sqlite-vec/)). Cloud models are likely stronger on code, but I have not measured the gap for our tasks.
- **Verdict:** worth testing, and test a local embedding model first. It serves both halves: fewer wrong hand-overs means fewer mistakes and less wasted reading.

### 2. A cheap model to pick, abstain and adapt

- **What:** one small model call at task start that reads the top few candidates and says "use this one" or "use none", and can point out which values differ (instead of guessing blanks by position).
- **Why it fits:** SWE-Exp lost 3.8 points when it dropped its model rerank. Plan caching (APC) found that a model-extracted intent key beat surface words. Both are in the research report.
- **Cost:** Haiku 4.5 is [$1 / $5 per million tokens](https://www.fast.io/resources/anthropic-api-pricing-guide.md). A pick over 3 short candidates is a few thousand tokens, so well under a cent per task. Note this works today through the user's own agent too; the cloud only matters if Singularity pays for or hosts the call.
- **Verdict:** worth testing. Keep it to one call with a hard budget, so cost stays tiny next to the agent's own bill.

### 3. Cheaper learning, if learning comes back

- **What:** run any model-based learning (summaries, trap warnings) on a server with the [Batch API at 50% off](https://www.fast.io/resources/anthropic-api-pricing-guide.md) and [prompt caching](https://www.fast.io/resources/anthropic-api-pricing-guide.md) (cached reads at 10% of input price), instead of on the user's machine and account.
- **Why it fits:** learning cost sank the old design. Saved scripts dropped learning, so today there is little to move.
- **Verdict:** only matters if we bring back model-written trap warnings. Then batching makes them roughly half price, and they never slow the user's machine.

### 4. Shared memory for teams

- **What:** one memory per repo shared by everyone working on it, like [GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) (repo facts visible to all users of the repo, used only in that repo, checked against the current branch, deleted after 28 days unused).
- **Why it fits:** today each person starts with empty memory, and the first similar task gets nothing. With a team, one person's commit becomes everyone's saved script. The more people, the more hits.
- **Cost:** storage is tiny, because saved scripts are pointers into git, not copies. A managed vector store like turbopuffer starts at [$16 a month](https://turbopuffer.com/docs-md/pricing-log.md); a Postgres database with pgvector would also do.
- **Local alternative: partly.** Memory could live in the repo itself (a file or git notes) and travel with `git push`. That keeps it local-first but leaks into the repo's history.
- **Verdict:** the strongest reason for a cloud option. It raises how often memory has something useful to give, which is where all the savings came from (the 7 markdownlint tasks with a hand-over saved 20%; the 5 without saved nothing).

### 5. Patterns that cross repos

- **What:** a shared library of abstract, name-free procedures and trap warnings across many repos (for example "adding a lint rule" or "a Vite config trap").
- **Why it fits:** the research says abstract items generalize across tasks and raw traces don't. Raw trajectories lost 9.5 points across tasks in one study.
- **Risk:** a script from one repo names files that don't exist in another, which makes agents follow wrong code with confidence. Only abstract warnings should cross repos, never diffs.
- **Verdict:** later. It needs many users first and a careful privacy story. Start with trap warnings only.

### 6. Running evals at scale

- **What:** run eval suites in the cloud, many runs in parallel, on fixed Claude Code versions.
- **Why it fits:** our results are thin because runs are few. The research says a 2-point gain needs about 9 runs per arm, and our only comparable numbers were already the cloud runs (Windows runs were not comparable).
- **Verdict:** useful now, for us rather than for users. It turns "suggestive" results into proof, which the launch claim needs.

### 7. A dashboard and usage stats

- **What:** per repo, show hits, abstains, stale scripts retired and money saved.
- **Verdict:** nice for trust and for marketing ("saved you $X"), but it does not change outcomes. Low priority.

## Tradeoffs against local-first

| | Local-first today | With a cloud option |
|---|---|---|
| **Privacy** | Code and prompts never leave the machine | Prompts, diffs or embeddings leave it. Embeddings can leak content. Needs opt-in, secret scanning before upload, and a self-host path for companies |
| **Cost to user** | Free after install | Small per-task fees, or a subscription. Must stay far below the 13 to 20% the hand-overs save |
| **Speed** | Task-start hook runs locally | A network call adds delay at task start. That's fine there, but never on the tool-call hook, which has a 0.1 s budget |
| **Offline** | Works | Must fall back to local search when the network is down |
| **Freshness** | Reads git at use time | Same, if the cloud stores pointers and the local side reads the code. Never hand over code text from the server without checking it against the local tree |

## What I'd do, in order

1. **Keep local-first as the default.** Saved scripts already met both halves of the goal locally on markdownlint. Nothing in Part 2 requires dropping that.
2. **Test better search locally first:** a small local embedding model plus the current score, against today's word search, on the same tasks. If it fixes most wrong picks, the cloud isn't needed for search.
3. **Add an optional cheap model pick** (Haiku-class, one call, abstain allowed) and measure picks and cost.
4. **Build team sharing as the first real cloud feature.** It is the only gain that local can't fully match, and it multiplies hits. Store pointers and warnings, not code, and verify against the local tree at use.
5. **Use cloud eval runs now** to get 3 to 9 runs per arm, so any launch claim is backed.

## Not verified here

- How much better cloud code embeddings are than local ones on our tasks. This needs a test.
- Turbopuffer's storage price per GB; only its $16 monthly minimum was confirmed.
- Prices change often; the ones above are from third-party listings checked on 2026-10-15, except GitHub's memory rules, which come from GitHub's docs.
