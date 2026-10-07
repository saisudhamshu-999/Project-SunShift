import { useEffect, useRef, useState } from 'react'
import * as api from '@/api/client'
import type { Metrics, PlanResult } from '@/api/types'
import { Reveal } from '@/components/text/Reveal'
import { PlanBadges, PlanLoading } from '@/components/ui/PlanStatus'
import { ActLabel, Working } from '@/components/ui/primitives'
import { fmt, pct } from '@/lib/format'
import { useInView } from '@/lib/hooks'
import { usePlan } from '@/state/plan'

interface Row {
  label: string
  get: (m: Metrics) => number
  show: (v: number) => string
  better: 'lower' | 'higher'
  note: string
}

const ROWS: Row[] = [
  { label: 'Peak feeder load', get: (m) => m.peakDemandKw, show: (v) => `${fmt(v, 1)} kW`, better: 'lower', note: 'highest 15-minute demand on the line' },
  { label: 'Time over the feeder limit', get: (m) => m.overloadSlots * 15, show: (v) => (v ? `${fmt(v)} min` : 'none'), better: 'lower', note: 'minutes where the line was overloaded' },
  { label: 'Energy the feeder could not deliver', get: (m) => m.curtailedKwh, show: (v) => `${fmt(v, 1)} kWh`, better: 'lower', note: 'lost to trips and voltage collapse' },
  { label: 'Water requested that arrived', get: (m) => m.adequacy, show: (v) => pct(v, 1), better: 'higher', note: "share of today's agronomic requirement delivered" },
  { label: 'Solar energy put to work', get: (m) => m.solarUsedKwh, show: (v) => `${fmt(v)} kWh`, better: 'higher', note: 'plant output actually used by pumps on this feeder' },
  { label: 'Energy from the grid', get: (m) => m.gridKwh, show: (v) => `${fmt(v, 1)} kWh`, better: 'lower', note: 'daytime draw beyond solar' },
  { label: 'Water delivered', get: (m) => m.waterM3 * 1000, show: (v) => `${fmt(v)} L`, better: 'higher', note: 'pumped volume reaching the fields' },
  { label: 'Fairness (Jain index)', get: (m) => m.fairnessJain, show: (v) => fmt(v, 3), better: 'higher', note: '1.000 = every farm served the same share' },
]

export function Impact() {
  const plan = usePlan((s) => s.result)
  const params = usePlan((s) => s.params)
  const ref = useRef<HTMLElement>(null)
  const near = useInView(ref, { margin: '600px 0px', once: true })
  const [solarOnly, setSolarOnly] = useState<PlanResult | null>(null)
  const key = JSON.stringify(params)

  // Same day, same farms, but no grid backup at all: does SunShift still hold up?
  useEffect(() => {
    if (!near || !plan) return
    const ctrl = new AbortController()
    setSolarOnly(null)
    api
      .plan({ ...params, gridBackupKw: 0, persist: false, timeLimitS: 2.5 }, ctrl.signal)
      .then((r) => setSolarOnly(r.data))
      .catch(() => undefined)
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, key, plan?.meta.createdAt])

  const u = plan?.uncoordinated.metrics
  const s = plan?.sunshift.metrics
  return (
    <section ref={ref} id="impact" className="relative bg-paper py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <ActLabel act="IX" title="The impact" />
        <Reveal as="h2" className="t-display t-xl mt-8 max-w-[14ch]" split="words">
          Less waste. Better timing. Fairer access.
        </Reveal>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <span className="chip chip-wrap border-alert text-alert" style={{ borderStyle: 'dashed' }}>
            Demonstration simulation · not field measurements
          </span>
          <PlanBadges plan={plan} />
        </div>

        {!plan || !u || !s ? (
          <div className="mt-14">
            <PlanLoading />
          </div>
        ) : (
          <>
            <div className="mt-14 overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left">
                <caption className="sr-only">Today's plan on Feeder 07: uncoordinated pumping versus SunShift, same farms and requirements</caption>
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--line-2)' }}>
                    <th className="kicker py-4 pr-4 font-[500] opacity-60">{plan.meta.dateLabel} · Feeder 07</th>
                    <th className="kicker py-4 pr-4 text-right font-[500] opacity-60">Uncoordinated</th>
                    <th className="kicker py-4 pr-4 text-right font-[500]">SunShift</th>
                    <th className="kicker py-4 pr-4 text-right font-[500] opacity-60">Change</th>
                    <th className="kicker py-4 text-right font-[500] opacity-60">SunShift · solar-only</th>
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((r) => {
                    const a = r.get(u)
                    const b = r.get(s)
                    const c = solarOnly ? r.get(solarOnly.sunshift.metrics) : null
                    const improved = r.better === 'lower' ? b < a - 1e-9 : b > a + 1e-9
                    const same = Math.abs(a - b) < 1e-9
                    const delta = a !== 0 ? (b - a) / Math.abs(a) : 0
                    return (
                      <tr key={r.label} className="border-b align-baseline" style={{ borderColor: 'var(--line)' }}>
                        <th scope="row" className="py-4 pr-4 font-[500]">
                          <span className="block text-[16px]">{r.label}</span>
                          {' '}
                          <span className="block text-[12.5px] font-[400] opacity-55">{r.note}</span>
                        </th>
                        <td className="num py-4 pr-4 text-right text-[18px] opacity-70">{r.show(a)}</td>
                        <td className="num py-4 pr-4 text-right text-[20px] font-[640]">{r.show(b)}</td>
                        <td className="num py-4 pr-4 text-right text-[14px] font-[600]" style={{ color: same ? 'var(--fg-2)' : improved ? '#4c8a3b' : '#d04a2f' }}>
                          {same ? '—' : a === 0 ? (improved ? 'better' : 'worse') : `${delta > 0 ? '+' : ''}${pct(delta, 0)}`}
                        </td>
                        <td className="num py-4 text-right text-[17px] opacity-80">{c == null ? <span className="text-[12px] opacity-50">…</span> : r.show(c)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {!solarOnly && (
              <div className="mt-4">
                <Working label="Solving the solar-only variant" />
              </div>
            )}
            <div className="mt-10 grid gap-8 lg:grid-cols-3">
              <p className="text-[15px] leading-relaxed opacity-70">
                <strong className="font-[600] opacity-100">How to read this.</strong> All columns use the same farms and the same water requirements.
                "Uncoordinated" switches each pump on at the farmer's habitual time; SunShift chooses the time. This isolates the value of coordination.
              </p>
              <p className="text-[15px] leading-relaxed opacity-70">
                <strong className="font-[600] opacity-100">Why more grid energy?</strong> When SunShift draws more from the grid, it is to deliver the
                water an overloaded feeder fails to deliver. The solar-only column removes grid backup entirely: SunShift then runs on the sun alone
                {solarOnly ? `, delivers ${pct(solarOnly.sunshift.metrics.adequacy)} of requirement and never overloads the line.` : '.'}
              </p>
              <p className="text-[15px] leading-relaxed opacity-70">
                <strong className="font-[600] opacity-100">What it does not claim.</strong> Water and yield effects of better agronomy show up over weeks.
                Run a season below on replayed real weather, including the cases where SunShift uses more water because the crop needed it.
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
