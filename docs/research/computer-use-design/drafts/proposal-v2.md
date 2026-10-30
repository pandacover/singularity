# Computer use memory: proposal v2

Written 2026-10-28 by the proposer, after the critic's review (`critic/review-v1.md`) of v1 (`drafts/proposal-v1.md`). Against main at b8d6ae1. Paths are relative to `apps/cli/` unless they start with `/mnt/`.

## What changed from v1

- **No task-start pointer.** Memory recognises a process by the screens it goes through, not by the words of the task. The pointer becomes an ablation arm, built only if card and notes pass on their own.
- **No run boundary, no write list, no "confirmed" label.** Nothing handed over needs them. What is handed over is gated by **recurrence**: two sessions or more saw it on the same screen.
- **Prompt injection and personal data** get their own rules (section 5). Memory writes a page's string down only once two sessions have seen it.
- **Step 0** checks that our hooks fire for these tools before anything is built.
- **"Runs" is renamed "trails"**, since `runs/` means eval runs everywhere in the repo.

## 1. The problem

Coding memory leans on git for a boundary (a commit ends a task), a success claim (the last check before it passed), the evidence (the diff, read back exactly at use) and a name (the commit message, which search finds a change by). Computer use has none of them.

v2 stops trying to rebuild all four. It keeps what a screen shows the same way every time, checks it against the live screen, and drops the parts that need to know where a task ended or whether it went right.

## 2. What the evidence says

- **The guide won on success.** On the new-job benchmark the one-page guide passed 23 of 23. It states every rule every time (`examples/new-job/RESULTS.md`).
- **Notes on fields that start set fixed the worst harms.** v2's note "'Send satisfaction survey' starts ticked; decide from the task" won T07, and the restock note won L08 (`RESULTS-v2.md`, section 4).
- **Steps hurt.** Steps without those fields made the agent stop reading the form (L08, L14). A key step went stale after a UI update (U02).
- **Places checked on the live page behaved.** After the update they fired 0 times: memory said less instead of pointing somewhere wrong.
- **Memory was fastest on repeats** (v1: 11 turns against 16), but that is 3 chores in 2 passes, and on "shares parts" chores it was slower (15 against 13).
- **In coding, the help came from what the repo doesn't hold**, check scripts and commands, not the pointed change (README, Results).

So v2 hands over what the guide and those notes had: the person's rules, the routes to screens, and what each screen does that is easy to miss.

## 3. Recognise by screens, not by words

Luv's ask is to capture a process and recognise it later. In v2 a **process** is a screen past sessions worked on (a form they filled, ticked or chose in), the route to it, and what that screen does that is easy to miss. Memory recognises it at two moments, neither of which needs the task's words to be understood:

1. **The agent opens an app memory knows.** Memory shows the **app card** once a session: the person's rules for that app and the routes past sessions took to the screens they worked on.
2. **The agent reaches a screen memory knows,** with its stored controls on the live screen. Memory shows that screen's **notes** once a session: fields that start set, and traps seen there.

Examples of each:

```
singularity: Hatchway (app.hatchway.example), from 6 past sessions.
Your rules here: "never restock damaged goods" (2026-10-20).
Screens past sessions worked on, and how they got there:
- "Refund" form (4 sessions): /orders/{n} › "Actions" › "Refund"
- "Edit address" form (2 sessions): /orders/{n} › "Edit address"
Read each screen as you go: the app may have changed since.
```

```
singularity: on this screen ("Refund" form), past sessions saw "Restock items" start ticked.
Some changed it, some didn't: decide from the task.
```

A route stops before any write and holds only controls that open a screen: links, tabs, menu items, and buttons that opened a screen or dialog. It never names a submit, send, pay or confirm control. Notes never say what a past session chose or typed, never name a key, and never say what to do.

## 4. Capture

### 4.1 Tools

A translator per tool family turns calls into one form: verb, target (role and name), screen, failed or not.

- **DOM-aware browsers** come first: Claude in Chrome (`mcp__claude-in-chrome__*`), the built-in browser (`mcp__Claude_Browser__*`) and Playwright MCP (`mcp__playwright__browser_*`). They give the page address and each control's role and name. The removed `web/Snapshot.ts`, `Places.ts`, `Presets.ts` and `Step.ts`'s anchor check (2d18711^) read this already.
- **Desktop computer use** (`mcp__computer-use__*`) is captured only, and only the app (its bundle id) and menu paths. Clicks are coordinates on screenshots, so there are no screens to anchor and no notes.
- **App MCP tools** (Gmail, Slack, …) give only the person's rules and traps (a call that failed, then the call that worked). Their schemas already say what they do.

Claude Code's hooks docs say MCP tools appear as regular tools in `PostToolUse`, matched as `mcp__<server>__.*`, and that hooks fire in the terminal, IDEs, the Desktop app and cloud sessions ([hooks reference](https://code.claude.com/docs/en/hooks)). Whether that holds for the computer use and Claude in Chrome tools in practice is Step 0 (section 7).

### 4.2 What memory keeps

One **trail** per session per app, read from the session's log in the background at task start and session end, as commits are stored today (`Background.ts`, `store.lock`). Never inside the tool-call hook.

A trail holds observations, each tied to a **screen pattern**: the origin, the address path with ids as `{n}` and no query string, plus the open dialog's title.

- **Hops**: control → screen it opened.
- **Worked-on screens**: where the session typed, chose or ticked something.
- **Fields that start set**: checkbox, radio and select fields on a worked-on screen when the session first read it. Only their state (ticked, unticked, which option) and whether the session changed it. Never a text value.
- **Traps**: an action that failed, the first line of what the screen said, cut to 40 characters, and the action that then worked.
- **The person's rules**: prompts with "always", "never", "from now on" or "remember", only the sentence that holds the word, with the app of the session's next computer use action.

Never kept: screenshots, typed text, page text from content areas (message bodies, documents, comments, list rows), query strings, password fields.

### 4.3 The per-app index

Written at store time from all trails of the app, read by the hooks in plain node, as `facts/Index.ts` and `facts/Lookup.ts` do for the facts card.

- **A string of the page is written in plain text only once two sessions saw it on the same screen pattern.** Until then the trail keeps a fingerprint: a hash salted with a secret of this machine's memory home, which can't be shown. At the second sighting the plain text comes from that session's log.
- **A route** is the screen-opening controls a session used to reach a worked-on screen, back to the last screen it reached by address or through content (a list row, a link in a message), which the route names by its address pattern. Loops are cut. It is shown when two sessions took the same hops; the shortest wins a tie.
- **A note or route retires** when its controls were missing on the live screen in the last two sessions that reached it, as `Fresh.ts` retires stale code.

## 5. Prompt injection and personal data

Hook text reaches the agent wrapped in a system reminder (the hooks reference), so a page's string replayed by memory carries more authority than the page itself. Strangers write pages, mail and shared docs. So:

1. Strings come only from the app's own controls: buttons, links, tabs, field labels, menu items and dialog titles. Never from content areas.
2. A string is kept only when two sessions saw it on the same screen pattern (4.3). Per-task values, such as a customer's name, a number or an amount, change from task to task and never get in.
3. Each string is cut to 40 characters and shown in quotes, as what past sessions saw. A string that reads as an instruction is dropped: it addresses the assistant or the user, holds an email address or a link, or starts with an imperative aimed at the reader.
4. Notes come back only in the app they were seen in, never in another app's session.
5. The person's own words, their rules, are the only free text memory shows.

Recurrence does not stop an injected string that stays on a page, such as a malicious product name in every listing. Rule 1 does, by never reading list rows. The eval tests it (section 7).

## 6. What we won't build, and why

- **Workflows written by a model, with blanks** (AWM style). They caused the new-job harms, and learning cost $3.80 on $8.86 of agent runs (v2).
- **Replayable macros** with coordinates or element refs. They break on the next layout change: ASI's verified skills failed on their first step in up to 72% of shopping checks (research report).
- **Keys or shortcuts as instructions** (U02).
- **A route or note that names a submit, send, pay or confirm control**, or says what a past session chose. Memory never shortens the last look before an irreversible action.
- **Screenshots in memory, or a model at store time.**
- **For now, a task-start pointer to a past session** (section 8).

## 7. How we'd know it works, in order

1. **Step 0, about half an hour on Luv's machine.** A hook that only logs `PostToolUse` for `mcp__.*`. Then one Claude in Chrome task and one desktop computer use task, both from Claude Code. Note whether the hook fires, how big its input is, whether screenshots and page text are in it, and where the session's log is. If the hook doesn't fire, there are no screen notes, and the design stops here.
2. **Count.** How many sessions in `~/.claude/projects` already used `mcp__claude-in-chrome__`, `mcp__Claude_Browser__`, `mcp__computer-use__` or `mcp__playwright__`. If almost none, capture needs a week of deliberate use first.
3. **Replay new-job, offline.** Run `runs/new-job/` (on Luv's machine, ignored by git) through the index builder. For each harm chore (L08, L14, L12, U05, U02, T07), see what card and notes would have shown before it, with recurrence at one session and at two. If neither produces the restock and survey notes in time, the design doesn't work.
4. **A new sealed browser benchmark**, built like new-job: a separate agent, a brief, a seal, apps nobody has seen. Arms: no memory, card and notes, and the one-page guide. Three runs per chore per arm.

   Bars, set before the runs:
   - harms first, by chore;
   - success no lower than no memory, and the gap to the guide reported;
   - median turns at least 20% lower on repeats;
   - "shares parts", look-alike and unrelated chores, and chores after an unannounced UI update: no worse than no memory.

5. **Privacy and injection audit, inside that benchmark.** Seed a fake password, a card number, personal names in list rows and one injected line. If any of them shows up in memory's files or hand-overs, the design fails.

## 8. Later, only if 7.4 passes

- **The task-start pointer**, as an ablation: card and notes, against card, notes and pointer.
- **Desktop notes**, if Step 0 shows a way to anchor screens without a model.

## 9. Open points for the critic

1. **The card at task start.** When the person's prompt names a known app (its host, or its name), show the card then, so the rules arrive before the agent plans. Else at first touch.
2. **Many screens.** An app with many worked-on screens won't fit in a 700-character card. Rank routes by how many of the task's words the screen's name holds, then by recurrence. Or let a hub screen's notes list where past sessions went next.
3. **Fingerprints** (4.3): enough for "memory's files hold nothing seen once"?
4. **One session or two for fields that start set.** v2 wrote the restock note from L01 alone. The replay (7.3) decides.
