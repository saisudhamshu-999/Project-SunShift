import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import * as api from '@/api/client'
import type { PlanResult, RainEventResult } from '@/api/types'
import { LoadChart } from '@/components/charts/LoadChart'
import { LogoMark } from '@/components/layout/Logo'
import { SourceBadge } from '@/components/ui/SourceBadge'
import { Working } from '@/components/ui/primitives'
import { clockFromSlot, fmt, pct } from '@/lib/format'
import { sound } from '@/lib/sound'
import { HeroPoster } from '@/sections/Hero'
import { usePlan } from '@/state/plan'
import { LazyCanvas } from '@/three/common/LazyCanvas'
import { FeederScene } from '@/three/scenes/FeederScene'

interface Data {
  base: PlanResult
  engine: 'cp-sat' | 'heuristic'
  rain: RainEventResult | null
  cloud: PlanResult | null
}

interface Scene {
  id: string
  seconds: number
  kicker: string
  title: (d: Data) => string
  body: (d: Data) => string
  /** Slot range the twin plays through during the scene. */
  slots: [number, number]
  mode?: 'sunshift' | 'uncoordinated'
  plan?: (d: Data) => PlanResult | null
  rain?: number
  panel?: 'load-unc' | 'load-sun' | 'solver' | 'rain' | 'cloud' | 'impact'
}

const SCENES: Scene[] = [
  { id: 'sun', seconds: 8, kicker: '06:00 · Scene 1', title: () => 'The sun rises over Feeder 07.', body: (d) => `${fmt(d.base.feeder.pvKwp)} kWp of solar, one ${fmt(d.base.feeder.limitKw)} kW feeder, ${d.base.farms.length} farms. Forecast for ${d.base.meta.dateLabel}: ${fmt(d.base.solar.energyKwh)} kWh of sun.`, slots: [0, 8] },
  { id: 'requests', seconds: 9, kicker: 'Scene 2', title: (d) => `${d.base.totals.farmsNeeding} farmers need water today.`, body: (d) => `FAO-56 water balance on every farm: ${fmt(d.base.totals.demandM3)} m³ requested, ${d.base.farms.filter((f) => f.priority.label === 'CRITICAL' || f.priority.label === 'HIGH').length} of them urgent.`, slots: [8, 10] },
  { id: 'conflict', seconds: 10, kicker: 'Scene 3 · Without coordination', title: (d) => `${fmt(d.base.uncoordinated.metrics.peakDemandKw, 0)} kW on a ${fmt(d.base.feeder.limitKw)} kW line.`, body: (d) => `Everyone switches on at their usual time. The feeder is overloaded for ${fmt(d.base.uncoordinated.metrics.overloadSlots * 15)} minutes and ${pct(1 - d.base.uncoordinated.metrics.adequacy)} of the water never arrives.`, slots: [4, 20], mode: 'uncoordinated', panel: 'load-unc' },
  { id: 'optimise', seconds: 10, kicker: 'Scene 4', title: () => 'SunShift optimises.', body: (d) => (d.engine === 'cp-sat' ? `OR-Tools CP-SAT: ${fmt(d.base.sunshift.solver.numBooleans)} decisions, ${d.base.sunshift.solver.status.toLowerCase()} in ${fmt(d.base.sunshift.solver.wallTimeS, 1)} s, every farm guaranteed a fair share.` : 'API offline: the browser fallback heuristic schedules the day.'), slots: [10, 12], panel: 'solver' },
  { id: 'distribute', seconds: 12, kicker: 'Scene 5 · With SunShift', title: () => 'Pumps take turns on the sun.', body: (d) => `Peak ${fmt(d.base.sunshift.metrics.peakDemandKw, 1)} kW, never over the limit. ${pct(d.base.sunshift.metrics.adequacy)} of the water delivered.`, slots: [8, 20], panel: 'load-sun' },
  { id: 'rain', seconds: 9, kicker: '11:00 · Scene 6', title: (d) => `Forecast: ${fmt(d.rain?.rain.mm ?? 18)} mm of rain at 13:00.`, body: () => 'The weather service updates. SunShift recomputes every farm’s water balance with the rain it expects.', slots: [20, 21], rain: 0.6, plan: (d) => d.rain?.base ?? d.base },
  { id: 'cancel', seconds: 9, kicker: 'Scene 7', title: () => "Don't pump the rain.", body: (d) => (d.rain ? `${d.rain.cancelledFarms.length} farms' remaining irrigation cancelled: ${fmt(d.rain.savedLitres)} litres and ${fmt(d.rain.savedKwh, 0)} kWh saved.` : 'Re-plan still computing…'), slots: [20, 26], rain: 0.85, plan: (d) => d.rain?.replan ?? d.base, panel: 'rain' },
  { id: 'cloud', seconds: 9, kicker: '11:30 · Scene 8', title: () => 'Then the sun changes.', body: () => 'A different day: a cloud bank cuts solar output 45% below the forecast for the rest of the afternoon.', slots: [22, 24], plan: (d) => d.base },
  { id: 'reopt', seconds: 10, kicker: 'Scene 9', title: () => 'SunShift re-optimises.', body: (d) => (d.cloud ? `What ran this morning stays. The rest of the day is re-solved${d.cloud.meta.engine === 'cp-sat' ? ` (${d.cloud.sunshift.solver.status.toLowerCase()} in ${fmt(d.cloud.sunshift.solver.wallTimeS, 1)} s)` : ''}: ${d.cloud.farms.filter((f) => f.schedule.window !== d.base.farms.find((b) => b.id === f.id)?.schedule.window).length} windows move, the feeder stays within limits.` : 'Re-plan still computing…'), slots: [22, 34], plan: (d) => d.cloud ?? d.base, panel: 'cloud' },
  { id: 'impact', seconds: 15, kicker: 'Scene 10', title: () => 'One sun. Many farms. One coordinated system.', body: () => 'Same farms, same water needs. Only the timing changed.', slots: [34, 47], panel: 'impact' },
]

const TOTAL = SCENES.reduce((a, s) => a + s.seconds, 0)

export default function Demo() {
  const storePlan = usePlan((s) => s.result)
  const [data, setData] = useState<Data | null>(null)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'playing' | 'paused' | 'done'>('idle')
  const [scene, setScene] = useState(0)
  const [, setTick] = useState(0)
  const sceneRef = useRef(0)
  const elapsedRef = useRef(0) // seconds into the current scene
  const slotRef = useRef(0)
  const rainRef = useRef(0)

  const jump = useCallback((index: number) => {
    const next = Math.max(0, Math.min(SCENES.length - 1, index))
    sceneRef.current = next
    elapsedRef.current = 0
    setScene(next)
  }, [])

  const start = useCallback(async () => {
    setPhase('loading')
    sound.click()
    const base = storePlan ? { data: storePlan, engine: storePlan.meta.engine } : await api.plan({ persist: false, timeLimitS: 3 })
    setData({ base: base.data, engine: base.engine, rain: null, cloud: null })
    jump(0)
    setPhase('playing')
    // The rest is computed while the first scenes play.
    void api.rainEvent({ forecastSlot: 20, rainMm: 18, rainProb: 85, rainStartHour: 13, timeLimitS: 2.5 }).then((r) => setData((cur) => (cur ? { ...cur, rain: r.data } : cur)))
    const executed = Object.fromEntries(base.data.farms.map((f) => [f.id, f.schedule.slots.filter((s) => s < 22)]))
    void api.plan({ failure: 'solar_forecast', fixedUntil: 22, executed, persist: false, timeLimitS: 2.5 }).then((r) => setData((cur) => (cur ? { ...cur, cloud: r.data } : cur)))
  }, [storePlan, jump])

  // One animation loop drives the scene timer, the twin's clock and the rain.
  useEffect(() => {
    if (phase !== 'playing') return
    let last = performance.now()
    let lastPaint = 0
    let raf = 0
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const sc = SCENES[sceneRef.current]
      elapsedRef.current += dt
      const f = Math.min(1, elapsedRef.current / sc.seconds)
      slotRef.current = sc.slots[0] + (sc.slots[1] - sc.slots[0]) * f
      rainRef.current += ((sc.rain ?? 0) - rainRef.current) * Math.min(1, dt * 1.5)
      if (elapsedRef.current >= sc.seconds) {
        if (sceneRef.current < SCENES.length - 1) jump(sceneRef.current + 1)
        else {
          elapsedRef.current = sc.seconds
          setPhase('done')
          return
        }
      }
      if (now - lastPaint > 100) {
        lastPaint = now
        setTick((t) => t + 1)
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [phase, jump])

  useEffect(() => {
    if (phase !== 'playing') return
    const id = SCENES[scene].id
    if (id === 'rain') sound.rain(true)
    if (id === 'cloud') sound.rain(false)
    if (id === 'optimise' || id === 'reopt') sound.chime()
    if (id === 'distribute') sound.pumpStart()
  }, [scene, phase])

  const go = useCallback(
    (delta: number) => {
      jump(sceneRef.current + delta)
      setPhase((p) => (p === 'done' ? 'playing' : p))
    },
    [jump],
  )
  const togglePlay = () => {
    if (phase === 'done') {
      jump(0)
      setPhase('playing')
    } else setPhase(phase === 'playing' ? 'paused' : 'playing')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase === 'idle' || phase === 'loading') return
      if (e.key === ' ') {
        e.preventDefault()
        setPhase((p) => (p === 'playing' ? 'paused' : 'playing'))
      } else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, go])

  useEffect(() => () => sound.rain(false), [])

  // ?autostart=1 starts immediately (kiosk / judging screens); ?scene=N jumps to a scene.
  const autostarted = useRef(false)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (autostarted.current || !q.has('autostart') || phase !== 'idle') return
    autostarted.current = true
    void start().then(() => {
      const n = Number(q.get('scene'))
      if (Number.isFinite(n) && n > 1) jump(n - 1)
    })
  }, [phase, start, jump])

  const sc = SCENES[scene]
  const activePlan = data ? (sc.plan?.(data) ?? data.base) : storePlan
  const progress = (SCENES.slice(0, scene).reduce((a, s) => a + s.seconds, 0) + elapsedRef.current) / TOTAL
  const loadPanel = useMemo(() => {
    if (!data) return null
    if (sc.panel === 'load-unc') return { load: data.base.uncoordinated.metrics.series.demandKw, label: 'Uncoordinated load' }
    if (sc.panel === 'load-sun') return { load: data.base.sunshift.loadKw, label: 'SunShift load' }
    if (sc.panel === 'cloud' && data.cloud) return { load: data.cloud.sunshift.loadKw, label: 'Re-optimised load', solar: data.cloud.solar.acKw }
    return null
  }, [data, sc.panel])

  return (
    <div data-theme="dark" className="theme-surface relative h-svh overflow-hidden">
      <LazyCanvas className="absolute inset-0" label="Feeder 07 in 3D, playing the demo" fallback={<HeroPoster />} camera={{ position: [44, 56, 74], fov: 38, near: 0.5, far: 2000 }} margin="2000px 0px" keepAlive>
        {(tier) => <FeederScene plan={activePlan ?? null} tier={tier} slot={slotRef} mode={sc.mode ?? 'sunshift'} autoRotate={phase === 'playing'} rainOverride={rainRef} />}
      </LazyCanvas>
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(12,10,7,0.88)_0%,rgba(12,10,7,0.55)_38%,rgba(12,10,7,0.05)_70%)]" aria-hidden />

      <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-between p-5 md:px-8">
        <Link to="/" className="flex items-center gap-2.5" aria-label="Exit demo to the SunShift story">
          <LogoMark ink="#f3eee4" />
          <span className="text-[14px] font-[680] tracking-[0.18em]">SUNSHIFT</span>
          <span className="kicker ml-2 text-ivory/50">Demo mode</span>
        </Link>
        <div className="flex items-center gap-2">
          {data && <SourceBadge kind={data.engine === 'cp-sat' ? 'cp-sat' : 'heuristic'} />}
          {data && <SourceBadge kind="simulation" />}
          <Link to="/app" className="btn h-9 border border-ivory/25 px-4 text-[13px] text-ivory hover:bg-ivory/10">Live feeder</Link>
        </div>
      </header>

      {phase === 'idle' || phase === 'loading' ? (
        <div className="relative z-10 flex h-full flex-col justify-center px-[var(--gutter)]">
          <p className="kicker text-sun">Yuva Yodha 2026 · Sustainable agriculture</p>
          <h1 className="t-display t-xl mt-6 max-w-[14ch]">Irrigation scheduling for the solar era.</h1>
          <p className="lede mt-6 text-ivory/65">A 100-second walkthrough: one feeder, twenty farms, real weather, real optimisation. Space to pause, arrow keys to step.</p>
          <div className="mt-10">
            {phase === 'loading' ? (
              <Working label="Planning today's feeder with CP-SAT" />
            ) : (
              <button className="btn btn-sun h-16 px-10 text-[18px]" onClick={() => void start()} autoFocus>
                Start demo ▶
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="relative z-10 flex h-full flex-col justify-end gap-8 px-[var(--gutter)] pb-28 pt-24">
          {data && (
            <div key={sc.id} className="max-w-[min(760px,92vw)]" style={{ animation: 'demo-in .9s cubic-bezier(.16,1,.3,1) both' }} aria-live="polite">
              <p className="kicker text-sun">{sc.kicker}</p>
              <h2 className={`t-display mt-4 ${sc.id === 'impact' ? 't-xl' : 't-l'}`}>{sc.title(data)}</h2>
              <p className="mt-5 max-w-[56ch] text-[clamp(1rem,1.4vw,1.25rem)] leading-relaxed text-ivory/75">{sc.body(data)}</p>
            </div>
          )}
          {data && loadPanel && (
            <div className="w-[min(640px,92vw)] rounded-2xl bg-ink/70 p-4 backdrop-blur" style={{ animation: 'demo-in .9s .2s both' }}>
              <LoadChart title={loadPanel.label} solar={loadPanel.solar ?? data.base.solar.acKw} load={loadPanel.load} limit={data.base.feeder.limitKw} height={170} cursor={Math.floor(slotRef.current)} loadLabel={loadPanel.label} />
            </div>
          )}
          {data && sc.panel === 'solver' && data.engine === 'cp-sat' && (
            <dl className="grid w-[min(640px,92vw)] grid-cols-2 gap-4 rounded-2xl bg-ink/70 p-5 backdrop-blur sm:grid-cols-4" style={{ animation: 'demo-in .9s .2s both' }}>
              {(
                [
                  ['Decisions', fmt(data.base.sunshift.solver.numBooleans)],
                  ['Constraints', fmt(data.base.sunshift.solver.numConstraints)],
                  ['Solve time', `${fmt(data.base.sunshift.solver.wallTimeS, 2)} s`],
                  ['Fairness floor', data.base.sunshift.solver.phase1 ? pct(data.base.sunshift.solver.phase1.guaranteed) : '–'],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="kicker text-ivory/50">{k}</dt>
                  <dd className="num mt-1 text-[24px] font-[620]">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {data && sc.panel === 'rain' && data.rain && (
            <dl className="grid w-[min(640px,92vw)] grid-cols-3 gap-4 rounded-2xl bg-ink/70 p-5 backdrop-blur" style={{ animation: 'demo-in .9s .2s both' }}>
              <div><dt className="kicker text-ivory/50">Farms cancelled</dt><dd className="num mt-1 text-[28px] font-[620]">{data.rain.cancelledFarms.length}</dd></div>
              <div><dt className="kicker text-ivory/50">Water saved</dt><dd className="num mt-1 text-[28px] font-[620] text-water-2">{fmt(data.rain.savedM3)} m³</dd></div>
              <div><dt className="kicker text-ivory/50">Energy saved</dt><dd className="num mt-1 text-[28px] font-[620] text-sun">{fmt(data.rain.savedKwh)} kWh</dd></div>
            </dl>
          )}
          {data && sc.panel === 'impact' && (
            <dl className="grid w-[min(860px,94vw)] grid-cols-2 gap-5 rounded-2xl bg-ink/75 p-6 backdrop-blur sm:grid-cols-4" style={{ animation: 'demo-in .9s .3s both' }}>
              {(
                [
                  ['Peak load', `${fmt(data.base.uncoordinated.metrics.peakDemandKw, 0)} → ${fmt(data.base.sunshift.metrics.peakDemandKw, 0)} kW`],
                  ['Overload', `${fmt(data.base.uncoordinated.metrics.overloadSlots * 15)} → ${fmt(data.base.sunshift.metrics.overloadSlots * 15)} min`],
                  ['Water arrived', `${pct(data.base.uncoordinated.metrics.adequacy)} → ${pct(data.base.sunshift.metrics.adequacy)}`],
                  ['Solar put to work', `${fmt(data.base.uncoordinated.metrics.solarUsedKwh)} → ${fmt(data.base.sunshift.metrics.solarUsedKwh)} kWh`],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="kicker text-ivory/50">{k}</dt>
                  <dd className="num mt-1 text-[22px] font-[620]">{v}</dd>
                </div>
              ))}
              <p className="col-span-full text-[12px] text-ivory/45">Demonstration simulation for {data.base.meta.dateLabel} with {data.base.meta.sources.weather} weather. Uncoordinated → SunShift.</p>
            </dl>
          )}
        </div>
      )}

      {(phase === 'playing' || phase === 'paused' || phase === 'done') && (
        <footer className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-4 px-[var(--gutter)] pb-6">
          <button className="grid h-11 w-11 place-items-center rounded-full bg-ivory text-ink" onClick={togglePlay} aria-label={phase === 'playing' ? 'Pause demo' : phase === 'done' ? 'Replay demo' : 'Resume demo'}>
            {phase === 'playing' ? '❚❚' : phase === 'done' ? '↺' : '▶'}
          </button>
          <button className="kicker rounded-full px-3 py-2 text-ivory/70 hover:bg-ivory/10" onClick={() => go(-1)} aria-label="Previous scene">← Prev</button>
          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-ivory/15" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Demo progress">
            <div className="absolute inset-y-0 left-0 bg-sun" style={{ width: `${progress * 100}%` }} />
            {SCENES.slice(1).map((_, k) => (
              <span key={k} className="absolute inset-y-0 w-px bg-ink/70" style={{ left: `${(SCENES.slice(0, k + 1).reduce((a, s) => a + s.seconds, 0) / TOTAL) * 100}%` }} />
            ))}
          </div>
          <button className="kicker rounded-full px-3 py-2 text-ivory/70 hover:bg-ivory/10" onClick={() => go(1)} aria-label="Next scene">Next →</button>
          <span className="kicker num w-16 text-right text-ivory/60">{clockFromSlot(slotRef.current)}</span>
        </footer>
      )}
      <style>{`@keyframes demo-in { from { opacity: 0; transform: translateY(28px) } to { opacity: 1; transform: none } }`}</style>
    </div>
  )
}
