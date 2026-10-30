# singularity

**Memory for coding agents.** When an agent commits a change, singularity
records the task, the files it changed and the commands it ran. When a later
session starts a similar task in the same repository, singularity points the
agent to that commit and lists the check scripts earlier sessions ran. The
agent can also look up a past change mid-task.

singularity helps with tasks like ones agents committed before in the same
repository. Its help comes from what the repository doesn't hold, such as a
check script a past session wrote outside the repository, or the commands
that session ran. An agent with its own memory of the repository may know
those already. So singularity should help most when the agent starts without
one, as Codex and Gemini CLI do by default, or Claude Code with its auto
memory turned off. Our results below come from Claude Code with auto memory
off.

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
   most like the new task. In Claude Code a small model picks it by default.
   That model is Haiku unless you choose another one, or none, in setup. It
   reads your task and the repository's stored changes, and picks one change
   or none. It runs in the background, so nothing waits for it, and the agent
   gets its answer a few seconds in, at its next step. Without a model,
   singularity matches the words of your task against each change's commit
   message. Either way, it tells the agent that change's commit, its commit
   message, and its files as they are named today. It leaves out the diff,
   which git has. Once a session, it also lists the check scripts that earlier
   sessions ran before committing and that are still on disk, such as a
   screenshot or end-to-end script. When the agent reads a stored change with
   `git show` or `git log`, singularity adds what the commit doesn't hold:
   the project commands its session ran, such as `npm test`, and what you
   asked for when the commit message says too little. It never hands over a
   diff or past mistakes.
3. **Recall mid-task.** Setup adds a short note to your agents'
   instructions, between `<!-- singularity:start ... -->` and
   `<!-- singularity:end -->`. It tells the agent to run
   `singularity recall "<what it is about to do>"` before a kind of change, a
   fix or a command it may have done before in the repository. The command
   prints the most similar past change, the same pointer with what git
   doesn't show, or says there is none.

Apart from that pick, singularity never calls a model. The pick costs about
$0.002 a task with Haiku, on your Claude plan. Run
`singularity recall "<task>"` yourself to see what an agent would be handed
for a task in the current repository.

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
singularity uninstall [--purge] # take memory out of every agent (--purge deletes it too)
```

## Computer use (preview)

Agents that drive a browser get memory of their own, set up apart from the
coding memory above:

```
singularity setup computer-use        # Claude Code's browser tools, and Claude desktop
singularity uninstall computer-use    # take it out again; coding memory stays
```

- When the agent opens an app memory knows, it gets the app's card: your
  rules for it, and the routes past sessions took to the screens they worked
  on. A route never names a send, pay or confirm button. The card comes at
  the task's start instead when your prompt names the app: its address, or
  a word you used before two sessions there and none elsewhere.
- When it reaches a known screen, it gets short notes: fields that start
  set, such as a box that starts ticked, ending "decide from the task",
  errors past sessions saw there, where they checked their result, and on
  a screen they left for different places, where they went. When the screen
  has changed, memory says nothing.
- To teach it a rule, say it in your prompt as an instruction: "Never
  restock damaged goods", "From now on, CC the manager on refunds". Rules
  are learned from Claude Code sessions; in Claude desktop memory doesn't
  see your prompts.
- `singularity changes --apps` lists the apps memory stored, and
  `singularity changes --app <app>` an app's sessions and the card an agent
  gets now.
- In Claude desktop, setup adds a server named `singularity-browser`: the
  browser tools of Playwright, through memory. Quit the app before setup;
  it rewrites its own config.
- It covers browsers driven from Claude Code (Playwright, Claude in Chrome,
  Claude's built-in browser) and Playwright in Claude desktop. Desktop apps
  are only noted, not helped yet.
- It never keeps screenshots, what you type, or what a page says. Page text
  is kept as a fingerprint until two sessions have seen it, and text that
  reads like an instruction, a link or an email address is never shown.
  Screens with a password field are left out.

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
- Memory stays on the machine that stored it. Clones of a repository on that
  machine share its memory.
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

**Fresh clones of chat-v2.** On 2026-10-22 we gave Claude Code two tasks
related to earlier work in [chat-v2](https://github.com/pandacover/chat-v2),
an Electron app of ours. Every run started from a fresh clone, with Claude
Code's auto memory off. Runs with singularity had a copy of the memory our
own sessions had built in chat-v2. Each one ran at the same time as a run
without singularity, on the same machine.

- Opus cost 26% less over 12 pairs of runs, and 10 of the 12 pairs were
  cheaper with singularity. Every run passed, with singularity and without.
- Sonnet cost the same, $3.50 with singularity and $3.51 without. It passed
  12 of 12 runs with singularity and 10 of 12 without.
- The help came from the check scripts and the project commands, not from
  the past change singularity pointed to. Opus reused the browser install
  that a past session had left on disk, wrote its own check from that
  session's scripts, and tested its change in the running app. The two
  Sonnet runs that failed without singularity committed a type error after
  trying `npx tsc`, which chat-v2 doesn't install. With singularity, Sonnet
  ran `bun run typecheck`, and several runs got that command from what
  singularity adds to `git show`.
- We measured this on the machine where those past sessions ran.
  singularity lists a check script only while it is still on disk, so on a
  new machine the list would be empty.
- No task passed less often with singularity.

**Daily use on markdownlint.** These runs used an earlier version, whose
hand-over included the past change's diff. Sonnet did 12 tasks in order, each
in a fresh session, three times with singularity and three times without.
Cost fell 6% (95% interval −13% to +1%), which is inside the noise. A second
run of the same three passes, on a version that also added notes when an
agent ran `git show`, cost 1.9% less (−12% to +8%). The earlier changes were
in the repository's git history, and agents read them there with
singularity and without.

**Recall.** Sonnet seldom runs `singularity recall` on its own. Across 177
sessions with the recall note on markdownlint, excalidraw and validator, it
ran recall once, and in its 12 runs on chat-v2 it never did. Opus ran it in 5
of its 12 runs on chat-v2.

These are small samples, on two repositories. The markdownlint runs, tables
and caveats are in
[`apps/cli/examples/scripts/RESULTS.md`](apps/cli/examples/scripts/RESULTS.md).

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
