# Retrieval and injection of procedural memory for agents

Sourcing note. Items marked [fetched] were read in full or in summary during this research (October 2026). Items marked [abstract-level] come from well-known papers whose headline numbers I know but did not re-fetch this session. Check those numbers against the arXiv page before quoting them in a final report.

## Q1. Lexical (BM25/substring) vs dense vs hybrid vs LLM reranking for retrieving experiences, workflows and examples

### Takeaway
Pure lexical matching is the weakest option whenever wording changes. On agent-memory benchmarks, BM25 trails dense retrieval by about 16 points and hybrid plus rerank by about 20. On procedural retrieval it loses about 42% of its quality when object vocabulary changes. Indexing an abstracted, object-free summary of each procedure is the single biggest generalization lever. Hybrid retrieval plus a reranker (often an LLM picking 1 of the top N) is the best-supported design.

### Cited Findings
- **LoCoMo, 3x3 grid** (GPT-5-mini backbone, text-embedding-3-small, k=5). Mean accuracy: BM25 57.1%, cosine 73.4%, hybrid + GPT-5.2 rerank 77.2%. The roughly 20-point gap between hybrid and BM25 held across all write strategies. Retrieval precision correlated with accuracy at r=0.98. Hybrid reranking cut retrieval failures from 35.3% to 11.4% for Basic RAG. Retrieval failure was the dominant error (11–46% of questions), well ahead of utilization failure (4–8%) and hallucination (0.4–1.4%). Raw-chunk "Basic RAG" with zero LLM calls at write time (77.9% cosine, 81.1% hybrid) matched or beat LLM-extracted facts and summaries — [Diagnosing Retrieval vs. Utilization Bottlenecks, arXiv 2603.02473](https://arxiv.org/html/2603.02473v2) [fetched]
- **Procedural memory retrieval benchmark** (ALFWorld trajectories; MAP on seen vs unseen object vocabularies):

  | Method | Seen | Unseen | Drop |
  |---|---|---|---|
  | BM25 | 0.815 | 0.469 | −42.5% |
  | Keyword Jaccard | 0.780 | 0.456 | −41.5% |
  | Combined embeddings | 0.844 | 0.592 | −29.9% |
  | Object-agnostic LLM summaries, embedded | 0.754 | 0.671 | −11.0% |

  The summary method rose from last place on seen queries to first on unseen ones. The authors call this a "generalization cliff" and argue that encoders treat procedures as bags of words — [A Benchmark for Procedural Memory Retrieval in Language Agents, arXiv 2511.21730](https://arxiv.org/html/2511.21730v1) [fetched]
- **SWE-Exp** (past issue-fix experiences on SWE-bench Verified). Experiences are indexed by inferred issue type and a generalized description, embedded with E5-large. It takes the top 10 by cosine, and an LLM rerank agent picks 1. Results (DeepSeek-V3):
  - Full system: 42.0%.
  - Without LLM reranking: 38.2% (−3.8).
  - Without abstraction (raw issue plus gold patch as demonstration): 36.0% (−6.0).
  - Claude-4 Sonnet: 73.0%.

  — [SWE-Exp, arXiv 2507.23361](https://arxiv.org/html/2507.23361v2) [fetched]
- **Abstract insights vs raw trajectories for cross-task reuse.** Raw trajectories gave negative forward transfer: −9.5 points on ALFWorld A→B and −7.5 on BabyAI A→B. Abstracted insights gave +6.5 and +9.0. Negative transfer fell mostly on cases the no-memory agent had failed — [Experience Reuse in LLM Agents, arXiv 2604.27003](https://arxiv.org/html/2604.27003v1) [fetched]
- **Code retrieval (CodeRAG-Bench).** Average NDCG@10: BM25 57.7, GIST-large 61.7, Jina-v2-code 65.4, SFR-Mistral 67.0. BM25 is near-competitive on lexical-heavy sets (CodeSearchNet 89.1 vs about 90.7). On SWE-bench-Lite retrieval, BM25 (43.0) beat Voyage-code (29.1) — [CodeRAG-Bench, arXiv 2406.14497](https://arxiv.org/html/2406.14497v2) [fetched]
- **Anthropic's Contextual Retrieval.** Prepending chunk context before embedding cut top-20 retrieval failure by 35%. Adding contextual BM25 brought the cut to 49%, and adding a reranker brought it to 67% — [Anthropic, Introducing Contextual Retrieval (Sept 2024)](https://www.anthropic.com/news/contextual-retrieval) [abstract-level]
- **Zep/Graphiti.** Search combines cosine, BM25 full-text and graph breadth-first search, then reranks with RRF, MMR, node distance or a cross-encoder. Reported results: Deep Memory Retrieval 94.8% vs MemGPT 93.4%, and on LongMemEval up to 18.5% higher accuracy with about 90% lower latency — [Zep, arXiv 2501.13956](https://arxiv.org/abs/2501.13956) [abstract-level]
- **Generative Agents.** The retrieval score is the sum of normalized recency (exponential decay), importance (rated 1–10 by an LLM) and relevance (embedding cosine) — [Park et al., arXiv 2304.03442](https://arxiv.org/abs/2304.03442) [abstract-level]
- **MemoryBank.** Dense retrieval (FAISS) plus Ebbinghaus-style decay and reinforcement of memories — [arXiv 2305.10250](https://arxiv.org/abs/2305.10250) [abstract-level]
- **Retrieval designs in other systems** [all abstract-level]:
  - ExpeL retrieves top-k successful trajectories by embedding similarity of the task, while its distilled insights are always injected — [ExpeL, arXiv 2308.10144](https://arxiv.org/abs/2308.10144).
  - Synapse retrieves trajectory exemplars by similarity of task metadata. It reports 99.2% average success on MiniWoB++ and a 56% relative step-success gain on Mind2Web — [Synapse, arXiv 2306.07863](https://arxiv.org/html/2306.07863v3).
  - RAP retrieves past experiences by the current context (multimodal) — [RAP, arXiv 2402.03610](https://arxiv.org/abs/2402.03610).
  - Agent Workflow Memory injects induced workflows for the website rather than retrieving per query. It reports +24.6% (Mind2Web) and +51.1% (WebArena) relative success — [AWM, arXiv 2409.07429](https://arxiv.org/abs/2409.07429).
  - A-MEM gives each note LLM-written keywords, tags and context plus an embedding, and links notes — [A-MEM, arXiv 2502.12110](https://arxiv.org/abs/2502.12110).
  - Mem0 extracts facts, retrieves them densely and reports +26% relative over OpenAI memory on LoCoMo, with about 91% lower p95 latency — [Mem0, arXiv 2504.19413](https://arxiv.org/abs/2504.19413).
- **Write-side indexing (LongMemEval).** Commercial assistants lose about 30% accuracy over long interactions. The paper finds that expanding stored keys with extracted facts, and time-aware query expansion, improve recall — [LongMemEval, arXiv 2410.10813](https://arxiv.org/abs/2410.10813) [abstract-level]

### Inferences
- **What this means for Singularity's substring cues.** The cues are the extreme lexical end of the spectrum, so the eval symptoms are what the literature predicts.
  - Paraphrases get nothing because lexical recall collapses under vocabulary shift (the −42% BM25 cliff).
  - Look-alike prompts get the wrong memory because lexical overlap is not procedural similarity, and nothing checks precision (cosine and BM25 precision@5 was only 10–29% on LoCoMo).
- **Cheapest well-supported fix, still local-first:**
  1. Index each workflow by an object-free, abstract "what kind of change this is" description written at build time (the CueWriter already runs then).
  2. Score with BM25 plus a small local embedding model, fused with RRF.
  3. Optionally add a rerank or verify step to pick 0 or 1.
- **On reranking.** SWE-Exp's 1-of-10 LLM rerank was worth +3.8 points. The same choice could be made by the running agent itself, at no extra call, if candidates are shown as short titles (see Q2).

### Gaps
- I found no study that measures exact-substring cue matching specifically. The nearest evidence is BM25 and keyword-Jaccard numbers.
- There is no head-to-head comparison of lexical, dense and hybrid retrieval over *code-change workflows* (as opposed to QA memory or ALFWorld).

## Q2. Push (inject at task start) vs pull (agent calls a memory tool)

### Takeaway
Evidence from coding agents favors push for knowledge the agent does not know it lacks. Agents fail to call optional retrieval tools most of the time unless they are told to explicitly. Pull wins when the agent is forced or well prompted to search, and can iterate its query. The best-supported pattern is a hybrid: push a small, high-precision index or pointer, and let the agent pull details.

### Cited Findings
- **Vercel's Next.js agent evals, 27 Jan 2026.** The agent never invoked an available skill in 56% of cases. Pass rates:

  | Setup | Pass rate |
  |---|---|
  | Baseline | 53% |
  | Skill, default | 53% (no gain) |
  | Skill plus explicit instruction to use it | 79% |
  | Compressed docs index always in AGENTS.md | 100% |

  The stated reasons: there is no decision point, the content is always available, and there are no ordering issues. Vercel still recommends skills for explicit, user-triggered workflows — [Vercel, AGENTS.md outperforms skills in our agent evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) [fetched]
- **Letta's filesystem agent** (GPT-4o-mini, tools `grep`, `search_files`, `open`, `close`) scored 74.0% on LoCoMo, against Mem0's best reported 68.5%. Tool rules *forced* the first call to be `search_files`, and the agent then iterated its own queries. Letta's conclusion: what matters is whether the agent knows when and how to use retrieval, more than the store (graph or vector) — [Letta, Benchmarking AI Agent Memory (12 Aug 2025)](https://www.letta.com/blog/benchmarking-ai-agent-memory) [fetched]
- **MemGPT/Letta** pioneered agent-managed, pull-style memory through function calls (paging between core, recall and archival memory) — [MemGPT, arXiv 2310.08560](https://arxiv.org/abs/2310.08560) [abstract-level]
- **Anthropic's context-engineering guidance** describes "just-in-time" retrieval through lightweight identifiers and tools, against pre-loaded retrieval. Claude Code is a hybrid: CLAUDE.md is loaded up front, and glob/grep pull the rest — [Anthropic, Effective context engineering for AI agents (Sept 2025)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) [abstract-level]
- **Agents follow retrieved memory almost mechanically** ("experience-following"). Similarity between the input and the retrieved record predicts similarity of the output, with Pearson r near 1 for RegAgent. Pushed memory is therefore very influential, for better or worse — [How Memory Management Impacts LLM Agents, arXiv 2505.16067](https://arxiv.org/html/2505.16067v2) [fetched]

### Inferences
- Singularity's finding that agents never called the recall command matches the Vercel result: optional tools go unused without an explicit decision point.
- Options that the evidence supports:
  - Push a compact list of candidate workflow *titles* (an "index"), not full bodies, and instruct the agent to open one if it applies. This mirrors the AGENTS.md index.
  - Make the pull mandatory at a defined step, like Letta's forced first `search_files`.
- Pushing full bodies combines with experience-following, so wrong pushed memory gets copied. That argues for pushing high-precision summaries and letting the agent pull the long text.

### Gaps
- I found no controlled study of push vs pull specifically for procedural or workflow memory in coding agents, beyond the Vercel docs eval.

## Q3. Irrelevant or wrong retrieved context hurts

### Takeaway
Strong, consistent evidence. Distracting or near-miss context lowers accuracy, length alone lowers accuracy, and in agents wrong memories get copied and errors compound. More is not better: SWE-Exp peaks at exactly 1 retrieved experience, and CodeRAG-Bench at about 5 documents.

### Cited Findings
- **SWE-Exp, by number of experiences:** 0 → 37.8%, 1 → 42.0%, 2 → 39.8%, 4 → 39.0%. The authors attribute the decline to irrelevant or conflicting information — [arXiv 2507.23361](https://arxiv.org/html/2507.23361v2) [fetched]
- **Adding every memory hurts** (success rates):

  | Agent | Fixed memory | Add-all | Strict utility filter |
  |---|---|---|---|
  | RegAgent | 67.53 | 55.48 | 70.95 |
  | EHRAgent | 16.75 | 13.05 | 38.50 |
  | AgentDriver | 40.11 | 32.32 | 51.00 |

  Errors in memory propagate and the gap widens over time. History-based deletion improves results further (CIC-IoT 85.4 → 89.6) — [arXiv 2505.16067](https://arxiv.org/html/2505.16067v2) [fetched]
- **Cross-task raw trajectories caused up to −9.5 points**, concentrated on hard cases — [arXiv 2604.27003](https://arxiv.org/html/2604.27003v1) [fetched]
- **CodeRAG-Bench:**
  - Retrieval can hurt strong models. DeepSeekCoder-7B on HumanEval fell from 70.1 (no context) to 68.9 with BM25 and to 53.0 with reranked docs.
  - Appending more low-ranked documents "may introduce noise." About 5 documents is optimal.
  - Strong models copy functions from context or overwrite the target function.
  - GPT-4o on SWE-bench-Lite: 2.3 with no retrieval, 6.7 with BM25, 21.7 with reranked retrieval, 30.7 with gold documents.

  — [arXiv 2406.14497](https://arxiv.org/html/2406.14497v2) [fetched]
- **Length alone hurts.** With perfect retrieval and masked distractors, accuracy still fell (Llama-3.1-8B HumanEval −50 points at 30K masked tokens; GPT-4o GSM8K −7 at 30K whitespace). A "recite evidence, then solve" step recovered accuracy from 35.5% to 66.7% in one setting — [Context Length Alone Hurts, arXiv 2510.05381](https://arxiv.org/html/2510.05381v1) [fetched]
- **Chroma's "Context Rot" study** (18 models including Claude 4, GPT-4.1, Gemini 2.5; 194,480 calls):
  - Performance degrades with input length.
  - Plausible distractors hurt more than unrelated text.
  - Degradation is worse when the needle is semantically less similar to the question.
  - LongMemEval scores drop sharply from focused inputs to full ones.

  — [Chroma context rot summary](https://www.zenml.io/llmops-database/context-rot-evaluating-llm-performance-degradation-with-increasing-input-tokens); [code](https://github.com/chroma-core/context-rot) [fetched, summary only, no effect sizes]
- **Lost in the Middle.** The accuracy curve is U-shaped over document position; evidence in the middle of the context is used worst — [Liu et al., arXiv 2307.03172](https://arxiv.org/abs/2307.03172) [abstract-level]
- **GSM-IC.** Irrelevant sentences in math problems sharply cut accuracy. An instruction to ignore irrelevant information partly mitigates this — [Shi et al., arXiv 2302.00093](https://arxiv.org/abs/2302.00093) [abstract-level]
- **"Power of Noise."** In RAG, *related-but-wrong* (distracting) passages hurt more than random ones — [Cuconasu et al., arXiv 2401.14887](https://arxiv.org/abs/2401.14887) [abstract-level]
- **Original SWE-bench.** A larger BM25 context raised file recall but lowered resolve rate — [SWE-bench, arXiv 2310.06770](https://arxiv.org/abs/2310.06770) [abstract-level]

### Inferences
- A wrong workflow at task start is worse than none. It is "related-but-wrong," the most harmful kind of distractor, and agents follow memory closely.
- Injecting up to about 10k characters by default is costly unless precision is high. The experience-reuse evidence points to one well-chosen item, abstracted, rather than many.

### Gaps
- Chroma's per-condition numbers were not available in the fetched summary.
- I found no study quantifying the harm of wrong *template parameter values* specifically.

## Q4. Relevance thresholds and abstention ("retrieve nothing if unsure")

### Takeaway
Gating retrieval, deciding when to retrieve and how much to trust the result, consistently beats always-retrieve in RAG. In agent memory, strict quality filters beat add-all. Abstention is well supported in principle. Thresholds have to be calibrated per retriever, and reported practice uses evaluator judgments or reranker confidence rather than raw cosine.

### Cited Findings
- **Strict utility evaluators beat add-all** by up to +25 points (EHRAgent 13.05 → 38.50) — [arXiv 2505.16067](https://arxiv.org/html/2505.16067v2) [fetched]
- **Adaptive retrieval.** Retrieving only for less-popular entities, and skipping it when the model already knows, beats always retrieving in both accuracy and cost — [Mallen et al., arXiv 2212.10511](https://arxiv.org/abs/2212.10511) [abstract-level]
- **Self-RAG** trains reflection tokens that decide whether to retrieve and whether a passage is relevant — [arXiv 2310.11511](https://arxiv.org/abs/2310.11511) [abstract-level]
- **CRAG** uses a retrieval evaluator with confidence thresholds (correct / incorrect / ambiguous) and discards retrieval judged incorrect — [arXiv 2401.15884](https://arxiv.org/abs/2401.15884) [abstract-level]
- **NLI filtering** of retrieved passages makes RAG robust to irrelevant context — [Yoran et al., arXiv 2310.01558](https://arxiv.org/abs/2310.01558) [abstract-level]
- **Training-free gating** of retrieval exists — [TARG, arXiv 2511.09803](https://arxiv.org/html/2511.09803v1) [search result only]
- **When to retrieve** can be learned — [arXiv 2404.19705](https://arxiv.org/pdf/2404.19705) [search result only]
- **SWE-Exp's rerank agent** effectively acts as a gate, choosing k=1, and k=0 performs worse than k=1 — [arXiv 2507.23361](https://arxiv.org/html/2507.23361v2) [fetched]

### Inferences
- For Singularity: require a match score margin, or an agreement test (lexical and embedding both rank the workflow first), before pushing a full body. Otherwise push nothing, or only titles.
- Log abstentions so they can be evaluated, much as `skipped.jsonl` does for skipped commits.

### Gaps
- No agent-memory paper I found reports a tuned cosine threshold value or a precision/recall curve for abstention on procedural memory.

## Q5. Filling a retrieved template's parameters: model vs rules

### Takeaway
The dominant practice is to abstract specifics away when storing and let the LLM adapt or fill at use time. AWM uses abstract placeholders, and SWE-Exp uses a "reuser" agent with no object names. Rule-based positional filling has no supporting evidence, and wrong concrete values are dangerous given experience-following.

### Cited Findings
- **AWM** induces workflows in which example-specific values are replaced by abstract variables (for example `{product-name}`). The agent fills them in context — [AWM, arXiv 2409.07429](https://arxiv.org/abs/2409.07429) [abstract-level]
- **SWE-Exp** extracts experiences with no specific object names, and a reuser agent adapts the chosen experience to the new issue. Dropping abstraction in favor of the raw issue and patch cost 6 points — [arXiv 2507.23361](https://arxiv.org/html/2507.23361v2) [fetched]
- **Object-agnostic summaries** generalize best for retrieval (−11% vs −42% under vocabulary shift) — [arXiv 2511.21730](https://arxiv.org/html/2511.21730v1) [fetched]
- **Agents copy retrieved records closely** (input/output similarity correlation near 1), so a wrong concrete value is likely to be reproduced — [arXiv 2505.16067](https://arxiv.org/html/2505.16067v2) [fetched]
- **Strong models copy** functions from retrieved context — [CodeRAG-Bench](https://arxiv.org/html/2406.14497v2) [fetched]

### Inferences
- "The Nth code span or quoted string" is a brittle rule-based slot filler.
- Safer alternatives:
  - Leave blanks as named placeholders with a one-line description, and let the agent fill them.
  - Fill a blank only when its value is unambiguous (exactly one candidate of the right type, verified to exist in the repository), and mark it "guessed" otherwise.

### Gaps
- I found no controlled comparison of rule-based vs LLM slot filling for agent workflow templates.

## Q6. Code-specific retrieval for coding agents

### Takeaway
Repository-level retrieval helps when it is precise, and iterating retrieval with generation helps further. Retrieving past fixes works best as one abstracted, reranked experience. Lexical BM25 remains a strong baseline for code-to-code and file localization.

### Cited Findings
- **SWE-Exp** retrieves past repair experiences across repositories (excluding the same repository and future data to avoid leakage). The experience bank saturates at about 300 experiences — [arXiv 2507.23361](https://arxiv.org/html/2507.23361v2) [fetched]
- **CodeRAG-Bench** SWE-bench-Lite numbers: see Q3. BM25 achieved 43.0 NDCG on SWE-bench retrieval, above some dense code retrievers — [arXiv 2406.14497](https://arxiv.org/html/2406.14497v2) [fetched]
- **RepoCoder.** Iterative retrieval-generation (using the draft completion as the next query) beats in-file and one-shot retrieval baselines on repository-level completion by more than 10% — [arXiv 2303.12570](https://arxiv.org/abs/2303.12570) [abstract-level]
- **Agentless** localizes hierarchically (repository tree, then files, classes and functions, then edit locations), combining LLM ranking with embedding retrieval — [arXiv 2407.01489](https://arxiv.org/abs/2407.01489) [abstract-level]

### Inferences
- RepoCoder's draft-as-query idea maps onto Singularity: re-query memory with the agent's first exploration or plan, for example through the tool-call hook after the first reads. That catches paraphrased prompts that the task text alone misses.

### Gaps
- I found no published study on retrieving a project's *own* past commits or diffs as procedural memory for the same repository with Claude Code-class agents.
