/**
 * Reading a tool call's result for signs that it failed.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g
const FAILURE = /\bexit(?:ed with)? (?:code|status) [1-9]|\bnpm ERR!|\berror TS\d+:|(?<!\d)[1-9]\d* failed\b/i

/**
 * Whether a command's output says that something in it failed: a nonzero exit
 * code, an npm error, a TypeScript error or failed tests. A pipeline exits with
 * its last command's status, so `yarn test:update --watch=false 2>&1 | tail`
 * succeeds even though yarn failed, but the output still says so.
 */
export const reportsFailure = (output: string): boolean => FAILURE.test(output.replace(ANSI, ""))

/** Output without terminal colour codes. */
export const stripAnsi = (text: string): string => text.replace(ANSI, "")
