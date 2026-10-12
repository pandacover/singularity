/**
 * Reading a tool call's result for signs that it failed.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g
const FAILURE = /\bexit(?:ed with)? (?:code|status) [1-9]|\bnpm ERR!|\berror TS\d+:|(?<!\d)[1-9]\d* failed\b/i

/**
 * What test runners and linters print, in their own case, only when something
 * failed: npm 7 and later; node's test runner (its summary, a failing test,
 * the list of failures, a plan or a coverage threshold not met, an assertion);
 * TAP; mocha; ESLint; Go; Rust.
 */
const REPORTED_FAILURE = new RegExp(
  [
    String.raw`^npm error\b`,
    String.raw`^[ℹ#] fail [1-9]`,
    String.raw`^\s*✖ .*\(\d+(?:\.\d+)?m?s\)\s*$`,
    String.raw`✖ failing tests`,
    String.raw`plan expected \d+ assertions? but received \d+`,
    String.raw`does not meet (?:\w+ )?threshold`,
    String.raw`AssertionError \[ERR_ASSERTION\]`,
    String.raw`code: 'ERR_ASSERTION'`,
    String.raw`^\s*not ok \d+`,
    String.raw`^\s*[1-9]\d* failing\s*$`,
    String.raw`✖ [1-9]\d* problems? \([1-9]\d* errors?`,
    String.raw`ESLint found too many warnings`,
    String.raw`^--- FAIL: `,
    String.raw`^FAIL\s`,
    String.raw`test result: FAILED`
  ].join("|"),
  "m"
)

/**
 * Whether a command's output says that something in it failed: a nonzero exit
 * code, an npm error, a TypeScript error, failed tests or a linter's errors. A
 * pipeline exits with its last command's status, so
 * `yarn test:update --watch=false 2>&1 | tail` succeeds even though yarn
 * failed, and `npm test 2>&1 | grep "^ℹ fail"` even though tests did: the
 * output still says so.
 */
export const reportsFailure = (output: string): boolean => {
  const text = output.replace(ANSI, "")
  return FAILURE.test(text) || REPORTED_FAILURE.test(text)
}

/** Output without terminal colour codes. */
export const stripAnsi = (text: string): string => text.replace(ANSI, "")
