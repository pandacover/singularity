import { createContext, type ReactNode, type PointerEvent, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react"

interface TipApi {
  readonly show: (e: PointerEvent, content: ReactNode) => void
  readonly hide: () => void
}

const TipContext = createContext<TipApi>({ show: () => {}, hide: () => {} })

export const useTip = () => useContext(TipContext)

/** One tooltip for the page, placed next to the pointer and kept on screen. */
export const TipProvider = ({ children }: { readonly children: ReactNode }) => {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null)
  const [shown, setShown] = useState<ReactNode>(null)
  const el = useRef<HTMLDivElement>(null)

  const show = useCallback((e: PointerEvent, content: ReactNode) => {
    setTip({ x: e.clientX, y: e.clientY, content })
    setShown(content)
  }, [])
  const hide = useCallback(() => setTip(null), [])
  const api = useMemo(() => ({ show, hide }), [show, hide])

  useLayoutEffect(() => {
    const t = el.current
    if (!t || !tip) return
    const w = t.offsetWidth, h = t.offsetHeight
    t.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, tip.x + 14))}px`
    t.style.top = `${tip.y + 16 + h > innerHeight ? tip.y - h - 12 : tip.y + 16}px`
  }, [tip])

  return (
    <TipContext.Provider value={api}>
      {children}
      {/* keeps its last content while fading out */}
      <div className={tip ? "tip on" : "tip"} ref={el} role="tooltip">{shown}</div>
    </TipContext.Provider>
  )
}
