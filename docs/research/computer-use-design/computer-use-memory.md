# Memory for computer use: the agreed design

Written 2026-10-28 for Luv by two Claude threads, a proposer and a critic, against main at b8d6ae1. The drafts and reviews behind it are in `drafts/` and `critic/` beside this file. Paths are relative to `apps/cli/` unless they start with `/mnt/`. Nothing here is built yet. Reviewed on 2026-10-29 against the same main, which hadn't moved; the changelog at the end says what changed and why.

## In short

- Computer use has no git, so memory can't point to a commit. It recognises a process by the screens it goes through.
- It has two hand-overs. When the agent opens an app memory knows, an **app card** gives the person's rules for that app and the routes past sessions took to the screens they worked on. When the agent reaches a known screen, **screen notes** give the fields that start set and the traps seen there. When the screen has changed, memory says nothing.
- It covers browsers driven from Claude Code first. Desktop apps are only captured.
- Memory never keeps screenshots, typed text or page content. It writes a page's text down only once two sessions have seen it.
- It aims at fewer mistakes; the kind of note it hands over has been tested on one chore (T07). Whether it also cuts cost is not known yet: routes are its main saving, and a replay has to show how much they can save. That choice is yours (see "Your call").
- The first step is a half-hour check on your machine that Claude Code's hooks fire for these tools at all, and what each tool hands them. Memory's installed hook doesn't run for them yet: its matcher names shell and edit tools only (see "Tools").

## Why git mattered

Git gives coding memory four things that computer use doesn't have:

1. **An end.** A commit ends a task.
2. **A success claim.** Memory stores a commit only when the last check before it passed.
3. **The evidence.** The diff stays in git, so memory stores only a pointer and reads the diff back exactly when needed.
4. **A name.** Memory finds a past change by its commit message.

So this design keeps only what a screen shows the same way every time, checks it against the live screen, and drops everything that needs to know where a task ended or whether it went right.

## What the earlier browser memory taught

Memory for browser chores was built and tested on 2026-10-09 (the "new job" benchmark, `examples/new-job/RESULTS.md` and `RESULTS-v2.md`, code removed in 2d18711). It failed its bars twice.

- **Steps caused the harms.** Given steps, the agent stopped reading the form and missed boxes that start ticked (L08, L14). A key step learned on old screens sent a form with the wrong person chosen after a UI update (U02).
- **A one-page guide won on success,** 23 of 23, because it states every rule every time.
- **Notes on fields that start set helped.** "'Send satisfaction survey' starts ticked; decide from the task" won T07. L08 was won by a rule and a step to untick "Restock items" for damaged goods, which memory's model wrote from one earlier session. This design writes T07's neutral kind of note in plain code, and that kind has been tested on T07 only.
- **Places checked on the live page behaved.** After the update they fired 0 times, so memory said less instead of pointing somewhere wrong.
- **Memory was fastest on repeat chores,** 11 turns against 16, but that was only 3 chores in 2 passes, and it was slower on chores that shared parts (15 against 13).

In coding, the README credits the measured help to what the repo doesn't hold, such as check scripts and commands (Results).

## The design

### The app card, once a session

It comes at the agent's first action in the app. It comes earlier, at task start, when your prompt names the app in a way memory has learned: its address, or a word that your prompts used before two or more sessions in this app, and never before a session in another app. Until then such a word is kept as a fingerprint, like a page's text (below).

It is at most 700 characters, and holds:

- **your rules for this app,** in your own words, with their dates;
- **routes:** the screens past sessions worked on, and the controls that got them there, the most used first.

```
singularity: Hatchway (app.hatchway.example), from 6 past sessions.
Your rules here: "never restock damaged goods" (2026-10-20).
Screens past sessions worked on, and how they got there:
- "Refund" form (4 sessions): /orders/{n} › "Actions" › "Refund"
- "Edit address" form (2 sessions): /orders/{n} › "Edit address"
Read each screen as you go: the app may have changed since.
```

### Screen notes, once a session per screen

They come after a browser call that read a screen whose stored controls are on the live screen. When those controls are missing, nothing comes. A note is at most about 400 characters.

They hold:

- **fields that start set,** by state only, ending "decide from the task". Fields some past session changed come first, without saying so;
- **traps:** an error message this screen showed past sessions, tied to a field or the form, such as a field's "A note is required over $250". Never a page-wide banner, which can be an announcement;
- **keys that did something there,** such as "Enter in a field submitted this form", once two sessions saw it, shown as a warning about that screen;
- **where past sessions checked their result** after a change on this screen, by address pattern only, so that the check after a write is more likely to happen;
- **on a hub screen,** where past sessions went next.

```
singularity: on this screen ("Refund" form), past sessions saw "Restock items" start ticked.
Decide from the task.
```

### Routes

- **Only controls that open a screen:** links, tabs, menu items, and buttons that opened a screen or dialog.
- **Never a write.** No submit, send, pay or confirm control (a word list as a backstop), and no step after which a status line appeared.
- **Where a route starts:** at the last screen the session reached by address or through content, such as a list row. It names that screen by its address pattern (`/orders/{n}`).
- **When the app changes:** the newest route to a screen wins over older ones. A route retires when its controls were missing in the last two sessions that reached its screen, when the app's last two sessions got there another way, or when the app's last few sessions never reached its first screen. A monthly task's route survives between uses.
- **A screen's address** is the path with ids as `{n}`, a hash route's path when there is one (`#/orders/{n}`; `Places.ts` dropped the hash), and the query's keys without their values (`?tab={}`; `Places.ts` kept the keys and blanked the values). A path segment that isn't a number is page text, written down only once two sessions saw it (below).
- **Apps with one address for many screens** (single-page apps): screens are told apart by their named forms and regions, as the removed `Places.ts` did. Headings can't do it, since a heading can be content (Gmail's heading is the email's subject).

### Your rules

- **What counts:** only sentences that open as an instruction: "always", "never", "from now on", "remember that", "make sure to always", "don't ever".
- **What doesn't:** a sentence whose object is only "that", "it" or "this".
- **Where it goes:** to the app of the session's next computer use action.
- **Telling users:** the README will say this is how to teach memory a rule.

Rules that helped in new-job (L11, T14) came from feedback after a mistake. In daily use that is a correction ("you restocked them, that's wrong"), which seldom uses these words. This design keeps no corrections. The capture data will count them first.

### What memory keeps

One **trail** per session per app, read from Claude Code's session log in the background at task start and at session end, the sweeps that store commits made outside the agent today (`src/workflows/hook.ts`, `StoreTrigger.ts`), one run at a time under the same lock (`src/setup/Background.ts`, `store.lock`): there is no commit to start it. Trails show in `singularity changes` and `status` as commits do, with the screens left out and why; no new command (`src/singularity.ts` keeps the eight). A trail holds:

- the hops (each control, and the screen it opened);
- the screens worked on;
- the fields that start set, by state only;
- the traps;
- your rules.

Never kept: screenshots, typed text, content (message bodies, documents, comments, list rows), query values. A screen with a password field is skipped entirely.

### Seen twice before written down

- **Fingerprints first.** A page's text is written in plain text only once two sessions saw it on the same screen; two visits in one session count once. Until then memory keeps a salted fingerprint, taken with numbers blanked as `{n}` first, as `Places.ts` did, so that "Orders (3)" and "Orders (5)" are one label.
- **Notes still arrive in time.** At the next visit, the hook fingerprints the live screen's labels, finds the match, and writes the note from the live text. That is in time for L08, as long as the first session's trail was stored, which happens at that session's end at the latest.
- **What this protects:** nothing seen only once reaches a hand-over, another app, or memory's files in plain text.
- **What it doesn't:** Claude Code's own session log holds everything anyway. And the salt sits in the same home folder, so anyone with that folder can guess a short value, such as a name or an amount, by trying candidates.

### Prompt injection

Hook text reaches the agent as a system reminder ([hooks reference](https://code.claude.com/docs/en/hooks)). So a page's text replayed by memory carries more weight than the page itself, and anyone can write pages, mail and shared docs. Five rules:

1. Strings come only from the app's own controls, dialog titles and error messages, never from content.
2. A string must be seen twice (above).
3. Each string is cut to 40 characters and shown in quotes, as what past sessions saw. A string that reads as an instruction is dropped: one that addresses the assistant or the user, holds an email address or a link, or opens with an order to the reader. The hooks reference asks for the same shape: hook text written as statements of fact, since text framed as a system order can trip Claude's injection defences, and is then shown to the user instead of read.
4. A string is shown only in the app where it was seen.
5. Your own words are the only free text memory shows.

### Tools

- **First, browsers driven from Claude Code:** Claude in Chrome (`mcp__claude-in-chrome__*`), Claude's built-in browser (`mcp__Claude_Browser__*`) and Playwright MCP (`mcp__playwright__browser_*`). They give the address and each control's role and name when the session reads the screen as text. Playwright MCP's actions answer with the page's address and a snapshot of roles and names. Claude in Chrome and the built-in browser read a page as text with `read_page` (the built-in browser also has `find` and `get_page_text`), and act through a `computer` tool whose clicks may name a point on a screenshot rather than a control; a hop is anchored only when the screen was read as text and the click names a control in it. How often sessions do that is a Step 0 count: a session that reads screens as screenshots alone gives memory nothing to store and nothing to check.
- **Desktop computer use** (`mcp__computer-use__*`): capture only, meaning the app (a background call names it by bundle identifier) and menu paths (`app_menu`). Clicks are coordinates on screenshots, so there is nothing to anchor a note to.
- **App tools** such as Gmail's or Slack's: rules and traps only.

The removed browser memory's `Snapshot.ts`, `Places.ts`, `Presets.ts` and `Step.ts`'s anchor check (2d18711^) come back. Its learning does not. `Snapshot.ts` reads Playwright MCP's answers alone (`- Page URL:`, then a yaml list of roles and names with refs), and `Extract.ts` knew a browser tool by Playwright's `browser_` prefix: the other two families need a translator each, written from the samples Step 0 collects.

**The installed hook has to be told about these tools.** Claude Code runs a `PostToolUse` hook only for the tools its matcher names, and memory's matcher names shell and edit tools (`src/setup/Agents.ts`, `CLAUDE_TOOLS`: `Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit`); new-job added `mcp__playwright__.*` by hand (`DESIGN-one-layer.md` at the repo root, Deviations). Setup and update add the browser servers (`mcp__claude-in-chrome__.*`, `mcp__Claude_Browser__.*`, `mcp__playwright__.*`) and `mcp__computer-use__.*` to the `PostToolUse` and `PostToolUseFailure` matchers, and no other MCP server. The hook then runs after every browser call and keeps to about 0.1 s: the tool's name is checked on the raw input first, then one read of the app's index, as the facts card is read today (`src/facts/Lookup.ts`). A screenshot call's input can hold an image; the hook reads past it and keeps none of it.

## What we won't build

- workflows a model writes, with blanks to fill;
- replayable macros (coordinates, element ids). They break at the next layout change: tools built this way failed on their first step in up to 72% of shopping checks (research report);
- keys or shortcuts as instructions;
- anything that names a submit, send, pay or confirm control, or says what a past session chose or typed;
- screenshots in memory, or a model call when storing;
- for now, a pointer at task start to a past session of the same task.

## Who it reaches

Only computer use driven from Claude Code on your machine:

- **Cloud sessions:** they don't read your local settings (hooks reference), so a cloud session linked to your computer gets nothing, and Claude in Chrome does run from remote sessions (the Chrome page of Claude Code's docs). Its tools go by other names there anyway (`mcp__remote-devices__Claude_Browser__*`, `mcp__remote-devices__computer_*`).
- **Outside Claude Code:** computer use in the desktop app's chat, in Cowork or in the Chrome extension's own panel may have no Claude Code hooks and no log memory can read. Not verified; Step 0 checks it.

## The plan, in order

It is built on a branch from main that reuses main's hooks and store, as the saved-scripts experiment was. Main itself stays as it is, which the research report's item 10 asks until coding memory shows a net win.

1. **Step 0, about half an hour on your machine.** Add a hook that only logs `PostToolUse` and `PostToolUseFailure` calls for `mcp__.*`, with each input's size and a sample of each tool's answer. Then run one Claude in Chrome task and one desktop computer use task from Claude Code. Note:
   - whether the hook fires, and how big its input is;
   - whether the input carries screenshots, and, for each tool that reads a page, the page's address, its controls' roles and names, and each field's state (ticked, which option), which the notes need (Playwright MCP 0.0.83 answered actions with a link to a file);
   - how many of the browser calls acted on a point of a screenshot with no such read before them;
   - where the session's log is;
   - which other surfaces run computer use outside Claude Code.
2. **Count** the computer use sessions already in `~/.claude/projects`, by the tool names above, and in them the browser calls that read the screen as text.
3. **Replay new-job offline,** from `runs/new-job/` on your machine. It is ignored by git, so it isn't in the cloud checkout. new-job ran through Playwright MCP, so the replay exercises that translator alone.
   - For each harm chore (L08, L14, L12, U05, U02, T07), what card and notes would have shown before it.
   - **The cost ceiling:** in runs without memory, the turns from opening the app to reaching the screen worked on, set against the route's length. Also, for comparison, the turns spent on that screen and after the write.
4. **A new sealed benchmark,** built like new-job by a separate agent, with a single-page app among its apps. Arms: no memory, card and notes, and the one-page guide. Three runs per chore per arm, with Claude Code's auto memory off. The bars, set before the runs:
   - harms first, by chore;
   - success no lower than no memory, with the gap to the guide reported;
   - median turns at least 20% lower on repeats, unless you choose option A below;
   - chores that share parts, look-alikes, unrelated chores and chores after an unannounced UI update: no worse than no memory.

   **The privacy and injection audit** runs inside it. Seed a fake password, a card number, personal names in list rows and one injected line. If any of them shows up in memory's files or hand-overs, the design fails.
5. **Later, only if step 4 passes:** the pointer, tested as card and notes against card, notes and pointer. Desktop notes come only if Step 0 shows a way to anchor screens without a model.

## Your call: the cost half

You asked for fewer resources **and** fewer mistakes. The notes mostly prevent mistakes. Routes are the main saving, and they cover only the hops inside an app's menus. If the replay shows those are under 20% of a chore's turns, the design can't meet the 20% bar. Then there are two ways to go:

- **A.** Aim this first version at fewer mistakes at no higher cost, and set the cost bar to "no higher than no memory".
- **B.** Look for another saving before the benchmark. The replay can size two candidates:
  - the pointer, which saved turns on repeats in new-job and also caused its harms;
  - routes that also name the search field past sessions used to find a record. Only when typing in it led to a list of results, since some boxes run commands, and never what was typed.

We'll bring you the replay's number with a recommendation. Until then, nothing to decide.

## How the two threads got here

- **The pointer.** The proposer's first draft pointed to the one past session most like the task, at its start. The critic argued that this pointer carried most of the risk and most of the machinery: an end to each task, a success label that a wrong-but-landed change would pass, and recognising tasks across every app by their words. We agreed to drop it into a later test.
- **Privacy and injection.** The critic added the injection rules and the rule of seeing things twice. The proposer added fingerprints, so memory never writes down what it saw once, and the critic found how notes can still arrive at the second visit.
- **What done looks like.** The proposer offered, as a saving, the status line past sessions saw after their changes. The critic objected: it would shorten the check after a write, which is where an agent catches its own mistakes (a toast can say "Refund issued" while the restock shows only on the order page), and status lines carry the most per-task values. We agreed to name instead the screen where past sessions checked their result, as a screen note for the mistakes half.
- **Still open:** nothing between the two threads. The cost half is yours to decide, with the replay's number.

## Changelog

Reviewed on 2026-10-29 against main at b8d6ae1 (unchanged since the design was written), the removed browser memory at 2d18711^, the new-job results, the three tools' own skills and Claude Code's hooks and Chrome docs. What changed, and why:

- **The installed hook never ran for these tools.** Memory's `PostToolUse` matcher names shell and edit tools only (`src/setup/Agents.ts`), which new-job's deviations had already noted. Added under "Tools": setup and update widen it to the browser servers and desktop computer use, and the hook's speed rule for the calls that now reach it. "In short" says so too.
- **Snapshots differ per tool.** `Snapshot.ts` and `Extract.ts` read Playwright MCP's answers alone. Added: a translator per family from Step 0's samples, and that the new-job replay tests only the Playwright one.
- **Screens read as screenshots give memory nothing.** Claude in Chrome and the built-in browser act through a `computer` tool whose clicks may name a point on a screenshot. Added to "Tools", Step 0 and the count: anchoring needs a read as text, and Step 0 checks that field states are in that text.
- **When trails are stored.** The doc said "the way commits are stored today" without saying when, and there is no commit to start it. Added: the task-start and session-end sweeps under `store.lock`, that the second-visit note depends on the first session's trail being stored, and where trails show (`changes`, `status`), with no new command.
- **A screen's address** is now defined: the path with ids blanked, a hash route's path, and the query's keys without values; a path segment that isn't a number is page text under the seen-twice rule. "Never kept: query strings" became "query values". `Places.ts` had dropped the hash, which single-page apps often route by.
- **Fingerprints with numbers blanked** as `{n}` first, as `Places.ts` did, so a label with a count recurs. The prompt words that name an app are fingerprints too until two sessions.
- **Hook text as statements.** Rule 3 now cites the hooks reference's own warning: text framed as a system order can trip Claude's injection defences.
- **Cloud sessions.** Claude in Chrome runs from remote sessions too, and the tools go by `mcp__remote-devices__*` names there; added under "Who it reaches".
- **"It should cut mistakes" softened** to what was measured: the neutral note won T07 and was tested on that chore alone.
- **Scope line.** Main stays as it is, as the research report's item 10 asks.
