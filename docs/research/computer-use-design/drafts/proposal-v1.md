# Computer use memory: proposal v1 (proposer's draft, for the critic)

Written 2026-10-28 against main at b8d6ae1. Draft for discussion, not the agreed write-up.

## 1. The problem

Coding memory leans on git for four things:

1. **A boundary.** A commit ends a task (`Cycle.ts`: a new task starts at the first request after HEAD moved).
2. **A success claim.** Memory stores a commit only when the last check before it passed (`Commits.ts`).
3. **The evidence, kept outside memory.** The diff lives in git and is read back exactly at use time (`Start.ts`, `Fresh.ts`), so memory stores a pointer.
4. **A name.** The commit message is what search and the Haiku pick find a change by (`Task.ts`, `Pick.ts`).

Computer use has none of these. So memory has to make its own boundary, its own success signal and its own name, and it has to keep the evidence itself, because there is no git to read it back from.

## 2. What our evidence says to copy and to avoid

From the earlier browser memory (`DESIGN-one-layer.md`, `examples/new-job/RESULTS.md`, `RESULTS-v2.md`; code removed in 2d18711):

- **Harms came from confident, incomplete procedures.** Steps that left out pre-ticked boxes made the agent stop reading the form (L08, L14). A keystroke step learned on old screens submitted the wrong form after a UI update (U02).
- **Rules lost when the wording didn't pick the workflow** (T07). The one-page guide that states every rule every time passed 23 of 23, the best of all arms.
- **On repeat chores memory was fastest.** v1, test and update phases: repeats passed 100% at a median of 11 turns, against 83% and 16 turns without memory, 13 for AWM and 17 for the guide. Look-alikes were its weak spot (50%, guide 100%).
- **Places checked against the live page behaved.** After the update they fired 0 times: memory said less instead of pointing somewhere wrong.
- **Learning cost a lot.** v2: $3.80 of learning calls on $8.86 of agent runs.

From coding memory on main: no learning step; one pointer or nothing; the Haiku pick (0 wrong and 10 right on 62 real starts, 30 of 31 reworded tasks, about $0.0013 a start); the measured help came from what the repo doesn't hold (check scripts, project commands), not from the pointed change. Agents rarely pull (Sonnet ran recall once in 177 sessions).

From the research report: at most one item, abstain when unsure; pitfalls beat procedures; verify at use time; ASI's executable skills failed on their first step in up to 72% of shopping checks because they named unstable element ids; AWM's workflows offered as callable actions were used in only 18.5% of tasks.

**So:** keep evidence, not workflows. Hand over what the guide had (rules, defaults, traps) every time an app is touched, and the one past run of the same process only when confident. Anchor everything we can to things we can check on the live screen. Spend no model at store time by default.

## 3. The mapping

| Coding today | Computer use |
|---|---|
| Subject: a repo | An app: a web origin (`app.example.com`), a desktop app's bundle id (`com.apple.Notes`), or an app MCP server (`mcp:Gmail`) |
| Unit: a commit | A **run**: one task cycle of a session that used computer use tools |
| Boundary: HEAD moved | A **write landed**: the session changed something outside itself |
| Success: last check passed before the commit | A **readback after the last write** showed a confirmation, and the person didn't correct the run |
| Evidence: the diff, in git | A **condensed trace**, kept by memory: actions with their targets in words, screens as patterns, writes and what the screen said after them |
| Name: the commit message | The person's request (first line), plus the app and the date |
| Same change, superseded (`sameChange`) | Same **process**: runs that landed the same writes on the same screens; only the newest confirmed run is handed over |
| Freshness: files changed since (`Fresh.ts`) | Anchors (a control's role and name on a screen pattern) checked against the live screen when the agent gets there |
| Facts card: check scripts | **App card**: the person's corrections for that app, fields that start set, traps, where results show up |
| git show add-on | **Screen notes**: when the agent reaches a screen memory knows, that screen's notes, once a session |

## 4. Capture

### 4.1 Which tools, and what each lets us anchor

A translator per tool family turns calls into one action form (verb, target in words, screen, failed or not), as `traces/Codex.ts` and `traces/Hermes.ts` turn other agents' logs into Claude Code's form today.

- **App MCP tools** (Gmail, Slack, Calendar and so on): the tool name is the anchor and writes are explicit (`send_message`, `create_event`). The easiest family; the computer-use skill tells Claude to prefer these when connected.
- **DOM-aware browsers**: Claude in Chrome (`mcp__claude-in-chrome__*`), the built-in browser (`mcp__Claude_Browser__*`), Playwright MCP (`mcp__playwright__browser_*`). Anchors: the page address and the role and name of each control (the accessibility tree). The removed `web/Snapshot.ts`, `Places.ts` and `Presets.ts` already parse this.
- **Desktop computer use** (`mcp__computer-use__*`, `mcp__remote-devices__computer_*`): each background call names its app by bundle id, and `app_menu` gives menu paths in words. Clicks are coordinates on screenshots, which are not anchors. So desktop gets the app, menu paths and the agent's own words, not screen notes.

### 4.2 The run

A run is one task cycle (`Cycle.ts`, unchanged) with one change: a new task starts at the first request after **a write landed** instead of after HEAD moved. A request before any landed write is a follow-up of the run under way. A cycle that ends in a commit stays a code change (its browser calls are its checks), so nothing is stored twice.

A **write** is an action that changes something outside the agent:

- app MCP tools: a tool whose name says send, create, update, delete, post, book, approve;
- DOM browsers: a click on a button, menu item or link whose name holds a verb from a short list (submit, send, save, confirm, pay, place, delete, apply, create, update, post, publish, book, approve, close), or Enter in a form field;
- desktop: a menu path or named button with such a verb; a coordinate click counts only when the agent's own line just before it names one.

It **landed** when the next screen the agent read shows a changed address, a closed dialog, or a status or alert line.

### 4.3 Outcome

A run is **confirmed**, the only kind ever handed over as a past run, when all of these hold:

1. after its last write, the agent read the screen again and saw a confirmation (the readback, which stands in for the check before a commit);
2. no call after its last write failed;
3. the person's next prompt in the session isn't a correction (starts with no, wrong, undo, that's not, you didn't, and the like: word rules in the style of `Requests.ts`, measured on real sessions before use).

A read-only run (it landed no write) is confirmed when the agent answered and the person didn't correct it. A **corrected** run is kept as evidence but never pointed to, and the person's correction is kept verbatim for that app's card (4.5).

When the person chose a model at setup (as for picks), Haiku may label runs the rules can't (my estimate: under a cent a run, like a pick; not measured). Off until measured.

### 4.4 What a run keeps

- the task: the person's request and follow-ups, as code records keep;
- the apps it touched, which it read from and which it wrote to;
- its steps, condensed: verb, target in words (role and name with the named regions around it, or a menu path), the screen as a pattern (address path with ids as `{n}`), failed or not;
- its writes, and what the screen said after each;
- the fields each form opened with already set, and whether the run changed them;
- detours: an action that failed, what the screen said, and the action that then worked.

Never kept: screenshots, typed text (a typed field keeps only its name: `typed into "Note"`), page text beyond control names, headings and status lines, query strings, anything typed into a password field.

Where: `<tenant>/runs/<app>/<id>.json`, apart from code records (they hold commits and diffs). A per-app index (`<tenant>/runs/index/<app>.json`: screen patterns, their anchors and notes, the card) is written at store time and read by the hooks in plain node, as `facts/Index.ts` and `facts/Lookup.ts` do.

When: at task start and session end, in the background (`Background.ts`, one run at a time under `store.lock`), from the session's log, as commits are stored. Never inside the tool-call hook. Runs looked at and left out go to a skipped log with the reason, and `status` shows them.

### 4.5 Processes and the app card, built without a model

- **Process**: confirmed runs whose writes hit the same targets on the same screens are one process, with a count and the newest run. Memory hands over only the newest confirmed run of a process (the `sameChange` and retire logic of `Start.ts`).
- **App card** (at most 700 characters, like the facts card): the person's corrections after runs in this app, verbatim with their date (newest three); fields that start set and how runs left them; traps seen in two runs or more; where results show up (the confirmations).

## 5. Recognise

### 5.1 At a task's start: one past run, or nothing

The same flow as code. The Haiku pick when the person chose it, word search otherwise, nothing below the bar, never more than one. Differences: there is no repo to scope by, so the list is the person's confirmed runs across apps (newest 150), each as `app · request's first line · date`; and a run whose screens a later run of the same process couldn't find is passed over as stale.

The pointer, about 500 characters, says what happened, never what to do:

```
You did a task like this in Hatchway (app.hatchway.example) on 2026-10-20 (4 times in all):
"Refund order 4412, the mug arrived broken". It ended with "Refund issued" on the order page.
Its screens: order page › Actions › Refund › Refund form › Review › Confirm refund.
On the Refund form "Restock items" starts ticked; that run unticked it.
See each step: singularity changes 7f3a. Read each screen as you go: the app may have changed.
```

No values it typed or chose, no keys, no coordinates. `singularity changes <id>` prints the condensed trace for an agent or person who wants it.

### 5.2 When the agent reaches a known screen

The analogue of the git show add-on. Setup adds the computer use tool names to the PostToolUse matcher (the new-job runs added `mcp__playwright__.*` by hand). After a call that read a screen, when the screen's pattern is in the app's index **and** at least one of its stored anchors is on the screen now, memory hands over that screen's notes once a session: fields that start set and how runs left them, a trap seen there. Nothing when the anchors are missing. The hook must stay near 0.1 s: tool name first, then one small JSON read.

### 5.3 When the agent first touches an app

The app card (4.5), once a session. This is our version of the guide that won on success, built from runs and the person's own words instead of written by hand.

### 5.4 Pull

`singularity recall` searches runs too, `changes` lists them per app, `changes <id>` shows one. No new commands (`singularity.ts` keeps the eight).

## 6. What we won't build, and why

- **Workflows a model writes, with blanks** (AWM style): they caused the new-job harms and cost 43% on top of the agent runs.
- **Replayable macros** (coordinates, element refs): they break on the next layout change (ASI's 72%).
- **Keys or shortcuts as instructions** (U02).
- **Anything that shortens the last look before an irreversible action.** The pointer reports the path; it never says "click Confirm". Claude itself never moves money (computer-use skill), and memory must not nudge it.
- **Screenshots in memory**, or a model at store time by default.

## 7. Privacy

Computer use sees mail, banks and health portals. Memory keeps only what 4.4 lists, in `~/.singularity`, and sends nothing anywhere. The pick sends run titles (the person's requests) to the person's chosen model through their own Claude Code, as code picks do today; numbers and email addresses in titles are masked first. An app the person lists as private is never stored.

## 8. How we'd know it works

1. **Capture only, no hand-over, on our own sessions for a week.** Count runs per app, how many are repeats of a process, and check run boundaries and outcome labels by hand on a sample. Replay task-start picks offline, as the 62-start check did. If repeats are rare, stop: no process memory can pay off.
2. **A new sealed browser benchmark**, built like new-job (separate agent, brief, seal), on apps nobody has seen. Arms: no memory, memory, a one-page guide. Three runs per chore per arm. Bars set before the runs: harms first, by chore; success no lower than no memory; median turns at least 20% lower on repeats; look-alikes and an unannounced UI update no worse than no memory; any model spend counted.
3. **Desktop**: capture only until the browser bench passes.

## 9. Build order

1. Translators, the run store, outcome labels; `changes` lists runs. Measure (8.1).
2. App card and screen notes. No task-start pointer yet.
3. The task-start pointer.

Each step measured before the next.

## 10. What comes from where

- **Unchanged from main**: the hooks and their rules (fast, never break a session), background storing, `Cycle.ts`, `Requests.ts`, `Search.ts`, `Pick.ts`, retiring, the hand-over log, `status`, `changes`, `visualise`, `recall`.
- **Back from the removed web reader** (2d18711^): `Snapshot.ts`, `Places.ts`, `Presets.ts`, the action reading in `Extract.ts`, the anchor check in `Step.ts`. Not `Induce.ts`, `Learn.ts` or `Awm.ts`.

## 11. Open questions for the critic

1. Is "a write landed" a good enough boundary, and how should read-only runs end?
2. Is the path in the pointer worth its risk, given L08 and L14?
3. Should desktop (coordinate clicks) be in scope at all before the browser works?
4. Are correction words a strong enough outcome signal, or must the person's verdict come another way?
5. A run across apps (an invoice from mail typed into accounting): which app owns it?
6. Not yet checked: whether Claude desktop app sessions run our Claude Code hooks for computer use tools, and where a cloud session linked to the person's computer keeps its log (likely in the cloud, out of local memory's reach).
