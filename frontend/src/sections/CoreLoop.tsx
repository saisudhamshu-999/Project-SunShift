import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlanResult } from '@/api/types'
import { Reveal } from '@/components/text/Reveal'
import { ActLabel } from '@/components/ui/primitives'
import { fmt } from '@/lib/format'
import { ScrollTrigger } from '@/lib/gsap'
import { useIsMobile } from '@/lib/hooks'
import { useSize } from '@/lib/useSize'
import { usePlan } from '@/state/plan'
import { useUi } from '@/state/ui'

type Glyph = 'sun' | 'wave' | 'panel' | 'cloud' | 'drop' | 'leaf' | 'layers' | 'bolt' | 'grid' | 'clock' | 'phone' | 'pump' | 'loop'

function Icon({ g }: { g: Glyph }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      {g === 'sun' && (<><circle cx="12" cy="12" r="4.5" {...p} /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" {...p} /></>)}
      {g === 'wave' && <path d="M2 14c3-6 5-6 8 0s5 6 8 0 3-4 4-2" {...p} />}
      {g === 'panel' && (<><path d="M3 15l3-9h12l3 9z" {...p} /><path d="M9 6l-1 9M15 6l1 9M4.5 10.5h15M12 15v5M8 20h8" {...p} /></>)}
      {g === 'cloud' && (<><path d="M7 16a4 4 0 1 1 .9-7.9A5 5 0 0 1 17.5 9 3.5 3.5 0 0 1 17 16z" {...p} /><path d="M9 19l-1 2M13 19l-1 2M17 19l-1 2" {...p} /></>)}
      {g === 'drop' && <path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z" {...p} />}
      {g === 'leaf' && (<><path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15" {...p} /><path d="M5 19l8-8" {...p} /></>)}
      {g === 'layers' && (<><path d="M3 8l9-4 9 4-9 4z" {...p} /><path d="M3 12l9 4 9-4M3 16l9 4 9-4" {...p} /></>)}
      {g === 'bolt' && <path d="M13 2L4 14h7l-1 8 9-12h-7z" {...p} />}
      {g === 'grid' && (<><rect x="3" y="3" width="18" height="18" rx="2" {...p} /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" {...p} /></>)}
      {g === 'clock' && (<><circle cx="12" cy="12" r="9" {...p} /><path d="M12 7v5l3 2" {...p} /></>)}
      {g === 'phone' && (<><rect x="7" y="2.5" width="10" height="19" rx="2" {...p} /><path d="M10 18.5h4" {...p} /></>)}
      {g === 'pump' && (<><rect x="4" y="9" width="9" height="9" rx="1.5" {...p} /><path d="M13 13h4v-4h3M8.5 9V5h4" {...p} /></>)}
      {g === 'loop' && <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" {...p} />}
    </svg>
  )
}

interface Node {
  title: string
  glyph: Glyph
  value: (p: PlanResult) => string
  accent?: 'sun' | 'water' | 'crop' | 'alert'
}

const NODES: Node[] = [
  { title: 'Sun', glyph: 'sun', accent: 'sun', value: (p) => `Sunrise ${p.weather.daily.sunrise?.slice(11) ?? '06:0x'} · sunset ${p.weather.daily.sunset?.slice(11) ?? '18:0x'}` },
  { title: 'Solar forecast', glyph: 'wave', accent: 'sun', value: (p) => `${fmt(p.weather.daily.rs, 1)} MJ/m² · peak ${fmt(Math.max(...p.weather.slots.ghi))} W/m²` },
  { title: 'PV availability', glyph: 'panel', accent: 'sun', value: (p) => `${fmt(p.solar.energyKwh)} kWh today · peak ${fmt(p.solar.peakKw, 1)} kW AC` },
  { title: 'Weather', glyph: 'cloud', accent: 'water', value: (p) => `${fmt(p.weather.daily.tmax, 1)} °C max · ${p.weather.daily.lookaheadRainProb}% rain chance` },
  { title: 'ET₀', glyph: 'drop', accent: 'water', value: (p) => `${fmt(p.weather.daily.et0, 2)} mm/day${p.weather.daily.et0Reference != null ? ` (Open-Meteo: ${fmt(p.weather.daily.et0Reference, 2)})` : ''}` },
  { title: 'Crop stage', glyph: 'leaf', accent: 'crop', value: (p) => `${p.farms.filter((f) => f.stage === 2).length} farms in their most yield-sensitive stage` },
  { title: 'Crop water requirement', glyph: 'leaf', accent: 'crop', value: (p) => `ETc ${fmt(Math.min(...p.farms.map((f) => f.etc)), 1)}–${fmt(Math.max(...p.farms.map((f) => f.etc)), 1)} mm/day` },
  { title: 'Soil-water balance', glyph: 'layers', accent: 'crop', value: (p) => `${p.farms.filter((f) => f.status !== 'SAFE').length} of ${p.farms.length} farms at or past their trigger` },
  { title: 'Farm demand', glyph: 'drop', accent: 'water', value: (p) => `${fmt(p.totals.demandM3)} m³ across ${p.totals.farmsNeeding} farms` },
  { title: 'Feeder constraint', glyph: 'bolt', accent: 'alert', value: (p) => `${fmt(p.feeder.limitKw)} kW limit · ${fmt(p.feeder.connectedLoadKw)} kW of pumps connected` },
  { title: 'CP-SAT optimiser', glyph: 'grid', value: (p) => (p.meta.engine === 'cp-sat' ? `${p.sunshift.solver.status} in ${fmt(p.sunshift.solver.wallTimeS, 2)} s · ${fmt(p.sunshift.solver.numBooleans)} decisions` : 'API offline: browser heuristic used') },
  { title: 'Irrigation schedule', glyph: 'clock', value: (p) => `${p.totals.farmsScheduled} farms · ${p.sunshift.metrics.pumpStarts} pump starts · peak ${fmt(p.sunshift.metrics.peakDemandKw, 1)} kW` },
  { title: 'Farmer', glyph: 'phone', value: () => 'SMS and voice call in Telugu, Hindi or English' },
  { title: 'Pump', glyph: 'pump', value: () => 'Contactor-switched; automation only by consent' },
  { title: 'Feedback', glyph: 'wave', value: () => 'Planned vs actual, every 15 minutes' },
  { title: 'Re-optimise', glyph: 'loop', accent: 'sun', value: () => 'Rolling re-plan when weather, solar or pumps deviate' },
]

const ACCENT = { sun: '#f2a900', water: '#2f74c0', crop: '#4c8a3b', alert: '#d04a2f' }

export function CoreLoop() {
  const plan = usePlan((s) => s.result)
  const reduced = useUi((s) => s.reducedMotion)
  const mobile = useIsMobile()
  const section = useRef<HTMLElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const { width } = useSize(stage)
  const [progress, setProgress] = useState(reduced ? 1 : 0)
  const rowH = mobile ? 104 : 118
  const height = NODES.length * rowH + 40

  const points = useMemo(
    () => NODES.map((_, i) => ({ x: mobile ? 22 : width * (i % 2 ? 0.62 : 0.38), y: 40 + i * rowH })),
    [width, mobile, rowH],
  )
  const d = useMemo(() => {
    if (!points.length) return ''
    let s = `M${points[0].x},${points[0].y}`
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]
      const b = points[i]
      const my = (a.y + b.y) / 2
      s += ` C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`
    }
    return s
  }, [points])
  const loopBack = useMemo(() => {
    if (!points.length || mobile) return ''
    const last = points[points.length - 1]
    const first = points[1]
    const x = width * 0.93
    return `M${last.x},${last.y} C${x},${last.y} ${x},${last.y} ${x},${last.y - 120} L${x},${first.y + 60} C${x},${first.y} ${x},${first.y} ${first.x + 40},${first.y}`
  }, [points, width, mobile])

  useEffect(() => {
    if (reduced) {
      setProgress(1)
      return
    }
    const el = stage.current
    if (!el) return
    const st = ScrollTrigger.create({ trigger: el, start: 'top 75%', end: 'bottom 60%', scrub: true, onUpdate: (self) => setProgress(self.progress) })
    return () => st.kill()
  }, [reduced])

  const len = pathRef.current?.getTotalLength() ?? 4000

  return (
    <section ref={section} id="system" className="survey-grid relative bg-ivory py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <ActLabel act="IV" title="The system" />
        <div className="mt-8 grid gap-8 lg:grid-cols-[1.4fr_1fr] lg:items-end">
          <Reveal as="h2" className="t-display t-xl" split="words">
            Predict the sun. Understand the crop. Coordinate the pumps.
          </Reveal>
          <p className="lede">
            Sixteen steps, recomputed every morning and again whenever reality drifts from the plan. The values on each step are today's, from the live plan.
          </p>
        </div>

        <div ref={stage} className="relative mt-16" style={{ height }}>
          {width > 0 && (
            <svg className="absolute inset-0" width={width} height={height} aria-hidden>
              <path d={d} fill="none" stroke="var(--line-2)" strokeWidth="1" strokeDasharray="2 6" />
              <path ref={pathRef} id="core-spine" d={d} fill="none" stroke="#15140f" strokeWidth="1.6" strokeDasharray={len} strokeDashoffset={len * (1 - progress)} />
              {loopBack && <path d={loopBack} fill="none" stroke="#f2a900" strokeWidth="1.6" strokeDasharray="5 7" opacity={progress > 0.95 ? 1 : 0.15} style={{ transition: 'opacity .8s' }} />}
              {!reduced &&
                [0, 1.5, 3, 4.5, 6, 7.5].map((b) => (
                  <circle key={b} r="3.6" fill="#f2a900">
                    <animateMotion dur="9s" begin={`${b}s`} repeatCount="indefinite" path={d} rotate="auto" />
                  </circle>
                ))}
            </svg>
          )}
          {points.map((pt, i) => {
            const node = NODES[i]
            const reached = progress >= i / NODES.length - 0.02
            const left = mobile || i % 2 === 0
            return (
              <div
                key={node.title}
                className="absolute flex items-center gap-4 transition-[opacity,transform] duration-700"
                style={{
                  top: pt.y - 26,
                  ...(mobile ? { left: pt.x - 22 } : left ? { right: width - pt.x - 22 } : { left: pt.x - 22 }),
                  flexDirection: !mobile && left ? 'row-reverse' : 'row',
                  opacity: reached ? 1 : 0.18,
                  transform: `translateY(${reached ? 0 : 14}px)`,
                }}
              >
                <span
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full border bg-ivory"
                  style={{ borderColor: node.accent ? ACCENT[node.accent] : '#15140f', color: node.accent ? ACCENT[node.accent] : '#15140f', boxShadow: reached ? `0 0 0 6px ${node.accent ? ACCENT[node.accent] : '#15140f'}14` : undefined }}
                >
                  <Icon g={node.glyph} />
                </span>
                <div className={`max-w-[min(42vw,360px)] ${!mobile && left ? 'text-right' : ''}`}>
                  <p className="kicker num opacity-45">{String(i + 1).padStart(2, '0')}</p>
                  <p className="text-[clamp(1.05rem,1.6vw,1.45rem)] font-[600] leading-tight tracking-[-0.02em]">{node.title}</p>
                  <p className="num mt-0.5 text-[13px] leading-snug opacity-65">{plan ? node.value(plan) : '…'}</p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
