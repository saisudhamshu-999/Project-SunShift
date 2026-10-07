import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '@/api/client'
import type { RainEventResult } from '@/api/types'
import { Gantt, type GanttRow } from '@/components/charts/Gantt'
import { SourceBadge } from '@/components/ui/SourceBadge'
import { Working } from '@/components/ui/primitives'
import { clockFromSlot, fmt } from '@/lib/format'
import { useInView, useTween } from '@/lib/hooks'
import { sound } from '@/lib/sound'
import { useUi } from '@/state/ui'

type Phase = 'active' | 'storm' | 'replanned'
const FORECAST_SLOT = 20

function RainCanvas({ on }: { on: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const reduced = useUi((s) => s.reducedMotion)
  useEffect(() => {
    const c = ref.current
    if (!c || !on || reduced) return
    const ctx = c.getContext('2d')!
    let raf = 0
    const drops = Array.from({ length: 220 }, () => ({ x: Math.random(), y: Math.random(), v: 0.9 + Math.random() * 0.8, l: 10 + Math.random() * 18 }))
    const draw = () => {
      // Resizing reallocates the backing store, so only do it when the element's size changes.
      const w = Math.round(c.clientWidth * devicePixelRatio)
      const h = Math.round(c.clientHeight * devicePixelRatio)
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      ctx.clearRect(0, 0, w, h)
      ctx.strokeStyle = 'rgba(190,210,230,0.45)'
      ctx.lineWidth = 1.2 * devicePixelRatio
      ctx.beginPath()
      for (const d of drops) {
        d.y += d.v * 0.012
        if (d.y > 1.1) {
          d.y = -0.1
          d.x = Math.random()
        }
        const x = d.x * w
        const y = d.y * h
        ctx.moveTo(x, y)
        ctx.lineTo(x - 3 * devicePixelRatio, y + d.l * devicePixelRatio)
      }
      ctx.stroke()
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [on, reduced])
  return <canvas ref={ref} aria-hidden className={`pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-1000 ${on ? 'opacity-100' : 'opacity-0'}`} />
}

export function WeatherInterrupt() {
  const ref = useRef<HTMLElement>(null)
  const near = useInView(ref, { margin: '1800px 0px', once: true })
  const [data, setData] = useState<RainEventResult | null>(null)
  const [engine, setEngine] = useState<'cp-sat' | 'heuristic' | null>(null)
  const [phase, setPhase] = useState<Phase>('active')
  const [cursor, setCursor] = useState(8)

  useEffect(() => {
    if (!near || data) return
    const ctrl = new AbortController()
    api
      .rainEvent({ forecastSlot: FORECAST_SLOT, rainMm: 18, rainProb: 85, rainStartHour: 13, timeLimitS: 2.5 }, ctrl.signal)
      .then((r) => {
        setData(r.data)
        setEngine(r.engine)
      })
      .catch(() => undefined)
    return () => ctrl.abort()
  }, [near, data])

  // Irrigation runs from dawn until the forecast lands at 11:00.
  const visible = useInView(ref, { margin: '-25% 0px' })
  useEffect(() => {
    if (!visible || phase !== 'active') return
    const id = window.setInterval(() => setCursor((c) => (c >= FORECAST_SLOT - 1 ? c : c + 1)), 180)
    return () => window.clearInterval(id)
  }, [visible, phase])

  const trigger = () => {
    setCursor(FORECAST_SLOT)
    setPhase('storm')
    sound.rain(true)
    window.setTimeout(() => {
      setPhase('replanned')
      sound.chime()
    }, 2400)
    window.setTimeout(() => sound.rain(false), 9000)
  }
  const reset = () => {
    setPhase('active')
    setCursor(8)
    sound.rain(false)
  }

  const rows: GanttRow[] = useMemo(() => {
    if (!data) return []
    return data.base.farms
      .filter((f) => f.schedule.slots.length)
      .map((f) => {
        const before = f.schedule.slots.filter((s) => s < FORECAST_SLOT)
        const after = f.schedule.slots.filter((s) => s >= FORECAST_SLOT)
        if (phase === 'active') return { id: f.id, code: f.code, crop: f.crop, slots: f.schedule.slots }
        const re = data.replan.farms.find((r) => r.id === f.id)
        const kept = (re?.schedule.slots ?? []).filter((s) => s >= FORECAST_SLOT)
        return { id: f.id, code: f.code, crop: f.crop, slots: phase === 'replanned' ? [...before, ...kept] : before, cancelled: after.filter((s) => !kept.includes(s)) }
      })
  }, [data, phase])

  const savedL = useTween(phase === 'replanned' && data ? data.savedLitres : 0, 1.6)
  const savedK = useTween(phase === 'replanned' && data ? data.savedKwh : 0, 1.6)
  const storm = phase !== 'active'

  return (
    <section ref={ref} id="rain" data-theme="dark" className="theme-surface relative overflow-hidden py-[clamp(80px,11vw,170px)]">
      <div className={`pointer-events-none absolute inset-0 transition-colors duration-[1400ms] ${storm ? 'bg-[#0b1118]' : 'bg-transparent'}`} aria-hidden />
      <RainCanvas on={storm} />
      <div className="wrap relative">
        <p className="kicker text-water-2">Weather interruption</p>
        <div className="mt-6 flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
          <h2 className="t-display t-xl max-w-[13ch]" aria-live="polite">
            {phase === 'active' && (
              <>
                Irrigation
                <br />
                <span className="text-crop-2">active.</span>
              </>
            )}
            {phase === 'storm' && (
              <>
                Rain is
                <br />
                <span className="text-water-2">coming.</span>
              </>
            )}
            {phase === 'replanned' && (
              <>
                Don't pump
                <br />
                <span className="text-water-2">the rain.</span>
              </>
            )}
          </h2>
          <div className="flex flex-col items-start gap-4 lg:items-end">
            <p className="kicker num text-ivory/60">
              {clockFromSlot(cursor)} · {phase === 'active' ? `${rows.filter((r) => r.slots.includes(cursor)).length} pumps running` : 'forecast update received'}
            </p>
            {phase === 'active' ? (
              <button className="btn h-14 bg-water px-7 text-[16px] text-ivory hover:bg-water-2" onClick={trigger} disabled={!data}>
                {data ? 'Inject rain forecast: 18 mm at 13:00' : 'Preparing the re-plan…'}
              </button>
            ) : (
              <button className="btn btn-ghost h-12" onClick={reset}>
                Replay
              </button>
            )}
          </div>
        </div>

        {!data ? (
          <div className="mt-14">
            <Working label="Planning the day and the rain re-plan" />
          </div>
        ) : (
          <div className="mt-14 grid gap-10 lg:grid-cols-[1.5fr_1fr]">
            <Gantt rows={rows} cursor={cursor} fixedUntil={storm ? FORECAST_SLOT : 0} label="Today's pump schedule around the rain forecast" barColor={storm ? '#6aa8e6' : '#84b85c'} />
            <div className={`space-y-8 transition-opacity duration-700 ${phase === 'replanned' ? 'opacity-100' : 'opacity-25'}`}>
              <div>
                <p className="kicker text-ivory/50">Rain expected</p>
                <p className="num mt-1 text-[clamp(2.2rem,4vw,3.4rem)] font-[620] leading-none">
                  {fmt(data.rain.mm)} mm <span className="text-[16px] text-ivory/50">· {data.rain.prob}% · from {clockFromSlot((data.rain.startHour - 6) * 4)}</span>
                </p>
              </div>
              <div>
                <p className="kicker text-ivory/50">Irrigation cancelled</p>
                <p className="num mt-1 text-[clamp(2.2rem,4vw,3.4rem)] font-[620] leading-none">
                  {data.cancelledFarms.length} farm{data.cancelledFarms.length === 1 ? '' : 's'}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <p className="kicker text-ivory/50">Water saved</p>
                  <p className="num mt-1 text-[clamp(1.8rem,3vw,2.6rem)] font-[620] leading-none text-water-2">{fmt(Math.round(savedL))} L</p>
                </div>
                <div>
                  <p className="kicker text-ivory/50">Energy saved</p>
                  <p className="num mt-1 text-[clamp(1.8rem,3vw,2.6rem)] font-[620] leading-none text-sun">{fmt(savedK, 1)} kWh</p>
                </div>
              </div>
              <p className="text-[14px] leading-relaxed text-ivory/60">
                At {data.forecastTime} the forecast changes. SunShift keeps what already ran, recomputes every farm's water balance with the
                expected rain, and re-optimises the rest of the day: {data.replan.sunshift.solver.status === 'HEURISTIC' ? 'heuristic re-plan' : `${data.replan.sunshift.solver.status} in ${fmt(data.replan.sunshift.solver.wallTimeS, 2)} s`}.
                Farms whose crops would be stressed before the rain arrives keep their water.
              </p>
              <div className="flex flex-wrap gap-2">
                <SourceBadge kind="simulation" />
                <SourceBadge kind={engine === 'heuristic' ? 'heuristic' : 'cp-sat'} />
                <span className="chip chip-wrap">Rain injected on top of {data.base.meta.sources.weather} weather</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
