import Lenis from 'lenis'
import { useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { gsap, ScrollTrigger } from '@/lib/gsap'
import { useUi } from '@/state/ui'

let lenis: Lenis | null = null

export function scrollToTarget(target: string | number | HTMLElement, offset = 0) {
  if (lenis) lenis.scrollTo(target, { offset, duration: 1.6 })
  else if (typeof target === 'number') window.scrollTo({ top: target })
  else {
    const el = typeof target === 'string' ? document.querySelector(target) : target
    if (el) window.scrollTo({ top: (el as HTMLElement).getBoundingClientRect().top + window.scrollY + offset })
  }
}

export function SmoothScroll({ children }: { children: ReactNode }) {
  const reduced = useUi((s) => s.reducedMotion)
  const { pathname, hash } = useLocation()

  useEffect(() => {
    if (reduced) return
    const instance = new Lenis({ lerp: 0.085, smoothWheel: true, wheelMultiplier: 0.95 })
    lenis = instance
    if (import.meta.env.DEV) (window as unknown as { __lenis?: Lenis }).__lenis = instance
    instance.on('scroll', ScrollTrigger.update)
    const raf = (time: number) => instance.raf(time * 1000)
    gsap.ticker.add(raf)
    gsap.ticker.lagSmoothing(0)
    return () => {
      gsap.ticker.remove(raf)
      instance.destroy()
      lenis = null
    }
  }, [reduced])

  useEffect(() => {
    if (hash) {
      const id = window.setTimeout(() => scrollToTarget(hash, -8), 120)
      return () => window.clearTimeout(id)
    }
    if (lenis) lenis.scrollTo(0, { immediate: true })
    else window.scrollTo(0, 0)
    const id = window.setTimeout(() => ScrollTrigger.refresh(), 200)
    return () => window.clearTimeout(id)
  }, [pathname, hash])

  return <>{children}</>
}
