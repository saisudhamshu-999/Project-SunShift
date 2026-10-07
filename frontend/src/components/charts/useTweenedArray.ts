import { useEffect, useRef, useState } from 'react'
import { useUi } from '@/state/ui'

/** Interpolates an array of numbers towards its new target (cross-browser path morphing). */
export function useTweenedArray(target: number[], duration = 900): number[] {
  const reduced = useUi((s) => s.reducedMotion)
  const [value, setValue] = useState(target)
  const from = useRef(target)
  const current = useRef(target)
  const raf = useRef(0)
  const key = target.join(',')

  useEffect(() => {
    cancelAnimationFrame(raf.current)
    if (reduced || current.current.length !== target.length) {
      current.current = target
      setValue(target)
      return
    }
    from.current = current.current
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const e = 1 - Math.pow(1 - t, 4)
      const next = target.map((v, i) => from.current[i] + (v - from.current[i]) * e)
      current.current = next
      setValue(next)
      if (t < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, duration, reduced])

  return value
}
