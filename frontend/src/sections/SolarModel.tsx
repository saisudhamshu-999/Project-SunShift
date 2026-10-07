import { LoadChart } from '@/components/charts/LoadChart'
import { Reveal } from '@/components/text/Reveal'
import { PlanBadges, PlanLoading } from '@/components/ui/PlanStatus'
import { clockFromSlot, fmt } from '@/lib/format'
import { useDayClock } from '@/lib/useDayClock'
import { usePlan } from '@/state/plan'
import { LazyCanvas } from '@/three/common/LazyCanvas'
import { PanelScene } from '@/three/scenes/PanelScene'
import { sunFromAngles } from '@/three/world/sun'

function Arrow() {
  return (
    <span aria-hidden className="mx-1 hidden text-[22px] opacity-30 sm:inline">
      →
    </span>
  )
}

export function SolarModel() {
  const plan = usePlan((s) => s.result)
  const clock = useDayClock({ initial: 25 })
  const i = clock.slot
  const s = plan?.solar
  const limit = plan?.feeder.limitKw ?? 60
  const grid = plan?.feeder.gridBackupKw ?? 0
  const solar = s?.acKw[i] ?? 0
  const demand = plan?.sunshift.loadKw[i] ?? 0
  const supplyCap = Math.min(limit, solar + grid)
  const remaining = supplyCap - demand
  const binding = solar + grid < limit ? 'solar (plus grid backup)' : 'the feeder limit'
  const sky = sunFromAngles(90 - (s?.zenith[i] ?? 40), s?.azimuth[i] ?? 140)
  const skyGradient = `linear-gradient(180deg, #${sky.skyTop.getHexString()} 0%, #${sky.skyHorizon.getHexString()} 62%, #cbb894 62.1%, #b9a37c 100%)`

  const chain = s
    ? [
        { k: 'GHI', v: fmt(s.ghi[i]), u: 'W/m²', note: 'sunlight on flat ground' },
        { k: 'POA', v: fmt(s.poa[i]), u: 'W/m²', note: `on panels tilted ${plan?.feeder.tiltDeg}° south` },
        { k: 'Cell', v: fmt(s.tcell[i], 1), u: '°C', note: 'hot cells lose output' },
        { k: 'DC', v: fmt(s.dcKw[i], 1), u: 'kW', note: `${fmt(plan?.feeder.pvKwp ?? 0)} kWp array` },
        { k: 'AC', v: fmt(s.acKw[i], 1), u: 'kW', note: 'after the inverter' },
      ]
    : []

  return (
    <section className="relative bg-ivory py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <p className="kicker text-sun">Step 04 · Solar model</p>
        <Reveal as="h2" className="t-display t-xl mt-6 max-w-[14ch]" split="words">
          Sunlight is not yet power.
        </Reveal>
        <p className="lede mt-6">
          The forecast says how much light reaches the ground. The feeder needs to know how much reaches the line. pvlib follows the light
          onto the tilted array, heats the cells, and runs it through the inverter, every 15 minutes.
        </p>

        <div className="mt-14 grid gap-8 lg:grid-cols-[1.25fr_1fr]">
          <LazyCanvas
            className="relative h-[380px] overflow-hidden rounded-[24px] md:h-[460px]"
            label={`Solar array under the sun at ${clockFromSlot(i)}`}
            fallback={<div className="absolute inset-0" />}
            camera={{ position: [6.5, 6.2, 10.5], fov: 40 }}
            gl={{ alpha: true, antialias: true }}
            style={{ position: 'absolute', inset: 0, background: skyGradient }}
          >
            {() => <PanelScene plan={plan} slot={clock.slotRef} />}
          </LazyCanvas>

          <div className="flex flex-col justify-center">
            <p className="kicker opacity-60">At {clockFromSlot(i)}</p>
            <ol className="mt-5 space-y-4">
              {chain.map((c, idx) => (
                <li key={c.k} className="flex items-baseline gap-4 border-b pb-3" style={{ borderColor: 'var(--line)' }}>
                  <span className="kicker w-12 shrink-0 text-sun">{c.k}</span>
                  <span className="num w-28 shrink-0 text-[30px] font-[620] leading-none tracking-[-0.03em]">
                    {c.v}
                    <span className="ml-1 text-[12px] font-[500] tracking-normal opacity-55">{c.u}</span>
                  </span>
                  <span className="text-[13px] opacity-60">{c.note}</span>
                  {idx < chain.length - 1 && <Arrow />}
                </li>
              ))}
            </ol>
            {!plan && <PlanLoading />}
          </div>
        </div>

        {plan && s && (
          <div className="mt-16 grid gap-10 lg:grid-cols-[1.7fr_1fr]">
            <div>
              <LoadChart
                title={`Solar power and scheduled pump load on ${plan.meta.dateLabel}`}
                solar={s.acKw}
                clearSky={s.clearSkyAcKw}
                load={plan.sunshift.loadKw}
                limit={limit}
                gridCap={grid}
                cursor={i}
                onCursor={(slot) => clock.setSlot(slot + 0.5)}
                height={300}
                showOverload={false}
                loadLabel="SunShift pump load"
              />
              <p className="mt-3 text-[13px] opacity-60">Drag across the chart (or focus it and use ← →). The dashed curve is the clear-sky potential.</p>
            </div>
            <div className="card self-start p-6">
              <p className="num t-display text-[56px] leading-none">{clockFromSlot(i)}</p>
              <dl className="mt-6 space-y-3 text-[15px]">
                {(
                  [
                    ['Solar available', `${fmt(solar, 1)} kW`],
                    ['Feeder capacity', `${fmt(limit, 0)} kW`],
                    ['Grid backup allowed', `${fmt(grid, 0)} kW`],
                    ['Current pump demand', `${fmt(demand, 1)} kW`],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 border-b pb-2" style={{ borderColor: 'var(--line)' }}>
                    <dt className="opacity-60">{k}</dt>
                    <dd className="num font-[600]">{v}</dd>
                  </div>
                ))}
                <div className="flex justify-between gap-4 pt-1">
                  <dt className="font-[600]">Remaining capacity</dt>
                  <dd className="num text-[22px] font-[650]" style={{ color: remaining < 3 ? '#d04a2f' : '#4c8a3b' }}>
                    {fmt(Math.max(0, remaining), 1)} kW
                  </dd>
                </div>
              </dl>
              <p className="mt-4 text-[12.5px] leading-relaxed opacity-60">At this moment the tighter limit is {binding}.</p>
              <PlanBadges plan={plan} className="mt-5" />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
