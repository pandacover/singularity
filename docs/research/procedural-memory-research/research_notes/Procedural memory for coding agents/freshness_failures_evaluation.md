# Keeping procedural memory correct, and evaluating whether it helps (freshness, failures, evaluation)

Scope: staleness and maintenance, negative results, failure-derived memories, evaluation method, and repository history as context. Written for Singularity, a local-first workflow memory for Claude Code that learns from commits. Current as of 2026-10-14.

## Q1. Staleness: temporal validity, use-time verification, decay, versioning, invalidation

### Takeaway
The approach with the strongest evidence is explicit revocation or invalidation of superseded memories, plus putting correct current facts in context. Append-only memory can do worse than no memory once the world changes, and an agent given a stale summary usually does not check it. Decay curves are widely implemented but have almost no controlled evidence behind them. Verifying a memory against the current code at use time is argued for but not yet measured.

### Cited Findings
- **Zep/Graphiti bi-temporal model.** Each edge carries four timestamps: t_valid and t_invalid for when the fact was true, and t'_created and t'_expired for when the system ingested or expired it. When a new edge contradicts an older one and their validity periods overlap, an LLM sets the older edge's t_invalid to the new edge's t_valid, and newer information wins. The paper says the definition of a contradiction is not fully specified. — [Zep, arXiv:2501.13956](https://arxiv.org/pdf/2501.13956.pdf)
- **Zep results.** On LongMemEval (gpt-4o), Zep scored 71.2% against 60.2% for full context, using about 1.6k context tokens against 115k and about 90% less latency. It was worse on *knowledge-update* with gpt-4o-mini (76.9% to 74.4%) and on single-session-assistant questions (94.6% to 80.4% with gpt-4o). On the DMR benchmark its gain was marginal (94.8% against 94.4% for full context), and the authors call DMR weak. The temporal machinery therefore did not clearly win on the update category. — [arXiv:2501.13956](https://arxiv.org/pdf/2501.13956.pdf)
- **TEPA (2026 preprint), "memory pollution".** Superseded but still active memories make append-only memory worse than no memory. Under controlled drift, full-reversal success was 0.210 for append-only and last-write-wins, 0.309 for no memory and 0.950 for TEPA. Under executable, file-backed drift it was 0.203 for append-only, 0.298 for no memory, 0.771 for reactive forgetting and 0.950 for TEPA. Each setting used 50 seeds. Removing the revocation step brings TEPA down to append-only level. On clean single-hop updates (MemoryAgentBench SH-6k), plain last-write-wins key replacement ties TEPA at 0.890. TEPA depends on extracting conflict keys reliably: at 20% key noise its score falls from 0.950 to 0.777. Revoked items are archived rather than deleted, so they can be promoted again. The preprint has some internal inconsistencies between tables. — [TEPA, arXiv:2608.07429](https://arxiv.org/pdf/2608.07429)
- **MemoryAgentBench.** Selective forgetting is the hardest competency for every memory type tested. On multi-hop conflict resolution (FactConsolidation-MH), every method scored about 7% or less; GPT-4o long-context scored 60.0 single-hop but 5.0 multi-hop. o4-mini scored 80.0 on multi-hop at 6K tokens but 14.0 at 32K, so the task becomes hard as history grows. — [MemoryAgentBench, arXiv:2507.05257](https://arxiv.org/html/2507.05257v3)
- **Stale context in coding agents (Meetless Research, draft).** All 10 models scored 0/6 and read no files when the only context was a CLAUDE.md-style summary whose six facts were all stale, even though current notes were on disk. The authors call this a verification failure: the summary answers the question, so the agent never checks. Other results:
  - When the summary *pointed to* the notes instead of stating the facts, agents found the current values on their own.
  - Adding "check the notes" fixed 6 of 10 models, with no way to predict which ones.
  - Corrections appended next to the stale text did nothing when they were labelled "provisional" or covered only part of the task. Complete, assertive corrections scored 6/6.
  - Pushing the correct facts into context scored 6/6 on every model and was the cheapest cell ($0.027 on Haiku).
  - On a code deliverable, a stale quick-reference made Haiku write obsolete API calls with zero tool calls.
  - The study is preliminary: 2–3 trials per cell and no significance tests. — [Meetless stale-context benchmark](https://research.meetless.ai/stale-context/)
- **Versioning in a git-native design (Lore).** Lore argues that decision context stored in commit-message trailers ("Constraint:", "Rejected:") cannot drift because commits are immutable and tied to the change they describe, while separate ADR files "routinely go stale." This is a design argument with no evaluation; a six-month two-team study is proposed but not run. — [Lore, arXiv:2603.15566](https://arxiv.org/html/2603.15566v1)
- **Deletion as maintenance (Xiong et al.).** Deleting records by their usage history improved accuracy and shrank memory:
  - EHRAgent: 38.67 to 42.06 with history-based deletion; 42.34 with combined deletion at memory size 248 instead of 1012 (about 75% smaller).
  - CIC-IoT: 85.40 to 89.60.
  - With a coarse (unreliable) evaluator, the same deletion hurt AgentDriver (36.92 to 34.00), so deletion is only as good as the quality signal behind it. — [Xiong et al., arXiv:2505.16067](https://arxiv.org/html/2505.16067v2) (ACL 2026: [aclanthology](https://preview.aclanthology.org/ingest-acl/2026.acl-long.27/))
- **ExpeL insight maintenance.** Insights are edited with ADD, EDIT, UPVOTE and DOWNVOTE. A new insight starts at a count of 2 and is removed when its count reaches 0, a vote-based lifecycle rather than a time-based one. — [ExpeL, arXiv:2308.10144](https://arxiv.org/pdf/2308.10144)
- **Skill fragility (web agents).** ASI's induced skills referenced unstable accessibility-tree IDs. Verification passed functions that failed on their first step in up to 72% of Shopping verifications under GPT. This is the web analogue of step text that points at code that has since moved. — [Budget-constrained study, arXiv:2606.15017](https://arxiv.org/pdf/2606.15017)

### Inferences
- For Singularity: the "stale step text misled agents" finding matches the Meetless result exactly. When memory states something with confidence, the agent stops looking. Design implications:
  - Hand over *pointers* to places that are checked against the current code at use time (Singularity already finds places by their surrounding blocks), rather than asserting content.
  - When a place cannot be found, drop the step or flag it plainly; do not show it with a hedge.
  - TEPA suggests that revoking a workflow step whose place has disappeared or changed (keyed by file and symbol) is the key mechanism, and that keeping the revoked step in an archive costs little.
- Invalidation keyed on file changes is the natural "conflict key" in a code repository, and it avoids TEPA's main weakness, noisy LLM-extracted keys. A commit that touches the anchored blocks is a deterministic invalidation signal.
- A hedged warning such as "this may be outdated" is unlikely to help (Meetless: labels like "provisional" did nothing). Either verify and assert, or omit.

### Gaps
- No controlled study found that tests Ebbinghaus-style decay or time-based forgetting curves against revocation or no decay for agent procedural memory. The sources found were blogs and implementations without ablations (MemoryBank, arXiv:2305.10250, uses the Ebbinghaus curve but I did not verify that it has an ablation isolating decay).
- No published evaluation was found of use-time verification of code memories, that is, re-checking anchors against the current tree, in coding agents.
- Graphiti's invalidation has not been benchmarked on code or procedural memory.

## Q2. Negative and mixed results: when memory or experience reuse hurts

### Takeaway
Negative results are common and come from several independent sources. Memory systems often fail to beat no memory on coding tasks. Indiscriminate "add-all" memory degrades performance. Errors spread because agents copy whatever they retrieve. Once module overhead is charged to the memory system, a budget-matched plain agent often wins.

### Cited Findings
- **Experience-following (Xiong et al.; ACL 2026).** When a new input is similar to a stored one, the agent's output closely mirrors the stored output; with large memory on RegAgent the correlation approaches r ≈ 1. Errors in memory therefore spread to new tasks ("error propagation"), and outdated or misaligned records are replayed ("misaligned experience replay"). Add-all memory fell 16–22% (relative) *below* a fixed-memory baseline:
  - RegAgent 67.53 to 55.48
  - EHRAgent 16.75 to 13.05
  - AgentDriver 40.11 to 32.32
  - CIC-IoT 71.50 to 59.90

  Strict, oracle-quality addition gained +5% to +130% (relative). A judge fine-tuned on 300 examples came close to the oracle. The study uses GPT-4o-mini and four agents and reports no significance tests. — [arXiv:2505.16067](https://arxiv.org/html/2505.16067v2)
- **VibeMemBench (Sep 2026), coding-specific.** The benchmark has 111 targets from 90 SWE-rebench V2 repositories, a history of 3,634 trajectories, and five held-out solvers. **11 of 12 solver-and-memory-system pairings failed to beat the matched memory-off baseline.** Injecting *verified* experience directly raised resolution by 1.1–4.5 pp on 4 of 5 solvers and cut steps on all 5. The authors conclude that useful experience exists in repository history but current memory systems don't deliver it. Targets were kept only where injected history helped in a reference setting, so the upside is likely optimistic. — [VibeMemBench, arXiv:2609.23570](https://arxiv.org/abs/2609.23570)
- **SWE Context Bench (Claude Sonnet 4.5, 99 related Lite tasks):**

  | Condition | Resolved | Cost |
  |---|---|---|
  | No context | 26.26% | $0.79 |
  | Free full-trajectory retrieval | 26.26% | $0.98 |
  | Free summary retrieval | 22.22% | |
  | Oracle full trajectory | 27.27% | |
  | Oracle summary | 34.34% | |
  | Mem0 | 24.24% | |

  - Free full-trajectory retrieval pulled in about 137k tokens, and only 18.18% of retrieved items matched the gold related task.
  - Free summary retrieval resolved fewer tasks than no context and doubled the patch-failure rate (7.07% against 3.03%).
  - Oracle summaries averaged about 217 tokens, against about 25.6k for a full trajectory.
  - Mem0 also landed below baseline.
  - Benchmark size: 1,476 tasks across 51 repositories. The paper's conclusion: experience helps only when compact and correctly selected. — [SWE Context Bench, arXiv:2602.08316](https://arxiv.org/html/2602.08316v3)
- **Budget-matched baselines (web agents).** A plain agent given 15 steps instead of 10 matched or beat AWM, ASI and ReasoningBank on WebArena with all three models:
  - Gemini 3 Flash: 50.7% at 71.9K tokens, against ASI's 47.9% at 107.1K.
  - GPT-5.4-mini: 36.6% against 32.1%.
  - Qwen 3.6-27B: 47.4% against 45.6%.

  About half of AWM's Shopping induction events, and over half of ReasoningBank's success-labelled Shopping entries, came from *failed* runs. Retrieved memories acted as distracting "active hints". Online learning is sequential, so an environment glitch can corrupt later knowledge. — [arXiv:2606.15017](https://arxiv.org/pdf/2606.15017)
- **Evo-Memory (streaming).** Several memory methods scored below no memory:
  - Gemini single-turn: ReAct 0.37 against a 0.59 baseline.
  - AWM scored 0.03 on AIME-24/25 with Claude.
  - Dynamic Cheatsheet dropped MMLU-Pro Engineering from 0.63 to 0.52.
  - Adding failed trajectories unfiltered collapsed ExpRAG (Gemini embodied success 0.38) and AWM (0.28).

  The simple ExpRAG baseline (retrieve top-k similar past experiences) was "highly effective", tying or beating the proposed ReMem on Claude single-turn (0.59 against 0.58). Gains correlated with within-dataset task similarity (Pearson r = 0.717 on Gemini, 0.563 on Claude). — [Evo-Memory, arXiv:2511.20857](https://arxiv.org/html/2511.20857v1)
- **Context collapse and brevity bias (ACE).** "Brevity bias" means context-adaptation methods drop domain detail in favour of concise summaries. "Context collapse" means that repeatedly rewriting a whole context erodes its detail over time. ACE avoids both with structured, incremental, itemized delta updates instead of full rewrites, and reports +10.6% on agent benchmarks (AppWorld) and +8.6% on finance. — [ACE, arXiv:2510.04618](https://arxiv.org/abs/2510.04618v2) (ICLR 2026: [poster](https://iclr.cc/virtual/2026/poster/10008343)). The paper's widely cited example (a context of about 18k tokens collapsing to about 122 tokens, with accuracy falling below baseline) appears in the full text but was not visible in the abstract I fetched; verify it before quoting.
- **ExpeL.** Adding Reflexion-style reflections to insight extraction dropped HotpotQA from 39.0% to 29.0%, which the authors attribute to hallucinated reflections misleading the extraction. — [arXiv:2308.10144](https://arxiv.org/pdf/2308.10144)
- **Memory poisoning (MINJA).** With query-only access to a shared memory, an attacker achieved 98.2% average injection success and 76.8% average attack success across EHRAgent, RAP/WebShop and a QA agent (up to 98.9% attack success for RAP with GPT-4o). — [MINJA, arXiv:2503.03704](https://arxiv.org/html/2503.03704v5)
- **Self-reinforcement in ReasoningBank-style scaling.** Weaker memories got *worse* with test-time scaling (Synapse Pass@1 40.6 to 40.1, AWM 44.4 to 41.2), while ReasoningBank improved. — [ReasoningBank, arXiv:2509.25140](https://arxiv.org/html/2509.25140v1)

### Inferences
- For Singularity: an in-sample replay gate is the setting where experience-following *flatters* memory. The replay task resembles the source task, so copying looks good. The literature (Evo-Memory's similarity correlation; Xiong's add-all collapse) predicts that gains shrink on dissimilar held-out tasks.
- Rewriting workflows from scratch every 3 changes risks ACE-style context collapse. Itemized delta edits with per-item counters (ACE, ExpeL) are the evidence-backed alternative.
- Memory built only from commits is mostly protected from the "failed runs labelled as success" problem, because a commit is a stronger success signal than an LLM judge. The commit does not guarantee the *session path* was good, though, so dead-end steps from the session log can still be learned.
- Local-first memory reduces the MINJA-style multi-user poisoning risk, but a malicious repository (for example, text in files the agent reads) could still seed bad workflows.

### Gaps
- No public study of memory hurting in Claude Code specifically, beyond the Meetless draft and VibeMemBench (which solvers it used was not visible in the abstract).
- ACE's exact collapse numbers were not verified from the full text.

## Q3. Learning from failures: insights, reflections, guidelines, warnings

### Takeaway
Failure-derived memories help when they are distilled into conditional "pitfall" or guardrail statements, and hurt when raw failed trajectories or hallucinated reflections are stored. The best direct ablation, ReasoningBank on WebArena-Shopping, shows that adding distilled failure lessons gains about 3 points, while workflow-style memory (AWM) *loses* points from the same failures. No found study cleanly isolates "failure warnings only" against "success procedures only".

### Cited Findings
- **ReasoningBank.** Successful runs yield strategies; failed runs yield "pitfalls and counterfactual guardrails". Ablation on WebArena-Shopping with Gemini-2.5-flash, going from success-only to success plus failure memory:
  - Synapse (stored trajectories): 40.6 to 41.7
  - **AWM (workflows): 44.4 to 42.2**
  - ReasoningBank: 46.5 to 49.7

  On SWE-bench Verified, resolution went from 34.2 to 38.8 (Gemini-2.5-flash) and 54.0 to 57.4 (Gemini-2.5-pro), with steps reduced by 2.8 and 1.3. — [arXiv:2509.25140](https://arxiv.org/html/2509.25140v1)
- **ExpeL.** Insights come from comparing failed and successful attempts at the same task, plus patterns across successes.
  - Insights-only against retrieval-only of successful trajectories: HotpotQA 36% against 31%, ALFWorld 50% against 55%, WebShop 37% against 38%. Insights help reasoning tasks; retrieved procedures help procedural ones.
  - Full ExpeL: ALFWorld 59% against ReAct 40%; HotpotQA 39% against 28%.
  - Gathering experience without retries, and so without success/failure pairs, did worse than gathering with Reflexion. — [arXiv:2308.10144](https://arxiv.org/pdf/2308.10144)
- **AutoGuide.** Guidelines are extracted by contrasting trajectories with different returns. Each guideline is conditional ("in context C, do or avoid X") and retrieved only when its context matches. The paper reports it beats ExpeL, which puts all guidelines in the prompt. I could not verify the numbers from the excerpt fetched. — [AutoGuide, arXiv:2403.08978](https://arxiv.org/html/2403.08978v2)
- **Evo-Memory.** Adding failed trajectories *raw* hurt ExpRAG and AWM sharply, while ReMem, which refines and prunes memory, held up (0.54 Gemini, 0.81 Claude). — [arXiv:2511.20857](https://arxiv.org/html/2511.20857v1)
- **Budget-constrained study.** Failed runs leaking into success-labelled memory, and memories acting as distracting hints, are named causes of no net gain. — [arXiv:2606.15017](https://arxiv.org/pdf/2606.15017)

### Inferences
- For Singularity: "trap warnings were the clearest win" is consistent with the literature.
  - Pitfall and guardrail memory is the one failure-derived form with positive ablations (ReasoningBank, ExpeL).
  - Procedure memory (AWM-like workflows) is the form most often found neutral or harmful once overhead and staleness are counted.
  - Warnings are also staleness-robust in a way steps are not. A warning asserts a condition to check ("if you see X, don't do Y"), not content that must still be true, and Singularity already triggers them on substrings in tool output.
- AutoGuide's main lesson is context-conditional retrieval. That matches trigger-based warnings that fire only when their words appear, rather than warnings dumped into the task-start hand-over.

### Gaps
- No study isolates warnings-only against procedures-only with matched token budgets on coding tasks.
- AutoGuide's quantitative results were not retrieved.

## Q4. Evaluating memory and continual-learning agents

### Takeaway
Sound evaluation needs four things:
- Held-out tasks: different from the tasks memory was built from, or at least later in time.
- Several runs per condition: agent pass@1 swings 2–6 pp between identical runs.
- Budget-matched baselines that charge memory-building and retrieval tokens to the memory system.
- Simple baselines: retrieve similar past examples, recency, a plain agent with more steps.

Coding-specific benchmarks now exist (SWE-Bench-CL, SWE Context Bench, VibeMemBench). They mostly show small or negative gains for off-the-shelf memory.

### Cited Findings
- **Variance (SWE-bench Verified; 60,000 trajectories, 10 runs × 6 configurations × 500 tasks).**
  - A single run's pass@1 varies by 2.2–6.0 pp; the standard deviation is about 1.5–1.8 pp, and the variance persists at temperature 0.
  - At 80% power and p<0.05, a 2 pp gain needs about 9 runs per agent, a 1 pp gain about 36 runs, and a 10 pp gain about 1 run.
  - Recommendation: report pass@k and pass^k alongside pass@1.
  - Trajectories diverge within the first 1% of tokens. — [On Randomness in Agentic Evals, arXiv:2602.07150](https://arxiv.org/html/2602.07150v2) ([ICLR 2026](https://iclr.cc/virtual/2026/10016323))
- **Task-level instability.** On Gemini Shopping, 54.0% of tasks succeeded in at least one of 3 runs but only 42.3% in all 3. Online, sequential memory also prevents parallel re-runs. — [arXiv:2606.15017](https://arxiv.org/pdf/2606.15017)
- **Cost-inclusive accounting.** Count the actor's tokens plus every module call (induction, retrieval, verification) and the extra prompt tokens injected. Compare against a vanilla agent given the same token or step budget. — [arXiv:2606.15017](https://arxiv.org/pdf/2606.15017)
- **SWE-Bench-CL.** 273 SWE-bench Verified tasks across 8 repositories, each ordered chronologically (then by difficulty). Proposed metrics: forgetting, forward and backward transfer, tool-use efficiency, and a composite CL-Fβ score. Tasks are weakly similar to one another (patch-token Jaccard 0.111, TF-IDF cosine 0.179; only one pair above 0.4). The memory experiments are *proposed, not run*. — [SWE-Bench-CL, arXiv:2507.00014](https://arxiv.org/html/2507.00014v1)
- **SWE Context Bench.** Related-task pairs come from issue and PR cross-references (376 related tasks from 1,100 base tasks). Conditions separate oracle from free retrieval, and full trajectories from summaries, which isolates *selection* error from *content* value. — [arXiv:2602.08316](https://arxiv.org/html/2602.08316v3)
- **VibeMemBench.** Executable tests, real repository histories, and memory evaluated on *held-out solvers* different from the one that generated the history. — [arXiv:2609.23570](https://arxiv.org/abs/2609.23570)
- **Evo-Memory.** A streaming search–predict–evolve protocol, a task-order robustness test (easy to hard against hard to easy), a step-efficiency metric (AlfWorld 22.6 to 11.5 steps with ReMem), and ExpRAG and ExpRecent as simple baselines. — [arXiv:2511.20857](https://arxiv.org/html/2511.20857v1)
- **MemoryAgentBench.** Four competencies: accurate retrieval, test-time learning, long-range understanding, and selective forgetting. Long-context models often beat retrieval for test-time learning and long-range understanding. — [arXiv:2507.05257](https://arxiv.org/html/2507.05257v3)
- **The memory's quality signal matters.** In Xiong et al., gains depend on the evaluator: a fine-tuned judge on 300 examples was needed for stable deletion. — [arXiv:2505.16067](https://arxiv.org/html/2505.16067v2)

### Inferences
- For Singularity:
  - (1) An in-sample replay score used as a gate is the evaluation this literature warns about most. Use the next real commits in the repository as a chronological held-out split (SWE-Bench-CL style): build memory from commits ≤ t and evaluate on tasks after t.
  - (2) Charge the building cost (about 2/3 of the no-memory bill per round in one test) to the memory arm, and compare against a no-memory agent given the same extra budget (budget-matched baseline).
  - (3) Gains under about 5 pp need about 4 or more runs per condition; under 2 pp, about 9 or more.
  - (4) Include an ExpRAG-style baseline: retrieve the most similar past session summary or commit diff, with no induction.
  - (5) Include a git-log baseline: `git log -p` of the touched files.
- Report pass^k (whether a run is reliably right) as well as cost. Memory that cuts tokens but adds variance may not be a win.

### Gaps
- No published guidance found on amortizing memory-building cost over future uses (break-even analysis); this has to be derived.
- No benchmark found for continual learning *within one repository's live history with a real user*; all use replayed public issues.

## Q5. Mining repository history as context: is git history a strong baseline?

### Takeaway
Repository history is a real and cheap signal. Injecting blame-commit context improved agentic program repair by +4.4% (Defects4J) to +38.6% (BugsInPy), and the union of three history heuristics by +31% and +70%, at no significant extra cost. VibeMemBench finds that useful experience exists in repository history, but packaged memory systems mostly fail to deliver it. Git history is therefore a strong baseline that any learned memory should be measured against.

### Cited Findings
- **HAFixAgent.** History is injected from `git blame` on the buggy lines: function names of co-changed files in the blame commit, before and after bodies of the function, or the file-level diff.
  - Benchmarks: 854 Defects4J and 501 BugsInPy bugs, run with DeepSeek-V3.2-Exp.
  - History against no history: 545 against 522 (+4.4%) on Defects4J, 377 against 272 (+38.6%) on BugsInPy.
  - The three heuristics fixed largely different bugs; their union fixed 684 (+31%) and 463 (+70.2%).
  - Against RepairAgent on Defects4J: 545 against 348.
  - History did not significantly change steps or cost in most categories; median successful repairs cost about $0.005–0.07.
  - With line-shift noise, no-history fell to 0% while history configurations kept 40–56%.
  - Caveats: assumes perfect fault localization; success means plausible patches; possible training contamination; only 71.1% (Defects4J) and 87.4% (BugsInPy) of bugs are blameable. — [HAFixAgent, arXiv:2511.01047](https://arxiv.org/html/2511.01047) ([code](https://github.com/SAILResearch/HAFixAgent))
- **VibeMemBench.** Verified experience mined from 3,634 repository trajectories gives +1.1–4.5 pp on 4 of 5 held-out solvers when injected directly, while 11 of 12 memory-system pairings do not beat memory off. — [arXiv:2609.23570](https://arxiv.org/abs/2609.23570)
- **SWE-Bench-CL dependencies.** Dependencies between tasks are estimated from overlapping modified file paths, a co-change signal. Patch similarity between tasks in the same repository is low (cosine 0.18). — [arXiv:2507.00014](https://arxiv.org/html/2507.00014v1)
- **Lore.** Proposes git commit trailers as an agent knowledge protocol, co-located and immutable. It has no empirical results. — [arXiv:2603.15566](https://arxiv.org/html/2603.15566v1)

### Inferences
- For Singularity: "git log gave similar info for free" is consistent with HAFixAgent, where plain blame and diff history gives sizeable gains at near-zero cost. The value a learned workflow memory adds over git should be demonstrated, not assumed. Candidate sources of that value:
  - Places *read* before editing, which git doesn't record.
  - Commands and verification steps.
  - Traps hit in sessions that never reach a commit.
- Low patch similarity between tasks in the same repository (SWE-Bench-CL) suggests most new tasks won't closely match a stored workflow. A memory that injects only when a match is strong, and otherwise falls back to pointers into git history, fits that evidence.
- History derived from git is fresh by construction (it reflects the current tree via blame), which addresses Q1's staleness problem.

### Gaps
- No head-to-head study found of git-history context against learned procedural memory on the same coding tasks with matched cost.
- No data found on co-change mining (files that change together) as agent context in 2025–26 agent benchmarks beyond HAFixAgent's `fn_all` heuristic.
