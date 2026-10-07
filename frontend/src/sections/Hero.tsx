import { useEffect, useMemo, useRef } from 'react'
import { SourceBadge } from '@/components/ui/SourceBadge'
import { FEEDER, FARMS } from '@/engine/scenario'
import { defaultPlanDate } from '@/engine/plan'
import { ScrollTrigger } from '@/lib/gsap'
import { useIsMobile } from '@/lib/hooks'
import { usePlan } from '@/state/plan'
import { useUi } from '@/state/ui'
import { LazyCanvas } from '@/three/common/LazyCanvas'
import { HeroScene } from '@/three/scenes/HeroScene'

const PHASES = [
  { title: ['Water', 'has a clock.'], sub: 'Every hour, sun and wind pull water out of the root zone. Wait too long and the crop pays for it.' },
  { title: ['Crops', 'have a need.'], sub: 'Cotton at flowering, chilli at fruiting, groundnut at pegging: each crop, each stage, a different thirst.' },
  { title: ['The sun', 'has a window.'], sub: 'A solarised feeder runs on daylight. The window opens at dawn and closes at dusk, and clouds move it.' },
  { title: ['And the feeder', 'has a limit.'], sub: `${FARMS.length} pumps share one ${FEEDER.feeder_limit_kw} kW line. When everyone switches on at 8 a.m., something gives.` },
  { title: ['SunShift', 'connects them.'], sub: 'Weather, agronomy, solar forecasting and constrained optimisation, coordinating every pump on the feeder.' },
]

export function HeroPoster() {
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: 'linear-gradient(180deg,#b4cde3 0%,#f1e4cc 58%,#b39466 58.2%,#9f8a5c 100%)' }}>
      <div className="absolute left-[62%] top-[34%] h-24 w-24 rounded-full bg-sun shadow-[0_0_120px_40px_rgba(242,169,0,0.45)]" />
      <div className="absolute inset-x-0 top-[58%] bottom-0 opacity-50" style={{ backgroundImage: 'repeating-linear-gradient(100deg, transparent 0 22px, rgba(76,138,59,.45) 22px 26px)' }} />
    </div>
  )
}

export function Hero() {
  const wrap = useRef<HTMLElement>(null)
  const progress = useRef(0)
  const phaseRefs = useRef<(HTMLDivElement | null)[]>([])
  const barRef = useRef<HTMLDivElement>(null)
  const cueRef = useRef<HTMLDivElement>(null)
  const countRef = useRef<HTMLSpanElement>(null)
  const reduced = useUi((s) => s.reducedMotion)
  const mobile = useIsMobile()
  const plan = usePlan((s) => s.result)
  const date = plan?.meta.date ?? defaultPlanDate()
  const crops = useMemo(() => (plan ? Object.fromEntries(plan.farms.map((f) => [f.id, f.crop])) : undefined), [plan])
  const das = useMemo(() => (plan ? Object.fromEntries(plan.farms.map((f) => [f.id, f.das])) : undefined), [plan])

  useEffect(() => {
    if (reduced) {
      progress.current = 1
      return
    }
    const el = wrap.current
    if (!el) return
    const n = PHASES.length
    const apply = (p: number) => {
      progress.current = p
      phaseRefs.current.forEach((node, i) => {
        if (!node) return
        const local = p * n - i
        const fadeIn = i === 0 ? 1 : Math.min(1, Math.max(0, (local + 0.05) / 0.22))
        const fadeOut = i === n - 1 ? 0 : Math.min(1, Math.max(0, (local - 0.72) / 0.22))
        const o = Math.max(0, fadeIn - fadeOut)
        node.style.opacity = String(o)
        node.style.transform = `translate3d(0, ${(1 - fadeIn) * 48 - fadeOut * 48}px, 0)`
        node.style.visibility = o < 0.01 ? 'hidden' : 'visible'
      })
      if (barRef.current) barRef.current.style.transform = `scaleX(${p})`
      if (cueRef.current) cueRef.current.style.opacity = String(Math.max(0, 1 - p * 25))
      if (countRef.current) countRef.current.textContent = String(Math.min(n, Math.floor(p * n) + 1)).padStart(2, '0')
    }
    apply(0)
    const st = ScrollTrigger.create({ trigger: el, start: 'top top', end: 'bottom bottom', scrub: true, onUpdate: (self) => apply(self.progress) })
    return () => st.kill()
  }, [reduced])

  const heightClass = reduced ? 'h-svh' : mobile ? 'h-[460vh]' : 'h-[620vh]'

  return (
    <section id="hero" ref={wrap} data-theme="dark" className={`relative ${heightClass}`} aria-label="SunShift: the sun is now the clock">
      <div className="sticky top-0 h-svh w-full overflow-hidden bg-[#140e09]">
        <LazyCanvas
          className="absolute inset-0"
          label="A solarised agricultural feeder: farm plots, crop rows, a solar plant and the distribution network, seen as the sun rises"
          fallback={<HeroPoster />}
          keepAlive
          camera={{ position: [6, -1.2, -12], fov: 46, near: 0.05, far: 2000 }}
          shadows
        >
          {(tier) => <HeroScene progress={progress} tier={tier} date={date} crops={crops} das={das} />}
        </LazyCanvas>

        {/* legibility veil */}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(10,8,5,0.55)_0%,rgba(10,8,5,0.15)_45%,rgba(10,8,5,0)_70%)]" aria-hidden />

        <div className="wrap pointer-events-none relative flex h-full flex-col justify-between pb-10 pt-[calc(var(--nav-h)+28px)] text-ivory">
          <div className="flex flex-wrap items-center gap-3">
            <span className="kicker text-sun">Act I · The sun</span>
            <span className="kicker opacity-70">Feeder 07 · Warangal, Telangana</span>
            <SourceBadge kind="simulation" className="hidden border-ivory/30 sm:inline-flex" />
          </div>

          {reduced ? (
            <div className="space-y-3">
              {PHASES.map((ph) => (
                <p key={ph.title.join()} className="t-display t-m">
                  {ph.title.join(' ')}
                </p>
              ))}
            </div>
          ) : (
            <div className="relative h-[52vh] sm:h-[48vh]">
              {PHASES.map((ph, i) => (
                <div key={i} ref={(el) => void (phaseRefs.current[i] = el)} className="absolute inset-x-0 bottom-0 will-change-transform" style={{ opacity: i === 0 ? 1 : 0 }}>
                  <h2 className="t-display t-xl max-w-[14ch]">
                    <span className="block">{ph.title[0]}</span>
                    {' '}
                    <span className={`block ${i === PHASES.length - 1 ? 'text-sun' : ''}`}>{ph.title[1]}</span>
                  </h2>
                  <p className="mt-6 max-w-[44ch] text-[clamp(1rem,1.3vw,1.2rem)] leading-relaxed text-ivory/80">{ph.sub}</p>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end justify-between gap-6">
            {!reduced && (
              <div className="w-48">
                <p className="kicker num opacity-80">
                  <span ref={countRef}>01</span> / 05
                </p>
                <div className="mt-2 h-px w-full bg-ivory/25">
                  <div ref={barRef} className="h-px origin-left bg-sun" style={{ transform: 'scaleX(0)' }} />
                </div>
              </div>
            )}
            <div ref={cueRef} className="kicker flex items-center gap-2 opacity-90">
              {reduced ? 'Motion reduced: static view' : 'Scroll to rise'}
              {!reduced && <span aria-hidden className="inline-block animate-bounce">↓</span>}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
