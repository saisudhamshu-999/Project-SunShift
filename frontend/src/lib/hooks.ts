import { useEffect, useLayoutEffect, useRef, useState, type DependencyList, type RefObject } from 'react'
import { gsap } from './gsap'

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

export const useIsMobile = () => useMediaQuery('(max-width: 767px)')

/** True once the element has come within `margin` of the viewport (and stays true if `once`). */
export function useInView<T extends Element>(ref: RefObject<T | null>, { margin = '0px', once = false } = {}): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true)
          if (once) io.disconnect()
        } else if (!once) setInView(false)
      },
      { rootMargin: margin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, margin, once])
  return inView
}

/** gsap.context scoped to a ref, reverted on unmount or when deps change. */
export function useGsap(scope: RefObject<HTMLElement | null>, fn: (ctx: gsap.Context) => void, deps: DependencyList = []) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useLayoutEffect(() => {
    if (!scope.current) return
    const ctx = gsap.context((self) => fnRef.current(self), scope.current)
    return () => ctx.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/** Animated number that eases towards its target. */
export function useTween(target: number, duration = 0.8): number {
  const [value, setValue] = useState(target)
  const obj = useRef({ v: target })
  useEffect(() => {
    const tween = gsap.to(obj.current, { v: target, duration, ease: 'power2.out', onUpdate: () => setValue(obj.current.v) })
    return () => {
      tween.kill()
    }
  }, [target, duration])
  return value
}
