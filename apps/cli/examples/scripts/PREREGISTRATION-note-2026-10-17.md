# Pre-registration: does the recall note's wording make agents run recall? (2026-10-17)

Written before any paid session ran. Driver: `examples/markdownlint/note-test.mjs`.

## Question

Agents almost never run `singularity recall` on their own: 0 of 81 eval
sessions that had the note (2026-10-16), and once in the user's own sessions
since 10-15 (it found nothing). They see the note and they read git history
instead (25 of 33 eval sessions with memory read past commits before their
first edit). The note's trigger is a judgment the agent can't make without
looking ("when you are about to do something that was likely done before"),
and it hedges twice ("Don't run it at every step", and in the skill "Memory
usually arrives on its own"). Does a note whose trigger is the habit agents
already have, reading git history, with no hedges, make them run it?

## Arms

The same sessions; only the note differs, given with
`--append-system-prompt-file` as the 10-16 evals gave it.

A, the note setup installs (`src/setup/Instructions.ts`, `RECALL_NOTE`):

> This machine keeps the changes past coding sessions committed in each git
> repository. At task start you may be handed one, headed "A past change in
> this repository like your task".
>
> Mid-task, when you are about to do something that was likely done before in
> this repository (a kind of change, a fix, a command that keeps failing), run
> `singularity recall "<what you are about to do>"` in the repository. It
> prints the most similar past change, read from git as it is now, or says there
> is none. It calls no model. Don't run it at every step, or for the task you
> were just handed a change for.

B, tied to reading git history, without the hedges (what it says recall
prints is what `src/scripts/Render.ts` prints):

> This machine keeps the changes past coding sessions committed in each git
> repository, with what git doesn't keep: the commands each session ran and the
> mistakes it made. At task start you may be handed one, headed "A past change
> in this repository like your task".
>
> When nothing was handed over, run `singularity recall "<what you are about to do>"`
> in the repository before you look through its history for how something was
> done (git log, git show, git blame). It prints the most similar past change,
> read from git as it is now, with the commands its session ran and the mistakes
> it made, or says there is none. It takes a second or two and calls no model.

Both start with the heading `## singularity memory`.

## Tasks and the state each starts from

Six markdownlint tasks of `tasks-day.json` (no list of what a change of its
kind needs, no instruction to commit), each prompt starting "This is our fork
of markdownlint." as the stored ones do:

- with a stored change of the same kind: t04 (a new rule, after t01 and t02),
  t07 and t10 (new rules), t09 (a rule's new parameter, after t03);
- without one: t08 (an example custom rule) and t11 (a bug fix), where
  running recall can only cost.

Each session starts where pass 1 of the 2026-10-16 markdownlint eval (memory
arm) started that task: a fresh clone of that pass's repo at the task's
starting commit, with no remote and no reflog, the later commits pruned
(checked: none of them is in the clone), `node_modules` a junction to the
pass's. Memory is a copy of that pass's memory holding only the records of
the tasks before it. Memory's hooks are off, so nothing is handed over at the
start or by file and nothing is stored: the condition of the user's own
sessions, where the start hand-over came 0 times in 5 tries. The
`singularity` command on PATH runs the branch's code as frozen for the day
benchmark (`C:\singularity-workspaces\eval-1016\app-new`, `COMMIT.txt`
there) on the session's memory.

## A property of the setup, found in the free dry run

Recall as it stands returns nothing for a query that names the new thing.
For each task the dry run asked recall what an agent might ("add a new
built-in rule MD063 list-max-depth", ...): 0 of 6 matched, though t04's
memory holds two new rules. "add a new built-in rule" matches t01 at 1.0.
A query matches at a task score of 0.38 or when its words, weighted by how
rare they are among the stored changes, are 60% covered (`QUERY_MIN`); the
new rule's name is the rarest and so weighs most. So this test measures
whether agents run recall, not whether it pays. After the run, each query an
agent ran is replayed against that session's memory, as it is and with the
new thing's own names left out, to see what a match on the kind of change
would have handed it.

## Sessions

Claude Code 2.1.296 (pinned copy), `--model sonnet --effort medium`,
`--setting-sources project,local` (no user settings, CLAUDE.md or skills),
the same tools as the day benchmark, below normal priority. A PreToolUse
hook ends the session at its first Edit, Write, MultiEdit or NotebookEdit
(`continue: false`; the edit itself lands, in the throwaway clone): by
then the agent has decided how to go about the change. Backstops:
`--max-turns 40`, `--max-budget-usd 0.60`, 15 minutes.

Order, one session at a time, which note goes first alternating:
t04 A, B; t07 B, A; t09 A, B; t10 B, A; t08 A, B; t11 B, A.

## Measures

From each transcript (`scoreTranscript` in the driver), up to the first
edit (an Edit-family call, or a shell command that writes a file):

- primary: whether the agent ran `singularity recall`;
- what recall printed (a change or "nothing"), and the query;
- git history lookups (`git log`, `show`, `blame`, `diff` against a commit);
- tool calls, and the session's cost.

## Decision

Six sessions a note read only as a gap:

- B ran recall in 4 or more of 6 and A in at most 1: the wording moves
  behavior. Next: whether recall answers the queries agents write (the
  replay above), then whether B pays in full runs.
- B in 2 or fewer: wording isn't the lever. Next: memory brought to the
  agent when it reads git history (the tool-call hook), not asked for.
- Anything between: inconclusive at this size; said so.

Harm, reported first: B's cost to the first edit against A's, and recall
runs on t08 and t11.

## Budget

About $2 expected; the driver stops before a session once $4 is spent, and
at the account's usage limit (exit 75, nothing after it counted).

## Limits

- The note sits in the system prompt; in daily use it is in the user's
  CLAUDE.md, with the skill listed too. Both arms alike.
- Sonnet; the user's own sessions run Opus 5.5.
- The stored prompts in this memory carry each kind's list of what a change
  needs, which the user's real memory doesn't: a found change pays more here
  than it would there. It doesn't change whether an agent runs recall.
- One session per task and note.

## Added after the run: a deviation

The first session (t04, A) wrote its files through Bash heredocs, which the
stop hook (Edit-family calls only) didn't catch. It was stopped by hand after
12 calls. Before the second session the hook was made to stop at a shell
command that writes a file too, the same pattern the measures use. All
measures are read up to the first edit, as planned; the cut-short session
reported no cost, so its tokens give it. Results: `RESULTS.md`.
