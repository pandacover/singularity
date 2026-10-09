// The practice app's runner, with the same commands as the sealed benchmark's.
//   node runner.mjs manifest | start --ui v1 | stop | reset ID | prompt ID | check ID | guide | reveal
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const runtime = "C:/singularity-workspaces/practice-runtime"
const PORT = 5190
const base = `http://localhost:${PORT}`
const chores = {
  P01: { prompt: "Lend \"Maps of the North\" to member 7. They don't want SMS reminders.", url: `${base}/`, check: (s) => s.loans.some((l) => l.book === 102 && l.member === 7 && !l.sms) && s.loans.length === 3 },
  P02: { prompt: "Please check out \"Small Engines\" for Lena Ortiz (member 9). No text messages for her.", url: `${base}/`, check: (s) => s.loans.some((l) => l.book === 103 && l.member === 9 && !l.sms) && s.loans.length === 3 },
  P03: { prompt: "Renew the loan of \"Glass and Iron\".", url: `${base}/`, check: (s) => s.loans.find((l) => l.id === 501)?.renewed === 1 && s.loans.find((l) => l.id === 501)?.fees === 0, feedback: "The member was charged a renewal fee. A first renewal is free; the fee is only for later ones." },
  P04: { prompt: "Please renew Ines Varga's loan.", url: `${base}/`, check: (s) => s.loans.find((l) => l.id === 502)?.renewed === 1 && s.loans.find((l) => l.id === 502)?.fees === 0, feedback: "The member was charged a renewal fee. A first renewal is free; the fee is only for later ones." },
  P05: { prompt: "Lend \"The Quiet Harbor\" to member 9.", url: `${base}/`, check: (s) => s.loans.some((l) => l.book === 101 && l.member === 9 && l.weeks === 2), feedback: "That loan was set to four weeks. Loans are two weeks unless the member asks for longer." },
  P06: { prompt: "Check out \"Small Engines\" for member 7, please.", url: `${base}/`, check: (s) => s.loans.some((l) => l.book === 103 && l.member === 7 && l.weeks === 2), feedback: "That loan was set to four weeks. Loans are two weeks unless the member asks for longer." },
  T01: { prompt: "Lend \"A Year of Soups\" to member 7, without SMS reminders.", url: `${base}/`, check: (s) => s.loans.some((l) => l.book === 104 && l.member === 7 && !l.sms) && s.loans.length === 3 },
  T02: { prompt: "Lend \"The Quiet Harbor\" to member 8.", url: `${base}/`, check: (s) => s.loans.length === 2 }
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const [cmd, arg] = process.argv.slice(2)
const state = async () => (await fetch(`${base}/__admin/state?token=practice`)).json()

if (cmd === "manifest") out({ apps: [{ id: "desk", url: base }], phases: [{ id: "learn", chores: ["P01", "P02", "P03", "P04", "P05", "P06"] }, { id: "test", chores: ["T01", "T02"] }], ui_for_phase: { learn: "v1", test: "v1" }, hash: "practice" })
else if (cmd === "start") {
  mkdirSync(runtime, { recursive: true })
  const pidFile = join(runtime, "pid")
  if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, "utf8"))) } catch {}
  const child = spawn(process.execPath, [join(here, "server.mjs"), String(PORT)], { detached: true, stdio: "ignore", windowsHide: true })
  writeFileSync(pidFile, String(child.pid))
  child.unref()
  out({ ok: true })
} else if (cmd === "stop") {
  const pidFile = join(runtime, "pid")
  if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, "utf8"))) } catch {}
  out({ ok: true })
} else if (cmd === "reset") { await fetch(`${base}/__admin/reset?token=practice`); out({ ok: true, url: chores[arg].url }) }
else if (cmd === "prompt") out({ prompt: chores[arg].prompt, url: chores[arg].url })
else if (cmd === "check") { const ok = chores[arg].check(await state()); out({ success: ok, feedback: ok ? "Done, thanks." : chores[arg].feedback ?? "That's not right.", traps_hit: [], moves: null, fewest_moves: null }) }
else if (cmd === "guide") out({ guide: "Front desk guide: books are lent from the book's page (Check out). Members with overdue loans can't borrow." })
else if (cmd === "reveal") out({ chores: Object.keys(chores) })
else { out({ error: `unknown command ${cmd}` }); process.exitCode = 1 }
