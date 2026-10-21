/**
 * Claude Code's tools by what they do. Apart from Metrics.ts, which
 * re-exports them, so that the tool-call hook can judge a call (records/
 * Outcome.ts) without loading the trace parser and Effect.
 */
export const READ_TOOLS = new Set(["Read"])
export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])
export const SHELL_TOOLS = new Set(["Bash", "PowerShell"])
export const SEARCH_TOOLS = new Set(["Glob", "Grep"])
