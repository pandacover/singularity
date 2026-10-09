# The "new job" benchmark, second version of web memory: results (2026-10-09, afternoon)

**Memory v2 still fails the bars: 3 of 6 hold, against 2 for the first
version.** It harmed 2 chores where the first version harmed 4. It fixed the
three failures the fixes were aimed at, and it has the fewest trap hits of any
condition with memory. It is still not faster on repeat work (10% fewer
turns where the bar asks for 20%). One harm is new: a keystroke step learned
on the app's old screens that broke on the new ones.

**This was not a sealed test.** I had read the benchmark's reveal and every
run of the first version before writing the fixes
(`PREREGISTRATION-v2.md`). So this shows the fixes fix what they were aimed
at, on a benchmark I had seen. It doesn't show they work on apps nobody has
seen.

Numbers: `runs/new-job/REPORT-numbers-v2.md` (the pre-registered computation,
`final.ts`) and `runs/new-job/COMPARE-v2.md` (per chore, side by side,
`compare.ts`).

## 1. Harm first

| Phase | Chore | What it was | Memory v2 passed | No memory passed | Why |
|---|---|---|---|---|---|
| learn | L12 | change an address | 0 of 1 | 1 of 1 | The parcel was already with the carrier, and nothing on the form says so. Same failure as the first version. Today's run without memory failed it too (0 of 1), so this one is close to a coin flip |
| update | U02 | change an account's owner, after the update | 1 of 2 | 2 of 2 | Memory's step said to "pick the option with ArrowDown + Enter", learned on the old screens. On the new owner form Enter submits the form, so it went in with the wrong person (the autocomplete trap) and with "Also transfer open cases" still ticked; the update made that box start ticked. The agent had read the revised policy on the page and meant to untick it ("Memory says the opposite, so I'll follow the page"). The second pass passed |

The other way, memory v2 passing more often: **T07** (2 of 2 against 0 of 2,
and 0 of 1 today), **L11**, **T14**.

## 2. What failed before, first version against second

| Chore | No memory | Memory v1 | Memory v2 | No memory, today |
|---|---|---|---|---|
| L08 refund damaged goods | 1/1 | **0/1** | 1/1 | 1/1 |
| L14 close a case | 1/1 | **0/1** | 1/1 | 1/1 |
| L12 change an address | 1/1 | **0/1** | **0/1** | 0/1 |
| T07 close as a duplicate | 0/2 | 1/2 | 2/2 | 0/1 |
| U05 change an address, after the update | 2/2 | **1/2** | 2/2 | 1/1 |
| U02 change an owner, after the update | 2/2 | 2/2 | **1/2** | 1/1 |

L02 failed in every run, and T05 in every run but the guide's: the guide
states the rule T05 needed. No earlier session could have taught memory
either rule.

## 3. The bars

| Bar | Memory v1 | Memory v2 | Numbers for v2 |
|---|---|---|---|
| Learn: no more failures than no memory | no | **yes** | 2 of 18 against 2 of 18 |
| Test: no more failures than no memory | yes | yes | 2 of 30 against 5 of 30 |
| Update: no more failures than no memory | no | no | 1 of 16 against 0 of 16 |
| Test, repeats and shares-parts: turns 20% lower, success no lower | no (-3%) | no | 13 against 14.5 turns (-10%); 100% against 92% |
| Test, look-alikes and unrelated: success no lower, turns at most 10% higher | yes | yes | 10.5 against 12.5 turns; 83% against 67% |
| Update: success no lower, last half no more turns | no | no | 94% against 100%; last half 56.5 against 59.5 turns |

Across all 64 runs: memory v2 passed 59, no memory 57, memory v1 56. Trap
hits: 3, 5 and 6. In the test phase memory v2 used 11 turns and 111k tokens
per chore (medians), against 13 and 138k without memory.

## 4. What each fix did

1. **Every rule at every start** won T07 (2 of 2; no memory 0 of 3 over
   three passes). Memory now handed over the close form's rule, "'Send
   satisfaction survey' starts ticked; decide from the task", and the note on
   that form fired when the agent opened it. The agent unticked the box for a
   duplicate case.
2. **What sessions left alone** won L08. L01 had unticked "Restock items" for
   smashed goods; memory saw the box starts ticked and wrote, before any
   failure, a rule and a step to untick it for damaged goods. The first version
   only learned this from L08's own failure. L14 passed too, but not thanks to
   the fixes: memory had nothing on closing cases yet, so no procedure was
   handed over and the agent read the form, as without memory.
3. **Learning right after a failure** ran a round after each of the three
   failures in the learn and update phases (L02, L12, U02), where the first
   version would have waited. I can't point to a chore it decided. Keeping
   rules when the replay turns a revision down happened once in each update
   pass (U08), live.

## 5. The new lesson

U02's failure is the first version's failure in a new form: a confident step
the agent follows instead of reading. This time it was a keystroke ("ArrowDown
+ Enter") that was right on the old screens and wrong on the new ones. U02 was
the first chore in that app after the update, so memory hadn't seen the new
screens yet. Its places behaved: none pointed anywhere, because the controls
had moved. But a keystroke inside a step's text is never checked against the
page. By the app's next chore (U06), memory had relearned the new route.
Steps that say how to operate a control (keys, shortcuts) go stale with the
UI, just as places do, and only places are checked at use.

## 6. Drift since last night

A third pass without memory ran alongside, not pooled into the baseline: learn
15 of 18, test 13 of 15, update 8 of 8. It failed the same chores as last
night (L02, L11, T05, T07), plus L12. Nothing drifted; L12 is noisy without
memory.

## 7. Against the baselines (test and update, first pass)

The guide passed 23 of 23, AWM's workflows 22, memory v2 21 and no memory 20.
Memory v2 used the fewest tokens (median 125k against 142k to 151k). The
one-page guide still wins on success.

## How it was run

- **Freeze:** memory code frozen at 11:46 UTC (sha256 `0c25b98f…`, 159 files),
  checked again by the run script before the first run. Code memory is
  untouched; only the web reader changed.
- **Seal:** the benchmark's seal (`8e65d2f9…`) was re-checked before the first
  run.
- **Two runner crashes:** the benchmark's runner crashed twice on a reset,
  the same crash as last night. The script's second try ran the lost chores.
- **No refusals:** all 105 runs completed normally; none was refused for a
  usage limit.
- **Cost:** $8.86 of Claude Code's figures for the agent runs, plus $3.80 for
  memory's learning.
