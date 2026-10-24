# singularity

> Memory for coding agents. It stores each change a Claude Code, Codex or Hermes Agent session commits in a repository. When a later session starts a similar task there, it points the agent to that change's commit and lists the check scripts earlier sessions ran. In Claude Code a model picks that change in the background (Haiku by default, about $0.002 a task, on the user's Claude plan). Everywhere else, and when the user chooses no model, a word search over commit messages picks it, with no model call. It never writes the change itself.

Source: https://github.com/pandacover/singularity (MIT license)

## What it does

1. Store. When a session commits a change, memory records it. The record holds the task as the person wrote it, the files changed, the commands that ran, what failed and what fixed it, and whether the last test, typecheck, build or lint before the commit passed. Records stay on the machine.
2. Hand over. At task start, memory picks the stored change most like the new task, or none. Word search scores each stored change against the task by the change's commit message, and by its request only when the message says too little. It picks the best change above a fixed bar and calls no model. In Claude Code, a model the user chose at setup picks instead: Haiku by default, or Sonnet, Opus, another model by name, or none, which keeps word search. The model reads the task and the repository's stored changes and picks one or none. It runs in a background hook, so the session never waits, and the pointer reaches the agent with its next tool result, a few seconds in. Codex, Gemini CLI, Droid and Hermes Agent use word search. On 62 real task starts, going by the commit message cut wrong pointers from 6 to 1, and Haiku handed over 0 wrong and 10 right. Either way, memory gives the agent that change's commit, the first line of its commit message, and its files as they are called today. It leaves out the diff, which `git show` has. Once a session, it also lists the check scripts that earlier sessions ran before committing and that are still on disk, such as a screenshot or end-to-end script, each with the change it last checked. The agent still writes every line itself. A task starts at the first message that asks for something, and again at the first one after each commit, so each new task in a long session can get one. Messages like "yes" or "commit it" start none.
3. What git doesn't show. When the agent reads a stored change with `git show` or `git log`, memory adds what the commit doesn't hold: the project commands its session ran, and the task that asked for it when the commit message says too little. No hand-over carries a diff or past mistakes. Memory adds each change once a session, and never one the session made itself.
4. Recall. Setup adds a short note to the user-level instructions of Claude Code, Codex and OpenCode. It tells the agent it can run `singularity recall "<what it is about to do>"` before work likely done before in the repository.

## Where it helps

It helps with tasks like ones agents committed before in the same repository. Its help comes from what the repository doesn't hold, such as a check script a past session wrote outside the repository, or the commands that session ran. An agent with its own memory of the repository may know those already. So it should help most when the agent starts without one, as Codex and Gemini CLI do by default, or Claude Code with its auto memory turned off.

## Before installing

Ask your user which of their agents should get memory. The default is every agent found. Pass each one as `--agent <id>`.

For Claude Code, also ask whether a model should pick the past change at each task start, and which. The default is Haiku, about $0.002 a task on their Claude plan. The other answers are Sonnet, Opus, another model by name, or none, which means word search and costs nothing.

Your shell has no terminal for setup to ask in, so setup asks nothing there and takes the default for anything not passed. That default turns on Haiku's pick in Claude Code, and no flag gives another answer. If the user wants another model or none, tell them to run `singularity setup` in their own terminal afterwards and choose. Apart from that pick, memory calls no model. Storing, word search and the other agents cost nothing.

You need git. The installer uses Node.js 24 or later if the machine has it. Otherwise it downloads its own copy into `~/.singularity/node` and changes nothing else.

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
| Claude Code | hands over at task start, picked by the model the user chose (a second task-start hook, run in the background) or by word search, and stores its sessions' changes | hooks in `~/.claude/settings.json`, skill, recall note in `~/.claude/CLAUDE.md` |
| Codex | hands over, stores its sessions' changes, once its hooks are trusted | hooks in `~/.codex/hooks.json`, skill, recall note in `~/.codex/AGENTS.md` |
| Gemini CLI | hands over | hooks in `~/.gemini/settings.json`, skill |
| Droid | hands over | hooks in `~/.factory/hooks.json`, skill |
| Hermes Agent | hands over, stores its sessions' changes | plugin in `~/.hermes/plugins/singularity` (enabled in its `config.yaml`), skill |
| OpenCode | when asked | skill, recall note in `~/.config/opencode/AGENTS.md` |
| Cursor, agents that read `~/.agents/skills` | when asked | skill |

On Windows, Hermes Agent's folder is `%LOCALAPPDATA%\hermes`. Setup never touches the rest of an agent's settings. It keeps a copy of each settings file it changes as `<file>.before-singularity`. In instruction files it adds only the recall note, between `<!-- singularity:start ... -->` and `<!-- singularity:end -->`. It also writes the `singularity` command into `~/.singularity/bin` and adds that folder to PATH. On Windows that is the user's Path. Elsewhere it is a marked line in the shell's startup file. Hooks never break a session. Their errors go to `~/.singularity/hook-errors.log`.

## Commands

```
singularity status [--json]         # which agents have memory, how many changes it stored per repo
singularity changes [<commit>] [--json] # the changes stored here, newest first, or one as it would be handed over (--repo <name> for another repo)
singularity visualise [--json]      # the same memory drawn for a person at a terminal (--repo <name> for another repo)
singularity recall "<task>" [--json] # the past change here most like a task (--cwd <repo> for another repo)
singularity store                   # store what this repo's earlier sessions committed (--repo <path> for another repo)
singularity setup                   # set up again to change the answers (the same flags as at install)
singularity update                  # the latest version, keeping every answer
singularity uninstall [--purge]     # take memory out of every agent (memory stays unless --purge)
```

Memory usually arrives on its own at task start. You don't need `recall` for every task.

## Update

```
singularity update
```

It fetches the latest code into `~/.singularity/app` and installs its dependencies when they changed. Then the new code brings what setup put in place up to date: hooks, Hermes Agent's plugin, the skill, the recall note and the command, only in the agents that already have memory. It asks nothing again, and agents left out stay out. If memory is storing a change in the background, it stops without changing anything. Run it again a minute later. Running the install command again does the same once memory is set up. With flags, it runs setup instead. An agent installed since setup gets memory from `singularity setup`.

## Uninstall

```
singularity uninstall
```

It takes memory's hooks, plugin, skill and recall note out of every agent and leaves the user's own settings. It removes the `singularity` command and takes its folder off PATH. Memory itself stays in `~/.singularity`, so setting up again later picks up where it left off.

To delete memory too, every record and the installed code, ask the user first, then run `singularity uninstall --purge --yes`. Without `--yes`, your shell has no terminal to confirm in and memory is kept.

## Where things are

`~/.singularity`, or `$SINGULARITY_HOME` when set:

| Path | What it is |
|---|---|
| `config.json` | the user's answers kept between runs of setup. `picks` is the model that picks in Claude Code, or `null` for word search. `path` is false when setup was told `--no-path`, and otherwise `update` keeps the command on PATH. |
| `app/` | the code, a git clone that `singularity update` updates |
| `node/` | the Node.js the installer fetched, only when the machine had none new enough |
| `bin/` | the `singularity` command |
| `tenants/local/subjects.json` | the repositories memory knows |
| `tenants/local/records/` | one record per stored change |
| `tenants/local/scripts/retired.jsonl` | stored changes memory no longer hands over: reverted, replaced, or their files gone |
| `tenants/local/facts/` | for each repository, what its stored changes teach about checking a change, written when memory stores |
| `tenants/local/scripts/sessions/` | for each session, the commit its last task started at, and the changes and check scripts memory gave it |
| `tenants/local/skipped.jsonl` | commits memory left out, and why. `singularity status` sums them up. |
| `store.log` | what storing in the background did |
| `hook-errors.log` | hook errors, which never break a session |

## When something is off

- Memory knows nothing in a repository. It stores changes as sessions commit them. `singularity status` shows what it kept and left out, and `singularity store` looks through earlier sessions.
- A task got nothing. No stored change was close enough, the model picked none, or the message asked for nothing ("yes", "commit it"). When the model can't be asked, word search picks instead. `singularity recall "<task>"` shows the closest change by word search, or says there is none.
- Codex hands nothing over. Its hooks aren't trusted yet, so the user opens Codex and types `/hooks`.
- `singularity` isn't found in a new terminal. Run the install command again. It updates and puts the command back on PATH. Then open a new terminal.
- Hooks are failing. See `~/.singularity/hook-errors.log`. `singularity status` counts the errors too.

## Results

Fresh clones of chat-v2 (https://github.com/pandacover/chat-v2), an Electron app, on 2026-10-22. Claude Code ran two tasks related to earlier work there, with its auto memory off, so the only memory of the repository was singularity's. Runs with memory had a copy of the memory the maintainers' own sessions had built. Each ran at the same time as a run without memory, on the same machine.

- Opus cost 26% less with memory over 12 pairs of runs, and 10 of the 12 pairs were cheaper. Every run passed, with memory and without.
- Sonnet cost the same, $3.50 with memory and $3.51 without. It passed 12 of 12 runs with memory and 10 of 12 without.
- The help came from the check scripts and the project commands, not from the past change memory pointed to. Opus reused the browser install that a past session had left on disk, wrote its check from that session's scripts, and tested its change in the running app. The two Sonnet runs that failed without memory committed a type error after trying `npx tsc`, which chat-v2 doesn't install. With memory, Sonnet ran `bun run typecheck`, and several runs got that command from what memory adds to `git show`.
- No task passed less often with memory.

Daily use on markdownlint, on an earlier version whose hand-over included the past change's diff. Sonnet did 12 tasks in order, each in a fresh session, three times with memory and three times without. Cost fell 6% (95% interval −13% to +1%), which is inside the noise. A second run of the same passes, which also added notes when an agent ran `git show`, cost 1.9% less (−12% to +8%). The earlier changes were in the repository's git history, and agents read them there with memory and without.

Sonnet seldom runs `singularity recall` on its own. Across 177 sessions with the recall note on markdownlint, excalidraw and validator, it ran recall once, and in its 12 runs on chat-v2 it never did. Opus ran it in 5 of its 12 runs on chat-v2.

## Limits

- It helps where the repository says too little. Where the past changes are in git and the agent reads them anyway, memory adds little.
- Memory lists only check scripts still on disk, so on a new machine it lists none. The chat-v2 runs were on the machine where the past sessions ran.
- The runs had Claude Code's auto memory off. An agent that keeps its own notes on a repository may already know what memory tells it.
- The chat-v2 runs picked by word search, before the model's pick, and their notes on `git show` still listed past mistakes. The markdownlint runs had a hand-over with the diff.
- Small samples: 12 pairs of runs per model on chat-v2, over two tasks in one repository, and three passes of 12 tasks on markdownlint. The picking numbers come from 62 real task starts, not from paid runs.
- A model's pick reaches the agent a few seconds in, at its next tool result, so its first step goes without it.
- Each comparison is within one Claude Code version.
