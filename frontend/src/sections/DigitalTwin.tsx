import { useMemo, useState } from 'react'
import type { PlanResult } from '@/api/types'
import { ConstraintMonitor } from '@/components/dashboard/ConstraintMonitor'
import { FarmLabelOverlay } from '@/components/dashboard/FarmLabelOverlay'
import { KpiStrip } from '@/components/dashboard/KpiStrip'
import { ScenarioControls } from '@/components/dashboard/ScenarioControls'
import { Reveal } from '@/components/text/Reveal'
import { PlanBadges, PlanLoading } from '@/components/ui/PlanStatus'
import { SourceBadge } from '@/components/ui/SourceBadge'
import { Segmented } from '@/components/ui/primitives'
import { clockFromSlot, fmt } from '@/lib/format'
import { useIsMobile } from '@/lib/hooks'
import { CROP_COLOR } from '@/lib/palette'
import { useDayClock } from '@/lib/useDayClock'
import { usePlan } from '@/state/plan'
import { useUi } from '@/state/ui'
import { LazyCanvas } from '@/three/common/LazyCanvas'
import { useLabelRegistry } from '@/three/common/ProjectedLabels'
import { FeederScene, type TwinLayer } from '@/three/scenes/FeederScene'
import { HeroPoster } from './Hero'

const LAYERS: { value: TwinLayer; label: string }[] = [
  { value: 'solar', label: 'Solar' },
  { value: 'weather', label: 'Weather' },
  { value: 'water', label: 'Water' },
  { value: 'energy', label: 'Energy' },
  { value: 'farmers', label: 'Farmers' },
]

export function LayerPanel({ plan, layer, slot }: { plan: PlanResult; layer: TwinLayer; slot: number }) {
  const w = plan.weather
  const running = plan.farms.filter((f) => f.schedule.slots.includes(slot))
  const next = plan.farms
    .map((f) => ({ f, s: f.schedule.slots.find((x) => x > slot) }))
    .filter((x) => x.s != null && !x.f.schedule.slots.includes(slot))
    .sort((a, b) => (a.s ?? 0) - (b.s ?? 0))
    .slice(0, 4)
  if (layer === 'solar')
    return (
      <div className="space-y-3 text-[14px]">
        <p className="num text-[34px] font-[620] leading-none">{fmt(plan.solar.acKw[slot], 1)} <span className="text-[14px] opacity-60">kW now</span></p>
        <p className="opacity-70">{fmt(plan.feeder.pvKwp)} kWp array · {fmt(plan.solar.energyKwh)} kWh today ({fmt((plan.solar.energyKwh / Math.max(1, plan.solar.clearSkyEnergyKwh)) * 100)}% of clear-sky potential)</p>
        <p className="opacity-70">Sun {fmt(plan.solar.elevation[slot], 1)}° above the horizon · cells at {fmt(plan.solar.tcell[slot], 1)} °C</p>
      </div>
    )
  if (layer === 'weather')
    return (
      <div className="space-y-3 text-[14px]">
        <SourceBadge kind={w.source} />
        <dl className="grid grid-cols-2 gap-3">
          {(
            [
              ['Temperature', `${fmt(w.daily.tmin, 1)}–${fmt(w.daily.tmax, 1)} °C`],
              ['Humidity', `${w.daily.rhMin}–${w.daily.rhMax}%`],
              ['Wind (2 m)', `${fmt(w.daily.u2, 1)} m/s`],
              ['Rain chance', `${w.daily.lookaheadRainProb}%`],
              ['Rain expected', `${fmt(w.daily.lookaheadRainMm, 1)} mm`],
              ['ET₀', `${fmt(w.daily.et0, 2)} mm`],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="kicker opacity-50">{k}</dt>
              <dd className="num font-[600]">{v}</dd>
            </div>
          ))}
        </dl>
        {plan.meta.notes.map((n) => (
          <p key={n} className="text-[12.5px] opacity-60">{n}</p>
        ))}
      </div>
    )
  if (layer === 'water')
    return (
      <ul className="space-y-2">
        {[...plan.farms].sort((a, b) => a.soilWaterPct - b.soilWaterPct).slice(0, 7).map((f) => (
          <li key={f.id} className="grid grid-cols-[48px_1fr_44px] items-center gap-3 text-[13px]">
            <span className="kicker num">{f.code}</span>
            <span className="h-2 overflow-hidden rounded-full bg-ivory/10">
              <span className="block h-full rounded-full" style={{ width: `${f.soilWaterPct}%`, background: f.status === 'STRESS' ? '#d04a2f' : f.status === 'WATCH' ? '#f2a900' : '#6aa8e6' }} />
            </span>
            <span className="num text-right">{fmt(f.soilWaterPct)}%</span>
          </li>
        ))}
        <li className="pt-1 text-[12px] opacity-55">Root-zone water as a share of what the soil can hold. Driest farms first.</li>
      </ul>
    )
  if (layer === 'energy') {
    const load = plan.sunshift.loadKw[slot] ?? 0
    const grid = plan.sunshift.gridKw[slot] ?? 0
    return (
      <div className="space-y-3 text-[14px]">
        <p className="num text-[34px] font-[620] leading-none">{fmt(load, 1)} <span className="text-[14px] opacity-60">/ {fmt(plan.feeder.limitKw)} kW</span></p>
        <p className="opacity-70">{grid > 0.05 ? `${fmt(grid, 1)} kW from the grid right now` : 'Fully on solar right now'} · peak today {fmt(plan.sunshift.metrics.peakDemandKw, 1)} kW</p>
        <p className="opacity-70">Gold particles follow the feeder from the substation to every running pump.</p>
      </div>
    )
  }
  return (
    <div className="space-y-4 text-[13.5px]">
      <div>
        <p className="kicker opacity-50">Running at {clockFromSlot(slot)}</p>
        <p className="mt-1">{running.length ? running.map((f) => f.code).join(' · ') : 'No pumps running'}</p>
      </div>
      <div>
        <p className="kicker opacity-50">Next starts</p>
        <ul className="mt-1 space-y-1">
          {next.map(({ f, s }) => (
            <li key={f.id} className="flex justify-between">
              <span>
                <i className="mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: CROP_COLOR[f.crop] }} aria-hidden />
                {f.code} · {f.cropLabel}
              </span>
              <span className="num">{clockFromSlot(s!)}</span>
            </li>
          ))}
          {!next.length && <li className="opacity-55">No more starts today</li>}
        </ul>
      </div>
    </div>
  )
}

export function DigitalTwin() {
  const plan = usePlan((s) => s.result)
  const selected = useUi((s) => s.selectedFarm)
  const selectFarm = useUi((s) => s.selectFarm)
  const [layer, setLayer] = useState<TwinLayer>('energy')
  const clock = useDayClock({ initial: 24, slotsPerSecond: 2 })
  const mobile = useIsMobile()
  const labels = useLabelRegistry()
  const i = clock.slot
  const label = useMemo(() => `Digital twin of Feeder 07 at ${clockFromSlot(i)}, showing the ${layer} layer`, [i, layer])

  return (
    <section id="twin" data-theme="dark" className="theme-surface relative">
      <div className="wrap pt-[clamp(80px,11vw,170px)]">
        <p className="kicker text-sun">Digital twin</p>
        <Reveal as="h2" className="t-display t-xl mt-6 max-w-[14ch]" split="words">
          A feeder you can see.
        </Reveal>
        <p className="lede mt-6 text-ivory/65">Every plot, pump and conductor is the optimiser's model, driven by its schedule. Change the scenario and CP-SAT re-plans the whole page.</p>
      </div>

      <div className="mt-12 grid lg:h-[100svh] lg:grid-cols-[1fr_380px]">
        <div className="relative h-[68svh] min-h-[440px] lg:h-full">
          <LazyCanvas className="absolute inset-0" label={label} fallback={<HeroPoster />} camera={{ position: [36, 58, 80], fov: 38, near: 0.5, far: 2000 }} shadows>
            {(tier) => <FeederScene plan={plan} tier={tier} slot={clock.slotRef} selected={selected} onSelect={selectFarm} layer={layer} labels={mobile ? undefined : labels} autoRotate={clock.playing} />}
          </LazyCanvas>
          {!mobile && <FarmLabelOverlay plan={plan} registry={labels} slot={i} layer={layer} selected={selected} onSelect={selectFarm} />}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-4 md:p-6">
            <div className="pointer-events-auto rounded-full bg-ink/70 p-1 backdrop-blur">
              <Segmented<TwinLayer> label="Twin layer" size="sm" value={layer} onChange={setLayer} options={LAYERS} />
            </div>
            <span className="kicker num rounded-full bg-ink/70 px-3 py-2 backdrop-blur">{clockFromSlot(i)}</span>
          </div>
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-4 bg-gradient-to-t from-ink/80 to-transparent p-4 md:p-6">
            <button onClick={() => clock.setPlaying(!clock.playing)} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ivory text-ink" aria-label={clock.playing ? 'Pause' : 'Play the day'}>
              {clock.playing ? (
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><rect x="2" y="1" width="3.5" height="12" rx="1" fill="currentColor" /><rect x="8.5" y="1" width="3.5" height="12" rx="1" fill="currentColor" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M3 1.5v11l9-5.5z" fill="currentColor" /></svg>
              )}
            </button>
            <label htmlFor="twin-time" className="sr-only">Time of day</label>
            <input id="twin-time" type="range" min={0} max={47} value={i} onChange={(e) => clock.setSlot(Number(e.target.value) + 0.5)} className="range flex-1" style={{ ['--fg' as string]: '#f3eee4', ['--bg' as string]: '#15140f' }} />
          </div>
        </div>
        <aside className="space-y-8 border-ivory/10 p-[var(--gutter)] lg:overflow-y-auto lg:border-l lg:p-7" data-lenis-prevent aria-label="Twin controls">
          {plan ? (
            <>
              <div>
                <p className="kicker text-ivory/50">{LAYERS.find((l) => l.value === layer)?.label} layer</p>
                <div className="mt-4">
                  <LayerPanel plan={plan} layer={layer} slot={i} />
                </div>
              </div>
              <div className="border-t border-ivory/10 pt-6">
                <ScenarioControls compact />
              </div>
              <div className="border-t border-ivory/10 pt-6">
                <ConstraintMonitor plan={plan} slot={i} />
              </div>
              <PlanBadges plan={plan} />
            </>
          ) : (
            <PlanLoading />
          )}
        </aside>
      </div>
      {plan && (
        <div className="wrap border-t border-ivory/10 py-10">
          <KpiStrip plan={plan} slot={i} dark />
        </div>
      )}
    </section>
  )
}
