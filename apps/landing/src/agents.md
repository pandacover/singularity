# singularity

> Memory for coding agents. It stores each change a Claude Code, Codex or Hermes Agent session commits in a repository. When a later session starts a similar task there, it points the agent to that change's commit, and lists the check scripts earlier sessions ran. In Claude Code a model picks that change, in the background (Haiku by default, about $0.002 a task, on the user's Claude plan); everywhere else, and when the user chooses no model, a word search over commit messages picks it, with no model call. It never writes the change itself.

Source: https://github.com/pandacover/singularity (MIT license)

## What it does

1. Store. When a session commits a change, memory records it. The record holds the task as the person wrote it, the files changed, the commands that ran, what failed and what fixed it, and whether the last test, typecheck, build or lint before the commit passed. Records stay on the machine.
2. Hand over. At task start, memory picks the stored change most like the new task, or none, in one of two ways. Word search scores each stored change against the task, by the change's commit message (by its request only when the message says too little), and picks the best one above a fixed bar; it calls no model. In Claude Code, a model the user chose at setup picks instead (Haiku by default; Sonnet, Opus, another model by name, or none, which keeps word search): it reads the task and the repository's stored changes and picks one or none. It runs in a background hook, so the session never waits, and the pointer reaches the agent with its next tool result, a few seconds in. Codex, Gemini CLI, Droid and Hermes Agent use word search. On 62 real task starts, going by the commit message cut wrong pointers from 6 to 1, and Haiku handed over 0 wrong and 11 right. Either way, memory gives the agent that change's commit, the first line of its task, and its files as they are called today, without the diff: `git show` has it. Then the check scripts earlier sessions ran before committing (a screenshot or end-to-end script) that are still on disk, each with the change it last checked, once a session. The agent still writes every line itself. A task starts at the first message that asks for something, and again at the first one after each commit, so each new task in a long session can get one. Messages like "yes" or "commit it" start none.
3. What git doesn't show. When the agent reads a stored change with `git show` or `git log`, memory adds what the commit doesn't hold: the task that asked for it, the commands its session ran, and its mistakes. It adds each change once a session, and never the session's own.
4. Recall. Setup adds a short note to the user-level instructions of Claude Code, Codex and OpenCode. It tells the agent it can run `singularity recall "<what it is about to do>"` before work likely done before in the repository.

## Before installing

Ask your user which of their agents should get memory. The default is every agent found. Pass each one as `--agent <id>`.

For Claude Code, also ask whether a model should pick the past change at each task start, and which. The default is Haiku, about $0.002 a task on their Claude plan; the other answers are Sonnet, Opus, another model by name, or none (word search, free).

Your shell has no terminal for setup to ask in, so setup asks nothing there and takes the default for anything not passed. That default turns on Haiku's pick in Claude Code, and there is no flag for another answer: if the user wants another model or none, tell them to run `singularity setup` in their own terminal afterwards and choose. Apart from that pick, memory calls no model: storing, word search and the other agents cost nothing.

Needs git. The installer uses Node.js 24 or later if the machine has it. Otherwise it downloads its own copy into `~/.singularity/node` and changes nothing else.

## Install

macOS, Linux, WSL or Git Bash, with flags after `sh -s --`:

```
curl -fsSL --connect-timeout 10 https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh -s -- --yes
```

Windows PowerShell, with flags at the end:

```
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1))) --yes
```

A person at a terminal can run the short forms, which ask the questions themselves: `curl -fsSL https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh` or `irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex`.

The installer clones the code into `~/.singularity/app`, installs its dependencies, then runs `singularity setup`. In a repository with earlier sessions, setup also stores the changes they committed. WSL keeps its own agents, so for agents that run on Windows, run the PowerShell command on Windows too.

Setup flags:

- `--yes` (`-y`) takes every default and asks nothing. For Claude Code, that includes Haiku picking the past change.
- `--agent <claude|codex|gemini|droid|hermes|cursor|opencode>` sets up only that agent. Repeat it for several.
- `--no-path` leaves the `singularity` command off PATH.

## After installing

The `singularity` command is on PATH only in terminals opened after setup. In the shell you installed from, run it by its full path: `~/.singularity/bin/singularity`, or `~\.singularity\bin\singularity.cmd` on Windows.

1. Check it. `singularity status` lists the agents that have memory, who picks the past change at task start, and how many changes it stored per repository.
2. Codex runs new hooks only once the user trusts them. Setup trusts them when a person answers yes at its terminal. From your shell it can't, so tell the user to open Codex and type `/hooks`. `singularity status` says whether Codex trusts them.
3. Agents running now get memory from their next start.
4. In another repository with earlier sessions, `singularity store` stores what those sessions committed.

## What setup changes

| Agent | What memory does there | Files |
|---|---|---|
| Claude Code | hands over at task start, picked by the model the user chose (a second task-start hook, run in the background) or by word search; stores its sessions' changes | hooks in `~/.claude/settings.json`, skill, recall note in `~/.claude/CLAUDE.md` |
| Codex | hands over, stores its sessions' changes, once its hooks are trusted | hooks in `~/.codex/hooks.json`, skill, recall note in `~/.codex/AGENTS.md` |
| Gemini CLI | hands over | hooks in `~/.gemini/settings.json`, skill |
| Droid | hands over | hooks in `~/.factory/hooks.json`, skill |
| Hermes Agent | hands over, stores its sessions' changes | plugin in `~/.hermes/plugins/singularity`, enabled in its `config.yaml`; skill |
| OpenCode | when asked | skill, recall note in `~/.config/opencode/AGENTS.md` |
| Cursor, agents that read `~/.agents/skills` | when asked | skill |

On Windows, Hermes Agent's folder is `%LOCALAPPDATA%\hermes`. Setup never touches the rest of an agent's settings. It keeps a copy of each settings file it changes as `<file>.before-singularity`. In instruction files it adds only the recall note, between `<!-- singularity:start ... -->` and `<!-- singularity:end -->`. It also writes the `singularity` command into `~/.singularity/bin` and adds that folder to PATH: the user's Path on Windows, a marked line in the shell's startup file elsewhere. Hooks never break a session. Their errors go to `~/.singularity/hook-errors.log`.

## Commands

```
singularity status [--json]         # which agents have memory, how many changes it stored per repo
singularity changes [<commit>] [--json] # the changes stored here, newest first, or one as it would be handed over; --repo <name> for another
singularity visualise [--json]      # the same memory drawn for a person at a terminal; --repo <name> for another
singularity recall "<task>" [--json] # the past change here most like a task; --cwd <repo> for another repo
singularity store                   # store what this repo's earlier sessions committed; --repo <path> for another
singularity setup                   # set up again, to change the answers; takes the same flags as at install
singularity update                  # the latest version, keeping every answer
singularity uninstall [--purge]     # take memory out of every agent; memory stays unless --purge
```

Memory usually arrives on its own at task start. You don't need `recall` for every task.

## Update

```
singularity update
```

It fetches the latest code into `~/.singularity/app` and installs its dependencies when they changed. Then the new code brings what setup put in place up to date: hooks, Hermes Agent's plugin, the skill, the recall note and the command, only in the agents that already have memory. It asks nothing again, and agents left out stay out. If memory is storing a change in the background, it stops without changing anything; run it again a minute later. Running the install command again does the same once memory is set up. With flags, it runs setup instead. An agent installed since setup gets memory from `singularity setup`.

## Uninstall

```
singularity uninstall
```

It takes memory's hooks, plugin, skill and recall note out of every agent, leaving the user's own settings, removes the `singularity` command and takes its folder off PATH. Memory itself stays in `~/.singularity`, so setting up again later picks up where it left off.

To delete memory too, every record and the installed code, ask the user first, then run `singularity uninstall --purge --yes`. Without `--yes`, your shell has no terminal to confirm in and memory is kept.

## Where things are

`~/.singularity`, or `$SINGULARITY_HOME` when set:

| Path | What it is |
|---|---|
| `config.json` | the user's answers kept between runs of setup: `picks`, the model that picks in Claude Code, or `null` for word search |
| `app/` | the code, a git clone that `singularity update` updates |
| `node/` | the Node.js the installer fetched, only when the machine had none new enough |
| `bin/` | the `singularity` command |
| `tenants/local/subjects.json` | the repositories memory knows |
| `tenants/local/records/` | one record per stored change |
| `tenants/local/scripts/retired.jsonl` | stored changes memory no longer hands over: reverted, replaced, or their files gone |
| `tenants/local/facts/` | for each repository, what its stored changes teach about checking a change: written when memory stores |
| `tenants/local/scripts/sessions/` | for each session, the commit its last task started at, and the changes and check scripts memory gave it |
| `tenants/local/skipped.jsonl` | commits memory left out, and why; `singularity status` sums them up |
| `store.log` | what storing in the background did |
| `hook-errors.log` | hook errors; they never break a session |

## When something is off

- Memory knows nothing in a repository. It stores changes as sessions commit them. `singularity status` shows what it kept and left out, and `singularity store` looks through earlier sessions.
- A task got nothing. No stored change was close enough, the model picked none, or the message asked for nothing ("yes", "commit it"). When the model can't be asked, word search picks instead. `singularity recall "<task>"` shows the closest one by word search, or says there is none.
- Codex hands nothing over. Its hooks aren't trusted yet, so the user opens Codex and types `/hooks`.
- Hooks are failing. See `~/.singularity/hook-errors.log`. `singularity status` counts the errors too.

## Results

Twelve tasks in the markdownlint repository, run in order, five passes with memory and three without, on one Claude Code version:

- The 7 tasks with a hand-over at the start cost 16% less and used 24% fewer tokens. The other 5 cost the same as without memory.
- A hand-over can carry a mistake forward. When one listed a build command that had failed before, agents ran it in 8 of 10 tasks, and in none of the 78 others.
- A task that leaves a check failing fails every later task. With memory, 4 of 60 tasks started such a run; without it, 2 of 36.
- Agents ran `singularity recall` on their own once in 60 runs that had the recall note.

On two long excalidraw tasks, one used 43% to 53% fewer tokens than no memory over two batches of 4 runs. The other was within the noise.

## Limits

- It helps with tasks like ones already committed in the same repository. With no close past change, a task costs what it costs without memory.
- Small samples, on two repositories. Picking was judged on 62 real task starts, not in paid runs.
- A model's pick reaches the agent a few seconds in, at its next tool result, so its first step goes without it.
- Results are compared only within one Claude Code version.
