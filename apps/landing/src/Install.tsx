import { type CSSProperties, type ReactNode, useRef, useState } from "react"

export type Os = "sh" | "ps"

const INSTALL: Record<Os, string> = {
  sh: "curl -fsSL https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh",
  ps: "irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex"
}

const SCRIPT: Record<Os, string> = {
  sh: "https://github.com/pandacover/singularity/blob/main/install.sh",
  ps: "https://github.com/pandacover/singularity/blob/main/install.ps1"
}

export const defaultOs = (): Os => (/Windows/.test(navigator.userAgent) ? "ps" : "sh")

/**
 * The ad blocker banners on the page. uBlock Origin's ClickFix rule keeps
 * pages from writing `irm … | iex` to the clipboard, since attacks paste the
 * same shape; the write then resolves with nothing copied, and the blocker
 * says so in a new banner of its own, added to the page as a popover.
 */
const blockerBanners = () =>
  [...document.documentElement.children].filter((el) => el.hasAttribute("popover") && /ClickFix/i.test(el.textContent ?? ""))

/** The install command; both boxes on the page share one choice of system. */
export const Install = ({ os, setOs, requirement, style }: {
  readonly os: Os
  readonly setOs: (os: Os) => void
  readonly requirement?: ReactNode
  readonly style?: CSSProperties
}) => {
  const [state, setState] = useState<"idle" | "done" | "blocked">("idle")
  const command = useRef<HTMLSpanElement>(null)
  const choose = (next: Os) => {
    setState("idle")
    setOs(next)
  }
  const copy = async () => {
    const before = blockerBanners()
    try { await navigator.clipboard.writeText(INSTALL[os]) } catch { return }
    if (blockerBanners().some((el) => !before.includes(el))) {
      // Nothing was copied: the command is selected, for the person to copy it themselves.
      const selection = getSelection()
      if (command.current && selection) selection.selectAllChildren(command.current)
      return setState("blocked")
    }
    setState("done")
    setTimeout(() => setState((s) => (s === "done" ? "idle" : s)), 1600)
  }
  return (
    <div className="install" style={style}>
      <div className="tabs" role="tablist" aria-label="Your system">
        <button role="tab" aria-selected={os === "sh"} onClick={() => choose("sh")}>macOS, Linux</button>
        <button role="tab" aria-selected={os === "ps"} onClick={() => choose("ps")}>Windows</button>
      </div>
      <div className="line">
        <pre><span className="p">$ </span><span ref={command}>{INSTALL[os]}</span></pre>
        <button className="copy" type="button" onClick={copy} data-done={state === "done" ? "" : undefined}>{state === "done" ? "Copied" : "Copy"}</button>
      </div>
      {state === "blocked" && (
        <div className="req blocked" role="status">
          Your ad blocker stopped the copy: it blocks pages from copying commands shaped like this one, because attacks use them too.
          The command is selected, so press {os === "ps" ? "Ctrl+C" : "Ctrl+C or ⌘C"} to copy it yourself, or <a href={SCRIPT[os]}>read the script</a> first.
        </div>
      )}
      {requirement && <div className="req">{requirement}</div>}
    </div>
  )
}
