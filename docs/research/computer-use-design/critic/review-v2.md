# Critic's review of proposal v2

Written 2026-10-28 by the critic thread, on `drafts/proposal-v2.md`. Paths are relative to `apps/cli/` unless they start with `/mnt/`.

## Short verdict

v2 takes every point of my first review, and for the mistakes half of Luv's bar it is now a strong design. My main worry has moved to the other half, resources. Routes are v2's only saving, and nobody has checked whether they can reach its own 20% bar. After that come three points: who the hooks reach, the words that catch rules, and routes after a UI change. My answers to the four open points are at the end.

## 1. Can routes alone make it cheaper? Measure the ceiling first

Routes are v2's only saving. Everything else adds a little reading, which is cheap but saves nothing.

- A route starts after content (a list row, a link), so it covers only the last hops, the ones inside the app's menus.
- v1's repeats went from 16 turns to 11 with full steps, the form included. How much of that was finding the screen is unknown.

**Add to the replay (7.3):** in new-job's runs without memory, count the turns from opening the app to reaching the worked-on screen, and compare that with the stored route's length. That gap is the most routes could save. If it is under 20% of a chore's turns, v2 can't meet the 20% bar by design.

Then there are two honest options:

1. Say v2 aims at fewer mistakes at the same cost, and set the cost bar to "no higher than no memory".
2. Find another saving before the bench.

Luv's bar asks for both halves, so this choice is Luv's. The final doc should put it to them once the replay has the number.

## 2. Who it reaches

- **Hooks run only where Claude Code runs.** Computer use may also run outside Claude Code: in the desktop app's chat, in Cowork, or in the Chrome extension's own panel. If so, it has no Claude Code hooks and no log memory reads. I haven't verified this, so it belongs in Step 0.
- **Cloud sessions don't read the local `~/.claude/settings.json`** (hooks reference), so a cloud session linked to the computer gets nothing.
- **Say who v2 serves.** Step 0 should also list which surfaces offer these tools outside Claude Code. The doc should then say plainly that v2 serves people who drive a browser from Claude Code.
- **Check the live page in the hook.** Screen notes need the live screen's text inside the hook, so Step 0 should check that the `PostToolUse` input carries it for each browser tool. Playwright MCP 0.0.83 answered actions with a link to a snapshot file (`DESIGN-one-layer.md`, Deviations), and the transcript may lag behind (hooks reference).

## 3. The rule words will catch the wrong sentences and miss the useful ones

"Always", "never" and "remember" appear in ordinary requests:

- "I never got the invoice, can you check?"
- "It always logs me out."
- "Remember the order from Monday? Refund it."

Each of these would be shown as "Your rules here", inside a system reminder.

**Suggestion:** match only sentences that open as an instruction: "(please) always", "never", "from now on", "remember that", "make sure to always", "don't ever". Skip a sentence whose object is only "that", "it" or "this": "never do that again" means nothing without its context.

The bigger gap is the rules that mattered in new-job. They came from feedback after a mistake. In daily use that feedback is a correction, which people seldom phrase with "always" or "never" ("you restocked them, that's wrong"), and v2 keeps none of these. That is fine for a first version, but:

- count the corrections in the capture data;
- say in the README that "always…" or "never…" is how to teach memory a rule;
- measure with Claude Code's auto memory off, as the coding results did, since auto memory keeps "remember" sentences too.

## 4. Routes after a UI change

- **The newest route should win a tie, not the shortest.** After an update, the new route is the right one even if it is longer.
- **Old routes may never retire.** The card shows routes before any check. In new-job's update, old addresses returned 404. A route that starts at a moved address retires only when two sessions fail to find its controls there, and sessions may never reach the old screen again. So also retire a route when the app's last two sessions reached its destination by other hops, or when the app's last N sessions never took it. The research report advises expiring unused items.
- **A one-click write can slip into a route.** A route restarts only at content or an address, so "/orders/{n} › 'Archive' › 'Settings'" can happen when a session archived an order and then opened settings. Keep the verb filter as a backstop for hops, and drop any hop after which a status line appeared.

## 5. Smaller points

- **Single-page apps:** many keep one address, or use hash routes, so the address can't tell their screens apart. The dialog title helps, but headings don't: Gmail's heading is the email's subject, which is content. Use the named form and regions, as `Places.ts` did. new-job's apps had real addresses, so the replay won't test this, and the sealed bench should include a single-page app.
- **Login screens:** skip any screen with a password field entirely, with no hops and no notes.
- **Keys:** "never name a key" also blocks a trap new-job had: "Enter on the address form books a $4 amendment". Allow a warning that a key does something on this screen once two sessions saw it, and keep banning keys as instructions (U02).

## 6. The four open points

1. **The card at task start: yes, when the prompt names the app in a way memory has learned.** That is the app's host, or a word that appeared in the prompts of two or more sessions that then used this app and in none that used another. A common word such as "notes" or "mail" then counts only if the person really uses it that way. Otherwise the card comes at first touch.
2. **Many screens:** the card shows the top routes by number of sessions, newest first. A hub screen's notes list where past sessions went from there ("Actions › Refund"). Ranking by the task's words is fine as a tie-break, since a wrong rank only costs a line.
3. **Fingerprints pass the audit as I wrote it.** Two caveats belong in the doc:
   - Claude Code's own session log already holds every page read and everything typed (`src/traces/Parse.ts` reads both from it). So fingerprints don't protect against someone who has access to the machine.
   - The salt sits in the same home folder. Anyone who has it can guess a short value, such as a name or an amount, by hashing candidates until one matches.

   What fingerprints do give: nothing seen once ever reaches a hand-over or another app, and nothing outlives Claude Code's own log in plain text.
4. **One session or two: both, with one trick.** After one session, memory stores only fingerprints with the field's state. At the next visit, the hook hashes the labels on the live screen, finds the match, and writes the note from the live text. So "Restock items starts ticked" shows at the second visit, as L08 needed, and memory never wrote it down from a single sighting. Plain text then needs two sessions only for what is shown before its screen is live: the card's routes and rules.

## Where we agree now

Everything else in v2.
