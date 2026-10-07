import { useEffect, useRef } from 'react'
import { ScrollTrigger } from '@/lib/gsap'
import { useIsMobile } from '@/lib/hooks'
import { useUi } from '@/state/ui'

const STAGES = [
  { k: 'Now', t: '20-farm simulation', d: 'This prototype: live weather, pvlib, FAO-56, CP-SAT scheduling and season replays on real ERA5 weather.', done: true },
  { k: 'Pilot', t: 'One feeder', d: 'Enrol 20–50 farms with an FPO and the DISCOM. Advisory mode by SMS and voice. Measure against a control feeder.' },
  { k: 'Field', t: 'Real pump telemetry', d: 'Current sensors and feeder metering replace estimates. Assisted mode where farmers consent.' },
  { k: 'Scale', t: 'Many feeders', d: 'One platform, per-feeder calibration, DISCOM dashboards, feeder-by-feeder impact reporting.' },
  { k: 'Future', t: 'Predictive optimisation + richer sensing', d: 'Forecast correction learned from telemetry, soil-moisture probes, groundwater signals, multi-day planning.' },
]

export function Roadmap() {
  const section = useRef<HTMLElement>(null)
  const track = useRef<HTMLOListElement>(null)
  const reduced = useUi((s) => s.reducedMotion)
  const mobile = useIsMobile()
  const horizontal = !reduced && !mobile

  useEffect(() => {
    const el = section.current
    const tr = track.current
    if (!el || !tr || !horizontal) return
    const st = ScrollTrigger.create({
      trigger: el,
      start: 'top top',
      end: 'bottom bottom',
      scrub: true,
      onUpdate: (self) => {
        const max = tr.scrollWidth - window.innerWidth + 80
        tr.style.transform = `translate3d(${-self.progress * Math.max(0, max)}px,0,0)`
      },
    })
    return () => st.kill()
  }, [horizontal])

  const items = STAGES.map((s, i) => (
    <li key={s.k} className="relative w-[min(78vw,420px)] shrink-0 pr-10 max-md:w-full max-md:pb-10">
      <div className="flex items-center gap-4">
        <span className={`grid h-10 w-10 place-items-center rounded-full border text-[13px] font-[650] ${s.done ? 'border-sun bg-sun text-ink' : 'border-ivory/30'}`}>{i + 1}</span>
        <span className="h-px flex-1 bg-ivory/20 max-md:hidden" aria-hidden />
      </div>
      <p className="kicker mt-6 text-sun">{s.k}</p>
      <h3 className="t-display t-m mt-3">{s.t}</h3>
      <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-ivory/65">{s.d}</p>
    </li>
  ))

  return (
    <section ref={section} id="roadmap" data-theme="dark" className="theme-surface relative" style={{ height: horizontal ? '240vh' : undefined }}>
      <div className={horizontal ? 'sticky top-0 flex h-svh flex-col justify-center overflow-hidden' : 'py-[clamp(80px,11vw,170px)]'}>
        <div className="wrap">
          <p className="kicker">Roadmap</p>
          <h2 className="t-display t-xl mt-6">From one feeder to thousands.</h2>
        </div>
        <ol ref={track} className={`mt-16 ${horizontal ? 'flex pl-[var(--gutter)] will-change-transform' : 'wrap flex flex-col'}`}>
          {items}
        </ol>
      </div>
    </section>
  )
}
