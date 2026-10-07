import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import * as api from '@/api/client'
import type { PlanRequest, PlanResult, RunRow } from '@/api/types'
import { Convergence } from '@/components/charts/Convergence'
import { Gantt, type GanttRow } from '@/components/charts/Gantt'
import { ConstraintMonitor } from '@/components/dashboard/ConstraintMonitor'
import { FarmLabelOverlay } from '@/components/dashboard/FarmLabelOverlay'
import { KpiStrip } from '@/components/dashboard/KpiStrip'
import { ScenarioControls } from '@/components/dashboard/ScenarioControls'
import { smsFor } from '@/components/farmer/messages'
import { LogoMark } from '@/components/layout/Logo'
import { FarmCard } from '@/components/ui/FarmCard'
import { SourceBadge } from '@/components/ui/SourceBadge'
import { Segmented, Working } from '@/components/ui/primitives'
import { clockFromSlot, fmt, pct } from '@/lib/format'
import { useIsMobile } from '@/lib/hooks'
import { sound } from '@/lib/sound'
import { useDayClock } from '@/lib/useDayClock'
import { LayerPanel } from '@/sections/DigitalTwin'
import { HeroPoster } from '@/sections/Hero'
import { usePlan } from '@/state/plan'
import { useUi } from '@/state/ui'
import { LazyCanvas } from '@/three/common/LazyCanvas'
import { useLabelRegistry } from '@/three/common/ProjectedLabels'
import { FeederScene, type TwinLayer } from '@/three/scenes/FeederScene'

const LAYERS: { value: TwinLayer; label: string }[] = [
  { value: 'solar', label: 'Solar' },
  { value: 'weather', label: 'Weather' },
  { value: 'water', label: 'Water' },
  { value: 'energy', label: 'Energy' },
  { value: 'farmers', label: 'Farmers' },
]

interface OpsEvent {
  at: string
  title: string
  detail: string
  tone: 'sun' | 'alert' | 'water'
}

function Header({ plan }: { plan: PlanResult | null }) {
  const status = usePlan((s) => s.status)
  const engine = usePlan((s) => s.engine)
  const run = usePlan((s) => s.run)
  const { sound: soundOn, toggleSound } = useUi()
  const live = plan?.meta.sources.weather === 'live' || plan?.meta.sources.weather === 'browser-live'
  return (
    <header className="sticky top-0 z-40 border-b border-ivory/10 bg-[#12110e]/90 backdrop-blur">
      <div className="wrap flex min-h-[64px] flex-wrap items-center justify-between gap-3 py-2">
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/" className="flex items-center gap-2.5" aria-label="Back to the SunShift story">
            <LogoMark ink="#f3eee4" />
            <span className="text-[14px] font-[680] tracking-[0.18em]">SUNSHIFT</span>
          </Link>
          <span className="h-5 w-px bg-ivory/20" aria-hidden />
          <span className="text-[14px] font-[620] tracking-[0.14em]">FEEDER 07</span>
          {plan &&
            (live ? (
              <span className="chip border-crop-2/50 text-crop-2">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-crop-2 opacity-70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-crop-2" />
                </span>
                Live weather
              </span>
            ) : (
              <SourceBadge kind={plan.meta.sources.weather} />
            ))}
          <span className="chip" style={{ borderStyle: 'dashed' }}>Simulated pumps</span>
          {plan && <span className="kicker num text-ivory/55">{plan.meta.dateLabel}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status === 'loading' ? (
            <Working label={engine === 'heuristic' ? 'Re-planning' : 'CP-SAT solving'} />
          ) : (
            plan && (
              <span className="kicker num text-ivory/55">
                {plan.meta.engine === 'cp-sat' ? `CP-SAT ${plan.sunshift.solver.status}` : 'Browser heuristic'} · {fmt(plan.sunshift.solver.wallTimeS, 2)} s
              </span>
            )
          )}
          <button className="btn h-9 border border-ivory/25 px-4 text-[13px] text-ivory hover:bg-ivory/10" onClick={() => void run()} disabled={status === 'loading'}>
            Re-optimise
          </button>
          <button className="btn h-9 px-3 text-[13px] text-ivory/70 hover:bg-ivory/10" onClick={toggleSound} aria-pressed={soundOn}>
            {soundOn ? 'Sound on' : 'Sound off'}
          </button>
          <Link to="/demo" className="btn btn-sun h-9 px-4 text-[13px]">
            Demo mode
          </Link>
        </div>
      </div>
    </header>
  )
}

function SolarStrip({ plan, cursor }: { plan: PlanResult; cursor: number }) {
  const max = Math.max(1, ...plan.solar.acKw)
  return (
    <div className="ml-[64px] flex h-12 items-end gap-[2px]" role="img" aria-label="Solar power by 15-minute slot">
      {plan.solar.acKw.map((v, i) => {
        const load = plan.sunshift.loadKw[i] ?? 0
        return (
          <span key={i} className="relative flex-1 rounded-t-[2px]" style={{ height: `${Math.max(3, (v / max) * 100)}%`, background: i === cursor ? '#ffc93c' : 'rgb(242 169 0 / 0.55)' }} title={`${clockFromSlot(i)}: ${fmt(v, 1)} kW solar, ${fmt(load, 1)} kW pumps`}>
            <span className="absolute inset-x-0 bottom-0 rounded-t-[2px] bg-ivory/70" style={{ height: `${Math.min(100, (load / Math.max(v, 1)) * 100)}%` }} />
          </span>
        )
      })}
    </div>
  )
}

function executedUntil(plan: PlanResult, slot: number, except?: number) {
  return Object.fromEntries(plan.farms.map((f) => [f.id, f.id === except ? f.schedule.slots.filter((s) => s < slot && s < (f.schedule.slots[0] ?? 0)) : f.schedule.slots.filter((s) => s < slot)]))
}

function Operations({ plan, slot, onEvent }: { plan: PlanResult; slot: number; onEvent: (e: OpsEvent) => void }) {
  const params = usePlan((s) => s.params)
  const adopt = usePlan((s) => s.adopt)
  const [busy, setBusy] = useState<string | null>(null)
  const running = plan.farms.filter((f) => f.schedule.slots.includes(slot))
  const victim = running[0]
  const at = clockFromSlot(slot)

  const replan = async (key: string, req: PlanRequest, describe: (next: PlanResult) => OpsEvent) => {
    setBusy(key)
    sound.click()
    try {
      const { data, engine } = await api.plan({ ...params, ...req, persist: true, timeLimitS: 2.5 })
      adopt(data, engine)
      onEvent(describe(data))
      sound.chime()
    } catch (e) {
      onEvent({ at, title: 'Re-plan failed', detail: String(e), tone: 'alert' })
    } finally {
      setBusy(null)
    }
  }
  const moved = (next: PlanResult) => next.farms.filter((f) => f.schedule.window !== plan.farms.find((p) => p.id === f.id)?.schedule.window).length
  const statusOf = (next: PlanResult) => (next.meta.engine === 'cp-sat' ? `CP-SAT ${next.sunshift.solver.status} in ${fmt(next.sunshift.solver.wallTimeS, 2)} s` : 'heuristic')

  return (
    <div className="space-y-5">
      <div>
        <p className="kicker text-ivory/50">Live operations · simulated telemetry</p>
        <p className="mt-3 text-[14px] text-ivory/70">
          At <span className="num text-ivory">{at}</span>: {running.length} pump{running.length === 1 ? '' : 's'} running, all reporting.
        </p>
      </div>
      <div className="grid gap-2">
        <button
          className="btn h-10 justify-start border border-ivory/20 px-4 text-[13.5px] text-ivory hover:bg-ivory/10 disabled:opacity-40"
          disabled={!!busy || slot >= 46}
          onClick={() =>
            void replan('cloud', { fixedUntil: slot, executed: executedUntil(plan, slot), solarEvent: { fromSlot: slot, factor: 0.5 } }, (next) => ({
              at,
              title: 'Cloud bank: solar −50%',
              detail: `Re-optimised from ${at} (${statusOf(next)}): ${moved(next)} windows changed, grid ${fmt(plan.sunshift.metrics.gridKwh, 1)} → ${fmt(next.sunshift.metrics.gridKwh, 1)} kWh.`,
              tone: 'sun',
            }))
          }
        >
          {busy === 'cloud' ? <Working label="Re-planning" /> : 'Cloud bank arrives now'}
        </button>
        <button
          className="btn h-10 justify-start border border-ivory/20 px-4 text-[13.5px] text-ivory hover:bg-ivory/10 disabled:opacity-40"
          disabled={!!busy || !victim}
          onClick={() =>
            victim &&
            void replan('fault', { fixedUntil: slot, executed: executedUntil(plan, slot, victim.id) }, (next) => {
              const after = next.farms.find((f) => f.id === victim.id)
              const later = after?.schedule.slots.filter((s) => s >= slot) ?? []
              return {
                at,
                title: `${victim.code} pump not responding`,
                detail: `No feedback since its start. Farmer called; ${victim.code} re-planned to ${later.length ? after!.schedule.window : 'tomorrow (no capacity left today)'}. ${statusOf(next)}.`,
                tone: 'alert',
              }
            })
          }
        >
          {busy === 'fault' ? <Working label="Re-planning" /> : victim ? `Pump fault: ${victim.code}` : 'Pump fault (no pump running)'}
        </button>
        <button
          className="btn h-10 justify-start border border-ivory/20 px-4 text-[13.5px] text-ivory hover:bg-ivory/10 disabled:opacity-40"
          disabled={!!busy || slot >= 40}
          onClick={() =>
            void replan('rain', { fixedUntil: slot, executed: executedUntil(plan, slot), weatherMode: 'rain', rainMm: 18, rainProb: 85, rainStartHour: Math.min(17, 6 + (slot + 8) / 4) }, (next) => ({
              at,
              title: 'Rain forecast: 18 mm in 2 h',
              detail: `${next.totals.farmsDeferred} farms deferred for rain; the day's pumped water ${fmt(plan.sunshift.metrics.waterM3)} → ${fmt(next.sunshift.metrics.waterM3)} m³. ${statusOf(next)}.`,
              tone: 'water',
            }))
          }
        >
          {busy === 'rain' ? <Working label="Re-planning" /> : 'Rain forecast arrives now'}
        </button>
      </div>
      <p className="text-[12px] leading-relaxed text-ivory/45">
        Each button keeps everything that already ran before {at} and re-optimises the rest of the day with the solver, exactly as the
        rolling re-plan would in the field.
      </p>
    </div>
  )
}

export default function LiveApp() {
  const plan = usePlan((s) => s.result)
  const ensure = usePlan((s) => s.ensure)
  const selected = useUi((s) => s.selectedFarm)
  const selectFarm = useUi((s) => s.selectFarm)
  const [layer, setLayer] = useState<TwinLayer>('energy')
  const [compare, setCompare] = useState<'sunshift' | 'uncoordinated'>('sunshift')
  const [events, setEvents] = useState<OpsEvent[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const labels = useLabelRegistry()
  const mobile = useIsMobile()
  const clock = useDayClock({ initial: 26, slotsPerSecond: 1.2 })
  const { setSlot } = clock
  useEffect(() => ensure(), [ensure])
  useEffect(() => {
    document.title = 'Feeder 07 · SunShift live feeder'
    return () => void (document.title = 'SunShift · Irrigation scheduling for the solar era')
  }, [])
  useEffect(() => {
    if (plan?.meta.nowSlot != null) setSlot(plan.meta.nowSlot + 0.5)
  }, [plan?.meta.nowSlot, setSlot])
  useEffect(() => {
    void api.runs(8).then(setRuns)
  }, [plan])

  const i = clock.slot
  const farm = plan?.farms.find((f) => f.id === selected) ?? null
  const rows: GanttRow[] = useMemo(
    () =>
      plan
        ? plan.farms.map((f) => {
            const slots = compare === 'sunshift' ? f.schedule.slots : f.uncoordinated.slots
            const over = new Set(plan.uncoordinated.metrics.series.overload.map((o, k) => (o ? k : -1)).filter((k) => k >= 0))
            return { id: f.id, code: f.code, crop: f.crop, slots, overloaded: compare === 'uncoordinated' ? new Set(slots.filter((s) => over.has(s))) : undefined, note: f.decision }
          })
        : [],
    [plan, compare],
  )
  const sms = farm ? smsFor(farm, 'en') : null

  return (
    <div data-theme="dark" className="theme-surface min-h-svh">
      <Header plan={plan} />
      <div className="wrap pb-20 pt-6">
        {!plan ? (
          <div className="grid min-h-[60svh] place-items-center">
            <Working label="Planning Feeder 07 with live weather" />
          </div>
        ) : (
          <>
            <KpiStrip plan={plan} slot={i} dark />

            <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_380px]">
              <div className="relative h-[62svh] min-h-[420px] overflow-hidden rounded-[22px] border border-ivory/10">
                <LazyCanvas className="absolute inset-0" label={`Live 3D map of Feeder 07 at ${clockFromSlot(i)}, ${layer} layer`} fallback={<HeroPoster />} camera={{ position: [36, 60, 78], fov: 38, near: 0.5, far: 2000 }} shadows margin="2000px 0px" keepAlive>
                  {(tier) => <FeederScene plan={plan} tier={tier} slot={clock.slotRef} mode={compare} selected={selected} onSelect={selectFarm} layer={layer} labels={mobile ? undefined : labels} />}
                </LazyCanvas>
                {!mobile && <FarmLabelOverlay plan={plan} registry={labels} slot={i} mode={compare} layer={layer} selected={selected} onSelect={selectFarm} />}
                <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="pointer-events-auto rounded-full bg-ink/70 p-1 backdrop-blur">
                    <Segmented<TwinLayer> label="Map layer" size="sm" value={layer} onChange={setLayer} options={LAYERS} />
                  </div>
                  <ul className="pointer-events-none flex flex-col gap-1 rounded-2xl bg-ink/70 p-3 text-[11px] backdrop-blur" aria-label="Map legend">
                    <li className="flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-[#ffbf2e]" /> Solar energy to running pumps</li>
                    <li className="flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-[#5dff8a]" /> Pump on</li>
                    <li className="flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-alert" /> Overload</li>
                    <li className="flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-water-2" /> Water in the field</li>
                  </ul>
                </div>
                <div className="absolute inset-x-0 bottom-0 flex items-center gap-4 bg-gradient-to-t from-ink/85 to-transparent p-4">
                  <button onClick={() => clock.setPlaying(!clock.playing)} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ivory text-ink" aria-label={clock.playing ? 'Pause' : 'Play the day'}>
                    {clock.playing ? '❚❚' : '▶'}
                  </button>
                  <label htmlFor="app-time" className="sr-only">Time of day</label>
                  <input id="app-time" type="range" min={0} max={47} value={i} onChange={(e) => clock.setSlot(Number(e.target.value) + 0.5)} className="range flex-1" style={{ ['--fg' as string]: '#f3eee4', ['--bg' as string]: '#15140f' }} />
                  <span className="num w-14 text-right text-[15px] font-[600]">{clockFromSlot(i)}</span>
                </div>
              </div>

              <aside className="space-y-6 rounded-[22px] border border-ivory/10 p-5" aria-label="Feeder status">
                <ConstraintMonitor plan={plan} slot={i} />
                <div className="border-t border-ivory/10 pt-5">
                  <p className="kicker text-ivory/50">{LAYERS.find((l) => l.value === layer)?.label} layer</p>
                  <div className="mt-3">
                    <LayerPanel plan={plan} layer={layer} slot={i} />
                  </div>
                </div>
              </aside>
            </div>

            <section className="mt-8 rounded-[22px] border border-ivory/10 p-5 md:p-6" aria-label="Today's schedule">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="kicker text-ivory/50">Today's schedule</p>
                  <p className="mt-1 text-[14px] text-ivory/70">{plan.totals.farmsScheduled} farms scheduled · {plan.totals.farmsDeferred} deferred for rain · peak {fmt(plan.sunshift.metrics.peakDemandKw, 1)} kW of {fmt(plan.feeder.limitKw)} kW</p>
                </div>
                <Segmented<'sunshift' | 'uncoordinated'> label="Compare" size="sm" value={compare} onChange={setCompare} options={[{ value: 'sunshift', label: 'SunShift' }, { value: 'uncoordinated', label: 'Uncoordinated' }]} />
              </div>
              <div className="mt-6 grid gap-8 xl:grid-cols-[1fr_380px]">
                <div className="min-w-0">
                  <SolarStrip plan={plan} cursor={i} />
                  <div className="mt-2">
                    <Gantt rows={rows} cursor={i} selected={selected} onSelect={selectFarm} barColor={compare === 'sunshift' ? '#f2a900' : '#f3eee4'} label="Pump schedule for all 20 farms" />
                  </div>
                </div>
                <div className="space-y-4">
                  {farm ? (
                    <>
                      <FarmCard farm={farm} onClose={() => selectFarm(null)} />
                      {sms && (
                        <div className="rounded-2xl bg-[#e9ecdc] p-4 text-ink">
                          <p className="kicker opacity-60">SMS to the farmer</p>
                          <div className="mt-2 space-y-0.5 text-[13px]">
                            {sms.lines.map((l, k) => (
                              <p key={k} className={k === 1 ? 'font-[700]' : ''}>{l}</p>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-[14px] text-ivory/55">Select a farmer in the schedule or on the map to see their plan, reasons and message.</p>
                  )}
                </div>
              </div>
            </section>

            <div className="mt-8 grid gap-6 lg:grid-cols-3">
              <section className="rounded-[22px] border border-ivory/10 p-5" aria-label="Live operations">
                <Operations plan={plan} slot={i} onEvent={(e) => setEvents((ev) => [e, ...ev].slice(0, 8))} />
                {events.length > 0 && (
                  <ol className="mt-5 space-y-3 border-t border-ivory/10 pt-4" aria-live="polite">
                    {events.map((e, k) => (
                      <li key={k} className="text-[13px]">
                        <p className="kicker" style={{ color: e.tone === 'alert' ? '#ef8a6c' : e.tone === 'water' ? '#6aa8e6' : '#f2a900' }}>
                          {e.at} · {e.title}
                        </p>
                        <p className="mt-1 text-ivory/65">{e.detail}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <section className="rounded-[22px] border border-ivory/10 p-5" aria-label="Scenario">
                <ScenarioControls compact />
              </section>
              <section className="space-y-5 rounded-[22px] border border-ivory/10 p-5" aria-label="Solver">
                <div>
                  <p className="kicker text-ivory/50">Solver</p>
                  <p className="mt-2 text-[14px] text-ivory/75">
                    {plan.meta.engine === 'cp-sat'
                      ? `${plan.sunshift.solver.solver} · ${plan.sunshift.solver.status} · ${fmt(plan.sunshift.solver.wallTimeS, 2)} s · gap ${pct(plan.sunshift.solver.gap, 2)} · ${fmt(plan.sunshift.solver.numBooleans)} decisions`
                      : plan.sunshift.solver.solver}
                  </p>
                  {plan.meta.engine === 'cp-sat' && (
                    <div className="mt-3">
                      <Convergence points={plan.sunshift.solver.convergence} timeLimit={plan.sunshift.solver.timeLimitS} />
                    </div>
                  )}
                </div>
                <div className="border-t border-ivory/10 pt-4">
                  <p className="kicker text-ivory/50">Recent runs (database)</p>
                  {runs.length ? (
                    <ul className="mt-3 space-y-1.5 text-[12.5px]">
                      {runs.map((r) => (
                        <li key={r.id} className="flex justify-between gap-3 text-ivory/70">
                          <span className="num">{new Date(r.createdAt.endsWith('Z') || r.createdAt.includes('+') ? r.createdAt : `${r.createdAt}Z`).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · {r.kind}</span>
                          <span className="num text-ivory/50">
                            {String((r.summary as Record<string, unknown>).status ?? '')} · {String((r.summary as Record<string, unknown>).binding ?? '')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-[12.5px] text-ivory/45">No runs recorded (database unavailable or browser fallback).</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <SourceBadge kind="simulation" />
                  <SourceBadge kind={plan.meta.sources.weather} />
                  <SourceBadge kind={plan.meta.engine === 'cp-sat' ? 'cp-sat' : 'heuristic'} />
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
