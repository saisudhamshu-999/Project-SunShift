import type { PlanResult } from '@/api/types'
import { fmt, pct } from '@/lib/format'

/** Live KPIs for the cursor slot and the day; every value comes from the plan. */
export function KpiStrip({ plan, slot, dark = false }: { plan: PlanResult; slot: number; dark?: boolean }) {
  const m = plan.sunshift.metrics
  const u = plan.uncoordinated.metrics
  const reduction = u.peakDemandKw > 0 ? 1 - m.peakDemandKw / u.peakDemandKw : 0
  const coordinated = plan.farms.filter((f) => f.requiredSlots > 0 || f.deferred).length
  const items: [string, string, string][] = [
    ['Solar available', `${fmt(plan.solar.acKw[slot] ?? 0, 1)} kW`, `${fmt(plan.solar.energyKwh)} kWh today`],
    ['Feeder load', `${fmt(plan.sunshift.loadKw[slot] ?? 0, 1)} kW`, `limit ${fmt(plan.feeder.limitKw)} kW`],
    ['Water scheduled', `${fmt(m.waterM3 * 1000)} L`, `${pct(m.adequacy)} of requirement`],
    ['Peak reduction', pct(reduction, 1), `${fmt(u.peakDemandKw, 1)} → ${fmt(m.peakDemandKw, 1)} kW`],
    ['Farmers coordinated', `${coordinated} / ${plan.farms.length}`, `${plan.totals.farmsDeferred} deferred for rain`],
  ]
  return (
    <dl className={`grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5 ${dark ? 'text-ivory' : ''}`}>
      {items.map(([k, v, sub]) => (
        <div key={k} className="min-w-0">
          <dt className="kicker opacity-55">{k}</dt>
          <dd className="num mt-1.5 truncate text-[clamp(1.4rem,2.2vw,2rem)] font-[620] leading-none tracking-[-0.03em]">{v}</dd>
          <dd className="mt-1 truncate text-[12px] opacity-55">{sub}</dd>
        </div>
      ))}
    </dl>
  )
}
