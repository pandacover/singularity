import { type RefObject, useEffect, useRef } from "react"

export const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches

export const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`)

export const med = (a: ReadonlyArray<number>) => {
  const s = [...a].sort((x, y) => x - y), n = s.length
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const introPlaying = () => document.documentElement.classList.contains("intro")

/** Runs fn once the element is on screen (and the intro, if any, is over). */
export const useOnceVisible = (ref: RefObject<Element | null>, fn: () => void, threshold = 0.35) => {
  const latest = useRef(fn)
  latest.current = fn
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let wait: (() => void) | undefined
    const o = new IntersectionObserver(([e]) => {
      if (!e?.isIntersecting) return
      if (introPlaying()) {
        wait = () => { o.unobserve(el); o.observe(el) }
        addEventListener("introdone", wait, { once: true })
        return
      }
      o.disconnect()
      latest.current()
    }, { threshold })
    o.observe(el)
    return () => {
      o.disconnect()
      if (wait) removeEventListener("introdone", wait)
    }
  }, [ref, threshold])
}
