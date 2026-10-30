# Procedural memory for LLM agents: storage formats, induction, validation, updating, and coding results

Scope: academic and industry research (2023 to Oct 2026) on how agents store "how to do it" knowledge learned from past runs. Numbers were checked against arXiv full text or abstracts during this session unless marked "(abstract only)" or "(not re-fetched)". All numbers are as the authors report them; almost none are replicated by third parties.

## Q1. What representations work best (raw trajectories, NL workflows, code skills, insights/rules, templated plans)?

### Takeaway
No single format wins everywhere. Abstracted, compact items (NL workflows, insight bullets, strategy items, plan templates) beat raw trajectories on held-out or cross-domain splits and cost far less context, while raw trajectories win when the task depends on exact action sequences in the same environment. Executable, verified skills (code) beat text skills where an execution environment can check them. For coding, the strongest evidence favors short, correctly chosen summaries of related past fixes and pitfall-style items, not full trajectories or generic overviews.

### Cited Findings

**Natural-language workflows: Agent Workflow Memory (AWM), arXiv 2409.07429, ICML 2025**
- Format: each workflow is an NL description plus steps; each step = NL state description, reasoning, executable action. Example-specific values are abstracted into placeholders such as `{product-name}` — [arXiv 2409.07429](https://arxiv.org/html/2409.07429v1)
- WebArena (GPT-4, 812 tasks, online induction on the test stream): 35.5% success vs BrowserGym 23.5% (+12.0 abs, 51.1% relative) and SteP's human-written workflows 33.0%; 5.9 steps per task. Gains appear within about the first 40 queries — [arXiv 2409.07429](https://arxiv.org/html/2409.07429v1); [ICML 2025 proceedings](https://proceedings.mlr.press/v267/wang25bx.html)
- Mind2Web offline (GPT-4): step success 45.1% vs MindAct 36.2%; task success only 4.8% vs 2.0%. Online cross-task / cross-website / cross-domain step SR 43.6 / 33.9 / 35.5, and the margin over MindAct grows with train-test gap (about 7.4 to 16.9 abs points) — [arXiv 2409.07429](https://arxiv.org/html/2409.07429v1)
- Ablations: abstract workflows beat retrieving concrete full examples (Synapse-style) by +5.0 element accuracy and +4.0 step SR; LM-induced vs rule-based induction 45.1 vs 43.4 on Mind2Web but 35.5 vs 35.6 on WebArena; text vs code-form workflows 45.4 vs 45.1 step SR but 3.6 vs 4.8 task SR; NL state descriptions beat raw HTML, and mixing both was worst; exposing workflows as callable actions (AWM-AS) was used in only 18.5% of tasks — [arXiv 2409.07429](https://arxiv.org/html/2409.07429v1)

**Programmatic skills: ASI (Agent Skill Induction), arXiv 2504.06821; SkillWeaver, arXiv 2504.07079; Voyager, arXiv 2305.16291**
- ASI induces skills as programs, verifies them by execution during induction, and reuses them. WebArena: +23.5% success over a static baseline and +11.3% over its text-skill counterpart, with 10.7 to 15.3% fewer steps; the authors attribute most of the gain to the "programmatic verification guarantee". Skills transfer across websites; incompatible ones get updated (abstract only; absolute vs relative not stated there) — [arXiv 2504.06821](https://arxiv.org/abs/2504.06821)
- SkillWeaver: agent explores a website, practices candidate skills, distills them into "plug-and-play APIs". Relative success gains of 31.8% on WebArena and 39.8% on real websites; APIs from strong agents improve weaker agents by up to 54.3% on WebArena (abstract only) — [arXiv 2504.07079](https://arxiv.org/abs/2504.07079)
- Voyager: an ever-growing library of executable JavaScript skills, refined with environment feedback, execution errors and self-verification. 3.3x more unique items, 2.3x longer distances, key tech-tree milestones up to 15.3x faster than prior SOTA; library reused zero-shot in a new world (abstract only) — [arXiv 2305.16291](https://arxiv.org/abs/2305.16291)

**Insights/rules: ExpeL, arXiv 2308.10144 (AAAI 2024)**
- Stores NL insights plus a pool of successful trajectories for retrieval. Insights-only vs retrieval-only: HotpotQA 36% vs 31% (insights better for analytical tasks), ALFWorld 50% vs 55% (concrete trajectories better where exact action sets matter). Note: the paper's text about ALFWorld vs Reflexion is internally inconsistent (says "outperforms" but quotes 54% vs 59%) — [arXiv 2308.10144](https://arxiv.org/html/2308.10144v3)

**Strategy items from success and failure: ReasoningBank, arXiv 2509.25140 (Google)**
- Item = title + one-sentence description + content (distilled reasoning, decision rationale, pitfalls), deliberately stripped of low-level execution details; embedding top-k retrieval into the system prompt — [arXiv 2509.25140](https://arxiv.org/html/2509.25140v1)
- WebArena success rate (No memory / Synapse / AWM / ReasoningBank): Gemini-2.5-flash 40.5 / 42.1 / 44.1 / 48.8; Gemini-2.5-pro 46.7 / 47.7 / 47.6 / 53.9; Claude-3.7-sonnet 41.7 / 42.6 / 40.8 / 46.3 (AWM below no-memory for Claude) — [arXiv 2509.25140](https://arxiv.org/html/2509.25140v1); [Google Research blog](https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/)

**Trajectory vs script vs both: Mem^p, arXiv 2508.06433**
- Compared storing gold trajectories, distilled "scripts" (abstract guidance), and "proceduralization" (both). Proceduralization was best. Trajectories did better on the dev split; scripts generalized better to the test split — [arXiv 2508.06433](https://arxiv.org/html/2508.06433v3)
- ALFWorld test success, no memory to proceduralization: GPT-4o 42.14 to 77.86 (steps 23.76 to 15.01); Claude-3.5-sonnet 34.97 to 74.72; Qwen2.5-72B 41.25 to 77.19. TravelPlanner (GPT-4o): commonsense 71.93 to 79.94, steps 17.84 to 14.62, but hard-constraint score fell 12.88 to 9.76 — [arXiv 2508.06433](https://arxiv.org/html/2508.06433v3)
- Retrieval keys: query-based and keyword-based ("AveFact") keys beat random sampling — [arXiv 2508.06433](https://arxiv.org/html/2508.06433v3)

**Evolving playbook of bullets: ACE (Agentic Context Engineering), arXiv 2510.04618, ICLR 2026**
- Context = itemized bullets, each with an ID, helpful/harmful counters and content (strategy, domain concept or failure mode); Generator / Reflector / Curator roles — [arXiv 2510.04618](https://arxiv.org/pdf/2510.04618)
- AppWorld (DeepSeek-V3.1): ReAct 42.4, ICL 46.0, GEPA 46.4, Dynamic Cheatsheet 51.9, ACE 59.4 offline / 59.5 online; matched IBM CUGA (60.3, GPT-4.1) on the leaderboard average. Finance (FiNER + Formula): base 69.1, ACE offline 81.9 vs GEPA 72.5 — [arXiv 2510.04618](https://arxiv.org/pdf/2510.04618)
- Limitation: tasks needing only concise instructions (HotPotQA, Game of 24) gain little from long playbooks — [arXiv 2510.04618](https://arxiv.org/pdf/2510.04618)

**Self-curated cheatsheet: Dynamic Cheatsheet, arXiv 2504.07952**
- Test-time memory of reusable strategies, code snippets and insights; no labels needed. GPT-4o on Game of 24: 10% to 99% after discovering and reusing a Python solution; Claude 3.5 Sonnet more than doubled on AIME; +9% GPQA-Diamond, +8% MMLU-Pro (abstract only) — [arXiv 2504.07952](https://arxiv.org/abs/2504.07952)

**Templated plans with keyword cache keys: Agentic Plan Caching (APC), arXiv 2506.14852, NeurIPS 2025** (closest published analogue to Singularity's design)
- Stores (keyword, plan template) pairs; templates strip entity names and numbers; extracted only after a cache-miss run finished with correct output (rule-based log filter then a small-LLM filter). On a hit, a small model (LLaMA-3.1-8B) adapts the template to the task's specifics — [arXiv 2506.14852](https://arxiv.org/html/2506.14852v2)
- Cache key: GPT-4o-mini extracts one higher-level intent keyword (e.g., "mean calculation"); exact keyword match by default. Query-similarity keys had more false positives and negatives because they overweight names. Fuzzy matching on FinanceBench: exact 46% hit / $1.86 / 85.5% acc; >80% fuzzy 54% / $1.15 / 83.0%; >60% 64% / $0.93 / 77.0%. Full-history caching (raw logs) scored 72.0% vs 85.5% for templates — [arXiv 2506.14852](https://arxiv.org/html/2506.14852v2)
- Overall: 50.31% average cost cut, 27.28% latency cut, 96.61% of best accuracy retained. Low hit rates on heterogeneous tasks (GAIA); authors suggest disabling caching when hit rates stay low — [arXiv 2506.14852](https://arxiv.org/html/2506.14852v2)

**Case banks / structured experience: Memento, Agent KB**
- Memento: case-based reasoning over an episodic case memory with a learned case-selection policy (memory-augmented MDP), no LLM fine-tuning. GAIA validation 87.88% Pass@3, test 79.40%; DeepResearcher 66.6 F1; case memory adds 4.7 to 9.6 abs points on out-of-distribution tasks (abstract only) — [arXiv 2508.16153](https://arxiv.org/abs/2508.16153)
- Agent KB: experience = problem pattern, goal, abstracted solution trajectory (optionally failure modes), context; student retrieves workflow-level, teacher retrieves step-level experiences. Ablation: raw workflow instead of structured experiences 58.18 vs 61.21 on GAIA — [arXiv 2507.06229](https://arxiv.org/pdf/2507.06229v5)

**Trajectories as exemplars and verbal reflection (older baselines)**
- Synapse (arXiv 2306.07863) stores abstracted state + full trajectories as exemplars, retrieved by similarity; reports 99.2% average on MiniWoB++ and a 56% relative step-SR gain on Mind2Web (not re-fetched this session) — [arXiv 2306.07863](https://arxiv.org/abs/2306.07863)
- Reflexion (arXiv 2303.11366) stores verbal self-reflections in an episodic buffer across retries of the same task; 91% pass@1 on HumanEval vs 80% for GPT-4 (not re-fetched; within-task memory, not cross-task procedural memory) — [arXiv 2303.11366](https://arxiv.org/abs/2303.11366)
- Learn-by-Interact (arXiv 2501.10893) synthesizes trajectories from documentation and back-constructs instructions from them; up to +12.2% in-context (Claude-3.5) and +19.5% via training (Codestral-22B) across SWE-bench, WebArena, OSWorld, Spider2-V (abstract only) — [arXiv 2501.10893](https://arxiv.org/abs/2501.10893)

### Inferences
- The pattern across AWM, ExpeL, Mem^p and APC: abstraction helps transfer, concrete traces help same-environment exact replay, and combining a short abstract guide with one concrete example (Mem^p "proceduralization") is the safest default.
- APC is the most direct precedent for Singularity's "template with blanks + keyword cue + fill at use". It succeeded only with (a) a model-extracted *intent* keyword, not surface words, (b) a small LLM doing the filling rather than positional substitution, and (c) templates saved only from verified-correct runs. Singularity's weak keyword recall and positional blank filling match APC's documented failure modes (low hit rate on heterogeneous tasks; fuzzy matching trading accuracy for hits).
- ReasoningBank and ACE store bullets that are mostly strategies and failure modes, not step templates; this matches Singularity's finding that trap/mistake warnings and command order were the clearest wins.

### Gaps
- No head-to-head study found comparing templated workflows with blanks vs pitfall bullets on the same coding benchmark.
- ASI, SkillWeaver, Voyager, Dynamic Cheatsheet, Memento and Learn-by-Interact numbers here come from abstracts; full-paper ablations and sample sizes were not checked.
- AWM, ReasoningBank and ACE online settings learn on the test stream itself; that is "held-out" only in the sense that labels are not used.

## Q2. Abstraction level: when do abstract workflows beat concrete trajectories, and how well do memories generalize across tasks and repos?

### Takeaway
Abstract memories win as the gap between past and new tasks grows (cross-website, cross-domain, test vs dev); concrete trajectories win for near-duplicate tasks with fixed action sets. For coding, cross-repo reuse works only when the item is short, abstract, and correctly matched; wrong or unfiltered context gives nothing or hurts.

### Cited Findings
- AWM's gain over MindAct grows from about 7.4 to 16.9 step-SR points as splits move from cross-task to cross-domain — [arXiv 2409.07429](https://arxiv.org/html/2409.07429v1)
- Mem^p: trajectories better on the dev split, scripts generalize better to test; combined is best — [arXiv 2508.06433](https://arxiv.org/html/2508.06433v3)
- ExpeL: insights beat retrieved trajectories on HotpotQA (36 vs 31) but lose on ALFWorld (50 vs 55) — [arXiv 2308.10144](https://arxiv.org/html/2308.10144v3)
- ReasoningBank gains are largest on Mind2Web's cross-domain split — [arXiv 2509.25140](https://arxiv.org/html/2509.25140v1)
- Agent KB abstracts experiences "from simpler tasks" to transfer to harder ones; structured experiences beat raw workflows (61.21 vs 58.18 GAIA) — [arXiv 2507.06229](https://arxiv.org/pdf/2507.06229v5)
- SWE-Exp excludes same-repo experiences to avoid leakage, so its gains are cross-repo: experiences are a "perspective" (abstract problem understanding) plus up to three generalized "modification" insights. Ablation: using raw problem statement + gold patch instead of extracted experience drops 42.0 to 36.0 (DeepSeek-V3, SWE-bench Verified) — [arXiv 2507.23361](https://arxiv.org/html/2507.23361v2)
- SWE-ContextBench (arXiv 2602.08316; 1,100 experience tasks + 376 related tasks, 51 repos, 9 languages; Lite: 300 + 99, Python, 12 repos). Claude Sonnet 4.5 on Lite (99 tasks): baseline 26.26%; oracle-chosen summary (about 217 tokens) 34.34%; oracle full trajectory (about 25,600 tokens) 27.27%; freely retrieved summary 22.22% (below baseline); freely retrieved full trajectory 26.26%. Authors: reuse helps "only when context is compact and correctly chosen" — [arXiv 2602.08316](https://arxiv.org/html/2602.08316)
- The same benchmark tested off-the-shelf memory frameworks: Supermemory 30.30%, Mem0 24.24% (below the 26.26% baseline) — [arXiv 2602.08316](https://arxiv.org/html/2602.08316)
- APC: keyword (intent) keys generalize better than query-similarity keys, which overweight specifics like names — [arXiv 2506.14852](https://arxiv.org/html/2506.14852v2)
- Strong-to-weak transfer works: SkillWeaver APIs from strong agents give weak agents up to +54.3% on WebArena (abstract only) — [arXiv 2504.07079](https://arxiv.org/abs/2504.07079); GPT-4o's Mem^p memory lifts Qwen2.5-14B by about 5% completion on TravelPlanner and cuts 1.6 steps — [arXiv 2508.06433](https://arxiv.org/html/2508.06433v3)

### Inferences
- For Singularity: retrieval precision dominates. SWE-ContextBench shows a 12-point gap between oracle and free selection, and free selection of summaries fell *below* no memory. A memory system whose picker has weak recall/precision can be net negative even if its items are good. A "show nothing unless confident" policy is supported by the data.
- Positional blanks are a form of concrete replay; the evidence suggests filling them by a model (APC) or not having them at all (ReasoningBank/ACE-style strategies) generalizes better across tasks.

### Gaps
- No study found that measures cross-*repository* generalization of templated workflows specifically (as opposed to abstract insights).
- SWE-ContextBench Lite has only 99 evaluation tasks; differences of a few points are within noise and no confidence intervals were reported in what I read.

## Q3. How are memories validated before being kept, and does learning from failures help?

### Takeaway
Three validation gates appear: execution/verification (ASI, Voyager, SkillWeaver), success filtering by ground truth or an LLM judge (AWM online, APC, Mem^p "validation"), and none (Dynamic Cheatsheet, ReasoningBank keeps everything but labels it). Programmatic verification is credited with most of ASI's gain. Learning from failures helps when failures are turned into explicit pitfall/strategy items (ReasoningBank, SWE-Exp, ExpeL) but hurts when failed traces are stored as workflows (AWM).

### Cited Findings
- AWM online: an LLM evaluator labels each attempt; only predicted successes become workflows. The paper notes that learning from incorrect predictions can degrade performance — [arXiv 2409.07429](https://arxiv.org/html/2409.07429v1)
- ASI attributes most of its success-rate gain to verifying skills by execution during induction (abstract only) — [arXiv 2504.06821](https://arxiv.org/abs/2504.06821)
- APC extracts a template only after a run "finished with correct outputs" — [arXiv 2506.14852](https://arxiv.org/html/2506.14852v2)
- ReasoningBank failure ablation (WebArena-Shopping, Gemini-2.5-flash), success-only vs with failures: Synapse 40.6 to 41.7; AWM 44.4 to 42.2 (worse); ReasoningBank 46.5 to 49.7 (better). Failures are judged by an LLM-as-judge without ground truth and turned into "counterfactual signals and pitfalls" — [arXiv 2509.25140](https://arxiv.org/html/2509.25140v1)
- SWE-Exp mines failed trajectories into "reflections" against the gold patch (perspective correction + modification mistakes); removing comprehension experience costs 3.2 points, modification experience 2.6 points — [arXiv 2507.23361](https://arxiv.org/html/2507.23361v2)
- ExpeL compares a failed with a successful trajectory of the same task to find right and wrong actions — [arXiv 2308.10144](https://arxiv.org/html/2308.10144v3)
- ACE without labels (execution feedback only) still reached 57.2 offline on AppWorld vs 59.4 with labels; but on finance, unlabeled online adaptation degraded both ACE and Dynamic Cheatsheet because noisy signals polluted the context. ACE needs a reasonably strong Reflector — [arXiv 2510.04618](https://arxiv.org/pdf/2510.04618)
- Mem^p's "validation" strategy keeps only successful trajectories; its "adjustment" strategy (revise the memory in place after a failed use) was best — [arXiv 2508.06433](https://arxiv.org/html/2508.06433v3)
- Agent KB had human annotators write correction templates for some failures, used as few-shot examples for the extractor; authors note validation "may miss subtle flaws" — [arXiv 2507.06229](https://arxiv.org/pdf/2507.06229v5)

### Inferences
- For Singularity: a git commit is a weak success signal (it may be reverted or broken). The literature's strongest gate is execution (tests passing), which Singularity can approximate by checking CI or whether a commit survived. Failures are most valuable as pitfall bullets, which matches Singularity's finding that trap/mistake warnings were the clearest win; turning failed runs into workflows is the documented anti-pattern (AWM).

### Gaps
- No paper found that isolates the effect of execution-verified vs LLM-judged success filtering on coding tasks.

## Q4. How do systems update, merge or delete memories, and what is known about bloat, staleness and "context collapse"?

### Takeaway
Most research systems only append (ReasoningBank, AWM, SWE-Exp, APC). Those that maintain memory use counters and votes (ExpeL, ACE), in-place revision after failed use (Mem^p), embedding dedup (ACE), or verification against current code at use time (GitHub Copilot memory). Whole-memory LLM rewrites cause "context collapse". More retrieved memory past a small k hurts. Staleness is handled only by a few systems, and similarity search cannot tell an outdated fact from a duplicate.

### Cited Findings
- **Context collapse:** in a Dynamic Cheatsheet run on AppWorld, context at step 60 was 18,282 tokens at 66.7% accuracy; one rewrite shrank it to 122 tokens and accuracy fell to 57.1%, below the 63.7% no-context baseline. ACE also names "brevity bias": optimizers favor short generic instructions and drop domain heuristics and failure modes — [arXiv 2510.04618](https://arxiv.org/pdf/2510.04618)
- ACE's fix: localized delta updates merged by deterministic non-LLM code, helpful/harmful counters per bullet, and semantic dedup ("grow-and-refine"), run per delta or lazily when the window fills. Versus Dynamic Cheatsheet online on FiNER: 91.5% lower latency, 83.6% lower token cost — [arXiv 2510.04618](https://arxiv.org/pdf/2510.04618)
- ExpeL: ADD / EDIT / UPVOTE / DOWNVOTE on insights; new insights start at importance 2, removed at 0 — [arXiv 2308.10144](https://arxiv.org/html/2308.10144v3)
- ReasoningBank consolidation is "a simple addition operation" (append-only), by design — [arXiv 2509.25140](https://arxiv.org/html/2509.25140v1)
- Too much memory hurts: Mem^p performance rises then plateaus with more retrieved memories, and too many hurt through interference — [arXiv 2508.06433](https://arxiv.org/html/2508.06433v3). SWE-Exp: 1 experience best (42.0), 0 gives 37.8, 2 gives 39.8, 4 gives 39.0; bank benefits plateau around 300 experiences (75-instance subset) — [arXiv 2507.23361](https://arxiv.org/html/2507.23361v2). APC: beyond about the number of unique task keywords, a larger cache adds little — [arXiv 2506.14852](https://arxiv.org/html/2506.14852v2)
- Agent KB says it has no systematic deprecation or version control — [arXiv 2507.06229](https://arxiv.org/pdf/2507.06229v5)
- **GitHub Copilot agentic memory (industry, Jan 2026):** each memory = subject, fact, citations (file:line), reason. No offline curation, dedup or batch expiry: before using a memory the agent checks the cited code; if the code contradicts it or the location is gone, it stores a corrected version; if valid and useful, it re-stores it (refreshing the timestamp). Retrieval loads the most recent memories for the repo. A/B: coding-agent PR merge rate 83% to 90%; code-review precision +3%, recall +4%; p < 0.00001. Adversarially seeded stale/contradicting memories were detected and corrected ("self-healing") — [GitHub blog](https://github.blog/2026-01-09-building-an-agentic-memory-system-for-github-copilot)
- **MemStrata (arXiv 2606.26511, draft, not peer reviewed):** cosine similarity cannot separate contradictions from duplicates (AUROC 0.59 on 98 pairs). On evolving-code scenarios (renames, config migrations, dependency bumps, API evolution; 20 to 30 scenarios each), RAG answered 0.20 to 0.47 and served the superseded value 15 to 40% of the time; a deterministic supersession ledger reached 0.95 to 1.00. Only on structured single-value facts; extraction quality on messy NL contradictions about 44% — [arXiv 2606.26511](https://huggingface.co/papers/2606.26511.md)
- ASI and SkillWeaver update skills that break when a website changes (abstract-level claim) — [arXiv 2504.06821](https://arxiv.org/abs/2504.06821)

### Inferences
- For Singularity's staleness problem, the most directly applicable evidence is Copilot's "cite code locations, verify at use time, rewrite or refresh" loop, which matches Singularity v1's "places kept as the blocks around an edit and found in the code at use". Adding an explicit "verified/refreshed at" timestamp and dropping items whose places can no longer be found would follow that design.
- Retrieval should be capped at about 1 to a few items; SWE-Exp and Mem^p both show more hurts.
- Never let one LLM call rewrite the whole memory; use itemized deltas with deterministic merge (ACE).

### Gaps
- No controlled study found measuring how fast procedural memories go stale in active repos, or the accuracy cost of serving stale workflows on coding tasks (MemStrata covers facts, not procedures).
- The Copilot numbers are a vendor A/B with no released data.

## Q5. Results on coding / software-engineering tasks

### Takeaway
Experience memory gives modest gains on SWE-bench (about +3 to +9 points) in research settings, larger with weaker models; repository context files (AGENTS.md-style) generated by LLMs slightly hurt and raise cost by about 20%, while minimal human-written ones help about 4%; retrieved skills help strong agents a little and can hurt weaker ones. Specific tooling instructions are reliably followed, which fits Singularity's "command order" win.

### Cited Findings
- **SWE-Exp** (SWE-bench Verified, 500 issues, Pass@1): Claude 4 Sonnet 73.0% vs OpenHands 70.4%, SWE-Agent 66.6%; DeepSeek-V3 42.0% vs no-experience 37.8% (also reported as 37.2% elsewhere in the paper). Cost +7.5% tokens (189.1K to 203.3K), wall time 12m37s to 15m49s. Experiences can mislead when they don't match and the agent cannot judge applicability. Python only; possible training-data overlap — [arXiv 2507.23361](https://arxiv.org/html/2507.23361v2)
- **ReasoningBank** on SWE-bench Verified: 34.2 to 38.8 (Gemini-2.5-flash), 54.0 to 57.4 (Gemini-2.5-pro), with fewer steps — [arXiv 2509.25140](https://arxiv.org/html/2509.25140v1)
- **Agent KB** on SWE-bench Lite (300 tasks): o3-mini pass@1 23.00 to 31.67; GPT-4.1 24.33 to 28.33. The paper's prose claims larger gains that do not match its tables (flagged) — [arXiv 2507.06229](https://arxiv.org/pdf/2507.06229v5)
- **SWE-ContextBench**: oracle-selected 217-token summaries +8 points over baseline for Claude Sonnet 4.5 (26.26 to 34.34, Lite, 99 tasks); freely retrieved summaries -4 points; GPT-5.3 Codex 22.60 to 23.94 with oracle summaries — [arXiv 2602.08316](https://arxiv.org/html/2602.08316)
- **Evaluating AGENTS.md** (arXiv 2602.11988; AGENTbench 138 tasks / 12 repos plus SWE-bench Lite 300 tasks; Claude Code/Sonnet-4.5, Codex/GPT-5.2 and GPT-5.1 mini, Qwen Code; one run per instance): LLM-generated context files lowered resolution in 5 of 8 settings (about -0.5% Lite, -2% AGENTbench), added 2.45 to 3.92 steps and about 20 to 23% cost. Developer-written files helped about +4% on average (not for Claude Code) but still added steps. Codebase overviews did not shorten the path to the relevant files. Specific tooling instructions were followed (uv used 1.6x per instance when mentioned vs under 0.01 when not). Recommendation: only minimal requirements — [arXiv 2602.11988](https://arxiv.org/html/2602.11988v1)
- **Agent skills in the wild** (arXiv 2604.04323; 34,198 open-source skills; SkillsBench 84 tasks x3 runs; Terminal-Bench 2.0 89 tasks): Claude Opus 4.6 on SkillsBench 35.4 no skills, 51.2 curated (agent chooses), 38.4 retrieved without curated; distractors cut 51.2 to 43.5; retrieved skills put Kimi K2.5 and Qwen3.5 below their no-skill baselines. Terminal-Bench 2.0 (Claude): 57.7 no skills, 61.4 retrieved, 65.5 with query-specific refinement — [arXiv 2604.04323](https://arxiv.org/html/2604.04323v1)
- **Learn-by-Interact** includes SWE-bench among four benchmarks; up to +12.2% ICL with Claude-3.5 (abstract only, per-benchmark split not checked) — [arXiv 2501.10893](https://arxiv.org/abs/2501.10893)
- **GitHub Copilot memory**: coding-agent PR merge rate 83% to 90% in production A/B — [GitHub blog](https://github.blog/2026-01-09-building-an-agentic-memory-system-for-github-copilot)

### Inferences
- The realistic ceiling for cross-task memory on SWE-style benchmarks is a few points of resolve rate plus some step savings, with real downside when retrieval is wrong. A memory layer should be judged against "no memory" and "git log/blame only" baselines, and should abstain more often.
- The AGENTS.md study supports Singularity's observations: generic overviews (which git history and the code already give) add cost without helping, while concrete repo-specific commands and requirements get followed. Pitfall warnings and command order are the content most consistent with what helped across ReasoningBank, ACE, SWE-Exp and the AGENTS.md study.

### Gaps
- I found no published study that mines *git commits* (rather than agent trajectories) into procedural memory and measures it on a coding benchmark, nor one that compares such memory to giving the agent `git log` directly.
- Most SWE results use one run per instance and no confidence intervals; gains of 2 to 4 points on 300 to 500 tasks are near run-to-run noise.
