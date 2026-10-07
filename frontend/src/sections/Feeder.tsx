import { useMemo } from 'react'
import { FarmLabelOverlay } from '@/components/dashboard/FarmLabelOverlay'
import { FarmCard } from '@/components/ui/FarmCard'
import { PlanBadges, PlanLoading } from '@/components/ui/PlanStatus'
import { ActLabel } from '@/components/ui/primitives'
import { Reveal } from '@/components/text/Reveal'
import { CROP_TAG } from '@/lib/palette'
import { clockFromSlot, fmt } from '@/lib/format'
import { useIsMobile } from '@/lib/hooks'
import { useDayClock } from '@/lib/useDayClock'
import { usePlan } from '@/state/plan'
import { useUi } from '@/state/ui'
import { LazyCanvas } from '@/three/common/LazyCanvas'
import { useLabelRegistry } from '@/three/common/ProjectedLabels'
import { FeederScene } from '@/three/scenes/FeederScene'
import { HeroPoster } from './Hero'

export function TwinPoster() {
  return <HeroPoster />
}

export function Feeder() {
  const plan = usePlan((s) => s.result)
  const selected = useUi((s) => s.selectedFarm)
  const selectFarm = useUi((s) => s.selectFarm)
  const mobile = useIsMobile()
  const clock = useDayClock({ initial: 26, autoplay: false })
  const labels = useLabelRegistry()
  const farm = plan?.farms.find((f) => f.id === selected) ?? null
  const i = clock.slot
  const running = useMemo(() => (plan ? plan.farms.filter((f) => f.schedule.slots.includes(i)).length : 0), [plan, i])

  return (
    <section id="feeder" className="relative bg-ivory py-[clamp(80px,12vw,180px)] text-ink" data-theme="light">
      <div className="wrap grid gap-10 lg:grid-cols-[1.25fr_1fr] lg:items-end">
        <div>
          <ActLabel act="III" title="The feeder" />
          <Reveal as="h2" className="t-display t-xl mt-8" split="words">
            {`${plan?.farms.length ?? 20} farms. One feeder. One sun.`}
          </Reveal>
        </div>
        <div className="space-y-6">
          <p className="lede">
            Feeder 07 is a simulated solarised agricultural feeder near Warangal. Every plot below is a real input to the optimiser: its crop,
            its soil, its pump and its water balance.
          </p>
          {plan ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              {[
                ['Solar plant', `${fmt(plan.feeder.pvKwp)} kWp`],
                ['Feeder limit', `${fmt(plan.feeder.limitKw)} kW`],
                ['Pump load', `${fmt(plan.feeder.connectedLoadKw)} kW`],
                ['Irrigated', `${fmt(plan.farms.reduce((a, f) => a + f.areaHa, 0), 1)} ha`],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="kicker opacity-55">{k}</dt>
                  <dd className="num mt-1 text-[22px] font-[600]">{v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <PlanLoading />
          )}
          <PlanBadges plan={plan} />
        </div>
      </div>

      <div className="mt-14 px-[max(8px,calc(var(--gutter)-16px))]">
        <div className="relative h-[68svh] min-h-[440px] overflow-hidden rounded-[28px] bg-[#c9b48d] md:h-[82svh]">
          <LazyCanvas
            className="absolute inset-0"
            label="Interactive 3D map of Feeder 07: twenty farm plots, the solar plant, transformer and feeder lines. Running pumps glow; select a farm from the list below the map."
            fallback={<TwinPoster />}
            camera={{ position: [42, 64, 86], fov: 38, near: 0.5, far: 2000 }}
            shadows
          >
            {(tier) => <FeederScene plan={plan} tier={tier} slot={clock.slotRef} selected={selected} onSelect={selectFarm} labels={mobile ? undefined : labels} />}
          </LazyCanvas>
          {!mobile && <FarmLabelOverlay plan={plan} registry={labels} slot={i} selected={selected} onSelect={selectFarm} />}

          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-4 md:p-6">
            <span className="kicker rounded-full bg-ivory/85 px-3 py-1.5 backdrop-blur">{mobile ? 'Tap a plot' : 'Drag to orbit · click a plot'}</span>
            <span className="kicker num rounded-full bg-ink px-3 py-1.5 text-ivory">
              {clockFromSlot(i)} · {running} pump{running === 1 ? '' : 's'} on
            </span>
          </div>

          {farm && !mobile && (
            <div className="absolute right-4 top-16 w-[340px] md:right-6">
              <FarmCard farm={farm} onClose={() => selectFarm(null)} />
            </div>
          )}

          <div className="absolute inset-x-0 bottom-0 flex items-center gap-4 bg-gradient-to-t from-ink/60 to-transparent p-4 text-ivory md:p-6">
            <button
              onClick={() => clock.setPlaying(!clock.playing)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ivory text-ink"
              aria-label={clock.playing ? 'Pause the day' : 'Play the day'}
            >
              {clock.playing ? (
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><rect x="2" y="1" width="3.5" height="12" rx="1" fill="currentColor" /><rect x="8.5" y="1" width="3.5" height="12" rx="1" fill="currentColor" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M3 1.5v11l9-5.5z" fill="currentColor" /></svg>
              )}
            </button>
            <label className="sr-only" htmlFor="feeder-time">Time of day</label>
            <input
              id="feeder-time"
              type="range"
              min={0}
              max={47}
              value={i}
              onChange={(e) => clock.setSlot(Number(e.target.value) + 0.5)}
              className="range flex-1 [--line-2:rgb(243_238_228/0.4)]"
              style={{ ['--fg' as string]: '#f3eee4', ['--bg' as string]: '#15140f' }}
            />
            <span className="num w-14 shrink-0 text-right text-[15px] font-[560]">{clockFromSlot(i)}</span>
          </div>
        </div>

        {farm && mobile && (
          <div className="mt-4">
            <FarmCard farm={farm} onClose={() => selectFarm(null)} />
          </div>
        )}

        <div className="wrap mt-6 px-0">
          <p className="kicker opacity-55">Farms on this feeder</p>
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {(plan?.farms ?? []).map((f) => (
              <li key={f.id}>
                <button
                  onClick={() => selectFarm(f.id)}
                  aria-pressed={selected === f.id}
                  className={`kicker rounded-full border px-3 py-1.5 transition-colors ${selected === f.id ? 'border-ink bg-ink text-ivory' : 'hover:bg-ink/5'}`}
                  style={{ borderColor: selected === f.id ? undefined : 'var(--line-2)' }}
                >
                  {f.code} <span className="opacity-50">{CROP_TAG[f.crop]}</span>
                  {f.schedule.slots.includes(i) && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-sun align-middle" aria-label="pump running" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
