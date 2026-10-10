# singularity

**Memory for coding agents.** singularity learns how changes get done in your
repositories (where each kind of change goes, how it is checked, which
mistakes cost time) and hands that to the next agent session that does a
similar task.

Coding agents start every session from zero. They search the repo for the
places a change touches, rerun commands that failed last time, and relearn
the same lessons. singularity watches the changes your agents commit, learns
the workflows behind them, and gives the agent the steps it needs with its
first prompt, pointing at the code as it is today.

On excalidraw, a task asking for four kinds of change memory had learned
took 9.5 turns instead of 28.5, and 423k tokens instead of 1.90M ($0.30
instead of $0.81). On kinds of change it hasn't seen, it costs about what no
memory costs. ([Results](#results))

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
2. which agent's model does the learning, if you have more than one that can;
3. whether memory may learn on its own, and how much it may spend a day.

Run `singularity setup` again any time to change your answers, and
`singularity update` to get the latest version: it keeps your answers and
brings memory's hooks, skill and command up to date, asking nothing again.
Running the installer again does the same. On WSL, run
the PowerShell command on Windows too if you also use agents there. From a
clone of this repo instead: `npm install`, then
`node apps/cli/src/singularity.ts setup`.

## Works with

| Agent | Memory at task start | Warnings during the task | Learns from its sessions | Can do the learning |
|---|:-:|:-:|:-:|---|
| Claude Code | ✓ | ✓ | ✓ | ✓ with Sonnet |
| Codex | ✓ | ✓ | ✓ | ✓ with the model Codex is set to use |
| Hermes Agent | ✓ | ✓ | ✓ | ✓ with the model Hermes is set to use |
| Gemini CLI | ✓ | ✓ | | |
| Droid | ✓ | ✓ | | |
| Cursor, OpenCode, other agents that read `~/.agents/skills` | when you ask for it | | | |

Codex runs new hooks only once you trust them. Setup offers to trust
memory's hooks for you (as `/hooks` in Codex would), and `singularity
status` says when Codex is still skipping them.

## How it works

1. **Record.** When a session commits a change and the last check before
   the commit passed (tests, a typecheck, a build or a lint; a docs-only
   change needs none), memory keeps a record of it: the prompts that led to
   it, the files changed and where, the commands that ran, and what failed
   and what fixed it. This needs no model call.
2. **Learn.** After every 3 new changes in a repo, a model reads the
   records and writes *workflows*: small reusable steps with blanks for the
   values that differ (`{field}`, `{shortcut}`), the places in the code they
   touch, the commands that check them, and the mistakes worth a warning. A
   new version is kept only if, replayed over the past changes, it fits them
   at least as well as the one before.
3. **Hand over.** When a task starts, memory picks the workflows the task's
   words call for (plain text matching, no model call, a fraction of a
   millisecond), fills in the values the task states, finds each place in
   the code as it is now, and adds it all to the agent's first prompt.
4. **Warn.** During the task, when a known mistake is about to happen again,
   its fix arrives with the error.

Memory helps the agent do the task; it never writes the change for it.
Workflows keep places as the blocks around an edit
(`class App › getContextMenuItems › return [`), not as code, so they keep
working as the code moves.

### What an agent gets

For the task *"Add a Grid lines toggle setting, stored in a new appState
field gridLinesEnabled (default false) … toggle it with Alt+G and from
Preferences in the main menu"* in excalidraw, the first prompt carries five
workflows. The first one, trimmed:

````
## 1. Add a persisted field to the app state
Filled from your task: {default} = `false`
Blanks: {field} the new appState field name
1. Add `{field}: {type};` to the AppState interface.
   `packages/excalidraw/types.ts:326-587` in export interface AppState {
   ```
     326| export interface AppState {
        ⋮
     586|   fontTopPicks: readonly FontFamilyValues[] | null;
     587| }
   ```
2. Add `{field}: false,` to the default app state returned by getDefaultAppState.
   `packages/excalidraw/appState.ts:28-146` in export const getDefaultAppState = …
3. Add `{field}: { browser: <bool>, export: <bool>, server: <bool> }` to the
   storage config, following the storage rules the task states.
4. Regenerate snapshots, since a new app-state field changes many of them.
Watch out: `yarn test:update` already passes a --watch option, so adding
`--watch=false` fails with 'Expected a single value for option -w, --watch'.
Run plain `yarn test:update`.
````

`singularity recall "<task>"` shows what any task would get in the repo
you're in.

## Commands

```
singularity status              # which agents have memory, what it knows per repo, how learning goes
singularity recall "<task>"     # what a task here would be handed (no model call)
singularity learn               # learn from new changes now (asks before spending)
singularity learn --past        # first store what this repo's earlier sessions committed
singularity learn --dry-run     # what a round would learn and roughly cost
singularity setup               # set up again, or change your answers
singularity update              # get the latest version (keeps your answers)
singularity uninstall [--purge] # take memory out of every agent (memory stays unless --purge)
```

These six are all the installed command has. The commands that build and
measure memory by hand run from a clone of this repo
([`docs/development.md`](docs/development.md)).

## Learning and what it costs

- **Which model.** Learning goes through one agent you have, on your
  account with it: Claude Code (with Sonnet), Codex (with the model it is set
  to use) or Hermes Agent (with the model and provider it is set to use).
  Setup asks which when you have more than one;
  `singularity setup --learn-with codex` changes it, and
  `singularity learn --with hermes` uses another one once. Setup checks
  with one tiny call that the model answers: a plan may refuse the model
  Codex is set to use, or a provider may have retired Hermes's. When it
  doesn't, setup offers the models the agent lists (cheapest first for
  Codex, free ones first for Hermes), and `singularity setup --learn-model
  <model>` picks one. Memory never switches models on its own.
- **How much.** A learning round costs cents to a few dimes. A repo's first
  memory reads every change stored for it, so a first memory from a long
  history of past sessions can cost a few dollars. `singularity learn
  --dry-run` gives the estimate first; estimates follow what your latest
  rounds really cost.
- **When.** Learning on its own happens only if you said yes at setup, and
  only within the daily limit you chose ($1 unless you choose;
  `singularity setup --daily-limit 2` changes it). A round that wouldn't fit
  in what's left of the day waits; `singularity learn` runs it by hand.
  Rounds run one at a time, in the background.
- **How it's counted.** Claude Code reports what each call cost. Codex
  reports tokens, which memory counts at OpenAI's API prices (on a ChatGPT
  plan they count toward the plan's limits rather than being billed). Hermes
  Agent's own estimate is used; when Hermes doesn't know a model's price,
  the round shows as $0.

## Privacy

- Everything memory keeps stays on your machine, in `~/.singularity`
  (`$SINGULARITY_HOME` to move it): records, workflows and logs.
  singularity has no server and sends nothing anywhere itself.
- The one thing that leaves your machine is a learning round: the records
  it reads (task prompts, commands and their errors, file paths, and short
  excerpts of the code around each edit) go to the model of the agent you
  chose, the same way that agent's own sessions do.
- Setup changes only memory's own entries in each agent's settings, and
  keeps a copy of every file it changes (`<file>.before-singularity`).
- Hooks never break a session: their errors go to
  `~/.singularity/hook-errors.log`, and `SINGULARITY_HOOKS=off` turns them
  off.

## Good to know

- Memory arrives with a session's first prompt. For a new task in a long
  session, start a new session to get what memory has for it.
- It helps with kinds of change it has learned from earlier sessions in the
  same repository. Every clone of a repo shares its memory.
- Commits memory leaves out (no passing check before them, say) are listed,
  with the reason, by `singularity status`.

## Results

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
