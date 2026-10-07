import { createElement, useRef, type ReactNode } from 'react'
import { gsap, SplitText } from '@/lib/gsap'
import { useGsap } from '@/lib/hooks'
import { useUi } from '@/state/ui'

type Tag = 'h1' | 'h2' | 'h3' | 'p' | 'div' | 'span'

/** Line/word/char reveal tied to scroll. Renders plain text when motion is reduced. */
export function Reveal({
  as = 'h2',
  children,
  className = '',
  split = 'lines',
  delay = 0,
  start = 'top 85%',
  stagger,
}: {
  as?: Tag
  children: ReactNode
  className?: string
  split?: 'lines' | 'words' | 'chars'
  delay?: number
  start?: string
  stagger?: number
}) {
  const ref = useRef<HTMLElement>(null)
  const reduced = useUi((s) => s.reducedMotion)
  useGsap(
    ref,
    () => {
      if (reduced || !ref.current) return
      const el = ref.current
      const type = split === 'lines' ? 'lines' : split === 'words' ? 'lines,words' : 'lines,chars'
      const splitter = SplitText.create(el, {
        type,
        mask: 'lines',
        autoSplit: true,
        onSplit(self) {
          const targets = split === 'chars' ? self.chars : split === 'words' ? self.words : self.lines
          return gsap.from(targets, {
            yPercent: 115,
            rotate: split === 'chars' ? 4 : 0,
            duration: 1.15,
            ease: 'expo.out',
            delay,
            stagger: stagger ?? (split === 'chars' ? 0.018 : split === 'words' ? 0.045 : 0.09),
            scrollTrigger: { trigger: el, start, once: true },
          })
        },
      })
      return () => splitter.revert()
    },
    [reduced],
  )
  return createElement(as, { ref, className }, children)
}

/** Simple rise-and-fade for blocks. */
export function Rise({ children, className = '', delay = 0, y = 40 }: { children: ReactNode; className?: string; delay?: number; y?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useUi((s) => s.reducedMotion)
  useGsap(
    ref,
    () => {
      if (reduced || !ref.current) return
      gsap.from(ref.current, { y, opacity: 0, duration: 1.1, delay, ease: 'expo.out', scrollTrigger: { trigger: ref.current, start: 'top 88%', once: true } })
    },
    [reduced],
  )
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
