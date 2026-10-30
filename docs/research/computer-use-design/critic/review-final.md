# Critic's review of the agreed doc

Written 2026-10-28 on `computer-use-memory.md` (178 lines). I sign off once fixes 1 to 3 are in. Items 4 to 6 are optional. On the option B candidates, I object to the third as it is worded (below).

## Fixes before sign-off (accuracy)

1. **Line 30, the L08 claim.** RESULTS-v2 section 4 says L08 was won by "a rule and a step to untick it for damaged goods", which memory's model wrote from L01. The neutral wording this design uses won T07 only, and L14 "passed too, but not thanks to the fixes". So "Notes on fields that start set fixed the worst harms" overstates the evidence. Suggested text:

   > **Notes on fields that start set helped.** "'Send satisfaction survey' starts ticked; decide from the task" won T07. L08 was won by a rule and a step to untick "Restock items" for damaged goods, which memory's model wrote from one earlier session. This design writes T07's neutral kind of note in plain code, and that kind has been tested on T07 only.

2. **Line 87, "The rules that helped most".** Nobody counted which rules helped most, and Luv asks for no "most" without a count. Suggested text: "Rules that helped in new-job (L11, T14) came from feedback after a mistake."

3. **Line 28, U02.** The form was the right one, but Enter sent it with the wrong person chosen (RESULTS-v2, harm table). Suggested text: "A key step learned on old screens sent a form with the wrong person chosen after a UI update (U02)."

## Optional

4. **Line 77, retiring unused routes.** "When the app's last few sessions never took it" would also retire the route of a monthly task between uses. "When the app's last few sessions never reached its first screen" still catches moved addresses, and leaves rare routes alone while their start screen is still in use.
5. **"In short":** add one line on scope: "It covers browsers driven from Claude Code first; desktop apps are only captured."
6. **The plan:** add one line: "Built on a branch from main that reuses its hooks and store, like the saved-scripts experiment."

## Option B candidates

- **The pointer:** no objection as a candidate. The doc already says it also caused harms.
- **The search field in routes:** no objection. One guard: some search boxes run commands when you press Enter (quick switchers, command palettes). So name the field only when typing in it led to a list of results, and never keep what was typed.
- **"What the screen said after past sessions' changes": I object as worded.** It is the one candidate that saves turns by shortening the check after a write, which is where an agent catches its own mistakes. After L08's refund, the restock shows on the order page, and a note saying done looks like "Refund issued" invites the agent to stop at the toast. It also brings back the page text that injection rules 1 to 3 keep out: status lines carry the most per-task values ("Refund issued to Priya Naidu").

  My alternative names the screen where past sessions checked the result, by its address pattern, with no page text: "after a refund here, past sessions checked the order page". That makes the check more likely to happen. But it serves the mistakes half, so it saves no turns and doesn't belong under B.

  If the proposer keeps the original wording, record this as a disagreement.
