# singularity

**Memory for coding agents.** singularity keeps the changes your agents
commit in your repositories (the task, the files changed, the commands that
worked, the mistakes made on the way) and hands the one most like a new task
to the next agent session that does it.

Coding agents start every session from zero. They search the repo for the
places a change touches, rerun commands that failed last time, and relearn
the same lessons. singularity gives the agent a past change like its task
with its first prompt, read from git as the code is today.

## Install

macOS, Linux, WSL or Git Bash:

```sh
curl -fsSL --connect-timeout 10 https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex
```

You need git, and at least one of the agents below. Node.js 24 or later is
used if you have it; otherwise the installer fetches its own copy into
`~/.singularity/node` (checked against nodejs.org's checksums) and changes
nothing else.

The installer puts singularity in `~/.singularity` and runs
`singularity setup`, which walks you through:

1. which of your agents get memory;
2. in a repo with earlier sessions, storing the changes they committed.

Run `singularity setup` again any time to change your answers, and
`singularity update` to get the latest version: it keeps your answers and
brings memory's hooks, skill and command up to date, asking nothing again.
Running the installer again does the same. On WSL, run
the PowerShell command on Windows too if you also use agents there. From a
clone of this repo instead: `npm install`, then
`node apps/cli/src/singularity.ts setup`.

## Works with

| Agent | Memory at task start | Stores its sessions' changes |
|---|:-:|:-:|
| Claude Code | ✓ | ✓ |
| Codex | ✓ | ✓ |
| Hermes Agent | ✓ | ✓ |
| Gemini CLI | ✓ | |
| Droid | ✓ | |
| Cursor, OpenCode, other agents that read `~/.agents/skills` | when you ask for it | |

Codex runs new hooks only once you trust them. Setup offers to trust
memory's hooks for you (as `/hooks` in Codex would), and `singularity
status` says when Codex is still skipping them.

## How it works

1. **Record.** When a session commits a change and the last check before
   the commit passed (tests, a typecheck, a build or a lint; a docs-only
   change needs none), memory keeps a record of it: what you asked for (not
   the notices and reminders your tools add), the files changed and where,
   the commands that ran, and what failed and what fixed it. This needs no
   model call.
2. **Hand over.** When a task starts, memory picks the stored change whose
   task is most like it (plain text matching, no model call), reads that
   change from git as the code is now, and adds it to the agent's first
   prompt: its task, the files it changed, the commands that worked, the
   mistakes made, and the diff. When no stored change is alike enough,
   nothing is handed over.

There is no learning step: memory calls no model.

`singularity recall "<task>"` shows what any task would get in the repo
you're in.

## Commands

```
singularity status              # which agents have memory, how many changes it stored per repo
singularity recall "<task>"     # what a task here would be handed (no model call)
singularity status --json       # the same as JSON, for agents and scripts (recall too)
singularity learn --past        # store what this repo's earlier sessions committed
singularity setup               # set up again, or change your answers
singularity update              # get the latest version (keeps your answers)
singularity uninstall [--purge] # take memory out of every agent (memory stays unless --purge)
```

These six are all the installed command has. The commands that build and
measure memory by hand run from a clone of this repo
([`docs/development.md`](docs/development.md)).

## Privacy

- Everything memory keeps stays on your machine, in `~/.singularity`
  (`$SINGULARITY_HOME` to move it): records and logs.
  singularity has no server and sends nothing anywhere itself.
- Setup changes only memory's own entries in each agent's settings, and
  keeps a copy of every file it changes (`<file>.before-singularity`).
- Hooks never break a session: their errors go to
  `~/.singularity/hook-errors.log`, and `SINGULARITY_HOOKS=off` turns them
  off.

## Good to know

- Memory arrives with a session's first prompt. For a new task in a long
  session, start a new session to get what memory has for it.
- It helps with tasks like changes earlier sessions committed in the same
  repository. Every clone of a repo shares its memory.
- Commits memory leaves out (no passing check before them, say) are listed,
  with the reason, by `singularity status`.

## Results

These measured memory v1 (workflows learned from runs), which this version
no longer has; saved scripts have not been measured the same way yet.

Medians of 3 to 4 pre-registered runs per side, one pinned Claude Code
version, hidden tests; all 40 runs passed.

- A task asking for four changes to excalidraw, every kind learned: 28.5
  turns to 9.5, 1.90M tokens to 423k, $0.81 to $0.30.
- The same task with two of its four kinds learned: 30% fewer turns, 39%
  fewer tokens.
- Tasks whose kind memory hadn't learned: turns moved between 25% fewer and
  17% more.

These are small samples on two repositories (excalidraw and validator.js).
Each measurement's plan was written before its runs, and its results were
added at the end: [four changes, every kind
learned](apps/cli/examples/excalidraw/PREREGISTRATION-v1-long.md), [two of
four learned](apps/cli/examples/excalidraw/PREREGISTRATION-v1-long-mixed.md),
[kinds memory hadn't learned](apps/cli/examples/PREREGISTRATION-v1-new-kinds.md).
Memory failed the bars of a computer-use benchmark built to be hard on it:
[its results](apps/cli/examples/new-job/RESULTS.md).

## Develop

singularity is a TypeScript monorepo: the command line, hooks and memory in
`apps/cli` (Effect 4, run directly by Node 24, no build step) and the
landing page in `apps/landing` (Vite and React).

```
npm install
npm test               # every workspace's tests
npm run typecheck
npm run cli -- <args>  # the whole command line, from this clone
```

- [`docs/development.md`](docs/development.md): the code's layout and the
  commands that build and inspect memory by hand.
- [`docs/evaluation.md`](docs/evaluation.md): running the evaluation suites
  and comparing memory setups.
- [`CLAUDE.md`](CLAUDE.md): how the code is written.

## License

[MIT](LICENSE)

## References

- Wang et al., *Agent Workflow Memory*, [arXiv:2409.07429](https://arxiv.org/abs/2409.07429)
- *Procedural Graphs: Self-Evolving Execution Structures for LLM Agents*, [arXiv:2609.09153](https://arxiv.org/abs/2609.09153)
