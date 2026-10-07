import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A playable day: `slotRef` holds a fractional slot (0..48) for per-frame 3D reads;
 * `slot` is the integer slot for the DOM, updated only when it changes.
 */
export function useDayClock({ initial = 24, slotsPerSecond = 2.4, autoplay = false, loop = true, from = 0 } = {}) {
  const slotRef = useRef(initial)
  const [slot, setSlotState] = useState(Math.floor(initial))
  const [playing, setPlaying] = useState(autoplay)
  const raf = useRef(0)

  const setSlot = useCallback((s: number) => {
    const v = Math.max(0, Math.min(47.999, s))
    slotRef.current = v
    setSlotState(Math.floor(v))
  }, [])

  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      let next = slotRef.current + dt * slotsPerSecond
      if (next >= 48) {
        if (loop) next = from
        else {
          next = 47.999
          setPlaying(false)
        }
      }
      slotRef.current = next
      const i = Math.floor(next)
      setSlotState((prev) => (prev === i ? prev : i))
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
  }, [playing, slotsPerSecond, loop, from])

  return { slotRef, slot, setSlot, playing, setPlaying }
}
