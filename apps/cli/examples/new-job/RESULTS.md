# The "new job" benchmark: results (2026-10-09)

**Memory fails the bars it was given before the runs.** It harmed 4 chores
(passed them less often than no memory did) and helped 3. On repeat work it was
3% faster where the bar asked for 20%. It never beat the company's one-page
onboarding guide. The guide passed every chore after the learn phase (23 of
23); then came Agent Workflow Memory's workflows (22), our memory (21) and no
memory (20).

What held up: memory used the fewest tokens, and it learned the apps' unwritten
rules from a manager's feedback. When the apps were updated, it never pointed
the agent to a control that had moved, and it relearned within a few sessions.

How it was run: `DESIGN-one-layer.md` (design and bars),
`PREREGISTRATION.md` (order, freeze, amendment). Every number comes from
`runs/new-job/REPORT-numbers.md`, produced by `examples/new-job/final.ts`.

## The benchmark

Built by a separate Claude agent (Opus 5.5) from a brief, sealed before any
run (sha256 `8e65d2f9…`, re-verified afterwards with the builder's own
function; no file changed after sealing):

- **The company:** a homewares seller, Fernhill Supply Co., with three
  internal tools: Hatchway (orders, refunds, addresses, stock), Tidepool CRM
  (accounts, contacts, cases) and Quire Billing (invoices, payments, credits).
  There's also a maze game, Burrow.
- **The chores:** 41 in all: 18 to learn from, 15 to test and 8 after an
  unannounced update. The test chores split evenly into 3 repeats, 3 new kinds
  that share parts with learned ones, 3 look-alikes, 3 unrelated chores and 3
  mazes.
- **13 traps:**
  - "Restock items" ticked by default on refunds.
  - Enter on the address form books a $4 carrier amendment.
  - An autocomplete that picks the first match (Priya Naidu before Priya Nair).
  - Date fields in DD/MM.
  - Forms that clear on an error.
  - Look-alike forms, and dead-end pages.
- **12 house rules, 4 of them silent:** the app accepts a breach, and only the
  manager's feedback says what was wrong.
- **The update:** pages and buttons moved to new addresses (old ones return
  404), a refund threshold dropped from $500 to $250, and a required field
  was added.
- **The mazes:** five hidden mechanics (sinkholes, one-way arrows, keys and
  doors, ice, portals), with a new layout in every game.

## 1. Harm first

| Phase | Chore | What it was | Memory passed | No memory passed | Why |
|---|---|---|---|---|---|
| learn | L08 | refund a damaged order | 0 of 1 | 1 of 1 | Memory's refund steps (reason, note, review, confirm) never mentioned the pre-ticked "Restock items"; the agent followed them and restocked damaged goods (trap fired) |
| learn | L14 | close a case | 0 of 1 | 1 of 1 | Same pattern: memory's close-case steps left out the pre-ticked survey box; 6 turns against 12, and the survey went out (rule C-3) |
| learn | L12 | change an address | 0 of 1 | 1 of 1 | Memory handed over only "open the order"; the agent went fast and didn't notice the parcel was already with the carrier (rule R-5) |
| update | U05 | change an address | 1 of 2 | 2 of 2 | One memory run used "Save & notify carrier" on an unshipped order. Its hand-over said nothing about carriers, so this is likely noise, but it counts |

The other way, memory passing more often: **L11** (memory had learned rule C-2
from an earlier failure's feedback; no memory broke it), **T14** (2 of 2
against 1 of 2: the survey rule, learned and handed over), **T07** (1 of 2
against 0 of 2).

## 2. Numbers

Every run; the test and update phases ran twice for memory and for no memory
(the pre-registered amendment).

| Condition | Phase | Runs | Passed | Median turns | Median tokens |
|---|---|---|---|---|---|
| no memory | learn | 18 | 16 | 13.5 | 161k |
| memory | learn | 18 | 14 | 14 | 140k |
| no memory | test | 30 | 25 | 13 | 138k |
| memory | test | 30 | 27 | 13 | 141k |
| AWM | test | 15 | 14 | 11 | 129k |
| guide | test | 15 | 15 | 13 | 139k |
| no memory | update | 16 | 16 | 16 | 173k |
| memory | update | 16 | 15 | 13.5 | 123k |
| AWM | update | 8 | 8 | 15.5 | 157k |
| guide | update | 8 | 8 | 16 | 179k |

By kind of chore (test and update; share of runs passed, then median turns
per chore):

| Kind | No memory | Memory | AWM | Guide |
|---|---|---|---|---|
| repeat | 83% · 16 | 100% · 11 | 100% · 13 | 100% · 17 |
| shares parts | 100% · 13 | 100% · 15 | 100% · 11 | 100% · 14 |
| look-alike | 33% · 10.5 | 50% · 12 | 67% · 10 | 100% · 11 |
| unrelated | 100% · 15 | 100% · 14.5 | 100% · 15 | 100% · 14 |
| maze | 100% · 9 | 100% · 9.5 | 100% · 8 | 100% · 9 |
| updated, moved | 100% · 16.3 | 92% · 13 | 100% · 13.5 | 100% · 16 |
| updated, rule | 100% · 17 | 100% · 18.3 | 100% · 17 | 100% · 18 |

## 3. The bars

| Bar | Holds | Numbers |
|---|---|---|
| Learn: no more failures than no memory | **no** | 4 of 18 against 2 of 18 |
| Test: no more failures than no memory | yes | 3 of 30 against 5 of 30 |
| Update: no more failures than no memory | **no** | 1 of 16 against 0 of 16 |
| Test, repeats and shares-parts: median turns at least 20% lower, success no lower | **no** | 14 against 14.5 turns (-3%); passed 100% against 92% |
| Test, look-alikes and unrelated: success no lower, turns at most 10% higher | yes | 12 against 12.5 turns; passed 75% against 67% |
| Update: success no lower, last half no more turns | **no** | passed 94% against 100%; last half 51 against 59.5 turns |

## 4. What the failures teach

1. **A confident, incomplete procedure makes the agent stop reading the
   page.** Memory remembers what earlier sessions clicked, not what they left
   alone. So the pre-ticked "Restock items" and "Send satisfaction survey"
   boxes, which earlier sessions happened to handle by reading the form, never
   made it into the steps. Given the steps, the agent followed them and
   skipped the read. Without memory it reads, and catches them. Two of the
   four harms are exactly this.
2. **Rules arrive late.** A rule learned from a failure waits for the app's
   next learning round, every 3 sessions. With 4 to 5 sessions per app in the
   learn phase, the last lessons weren't in memory when the test phase began.
3. **Rules live inside workflows, so they're lost when the wording doesn't
   pick the workflow.** T07 ("close as a duplicate") picked nothing, so the
   survey rule memory did know never reached the agent. The guide states every
   rule every time; that is its whole advantage, and it was enough to win.
4. **The mazes didn't test what they were meant to.** Sonnet solved every
   maze in close to the fewest moves with or without memory (T15: exactly the
   fewest, 30 moves, in all six Sonnet runs). Memory learned no game rules from them, only a
   note about stale page references. With Haiku, memory did help on mazes:
   median 15 turns against 31, and near-optimal moves where Haiku without
   memory wandered (99 moves against 62, 54 against 30).

## 5. What held up

- **Learning rules from feedback.** Memory turned the manager's notes into
  rules with page triggers: never restock damaged goods (R-3), cancel rather
  than refund an unshipped order (R-6), move open cases with the account
  (C-2), surveys only on resolved cases (C-3), phone numbers with a country
  code, approver initials. When a rule reached the agent, it worked (L11,
  T14).
- **The update.** After the update, memory's pointers fired 0 times: the
  controls had moved, so memory said less rather than pointing somewhere
  wrong. Within three sessions it had relearned the moves ("the owner form is
  now behind the Manage menu"). Over the update it used 16% fewer turns and
  29% fewer tokens than no memory, though one run failed.
- **Look-alikes and unrelated chores.** Memory was no worse here: success 75%
  against 67%, turns 12 against 12.5.
- **Tokens.** Memory used the fewest tokens of all four conditions across test
  and update.

## 6. The stand-in for a second agent

Haiku with the memory Sonnet's runs built, frozen, on the test phase: 14 of 15
passed with memory and 14 of 15 without; median turns 16 against 15. No chore
was harmed or helped. It is the same family with one model swapped, so it
proves nothing about other agents. It does show that memory built by one
model doesn't break another.

## 7. What I'd change next

In order of what the evidence says matters:

1. **Hand over an app's rules every time,** not only inside a picked
   workflow. That would have won T07, and it's what the guide does. (T05
   needed R-6, which memory only learned later, from T05's own failure.)
2. **Learn what earlier sessions left alone.** For each form, which fields
   successful sessions changed and which they left at their default; a
   default that broke a rule becomes a warning on that form. The two
   pre-ticked boxes were 2 of the 4 harms.
3. **Learn right after a failure that came with feedback,** instead of
   waiting for the third session. It's cheap, and it's where the rules come
   from.
4. **Harder mazes,** where the mechanics matter more than the route, if mazes
   are to test rule learning. And more runs per chore: one or two runs can't
   tell a 3% difference from noise.

## How the night went

- **Code memory is unchanged:** byte-identical hand-overs through the new API.
- **Memory code was frozen before the first run** (sha256 `69219c63…`) and
  re-checked unchanged at 06:24Z.
- **The seal held:** the hash was verified afterwards, and an audit of 28
  sessions and 5,047 tool calls found nothing that read the benchmark, its
  logs or its builder's thread. Four calls mention those names: the setup of
  the guard, and one test of the guard, which the guard denied.
- **Two crashes and a pause:**
  - The benchmark's runner crashed twice (exit 0xC0000409 on a `reset`). The
    lost chores were run again, in order, before anything that depended on
    them.
  - A usage-limit pause stopped all work from 01:19Z to 06:24Z.
  - After the pause, the second pass ran before the Haiku stand-in instead of
    after it.
- **Cost:** 204 agent runs at $14.31 of Claude Code's figures, plus $3.97 of
  memory's learning calls and AWM's induction, on a subscription.
