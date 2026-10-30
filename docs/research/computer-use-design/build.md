# Building computer-use memory: decisions

Written 2026-10-30, before building, on branch `t3/computer-use-memory` from main at f0f4ab6. It implements `computer-use-memory.md` (the agreed design) and settles two things the design left open: how memory reaches Claude desktop, which has no hooks there, and how computer use is set up next to coding. Paths are relative to `apps/cli/`.

## What was checked first

- **Claude desktop's config** is `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude_desktop_config.json` on this machine. The Store package's own folder (`Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude`) was emptied on 2026-10-20 and holds only a `.user-data-left` marker: the app moved its data out of the package. The config already registers a server named `singularity`, the 10-18 hand-test server in the `t3-browser-memory` worktree.
- **One server process per app launch, shared by every chat.** The 10-18 hand test's call log (`C:\singularity-workspaces\browser-try\calls.jsonl`) shows Claude desktop starts a server twice at launch, once for Chat (client `claude-ai`) and once for Code mode (client `local-agent-mode-singularity`), and keeps both for days. Two Code-mode chores 38 seconds apart went to the same process.
- **Chat drops server instructions** (10-18: 0 of 2 chores called memory); Code mode runs Claude Code and read them (2 of 2).
- **Playwright MCP 0.0.83** (the version new-job ran) answers actions with the page's address and a link to a snapshot file (`- [Snapshot](..\pw\page-….yml)`), and gives the snapshot inline only for `browser_snapshot`.
- **Claude Code logs hold no Claude in Chrome or built-in browser calls** to learn their answers from: the built-in browser's tools appear only in tool lists. Its `read_page` is described as "a YAML-style accessibility tree", each control tagged `[ref_N]`; clicks name a `ref` or a point on a screenshot. Playwright calls are in 342 logs (new-job).

## Claude desktop: memory as a proxy in front of the browser

Chat has no hooks and no log memory can read, so the MCP server has to both hand over and capture. Three ways were weighed:

- **Memory tools the model calls** (recall at the start, record at the end): Chat made 0 of 2 such calls on 10-18, and what the model records is its own account, which listed a button it never pressed.
- **A tool the model pastes each screen into:** every page read would be paid again as output, which would spoil the cost half of any eval, and it still depends on the model calling it.
- **A proxy (chosen).** Singularity's server starts Playwright MCP as its child and offers the child's browser tools as its own. Every call goes through it, so capture needs nothing from the model, and hand-over is a short block added to a tool's answer, as a hook's text is.

How the proxy works:

- **Tools:** the child's tools, unchanged in name, description and input, but for one line before `browser_navigate`'s description saying this browser brings memory of past sessions (added 10-31: on 10-31 plain Chat picked the built-in browser pane for a web task, and the server's instructions never reach Chat). Images pass through untouched and are never read.
- **Hand-over:** a block starting `singularity:` added after the child's answer. The app card on the first answer this session whose address is in an app memory knows. Screen notes on an answer whose screen has the stored controls, once per screen per session. The same budgets (700 and about 400 characters) and the same five injection rules. Text in a tool's answer carries less weight than a hook's system reminder, so this is no riskier than the hook path.
- **Capture:** the proxy reads each answer's address and snapshot (inline, or the file the answer links to, in the output folder the proxy gave Playwright) with the same reader the hook path uses, and keeps the session's calls in memory. It writes the session's trail as it goes, so a closed app loses nothing. What reaches disk is only what the design allows: fingerprints, blanked addresses, field states, and text two sessions have seen.
- **Playwright's own files:** Playwright writes each snapshot to its output folder, page text included. The proxy puts that folder in the system's temp folder and empties it when the server starts and stops.
- **Sessions.** A new session starts with a new server process, and at the first call after 10 minutes without one. Step 0 logs each call's `_meta`; if Claude desktop sends a conversation id there, a new id starts a session too. Two chores in one session only delay what memory writes down (seen-twice counts sessions), but the second chore gets no card, so **eval chores end by quitting the app**.
- **Your rules** come from your prompts, which the proxy never sees. In Claude desktop they aren't captured: a rule the model passed on would be its words, not yours (injection rule 5).
- **Not covered in Claude desktop:** Claude in Chrome, the built-in browser pane and desktop computer use are the app's own tools, and nothing can stand in front of them. Code mode may run Claude Code's hooks for them; Step 0 checks.
- **Evals:** every arm, no memory included, runs through the proxy, with hand-over off (`SINGULARITY_HANDOVER=off` in the server's environment) for no memory. The tools are the same in every arm; memory is the only switch.
- **Playwright's version** is pinned in the registration (0.0.83 until Step 0 says otherwise), since its answers' shape changes between versions.

The server is `src/computer/server.ts`. The JSON-RPC line handling and the never-break-the-host rule (errors to `hook-errors.log`, the request answered with an error) come from the `t3/desktop-memory` server, copied in. Its tools (recall, plan, record, mark) don't: they served replay, which the design rejects.

## Claude Code: hooks, as the design says

- A hook of its own, `src/computer/hook.ts`, so the coding hook and its matcher stay as they are. Its `PostToolUse` and `PostToolUseFailure` entries match `mcp__claude-in-chrome__.*|mcp__Claude_Browser__.*|mcp__playwright__.*|mcp__computer-use__.*`, and no other MCP server.
- **Speed:** the tool's name is checked on the raw input before it is parsed (a screenshot's input can be megabytes), and only browser tools load anything: one read of the session's small state file and the app's index.
- **Capture** from Claude Code's session log, at task start and session end, in the background under `store.lock`, as the design says. The hook itself writes only which hand-overs it gave.
- **Readers:** Playwright first (Snapshot.ts, back from `2d18711^`, reading linked snapshot files too). The built-in browser's reader is written from its tool descriptions and checked against Step 0's samples; Claude in Chrome's waits for its samples. Desktop computer use: the app's name and menu paths only.
- Codex, Gemini CLI, Droid and Hermes Agent get nothing for computer use.

## Setup: `singularity setup computer-use`

- `singularity setup computer-use` sets computer use up, `singularity uninstall computer-use` takes it out, and plain `singularity uninstall` takes out both. `singularity.ts` keeps its eight commands: `computer-use` is an argument of `setup` and `uninstall`. Plain `singularity setup` is unchanged and never touches computer use.
- **What it installs:** Claude Code's computer-use hook entries (above), and the proxy registered in Claude desktop as `singularity-browser`. The name `singularity` is the old hand-test server's; setup leaves any entry it didn't write alone and says so.
- **Claude desktop's config:** looked for in `%APPDATA%\Claude`, then `%LOCALAPPDATA%\Claude-Data\<package>`, then the Store package's `LocalCache\Roaming\Claude`; on macOS `~/Library/Application Support/Claude`. `SINGULARITY_CLAUDE_DESKTOP_CONFIG` overrides it, which tests and `try-install` use. The first change keeps a `.before-singularity` copy. The app holds its config in memory and writes it back whole, so setup asks you to quit the app first when it is running, and checks afterwards that the entry is still there.
- `config.json` records `computer_use: true`; `update` then rewrites the hook entries and the registration with the new code's paths. `status` gets a "Computer use" section: where it is set up, the apps memory knows, sessions stored, screens left out and why.

## Step 0, on your machine

`node apps/cli/src/cli.ts computer-use step0 on` (not in the daily `singularity` command) adds a logging hook for `mcp__.*` to your Claude Code settings; `step0 off` takes it out and `step0 report` summarises what it saw: per tool, how often it was called, input and answer sizes, whether answers carried images, a page address, controls with roles and names, field states, and how many clicks named a point instead of a control. Samples stay in `~/.singularity/step0/`. While `~/.singularity/step0/` exists, the Claude desktop server also logs each call's `_meta` to `step0/proxy-meta.jsonl`, to learn whether Claude desktop names its conversations.

Your steps, from this worktree (`C:\Users\luvma\.t3\worktrees\singularity\t3-computer-use-memory`), about half an hour:

1. `node apps/cli/src/cli.ts computer-use step0 on`. This adds one entry to your real `~/.claude/settings.json`, for MCP tools only.
2. **Claude in Chrome from Claude Code.** In an empty folder, start `claude --chrome` and ask for something harmless on a public page, such as: "Open https://en.wikipedia.org/wiki/Special:Random, read the page as text, then open the first link in its body." Let it finish.
3. **The built-in browser and desktop computer use, in Claude desktop's Code mode.** In Code mode, in an empty folder, ask: "In the browser pane, open https://example.com, read the page, and follow its link." Then, in a new Code session: "Open Notepad, type hello, then use the Edit menu to select all." Close Notepad without saving afterwards.
4. **Playwright through memory in Claude desktop** (optional). This step changes your real settings: computer use's hook entries go into `~/.claude/settings.json`, and `singularity-browser` into Claude desktop's config, both pointing at this worktree. Quit Claude desktop fully, run `node apps/cli/src/singularity.ts setup computer-use`, start the app, and in a Chat ask: "Use the browser to open https://example.com and read the page." It runs a Chrome of Playwright's own. To undo it, quit the app and run `node apps/cli/src/singularity.ts uninstall computer-use`.
5. `node apps/cli/src/cli.ts computer-use step0 report`, and send me what it prints. Then `node apps/cli/src/cli.ts computer-use step0 off`.

What it answers: whether hooks fire for these tools in Claude Code and in Code mode; the answers' shape (strings or blocks, trees inline or not); whether field states (`checked`, `selected`) are in the built-in browser's and Chrome's trees; how often clicks name a point; where the logs are; and whether Claude desktop sends a conversation id.

## What was built, and where it departs from the design

Built on 2026-10-31, uncommitted on `t3/computer-use-memory`; the module map is in `docs/development.md` ("Computer use"). 292 tests pass (19 new), and the typecheck is clean.

- **The hook is plain node.** Importing Effect takes 0.44 s on this machine, so the hook reads its input and memory's small files with `JSON.parse` and checks them by hand, as the coding hook's commit check does. Storing, in the background, reads everything with Schema. Measured through stdin, 7 runs each: a browser read that hands over a card and notes, 123 ms; a screenshot call with a 3 MB image, 126 ms; node's own start and input, 81 ms.
- **Seen twice counts per screen**, as the design says. An address's segments count per app, apart from labels: a link "Orders" and the path's `orders` are different strings.
- **Where a result was checked** is named by the address's path, without its query keys: a form that sends `restock` only when ticked gave two addresses for one page.
- **A session's file never holds an address.** It keeps the page the session is on as memory keeps addresses (the host, the path by fingerprint, query keys without values): a form sent by GET puts what was typed in the address. A test sends one through the hand-over and checks memory's files.
- **A screen's notes need all its stored fields on the live screen.** A screen with no stored fields gets notes (traps, keys, checks) when its address and named region match.
- **Built on 10-31, the rest of the design:**
  - **Words that name an app:** a prompt word that came before two sessions in one app and none in another brings its card at a task's start. Kept by fingerprint only (`Text.ts` `promptWords`, `computer/words.json`).
  - **Hub screens:** a screen sessions left for two or more screens gets "Past sessions went on to …", naming those two sessions went to.
  - **App tools,** claude.ai's connectors (`mcp__claude_ai_<App>__*`): rules, and the errors failed calls answered with, seen twice, on the app's card. Stored at session end when the log has such calls; the tool-call hook still matches browser tools only. Other MCP servers aren't apps.
  - **Trails in `singularity changes`:** `--apps` lists the apps, `--app <app>` an app's sessions and its card now.
  - **The proxy stores under `store.lock`,** waiting up to 30 s; the next call stores the whole session again.
  - The hook after these: 108 ms a browser read (node alone: 47 ms on this run), 75 ms a tool it skips.
- **Still not built:** desktop capture beyond the app and menu paths, until Step 0 shows what those tools hand over.
- **The built-in browser's and Claude in Chrome's translators** are written from their tool descriptions; no session on this machine has called them. Step 0 checks them.

### The offline replay (design step 3), first numbers

`computer-use replay` over new-job's no-memory arm (42 sessions in `~/.claude/projects`, their snapshots still in `C:\singularity-workspaces\new-job-runs\none\runs\*\pw`), free:

- **Harm chores:** L08 was handed "past sessions saw "Restock items" start ticked. Decide from the task." at the refund form; L14 and T07 were handed "Send satisfaction survey" start ticked at the case's close form, the note that won T07 in new-job.
- **Hand-overs:** 29 of 42 sessions were handed something, 42 hand-overs in all; cards come from an app's third session on, as seen-twice requires.
- **The cost ceiling, first cut:** 219 of 547 calls (40%) came between a session's first action in an app and its arrival at the screen it worked on, against routes of one or two hops. That bounds what routes could save before the reads an agent still needs; the count in turns follows.
- **The cost ceiling in turns (10-31, SNG-10):** all three Sonnet no-memory rounds (`none`, `none-r2`, `none-r3`: 106 sessions, 1,175 turns, $8.85) replayed oldest first. A route saves at most the turns above its floor (one to open its start, one per hop), counted only when the card could have shown it before the session.
  - 41% of turns go from the first action to the screen worked on, but most are reads and finding the record, which a route doesn't skip.
  - Routes memory had: 81 turns above the floor (6.9% of turns, 5.2% of dollars), in the 21 sessions memory had a route for; the median session saves 0%, and among those 21 the median is 30% of their turns.
  - Had memory known every route sessions took: 180 turns (15.3%).
  - After reaching the screen worked on: 684 turns (58.2%), the work there, the write and the check after it (SNG-12).
  - What each harm chore would have been handed, with the hub notes built later on 10-31 (`all-none2.txt`): L08 "Restock items" start ticked at the refund form, both times it ran with memory that had seen it; L14 and T07 "Send satisfaction survey" start ticked; U02's third run "Also transfer this account's open cases" start ticked; L12 and U05 only the card, hub notes and where past sessions checked. Hub notes come on most list and detail pages.
  - Harm chores: L08, L12, U02 and U05 never had a route (the card adds no steps there; their notes are what counts); L14 and T07 had one-hop routes, 3 turns above the floor each.
  - Against the design's bar (median turns 20% lower on repeats): only repeats with a route can reach it, at a 30% ceiling before the reads an agent still needs; across the suite routes stay under 20%. That is the design's case for choosing A or B ("Your call: the cost half" in `computer-use-memory.md`). Output: `C:\singularity-workspaces\cu-replay\all-none.txt`.
- **Live smoke test:** three refund chores through the proxy and the real Playwright MCP 0.0.83 (headless, a local app): nothing in the first, the form's note in the second, the card and the note in the third.

## Build order

1. Step 0 kit, so it can run while the rest is built.
2. The core, plain code with tests: snapshot readers, screen addresses, salted fingerprints, the injection filter, trails from a session's calls, the app index with seen-twice and route retirement, card and notes.
3. The Claude Code hook and the background capture.
4. The Claude desktop proxy.
5. `setup computer-use`, `uninstall computer-use`, status and update.
6. The offline new-job replay (design step 3) on the core, before any paid run.
