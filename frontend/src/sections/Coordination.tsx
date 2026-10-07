import { useEffect, useMemo, useRef, useState } from 'react'
import { Gantt, type GanttRow } from '@/components/charts/Gantt'
import { LoadChart } from '@/components/charts/LoadChart'
import { PlanBadges, PlanLoading } from '@/components/ui/PlanStatus'
import { Segmented } from '@/components/ui/primitives'
import { fmt, pct } from '@/lib/format'
import { useInView } from '@/lib/hooks'
import { sound } from '@/lib/sound'
import { useDayClock } from '@/lib/useDayClock'
import { usePlan } from '@/state/plan'

type Mode = 'uncoordinated' | 'coordinated'

function Bar({ label, value, max, display, tone, note }: { label: string; value: number; max: number; display: string; tone: 'alert' | 'sun' | 'ivory'; note?: string }) {
  const colors = { alert: '#d04a2f', sun: '#f2a900', ivory: '#f3eee4' }
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="kicker opacity-70">{label}</span>
        <span className="num text-[clamp(1.4rem,2.2vw,2rem)] font-[600] leading-none">{display}</span>
      </div>
      <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-ivory/10">
        <div className="h-full rounded-full transition-[width] duration-[1100ms] ease-[cubic-bezier(0.16,1,0.3,1)]" style={{ width: `${Math.max(2, Math.min(100, (value / max) * 100))}%`, background: colors[tone] }} />
      </div>
      {note && <p className="mt-2 text-[12.5px] text-ivory/55">{note}</p>}
    </div>
  )
}

export function Coordination() {
  const plan = usePlan((s) => s.result)
  const [mode, setMode] = useState<Mode>('uncoordinated')
  const ref = useRef<HTMLElement>(null)
  const inView = useInView(ref, { margin: '-20% 0px' })
  const clock = useDayClock({ initial: 4, slotsPerSecond: 3.2, autoplay: false })
  const { setPlaying } = clock
  useEffect(() => setPlaying(inView), [inView, setPlaying])

  const data = useMemo(() => {
    if (!plan) return null
    const coordinated = mode === 'coordinated'
    const m = coordinated ? plan.sunshift.metrics : plan.uncoordinated.metrics
    const overloadSet = new Set(m.series.overload.map((o, i) => (o ? i : -1)).filter((i) => i >= 0))
    const rows: GanttRow[] = plan.farms
      .filter((f) => f.requiredSlots > 0)
      .map((f) => {
        const slots = coordinated ? f.schedule.slots : f.uncoordinated.slots
        return { id: f.id, code: f.code, crop: f.crop, slots, overloaded: coordinated ? undefined : new Set(slots.filter((s) => overloadSet.has(s))) }
      })
    return { m, rows, load: m.series.demandKw }
  }, [plan, mode])

  const toggle = (v: Mode) => {
    setMode(v)
    if (v === 'coordinated') {
      sound.pumpStart()
      window.setTimeout(() => sound.chime(), 700)
    } else sound.click()
  }

  const unc = plan?.uncoordinated.metrics
  const sun = plan?.sunshift.metrics
  const limit = plan?.feeder.limitKw ?? 60
  const coordinated = mode === 'coordinated'

  return (
    <section ref={ref} id="coordination" data-theme="dark" className="theme-surface relative overflow-hidden py-[clamp(80px,11vw,170px)]">
      <div className="wrap">
        <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
          <div className="max-w-[16ch]">
            <p className="kicker text-sun">{coordinated ? 'With SunShift' : 'Without SunShift'}</p>
            <h2 className="t-display t-l mt-6" aria-live="polite">
              {coordinated ? (
                <>
                  Same water.
                  <br />
                  <span className="text-sun">Different timing.</span>
                </>
              ) : (
                <>
                  20 farmers.
                  <br />
                  20 switches.
                  <br />
                  <span className="text-alert">One line.</span>
                </>
              )}
            </h2>
          </div>
          <div className="max-w-md space-y-6">
            <p className="text-[clamp(1rem,1.25vw,1.15rem)] leading-relaxed text-ivory/70">
              {coordinated
                ? 'SunShift keeps every farm\'s water requirement and moves each pump into a window where the sun and the feeder can carry it.'
                : 'The same farms with the same water needs, but each farmer switches on at their usual time: most between 7 and 9 a.m., before the sun is strong.'}
            </p>
            <Segmented<Mode>
              label="Coordination mode"
              value={mode}
              onChange={toggle}
              options={[
                { value: 'uncoordinated', label: 'Uncoordinated' },
                { value: 'coordinated', label: 'Coordinated' },
              ]}
            />
          </div>
        </div>

        {!plan || !data || !unc || !sun ? (
          <div className="mt-16">
            <PlanLoading />
          </div>
        ) : (
          <>
            <div className="mt-14 grid gap-10 lg:grid-cols-[1.6fr_1fr]">
              <div>
                <LoadChart
                  title={`${coordinated ? 'Coordinated' : 'Uncoordinated'} pump load against solar supply on ${plan.meta.dateLabel}`}
                  solar={plan.solar.acKw}
                  load={data.load}
                  limit={limit}
                  height={320}
                  cursor={clock.slot}
                  loadLabel={coordinated ? 'Coordinated pump load' : 'Uncoordinated pump load'}
                />
              </div>
              <div className="flex flex-col justify-center gap-8">
                <Bar
                  label="Peak load"
                  value={data.m.peakDemandKw}
                  max={Math.max(unc.peakDemandKw, limit) * 1.1}
                  display={`${fmt(data.m.peakDemandKw, 1)} kW`}
                  tone={data.m.peakDemandKw > limit ? 'alert' : 'ivory'}
                  note={`Feeder limit ${fmt(limit)} kW`}
                />
                <Bar
                  label="Water that arrived"
                  value={data.m.adequacy}
                  max={1}
                  display={pct(data.m.adequacy, 1)}
                  tone={data.m.adequacy < 0.98 ? 'alert' : 'ivory'}
                  note={data.m.adequacy < 0.98 ? `${pct(1 - data.m.adequacy)} of the water requested never reached the fields` : 'Every farm received its requirement'}
                />
                <Bar
                  label="Solar energy put to work"
                  value={data.m.solarUsedKwh}
                  max={Math.max(unc.solarUsedKwh, sun.solarUsedKwh) * 1.05}
                  display={`${fmt(data.m.solarUsedKwh)} kWh`}
                  tone="sun"
                  note={`${fmt(data.m.gridKwh)} kWh from the grid${coordinated && sun.gridKwh > unc.gridKwh ? ', to deliver the water an overloaded feeder cannot' : ''}`}
                />
                <Bar
                  label="Conflict"
                  value={data.m.overloadSlots}
                  max={Math.max(1, unc.overloadSlots)}
                  display={data.m.overloadSlots ? `${fmt(data.m.overloadSlots * 15)} min` : 'None'}
                  tone="alert"
                  note={data.m.overloadSlots ? `${fmt(data.m.curtailedKwh, 1)} kWh the feeder could not deliver` : 'Load never exceeds the feeder limit'}
                />
              </div>
            </div>

            <div className="mt-14 grid gap-8 lg:grid-cols-[1fr_280px]">
              <Gantt rows={data.rows} cursor={clock.slot} label="Pump schedule by farm" barColor={coordinated ? '#f2a900' : '#f3eee4'} />
              <div className="space-y-5 text-[14px] leading-relaxed text-ivory/65">
                <p>
                  Each row is a farm that needs water today; each bar is its pump running.{' '}
                  {coordinated ? 'Gold bars are SunShift\'s windows.' : 'Red hatching marks slots where the feeder was overloaded.'}
                </p>
                <p className="kicker text-ivory/45">Both views use the same farms and the same requirements. Only timing changes.</p>
                <PlanBadges plan={plan} />
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
