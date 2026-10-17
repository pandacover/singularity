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
command setup installs, with the seven daily commands only, so nothing
user-facing points anywhere else; `apps/cli/src/cli.ts` is the whole command
line, with those seven too, and runs memory's background work. To set memory
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
| `scripts/` | memory: at task start (a session's first prompt that asks for something, and the first after each commit: `Cycle.ts`), the stored commit most like the task, read from git (`Hook.ts`, `Start.ts`, `Search.ts`, `Render.ts`), checked against the code as it is now (`Fresh.ts`), and the scripts the search passes over for good (`Retired.ts`); after nothing at the start, a stored commit to the first watched file the agent edits (`Watch.ts`); and what git doesn't show about a stored commit the agent reads with `git show` or `git log` (`History.ts`) |
| `workflows/` | the hook script (`hook.ts`) and storing commits (`Commits.ts`, `StoreTrigger.ts`, `Transcripts.ts`); the hand-over log (`Session.ts`) |
| `records/` | records: what a committed change shows, read from its session and its diff; what it was asked and what its commit says, which it is found by (`Task.ts`) |
| `traces/` | reading session logs: Claude Code's, and Codex's and Hermes Agent's as Claude Code's; whether a prompt asks for a change (`Requests.ts`) |
| `eval/` | the eval harness and its memory setups (no memory and saved scripts) |
| `local/` | the memory home and git |
| `handover/` | only `HookInput.ts`, the hook's input |
| `graph/` | only `Similarity.ts` and the store errors records use |

On this branch memory is saved scripts only. Memory v1's learning and
hand-over (the rest of `workflows/`), the learning step (`setup/AutoLearn.ts`,
`Learner.ts`, `LearnerModel.ts`, `Preferences.ts`, the model calls in
`eval/`), memory v0 (`memory/`, `search/`, the rest of `handover/`,
`src/hook.ts`), the graph setup, `layer/` and `web/` were removed; tags
`memory-v0` and `memory-local-first` keep them.

Memory reaches an agent four ways: the task-start hook hands over the
stored commit most like the task; the tool-call hook, mid-task, hands over
a stored commit by the file the agent edits, and adds what git doesn't show
about a stored commit the agent reads in git; the recall note (`setup/Instructions.ts`,
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

A stored change is found by its task, the first prompt of its part of the
log that asks for something, else the session's last that asked before it
(`records/Task.ts`), and by its commit message (`task.message`; records
stored before it get it from git when read, `Git.commitMessages`), the
message only when it has four words of its own. A task that asks for
nothing is never searched by.

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
  its diff chunk is left out and its file line names the commit that took
  its lines out (`git log -S`) and says to read the file as it is now. A file
  deleted since, its code nowhere else, is gone and its chunk left out too.
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

`Render.ts` gives hand-written source the room first (whole when it fits,
else each source file an equal share), then tests, then docs, examples,
fixtures, snapshots and config (`fileKind`); a file left under 200
characters is only named, with `git show <sha> -- <file>`.

Mistakes other stored changes made come along only when the two changes
share a code or test file few stored changes touched (`Search.tellingFiles`,
with two at least). Linked through any shared file (most changes edit
`README.md`), one session's failed `npm run build-declaration` reached every
later hand-over in two markdownlint passes, and agents ran it.

### A hand-over by file

A task start that hands over nothing writes the files to watch instead
(`Search.watchFiles`, `<home>/watch/<session>.json`): the non-docs,
non-snapshot files of stored changes whose task scores at least
`FILE_MIN_SCORE` (0.2) against the new one, each changed by at most
`MAX_FILE_SHARE` (20%, one at least) of the stored changes
(`Search.tellingFiles`), with up to
three changes per file, best first. The tool-call hook (`Watch.ts`, plain
node) checks each call of a watching session: an edit tool's file, a
patch's files, or a watched file a shell command names that `git status`
shows changed (agents also edit with sed and scripts). The first match
takes the watch and hands over the first of its changes still worth it,
examined as at task start (`Start.fileHandover`), with its own intro and
the edited file's change shown first; the log line has `moment: "file"`.
A change the session was given already (a commit it read, below) is
skipped.
One hand-over a task; the watch ends at the session's next task start and at
session end, and a watch older than a day is swept at the next task start. The common call costs
one look at the watch folder (timed at about 0.1 s a call either way).
`node apps/cli/examples/scripts/check-file-handover.ts` shows what it would
hand over on the markdownlint and excalidraw tasks.

### A hand-over by commit

Agents read the change before theirs with `git show`, unprompted (in the
note test of 2026-10-17, the first command of every session that added a
rule like an earlier one). Git has that change's diff; memory has the rest.
After a call that reads commits, the tool-call hook adds what git doesn't
show about the first one memory stored (`History.ts`, plain node, then
`Start.commitHandover`): the request that asked for it (when one did, else
its commit message was its task, and git has that), the project commands its
session ran, its mistakes, and other changes' mistakes in its files, as at
task start (`Render.renderBehind`, nothing when it has none of these). A
call reads commits when it runs `git show`, or `git log` printing a diff or
a stat. They're the commits its output heads with `commit <hash>`, else the
lines it starts with a hash, else the hashes and `HEAD~n` revisions its
command names (resolved in the repo; not `<commit>:<path>`). More than
two commits listed is a survey: nothing. A reading never gives a session
its own commits. Every hand-over notes its commit for the session (task
start, file, a reading, or `singularity recall`, which Claude Code's
`CLAUDE_CODE_SESSION_ID` ties to the session):
`<tenant>/scripts/sessions/<id>.given`. A reading or a watched file skips a
commit noted there; a task's start doesn't, since a new task may need the
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
