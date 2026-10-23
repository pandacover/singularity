# singularity

**Memory for coding agents.** When an agent commits a change, singularity
records the task, the files it changed, the commands it ran and the mistakes
it made. When a later session starts a similar task in the same repository,
singularity reads that change from git as the code is now and adds it to the
agent's first prompt. The agent can also look up a past change mid-task.

## Install

macOS, Linux, WSL or Git Bash:

```sh
curl -fsSL --connect-timeout 10 https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex
```

You need git and at least one of the agents below. The installer uses your
Node.js if it is version 24 or later. Otherwise it downloads its own copy into
`~/.singularity/node`, checks it against nodejs.org's checksums, and changes
nothing else on your system.

The installer puts singularity in `~/.singularity` and runs
`singularity setup`. Setup asks which of your agents get memory, and, for
Claude Code, whether a model should pick the past change at each task start
(below). In a repository with earlier sessions, it also stores the changes
they committed.

Run `singularity setup` again to change your answers. Run
`singularity update`, or the installer again, to get the latest version. It
keeps your answers and asks nothing. On WSL, also run the PowerShell command
on Windows if you use agents there.

To set up from a clone of this repository instead, run `npm install`, then
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

Claude Code, Codex and OpenCode also get the recall note, described below,
in their user-level instructions. Other agents get only the skill.

Codex runs a new hook only after you trust it. Setup offers to trust
singularity's hooks for you, and `singularity status` tells you if Codex
still skips them.

## How it works

1. **Store.** When a session commits a change, singularity records it. The
   record holds what you asked for, the files changed, the commands that
   ran, what failed and what fixed it, and whether the last test, typecheck,
   build or lint before the commit passed.
2. **Hand over.** At the start of a task, singularity finds the stored change
   most like the new task. By default in Claude Code a small model picks it
   (Haiku; you can choose another model, or none, in setup): it reads your
   task and the repository's stored changes and picks one, or none. It runs
   in the background, so nothing waits for it; the agent gets its answer a
   few seconds in, at its next step. Without a model, singularity matches
   the words of your task against each change's commit message. Either way
   it tells the agent that change's commit, its commit message, and its
   files as they are called today, without the diff: git has it. Then it
   lists the check scripts earlier sessions ran before committing (a
   screenshot or end-to-end script, say) that are still on disk, once a
   session. When the agent reads a stored change in git, with `git show` or
   `git log`, singularity adds what the commit doesn't hold: what you asked
   for, the commands that ran, and what failed and what fixed it.
3. **Recall mid-task.** Setup adds a short note to your agents'
   instructions, between `<!-- singularity:start ... -->` and
   `<!-- singularity:end -->`. It tells the agent to run
   `singularity recall "<what it is about to do>"` before a kind of change, a
   fix or a command it may have done before in the repository. The command
   prints the most similar past change, or says there is none.

Apart from that pick, singularity never calls a model; the pick costs about
$0.002 a task with Haiku, on your Claude plan. Run `singularity recall "<task>"` yourself
to see, in full, the stored change a task would be pointed to in the current
repository.

## Commands

```
singularity status              # which agents have memory, how many changes it stored per repo
singularity changes             # the changes stored for this repo, newest first, with their commits
singularity changes <commit>    # one of them, as an agent would be handed it now
singularity visualise           # the same memory drawn: when changes were committed, the latest, the folders it knows
singularity recall "<task>"     # the past change here most like a task
singularity status --json       # the same as JSON, for agents and scripts (changes, visualise and recall too)
singularity store               # store what this repo's earlier sessions committed
singularity setup               # set up again, or change your answers
singularity update              # get the latest version, keeping your answers
singularity uninstall [--purge] # take memory out of every agent; --purge deletes it too
```

## Privacy

- singularity keeps its records and logs in `~/.singularity`. Set
  `$SINGULARITY_HOME` to move them. It has no server and sends nothing
  anywhere.
- Setup changes only singularity's own entries in each agent's settings. It
  saves a copy of each settings file it changes as
  `<file>.before-singularity`. In instruction files it adds only the marked
  recall note, and `uninstall` removes it.
- A hook error never breaks a session. Hooks write errors to
  `~/.singularity/hook-errors.log`. Set `SINGULARITY_HOOKS=off` to turn them
  off.

## Good to know

- A hand-over arrives with the first prompt that asks for something, and
  again with the first one after each commit, so each new task in a long
  session can get one. Prompts like "yes" or "commit it" get none.
- singularity helps with tasks like ones earlier sessions committed in the
  same repository. Clones of a repository on one machine share its memory.
- `singularity visualise` draws a repository's memory in the terminal: the
  days changes were committed, the latest ones with their size and check,
  the folders memory knows most, and the changes it handed over most.
  Outside a repository it knows, it shows every repository side by side.
- `singularity changes` lists the changes singularity stored in a repository,
  and the ones it no longer hands over and why, such as a revert or a newer
  change of the same files.
- `singularity status` lists the commits singularity didn't store and why,
  such as a failing check before the commit.

## Results

We ran 12 markdownlint tasks in sequence, five times with singularity and
three times without, on Claude Code 2.1.295.

- Pass counts swing. One task that leaves a check failing fails every later
  task until an agent fixes it. With singularity, 4 of 60 tasks started such
  a run of failures. Without it, 2 of 36 did.
- A hand-over can cause a mistake. Across all our markdownlint runs, when a
  hand-over listed a build command that had failed before, agents ran that
  command in 8 of 10 tasks, and in none of the 78 other tasks. Two of those runs failed the task. A fix is in the code but
  not yet measured in runs.
- Agents almost never ran `singularity recall` on their own. One did, in 60
  runs that had the recall note.
- On the 7 tasks with a hand-over at the start, cost fell 16% and tokens 24%.
  The other 5 tasks cost the same with and without singularity.

On two long excalidraw tasks, one used 43% to 53% fewer tokens than no
memory over two batches of 4 runs. The other, over 8 runs, was within the
noise.

These are small samples on two repositories. The runs, tables and caveats
are in [`apps/cli/examples/scripts/RESULTS.md`](apps/cli/examples/scripts/RESULTS.md).

## Develop

singularity is a TypeScript monorepo. `apps/cli` holds the command line,
hooks and memory, written with Effect 4 and run directly by Node 24 with no
build step. `apps/landing` is the landing page, built with Vite and React.

```
npm install
npm test               # every workspace's tests
npm run typecheck
npm run cli -- <args>  # the whole command line, from this clone
```

- [`docs/development.md`](docs/development.md) covers the code's layout and
  the commands that build and inspect memory by hand.
- [`docs/evaluation.md`](docs/evaluation.md) covers the evaluation suites.
- [`CLAUDE.md`](CLAUDE.md) covers how the code is written.

## License

[MIT](LICENSE)
