import { useEffect, useRef, useState } from 'react'
import * as api from '@/api/client'
import type { FairnessResult, PlanRequest } from '@/api/types'
import { Reveal } from '@/components/text/Reveal'
import { SourceBadge } from '@/components/ui/SourceBadge'
import { Segmented, Working } from '@/components/ui/primitives'
import { fmt, pct } from '@/lib/format'
import { useInView } from '@/lib/hooks'
import { CROP_COLOR } from '@/lib/palette'

const SCARCITY: PlanRequest = { weatherMode: 'heatwave', solarEvent: { fromSlot: 12, factor: 0.4 }, gridBackupKw: 0, timeLimitS: 3 }

type View = 'throughput' | 'fair'
type Day = 'yesterday' | 'today'

export function Fairness() {
  const ref = useRef<HTMLElement>(null)
  const near = useInView(ref, { margin: '1800px 0px', once: true })
  const [data, setData] = useState<FairnessResult | null>(null)
  const [engine, setEngine] = useState<'cp-sat' | 'heuristic' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('throughput')
  const [day, setDay] = useState<Day>('yesterday')

  useEffect(() => {
    if (!near || data) return
    const ctrl = new AbortController()
    api
      .fairness(SCARCITY, ctrl.signal)
      .then((r) => {
        setData(r.data)
        setEngine(r.engine)
      })
      .catch((e) => !ctrl.signal.aborted && setError(String(e)))
    return () => ctrl.abort()
  }, [near, data])

  const valueOf = (f: FairnessResult['farms'][number]) => (view === 'throughput' ? f.throughput : day === 'today' ? f.nextDay : f.fair)
  const summary = data ? (view === 'throughput' ? data.throughput : day === 'today' ? data.nextDay : data.fair) : null
  const rows = data ? [...data.farms].sort((a, b) => a.id - b.id) : []

  return (
    <section ref={ref} id="fairness" className="relative bg-sand py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <p className="kicker">Fairness</p>
        <Reveal as="h2" className="t-display t-xxl mt-6" split="words">
          Who gets the sun?
        </Reveal>
        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          <p className="lede text-ink/70">
            On a heatwave day when a cloud bank cuts the sun to 40% from 9 a.m., there is not enough solar for every pump. Maximising total
            water pumped would hand the sun to the biggest pumps. SunShift first guarantees everyone a fair floor, then maximises the rest.
          </p>
          <div className="flex flex-col items-start gap-4 lg:items-end">
            <Segmented<View>
              label="Allocation rule"
              value={view}
              onChange={setView}
              options={[
                { value: 'throughput', label: 'Maximise total water' },
                { value: 'fair', label: 'SunShift: fair' },
              ]}
            />
            <div className={view === 'fair' ? '' : 'pointer-events-none opacity-30'} aria-hidden={view !== 'fair'}>
              <Segmented<Day>
                label="Day"
                size="sm"
                value={day}
                onChange={setDay}
                options={[
                  { value: 'yesterday', label: 'Yesterday' },
                  { value: 'today', label: 'Today (shortfalls repaid)' },
                ]}
              />
            </div>
          </div>
        </div>

        {!data ? (
          <div className="mt-16">{error ? <p className="text-alert">Fairness study failed: {error}</p> : <Working label="Solving two allocations" />}</div>
        ) : (
          <>
            <div className="mt-14 grid gap-x-10 gap-y-2.5 md:grid-cols-2">
              {rows.map((f) => {
                const v = valueOf(f)
                const prev = view === 'fair' && day === 'today' ? f.fair : null
                return (
                  <div key={f.id} className="grid grid-cols-[64px_1fr_52px] items-center gap-3">
                    <span className="kicker num flex items-center gap-1.5">
                      <i className="h-1.5 w-1.5 rounded-full" style={{ background: CROP_COLOR[f.crop] }} aria-hidden />
                      {f.code}
                    </span>
                    <span className="relative h-3 rounded-full bg-ink/10" role="meter" aria-label={`${f.code} received`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
                      <span
                        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-[1100ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                        style={{ width: `${Math.max(1.5, v * 100)}%`, background: v < 0.05 ? '#d04a2f' : view === 'fair' ? '#15140f' : '#8a8270' }}
                      />
                      {prev != null && <span className="absolute -top-1 h-5 w-0.5 bg-sun" style={{ left: `${prev * 100}%` }} title="yesterday" />}
                    </span>
                    <span className="num text-right text-[14px] font-[600]" style={{ color: v < 0.05 ? '#d04a2f' : undefined }}>
                      {pct(v)}
                    </span>
                  </div>
                )
              })}
            </div>
            {summary && (
              <div className="mt-14 grid grid-cols-2 gap-6 border-t pt-8 sm:grid-cols-4" style={{ borderColor: 'var(--line-2)' }}>
                <div>
                  <p className="kicker opacity-55">Water delivered</p>
                  <p className="num mt-1 text-[30px] font-[620]">{fmt(summary.waterM3)} m³</p>
                </div>
                <div>
                  <p className="kicker opacity-55">Least-served farm</p>
                  <p className="num mt-1 text-[30px] font-[620]" style={{ color: summary.minServed < 0.05 ? '#d04a2f' : undefined }}>{pct(summary.minServed)}</p>
                </div>
                <div>
                  <p className="kicker opacity-55">Fairness (Jain index)</p>
                  <p className="num mt-1 text-[30px] font-[620]">{fmt(summary.jain, 2)}</p>
                </div>
                <div>
                  <p className="kicker opacity-55">{view === 'fair' && day === 'today' ? 'Two-day floor' : 'Solver'}</p>
                  <p className="num mt-1 text-[30px] font-[620]">
                    {view === 'fair' && day === 'today' ? pct(data.twoDay.minServed) : engine === 'cp-sat' ? summary.status : 'Heuristic'}
                  </p>
                </div>
              </div>
            )}
            <p className="mt-8 max-w-3xl text-[15px] leading-relaxed text-ink/70">
              {view === 'throughput'
                ? `Maximising raw throughput delivers ${fmt(data.throughput.waterM3)} m³ but its least-served farm gets ${pct(data.throughput.minServed)}.`
                : day === 'yesterday'
                  ? `SunShift delivers ${fmt(data.fair.waterM3)} m³ (${pct(1 - data.fair.waterM3 / Math.max(1, data.throughput.waterM3))} less) and lifts the least-served farm to ${pct(data.fair.minServed)}.`
                  : `The next day, farms that received less carry a fairness debt into the solver. Gold ticks show yesterday; over two days the least-served farm reaches ${pct(data.twoDay.minServed)}.`}{' '}
              <strong className="font-[600]">The optimiser doesn't choose winners. It manages scarcity fairly.</strong>
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <SourceBadge kind="simulation" />
              <SourceBadge kind={engine === 'heuristic' ? 'heuristic' : 'cp-sat'} />
              <span className="chip chip-wrap">Scenario: heatwave + cloud bank · solar only</span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
