/**
 * The files a shell command reads (`cat`, `sed -n`, `head`, `grep`, and
 * PowerShell's `Get-Content`), for the tool-call hook's first read of a file
 * (Lookup.ts): an agent reads with the shell as often as with the Read tool.
 * Paths as typed; the hook makes them repo paths. Apart from Lookup.ts, so
 * that a Read call never loads the shell's tokenizer.
 */
import { commandWords, programName, splitCommand } from "../records/Shell.ts"

/** Programs that print files they're given, each with its options that take the next word as a value. */
const READERS: Readonly<Record<string, RegExp>> = {
  cat: /^$/,
  nl: /^$/,
  bat: /^$/,
  less: /^$/,
  more: /^$/,
  type: /^$/,
  wc: /^$/,
  head: /^(?:-n|-c|--lines|--bytes)$/,
  tail: /^(?:-n|-c|--lines|--bytes)$/,
  sed: /^(?:-e|-f|--expression|--file)$/,
  grep: /^(?:-[ABCmef]|--(?:after-context|before-context|context|max-count|regexp|file|include|exclude))$/,
  egrep: /^(?:-[ABCmef])$/,
  rg: /^(?:-[ABCmegtT]|--(?:glob|type|type-not|max-count|context|regexp))$/,
  "get-content": /^-(?:TotalCount|Tail|Head|First|Encoding)$/i,
  gc: /^-(?:TotalCount|Tail|Head|First|Encoding)$/i,
  "select-string": /^-(?:Pattern|Encoding|Context)$/i,
  sls: /^-(?:Pattern|Encoding|Context)$/i
}
/** Of those, the ones whose first word that isn't an option is a pattern or a script, not a file. */
const PATTERN_FIRST = new Set(["sed", "grep", "egrep", "rg", "select-string", "sls"])

export const filesReadBy = (command: string): Array<string> => {
  const out: Array<string> = []
  for (const segment of splitCommand(command)) {
    const ws = commandWords(segment)
    const program = programName(ws[0] ?? "")
    const takesValue = READERS[program]
    if (takesValue === undefined) continue
    // `sed -i` edits; `sed -n '1,80p' f` reads.
    if (program === "sed" && ws.some((w) => /^-[a-zA-Z]*i/.test(w))) continue
    // A pattern given as an option (`grep -e x f`, `Select-String -Pattern x f`) leaves every other word a file.
    let pattern = PATTERN_FIRST.has(program) && !ws.some((w) => /^(?:-e|--regexp|-f|--file|-Pattern)$/i.test(w))
    for (let i = 1; i < ws.length; i++) {
      const w = ws[i]
      if (takesValue.test(w)) {
        i++
        continue
      }
      if (w.startsWith("-") && w.length > 1) continue
      if (pattern) {
        pattern = false
        continue
      }
      out.push(w)
    }
  }
  return out
}
