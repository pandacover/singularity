import { type CSSProperties, type ReactNode, useState } from "react"

export type Os = "sh" | "ps"

const INSTALL: Record<Os, string> = {
  sh: "curl -fsSL https://raw.githubusercontent.com/pandacover/singularity/main/install.sh | sh",
  ps: "irm https://raw.githubusercontent.com/pandacover/singularity/main/install.ps1 | iex"
}

export const defaultOs = (): Os => (/Windows/.test(navigator.userAgent) ? "ps" : "sh")

/** The install command; both boxes on the page share one choice of system. */
export const Install = ({ os, setOs, requirement, style }: {
  readonly os: Os
  readonly setOs: (os: Os) => void
  readonly requirement?: ReactNode
  readonly style?: CSSProperties
}) => {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(INSTALL[os]) } catch { return }
    setDone(true)
    setTimeout(() => setDone(false), 1600)
  }
  return (
    <div className="install" style={style}>
      <div className="tabs" role="tablist" aria-label="Your system">
        <button role="tab" aria-selected={os === "sh"} onClick={() => setOs("sh")}>macOS, Linux</button>
        <button role="tab" aria-selected={os === "ps"} onClick={() => setOs("ps")}>Windows</button>
      </div>
      <div className="line">
        <pre><span className="p">$ </span><span>{INSTALL[os]}</span></pre>
        <button className="copy" type="button" onClick={copy} data-done={done ? "" : undefined}>{done ? "Copied" : "Copy"}</button>
      </div>
      {requirement && <div className="req">{requirement}</div>}
    </div>
  )
}
