# Developing singularity

How the code is laid out, how to run it from a clone, and the commands that
build and inspect memory by hand. How the code is written is in
[`CLAUDE.md`](../CLAUDE.md); running evaluations is in
[`evaluation.md`](evaluation.md), and each measurement, planned before its
runs, is in a `PREREGISTRATION*.md` file under `apps/cli/examples/`.

## The repo

A Turborepo monorepo with npm workspaces:

| Workspace | What it is |
|---|---|
| `apps/cli` | the command line, hooks, memory and eval harness: TypeScript 7 and Effect 4, run directly by Node 24 (no build step) |
| `apps/landing` | the landing page: Vite and React |

```
npm install
npm test               # every workspace's tests (vitest), through turbo
npm run typecheck      # every workspace's tsc
npm run build          # the landing page, into apps/landing/dist
npm run dev            # the landing page's dev server
npm run cli -- <args>  # the whole command line, same as node apps/cli/src/cli.ts <args>
```

Commands here run from the repo root, where eval runs go (`runs/`). There
are two entry points: `apps/cli/src/singularity.ts` is the `singularity`
command setup installs, with the eight daily commands only, so nothing
user-facing points anywhere else; `apps/cli/src/cli.ts` is the whole command
line, with those eight too, and runs memory's background work. To set memory
up from a clone instead of the installer's copy:
`node apps/cli/src/singularity.ts setup`.

To try the install as a user gets it, with this checkout as it is
(uncommitted changes included), in a sandbox home that leaves your agents and
PATH alone: `scripts/try-install.ps1` on Windows, `scripts/try-install.sh`
elsewhere. The first run installs and runs setup; a run after that updates;
`-Fresh` (`--fresh`) starts over and `-OwnNode` (`--own-node`) makes the
installer fetch its own Node.js. Everything singularity prints, the
installers included, follows one layout, described in
`apps/cli/src/setup/Ui.ts`.

## Where things are

Under `apps/cli/src`:

| Directory | What it holds |
|---|---|
| `setup/` | daily use: setup, status, the agents memory knows and what each gets, hook files, the skill, the recall note in agents' instruction files (`Instructions.ts`), the `singularity` command, Codex hook trust (`CodexHooks.ts`), updating to the latest code with what setup put in place kept current (`Update.ts`) |
| `scripts/` | memory: at task start (a session's first prompt that asks for something, and the first after each commit: `Cycle.ts`), a pointer to the stored commit most like the task, read from git (`Hook.ts`, `Start.ts`, `Search.ts`, `Render.ts`; picked by a model when the person chose one, `Pick.ts`), checked against the code as it is now (`Fresh.ts`), and the scripts the search passes over for good (`Retired.ts`), then the repo's card of check scripts (`facts/`); and what git doesn't show about a stored commit the agent reads with `git show` or `git log` (`History.ts`) |
| `facts/` | facts: what records teach about checking a change here and the traps on the way (`Facts.ts`), kept as one index per repo at store time (`Index.ts`) and read in plain node (`Lookup.ts`, `Reads.ts`); a task's start hands over its card of check scripts (see Facts below) |
| `workflows/` | the hook script (`hook.ts`) and storing commits (`Commits.ts`, `StoreTrigger.ts`, `Transcripts.ts`); the hand-over log (`Session.ts`) |
| `records/` | records: what a committed change shows, read from its session and its diff; what it was asked and what its commit says, which it is found by (`Task.ts`) |
| `traces/` | reading session logs: Claude Code's, and Codex's and Hermes Agent's as Claude Code's; whether a prompt asks for a change (`Requests.ts`) |
| `eval/` | the eval harness and its memory setups (no memory and saved scripts) |
| `local/` | the memory home and git |
| `handover/` | only `HookInput.ts`, the hook's input |
| `graph/` | only `Similarity.ts` and the store errors records use |
| `computer/` | computer-use memory, set up apart (`singularity setup computer-use`): see Computer use below |

On this branch memory is saved scripts only. Memory v1's learning and
hand-over (the rest of `workflows/`), the learning step (`setup/AutoLearn.ts`,
`Learner.ts`, `LearnerModel.ts`, `Preferences.ts`, the model calls in
`eval/`), memory v0 (`memory/`, `search/`, the rest of `handover/`,
`src/hook.ts`), the graph setup, `layer/` and `web/` were removed; tags
`memory-v0` and `memory-local-first` keep them.

Memory reaches an agent four ways: the task-start hook points to the
stored commit most like the task and adds the repo's card of check scripts;
the tool-call hook, mid-task, adds what git doesn't show about a stored
commit the agent reads in git; the recall note (`setup/Instructions.ts`,
a marked block in Claude Code's `CLAUDE.md`, Codex's and OpenCode's
`AGENTS.md`) tells the agent it can run `singularity recall` mid-task; and
the skill (`setup/Skill.ts`) says the same to agents that read skills.
`RECALL_NOTE` and `NOTE_BLOCK` there are the note's text, for eval drivers
that hand it over themselves. Setup used to write a second task-start hook
(`user-prompt-submit-2`, for a hand-over in two parts); setup and update
now replace it with the one hook, and `workflows/hook.ts` still accepts it
as a silent no-op for settings not yet updated.

Tests mirror it under `apps/cli/test`.

## Saved scripts at task start

A task starts at a prompt that asks for something (`traces/Requests.ts`:
four words of its own or more once filler, approval, commit and read-this
words are taken out; not a question about how things stand; not "don't
change anything yet"): the session's first such prompt, and the first after
each commit (`scripts/Cycle.ts`, a marker per session keeping the commit HEAD
was at). "yes", "commit and open a PR" and "please read @HANDOFF.md" start
nothing.

A stored change is found by its commit message (`task.message`; records
stored before it get it from git when read, `Git.commitMessages`) when the
message has four words of its own, else by its task, the first prompt of its
part of the log that asks for something, else the session's last that asked
before it (`records/Task.ts` `taskKeys`). A task that asks for nothing is
never searched by. Not the task beside the message: on the 62 real task
starts of 2026-10-23, judged blind by a stronger model, the task's words
(chat questions, agent-written briefs) brought 5 of the 6 wrong hand-overs;
the message alone handed over 1 wrong and 8 right where both handed over 6
wrong and 9 right. It costs look-alike tasks told in the same words: on the
markdownlint daily runs, the new-rule tasks no longer find the earlier rule
by its request (21 picks to 1).

In Claude Code a model may pick instead (`scripts/Pick.ts`), when the person
chose one at setup (`config.json` `picks`, `local/Home.ts`; the default
suggested is Haiku). Claude Code runs two task-start hooks: `hook.ts
user-prompt-submit --picks` hands over the card at once and leaves the change
out, and `hook.ts user-prompt-pick`, a background hook (`async: true`,
`setup/Agents.ts`), asks `claude -p` (no tools, no settings, no session kept)
which of the repo's latest 150 changes, listed by commit title and the start
of its request, has the task's goal, then hands the pointer over through
`Start.ts` as word search's pick would be. Claude Code gives a background
hook's output to the agent at its next step. Each hook keeps its own marker of
task starts (`Hook.ts` `startsTask`). The call takes about 5 s, most of it
the command starting; on those 62 starts Haiku handed over 0 wrong and 10
right ($0.0013 a start; one start counted right before isn't a task start
under `isRequest`, so no pick runs for it). When the model can't be asked, word search picks,
and the hand-over log says why (`moment: "pick"`, `by`, `error`). Other
agents' hooks, which can't run in the background, use word search.

`scripts/Start.ts` ranks the repo's stored changes against the new prompt
(`Search.ts`, the best score over those texts) and examines the best five above the bar, best first. Each
costs a few git calls (30 to 100 ms on markdownlint and excalidraw, under
0.5 s for a sixty-file change) and no model call:

- **Commit missing** (a rebase, another clone): passed over this time only.
- **Reverted**: a commit since says `This reverts commit <sha>`.
- **Superseded**: a newer stored change (the commit history's order, else the
  time it was made) of mostly the same files (Jaccard 0.8) whose task or
  message scores 0.8 against this one's both ways (`Search.score`); two
  changes filed under the same "commit and then start" aren't alike for it.
- **Stale files** (`Fresh.ts`): for each file it changed, the share of its
  meaningful added lines (8 characters or more besides spaces, a letter or
  digit, not an import of one name or other boilerplate) still in today's
  file, whitespace collapsed. Below 0.5, the five longest missing lines are
  looked for with `git grep -F`; one other file holding two or more and 60%
  of them, with the change surviving at 0.5 in both files together, means
  the code moved there (the file line names it). Otherwise the file is stale:
  its file line says it has changed since and names the commit that took its
  lines out (`git log -S`). A file deleted since, its code nowhere else, is
  gone: its line says it no longer exists.
  Searches are spent on source files first, six per script.
- **Gone**: every file stale or gone. Passed over; retired only when the
  commit is on HEAD's history (on another branch it may come back).

Reverted, superseded and gone scripts are retired: a line in
`<tenant>/scripts/retired.jsonl` (`{id, commit, reason, at}`), which the
search skips from then on; records are never deleted. Only a call that may
write retires (the hook; `recall` passes `persist: false`).
`Retired.countRetired` counts them by reason. Storing commits retires too: a
follow-up commit of the same session right on top of its previous stored
one, touching only that one's files with no new prompt in between (a lint
fix), is stored as one script from the earlier base, and the earlier record
is retired as `folded into <id>`.

Commands: `npm|yarn|pnpm|bun <x>` is dropped when `x` was a script in a
`package.json` (the repo's, or one in a folder of a changed file) at the
commit and is in none of them today; builtins and tools are kept.

The hook hands over a pointer (`Render.renderPointer`): the commit, the
first line of its task (its commit message's when the prompt asked for
nothing), and up to twelve of its files as they are called today, with
what became of them (moved, renamed, changed since, gone). No diff: git has
it, `git show <sha>` shows it, and reading it brings what git doesn't show
(below). A session is never pointed to a change it made. After it comes
the repo's card (Facts, below). `singularity recall` and `singularity
changes <commit>` show a change in full (`Render.renderFull`): the pointer,
then what git doesn't show about it, the same as a reading adds (below),
and never its diff. So `changes <commit>` prints exactly what an agent can
be handed of that change.
`singularity visualise` (`src/setup/Visualise.ts`) draws what `changes`
lists (`gatherChanges`), with the sessions each commit was handed to
(`scripts/sessions/*.given`): a calendar of the days changes were
committed, the latest changes, the folders they touched most, their checks
and the changes handed over most; where memory knows no repo, every repo
with a sparkline of its weeks. Each graph has a title over a rule, a line
saying what it shows, and its axes and units labelled; bars are drawn in
`▆`, which leaves a gap between rows, and neighbouring rows alternate two
shades in color. It draws 48 to 110 columns wide, dropping the date column
below 72, with the glyphs setup already prints and every line as long with
color as without. Reading is the only Effect; `summarise` and the renderers
are plain functions, and `--json` prints `summarise`'s data.

On real prompts of 2026-10-21 (a copy of `~/.singularity`), two chat-v2
tasks went from the 9,583 characters of the diff hand-over to 1,514, pointer
and card; a singularity task that matched nothing got a 393-character card.
The task-start hook takes about 0.9 s, as before (most of it git, judging
the change's files); the tool-call hook about 75 ms a call, a little less
than before, with no watch to look for.

No hand-over shows a diff or past mistakes (2026-10-24). Read on the 69
changes then stored for this repo, `recall` and `changes` gave 9,547
characters at the median, 46% of them the diff git has; a reading gave
2,887, 55% of them mistakes other changes made in its files, linked through
a shared code file (`tellingFiles`, now only the eval's): one session's
scratch failures (a SQLite query, a test run mid-change, two experiments)
reached every change sharing a file with it. A change's own mistakes were
mostly checks that failed mid-change and scratch scripts. After: 1,054 and
226 characters. The person's request comes only when the commit message
says too little (`Task.askedShown`): 66 of the 69 were filed under prompts
that pass as requests, among them questions and replies to a screenshot,
while all 69 commit messages say what the change was for. Before that,
mistakes were linked only through a code or test file few stored changes
touched: through any shared file (most changes edit `README.md`), one
session's failed `npm run build-declaration` reached every later hand-over
in two markdownlint passes, and agents ran it.

### A hand-over by commit

Agents read the change before theirs with `git show`, unprompted (in the
note test of 2026-10-17, the first command of every session that added a
rule like an earlier one). Git has that change's diff; memory has the rest.
After a call that reads commits, the tool-call hook adds what git doesn't
show about the first one memory stored (`History.ts`, plain node, then
`Start.commitHandover`): the project commands its session ran, and the
request that asked for it when its commit message says too little (else git
has what it was for) (`Render.renderBehind`, nothing when it has neither). A
call reads commits when it runs `git show`, or `git log` printing a diff or
a stat. Runs, not mentions: what quotes hold and heredoc bodies (a commit
message, a pull request's description, an `echo`'s text) are left out first
(`History.shellRuns`); a pull request whose description named `git show` and
a stored commit's hash brought that commit's hand-over on 2026-10-24. They're
the commits its output heads with `commit <hash>`, else the lines it starts
with a hash, else the hashes and `HEAD~n` or `@~n` revisions the git command
itself is given (up to the next `;`, `&`, `|`, `)` or line end; resolved in
the repo; not `<commit>:<path>`, `HEAD@{1}` or `@{u}`), a command continued
over lines read as one. Replayed over the 28 hand-overs by commit in
transcripts then, that drops the pull request and two loops over four
commits whose hashes came from the loop's list, not from git show. A
commit inside a stored change of several (one command made them, so the
record is the last one's) brings that change: the first stored change after
it on the way to HEAD whose base is before it. More
than two commits listed is a survey: nothing. A reading never gives a session
its own commits. Every hand-over notes its commit for the session (task
start, a reading, or `singularity recall`, which Claude Code's
`CLAUDE_CODE_SESSION_ID` ties to the session):
`<tenant>/scripts/sessions/<id>.given`. A reading skips a commit noted
there; a task's start doesn't, since a new task may need the
same change again. The log line has `moment: "git"`.
A call ends at the raw check (`git` then `show` or `log` in the input) or at
the plain one before the hand-over's modules load, in about 0.1 s; a
hand-over takes about 0.9 s.
`node apps/cli/examples/scripts/replay-git-handover.ts` replays it on the
note test, the user's own sessions and the 2026-10-16 markdownlint runs.

The hook script ends by running out of work, not with `process.exit`: on
Windows, `process.exit` while other threads still finish work trips a libuv
assertion (async.c line 76), and the hook dies with exit 127, which Claude
Code logs as a hook error, dropping what the hook printed (215 of 608 runs
under CPU load; 0 of 608 since; RESULTS.md). A 5 s timer that doesn't hold
the process open ends a hook that something else would.

`node apps/cli/examples/scripts/check-staleness.ts [repo ...]` replays the
staleness rules over a repo's history (read-only: files are read at each
revision with git) and writes a sample of verdicts to check by hand to
`apps/cli/examples/scripts/results/staleness-sample.tsv`.

## Facts

Each time memory stores a change (and once for a repo stored before facts
were kept), `storeCommits` writes `<tenant>/facts/<subject>.json` from the
repo's records (`facts/Index.ts`). Two kinds only (`facts/Facts.ts`):

- a trap: a detour whose fix was another command, or the same one run
  otherwise (`bun run build` first, `--ignoreConfig`), with the failing
  command, the line of its failure that tells it apart (`signal`), and what
  worked. Detours closed by editing the repo's code, by an edit tool, of the
  agent's own inline scripts, of failing tests, or of a shell's quoting
  error are left out (`trapOf` says which);
- a check: the project's own checks a change ran before its commit (a test,
  typecheck, build or lint command of its package, in the repo), and
  scripts run to check (named so: `smoke`, `e2e`, `shots`, `ui`, …), with
  what their line set up first (`bun run build; unset ELECTRON_RUN_AS_NODE`),
  each known by the file it runs (`check:<path>`): sessions name theirs
  alike (`shots.mjs` in three folders of `%TEMP%`).

A record keeps each command to 500 characters once the code fed through it
(heredoc bodies, long quoted scripts) is cut (`Shell.compactCommand`). Records
stored before kept the first 500, and lost what ran after a heredoc: all
three of the header session's screenshot runs (2c65307, `cat > shots.mjs
<<'EOF' … EOF … node "$TEMP/cv2-header/shots.mjs"`). Their commands and
detours are read again from their logs by today's rules, once, and kept in
`<tenant>/facts/commands/<record id>.json` (`Index.commandsNow`); the record
stays as stored. The index has a format (`Lookup.INDEX_FORMAT`, 2 since
then): a store builds an index of another format again.

The same fact from several records is one, with its `recurrence`, the
newest record's text and all their commits. A trap retires when a later
record ran its failing command as it was and it worked; a fact whose script
is gone from disk or whose package script is gone from package.json is left
out (`Lookup.isLive`, at store time and again at use). Facts are looked up
by what they run (`by_key`) and by the source files of their changes
(`by_file`).

The task-start hook reads the index (never builds it) and hands over its
card (`Lookup.cardFacts`, `renderCard`): up to four check scripts in 700
characters of lines, each on disk: first the scripts of the change the
pointer names, whatever their recurrence (the harness written for a task
like this one), then the repo's, strongest first, run for two changes or
more (`CARD_MIN_RECURRENCE`: one run once is a scratch script as often as a
harness), with its folder when its command names it only by its name, and
the change it last checked. Not the project's own checks (agents run `bun test` anyway), not
traps (they helped once in 37 replayed sessions). Each fact comes once a
session (`<tenant>/scripts/sessions/<id>.facts`), so a later task's start
brings only facts the session wasn't given, and never one only that
session taught. `Lookup.factsAt` picks for the other moments the replay
measured (a first read, a failed command); the hooks don't use them.

The replay's card table (past only, a session left out at a time) counts
the task starts whose card's first line names a script the session then
read or ran. On 2026-10-21, over 81 records: as stored, 2 of 34 cards;
with commands read again, 3 of 43; with the pointed-to change's scripts
first, 2 of 45 (the pointer names a change in few past-only task starts:
3). Few could be more: of 71 check scripts in those sessions, 3 were ever
run by a second session. Agents adapt a harness more than they rerun it
(the header session read `cv2-ui/ui.mjs`, then wrote `cv2-header/shots.mjs`).
Ranking the repo's scripts by the files their changes share with the
pointed-to one changed no card; leading with the best match below the
pointer's bar gained one card in chat-v2 and lost one in singularity.

`node apps/cli/examples/scripts/replay-facts.ts [--home <memory home>]`
replays it over a home's real records, a session left out at a time, its
facts from the other sessions or only from changes before it, and scores
each fact that would have fired against what the session did next; it set
`MIN_RECURRENCE`, `MAX_FACTS_CHARS` and `MAX_FACTS` in `Lookup.ts`.

## Computer use

Memory for agents that drive a browser, built from the agreed design in
`docs/research/computer-use-design/computer-use-memory.md`; the decisions
taken while building it (the Claude desktop proxy, the setup's shape) are in
`build.md` beside it. Everything is in `src/computer/`:

| Module | What it does |
|---|---|
| `Calls.ts` | one translator per tool family: Playwright MCP, Claude's built-in browser, Claude in Chrome (both written from their tool descriptions until Step 0's samples), desktop computer use (the app and menu paths only) |
| `Snapshot.ts` | screens read as text (`[ref=e19]` and `[ref_3]` tags), field states, the named region that tells screens at one address apart |
| `Text.ts` | salted fingerprints with numbers blanked, the injection filter (`showable`), screen addresses, your rules in prompts |
| `Trail.ts` | a session's trail per app: hops, screens worked on, fields that start set, traps, keys, where results were checked, routes |
| `Index.ts` | an app's index from all its trails: seen-twice counts per screen, newest route wins, retirement |
| `Render.ts` | the app card (700 characters) and screen notes (400) |
| `HandoverCore.ts`, `Handover.ts` | when each is due, once a session; the core is plain TypeScript for the hook |
| `Capture.ts`, `Store.ts`, `Model.ts`, `Paths.ts` | storing sessions; files in `<tenant>/computer/`, read back with Schema |
| `hook.ts`, `HookRun.ts` | the Claude Code hook: plain node, about 45 ms over node's own start per browser call (Effect's import alone is 0.4 s) |
| `Proxy.ts`, `server.ts` | the Claude desktop server: Playwright MCP behind memory, which captures every call and adds its block to answers |
| `ClaudeDesktop.ts`, `Setup.ts` | finding Claude desktop's config, registering the server, the hook entries, status and update |
| `Step0.ts`, `step0-hook.ts`, `Replay.ts` | Step 0's logging hook and the offline replay |

From the repo:

```
node src/cli.ts computer-use step0 on | off | report        # Step 0's logging hook in your Claude Code settings
node src/cli.ts computer-use store --session ID --transcript FILE
node src/cli.ts computer-use show [APP]                     # an app's screens, retired routes, and card
node src/cli.ts computer-use replay LOG... --home DIR       # each session handed what it would have been, oldest first
```

The replay of new-job's no-memory arm (42 sessions, free, no model call)
handed L08 and L14 their notes ("Restock items" and "Send satisfaction
survey" start ticked); 40% of those sessions' calls came before they reached
the screen they worked on, against routes of one or two hops. Tests are in
`test/computer/`; `test/computer/fixtures.ts` is a refund app as Playwright
MCP shows it.

## Records, by hand

```
node apps/cli/src/cli.ts record import runs/excalidraw/*/ [--task ID ...]   # records from eval runs
node apps/cli/src/cli.ts record commits [--cwd REPO] [--all]                # store the changes sessions committed (the hooks run this)
node apps/cli/src/cli.ts record list | show ID
```

The sections on building memory v1 and v0 by hand were removed with those
designs.

## Summarize a session

```
node apps/cli/src/cli.ts traces <session id or path to .jsonl> [--json]
```

Reads Claude Code's transcript (including subagents) and prints tokens, tool
calls, failed calls and repeated file reads.
