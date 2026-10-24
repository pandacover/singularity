// Draws the link-preview image, public/og.png (1200 × 630), with a headless Chrome or Edge. Run `npm run og` here
// after changing its text. Set BROWSER to the browser's path when it isn't in one of the places below.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const browser = [
  process.env.BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].find((b) => b && existsSync(b))
if (!browser) throw new Error("No Chrome or Edge found. Set BROWSER to the path of one.")

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,300..500&family=IBM+Plex+Mono:wght@400;500&display=block" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; overflow: hidden; background: #f2eee5; color: #1a1815; font-family: "Newsreader", Georgia, serif; }
  main { height: 100%; padding: 64px 76px 56px; display: flex; flex-direction: column; }
  .logo { height: 40px; width: auto; display: block; align-self: flex-start; }
  .kicker { margin-top: 64px; font: 500 17px "IBM Plex Mono", monospace; letter-spacing: 0.08em; text-transform: uppercase; color: #d33c1d; }
  h1 { margin-top: 18px; font-weight: 380; font-size: 92px; line-height: 1.02; letter-spacing: -0.024em; font-variation-settings: "opsz" 72; }
  p { margin-top: 26px; max-width: 980px; font-size: 33px; line-height: 1.32; color: #4b463e; }
  footer { margin-top: auto; padding-top: 16px; border-top: 2px solid #1a1815; display: flex; justify-content: space-between; font: 19px "IBM Plex Mono", monospace; color: #8a8376; }
  footer b { font-weight: 500; color: #1a1815; }
</style></head>
<body><main>
  ${readFileSync(here("./public/logo.svg"), "utf8").replace("<svg ", '<svg class="logo" ')}
  <div class="kicker">Open source · runs on your machine</div>
  <h1>Memory for coding agents</h1>
  <p>When a task is like one committed before in the same repository, singularity points the agent to that commit and lists the check scripts earlier sessions ran.</p>
  <footer><span>Claude Code · Codex · Hermes Agent · Gemini CLI · Droid</span><b>singul8rity.vercel.app</b></footer>
</main></body></html>`

const dir = mkdtempSync(join(tmpdir(), "singularity-og-"))
try {
  writeFileSync(join(dir, "og.html"), html)
  execFileSync(browser, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1200,630",
    "--virtual-time-budget=10000", `--user-data-dir=${join(dir, "profile")}`, `--screenshot=${here("./public/og.png")}`,
    pathToFileURL(join(dir, "og.html")).href
  ], { stdio: "inherit" })
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
