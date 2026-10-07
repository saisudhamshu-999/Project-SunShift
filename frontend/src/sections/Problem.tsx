import { useEffect, useRef } from 'react'
import { ActLabel } from '@/components/ui/primitives'
import { FARMS, FEEDER } from '@/engine/scenario'
import { ScrollTrigger } from '@/lib/gsap'
import { useIsMobile } from '@/lib/hooks'
import { useUi } from '@/state/ui'

const BEFORE = ['Grid power', 'Available hours', 'Pump', 'Irrigation']
const AFTER = ['Sun', 'Variable solar', 'Multiple pumps', 'Feeder capacity', 'Irrigation demand']

function Chain({ items, tone, label, sub, progressVar }: { items: string[]; tone: 'grid' | 'sun'; label: string; sub: string; progressVar: string }) {
  const accent = tone === 'sun' ? 'var(--color-sun)' : 'var(--fg-2)'
  return (
    <div className="flex h-full flex-col">
      <p className="kicker" style={{ color: tone === 'sun' ? 'var(--color-sun)' : undefined }}>{label}</p>
      <ol className="mt-8 flex flex-1 flex-col gap-0" aria-label={label}>
        {items.map((it, i) => {
          const at = i / items.length
          return (
            <li key={it} className="relative flex flex-col items-start">
              <span
                className="t-display t-s rounded-full border px-5 py-3 transition-none"
                style={{
                  borderColor: accent,
                  opacity: `clamp(0.12, calc((var(${progressVar}) - ${at}) * 6), 1)`,
                  transform: `translateY(calc(clamp(0, (${at} + 0.15 - var(${progressVar})) * 80, 12) * 1px))`,
                  background: tone === 'sun' && i === 0 ? 'var(--color-sun)' : 'transparent',
                  color: tone === 'sun' && i === 0 ? 'var(--color-ink)' : undefined,
                }}
              >
                {it}
              </span>
              {i < items.length - 1 && (
                <span className="ml-8 block h-8 w-px origin-top" style={{ background: accent, transform: `scaleY(clamp(0, calc((var(${progressVar}) - ${at}) * 6), 1))` }} aria-hidden />
              )}
            </li>
          )
        })}
      </ol>
      <p className="mt-6 max-w-[34ch] text-[15px] leading-relaxed opacity-75">{sub}</p>
    </div>
  )
}

export function Problem() {
  const section = useRef<HTMLElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const word = useRef<HTMLSpanElement>(null)
  const reduced = useUi((s) => s.reducedMotion)
  const mobile = useIsMobile()
  const horizontal = !reduced && !mobile

  useEffect(() => {
    const el = section.current
    if (!el) return
    if (!horizontal) {
      el.style.setProperty('--chain', '1')
      el.style.setProperty('--shift', '1')
      return
    }
    const st = ScrollTrigger.create({
      trigger: el,
      start: 'top top',
      end: 'bottom bottom',
      scrub: true,
      onUpdate: (self) => {
        const p = self.progress
        if (track.current) track.current.style.transform = `translate3d(${-p * 200}vw,0,0)`
        el.style.setProperty('--chain', String(Math.min(1, Math.max(0, (p - 0.28) / 0.32))))
        el.style.setProperty('--shift', String(Math.min(1, Math.max(0, (p - 0.78) / 0.2))))
      },
    })
    return () => st.kill()
  }, [horizontal])

  const panels = (
    <>
      <div className="flex h-svh w-screen shrink-0 flex-col justify-center bg-ivory text-ink">
        <div className="wrap">
          <ActLabel act="II" title="The problem" />
          <h2 className="t-display t-xxl mt-8 max-w-[11ch]">Solar changes the question.</h2>
          <p className="lede mt-8 text-[clamp(1.1rem,1.5vw,1.45rem)]">
            For decades the question was: <em className="not-italic text-ink">when will the grid give us power?</em> On a solarised feeder it becomes:{' '}
            <em className="not-italic text-ink">when should {FARMS.length} farmers share the sun?</em>
          </p>
        </div>
      </div>
      <div className="flex min-h-svh w-screen shrink-0 items-center bg-sand text-ink">
        <div className="wrap grid gap-12 py-24 md:grid-cols-2 md:gap-20">
          <Chain items={BEFORE} tone="grid" label="Before solar" sub="One question: are the supply hours on? Everyone irrigates when they are." progressVar="--chain" />
          <Chain items={AFTER} tone="sun" label="After solar" sub="Five interacting constraints, shared by every pump on the feeder, changing hour by hour." progressVar="--chain" />
        </div>
      </div>
      <div data-theme="dark" className="theme-surface flex h-svh w-screen shrink-0 flex-col justify-center overflow-hidden">
        <div className="wrap">
          <h2 className="t-display t-xxl">
            <span className="block">The</span>
            <span
              ref={word}
              className="block text-sun will-change-transform"
              style={{ transform: horizontal ? 'translateX(calc((var(--shift) - 1) * -35vw))' : undefined }}
            >
              constraint
            </span>
            {' '}
            <span className="block">moved.</span>
          </h2>
          <p className="lede mt-8 text-[clamp(1.1rem,1.5vw,1.45rem)] text-ivory/75">
            The limit is no longer the hours of supply. It is the sun's shape, the feeder's {FEEDER.feeder_limit_kw} kW, and the crops' clock, all at once.{' '}
            <span className="text-ivory">SunShift is built for the new constraint.</span>
          </p>
        </div>
      </div>
    </>
  )

  return (
    <section ref={section} id="problem" className="relative" style={{ height: horizontal ? '300vh' : undefined, ['--chain' as string]: 0, ['--shift' as string]: 0 }} data-theme="light">
      {horizontal ? (
        <div className="sticky top-0 h-svh overflow-hidden">
          <div ref={track} className="flex h-full will-change-transform">
            {panels}
          </div>
        </div>
      ) : (
        <div className="flex flex-col">{panels}</div>
      )}
    </section>
  )
}
