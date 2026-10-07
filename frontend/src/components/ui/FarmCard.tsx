import type { FarmPlan } from '@/api/types'
import { fmt } from '@/lib/format'
import { CROP_COLOR, PRIORITY_COLOR } from '@/lib/palette'

/** The farm fact sheet shown when a plot is selected. Every value comes from the plan. */
export function FarmCard({ farm, onClose, compact = false }: { farm: FarmPlan; onClose?: () => void; compact?: boolean }) {
  const rows: [string, string][] = [
    ['Crop', `${farm.cropLabel} · ${farm.stageLabel}`],
    ['Area', `${fmt(farm.areaHa, 1)} ha`],
    ['Soil', farm.soilLabel],
    ['Pump', `${fmt(farm.pumpHp, farm.pumpHp % 1 ? 1 : 0)} HP · ${fmt(farm.pumpKw, 1)} kW · ~${fmt(farm.flowM3h, 1)} m³/h`],
    ['Irrigation', `${farm.methodLabel} (${fmt(farm.efficiency * 100)}% efficient)`],
  ]
  const urgency = farm.priority.label
  return (
    <article className="card w-full p-5 text-ink shadow-[0_24px_60px_-28px_rgba(21,20,15,0.45)]" aria-label={`Farm ${farm.code} details`}>
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="kicker opacity-60">Farm</p>
          <p className="t-display text-[44px] leading-none">{farm.code.replace('F', '')}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className="chip" style={{ borderColor: CROP_COLOR[farm.crop], color: 'inherit' }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: CROP_COLOR[farm.crop] }} />
            {farm.cropLabel}
          </span>
          {onClose && (
            <button onClick={onClose} className="kicker opacity-60 hover:opacity-100" aria-label="Close farm details">
              Close ×
            </button>
          )}
        </div>
      </header>
      {!compact && (
        <dl className="mt-4 divide-y" style={{ borderColor: 'var(--line)' }}>
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-6 py-2 text-[13.5px]" style={{ borderColor: 'var(--line)' }}>
              <dt className="opacity-55">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-4 grid grid-cols-3 gap-3 border-t pt-4" style={{ borderColor: 'var(--line)' }}>
        <div>
          <p className="kicker opacity-55">Soil water</p>
          <p className="num mt-1 text-[22px] font-[600] leading-none">{fmt(farm.soilWaterPct)}%</p>
          <p className="mt-1 text-[11px] opacity-55">{fmt(farm.drStart)} / {fmt(farm.taw)} mm depleted</p>
        </div>
        <div>
          <p className="kicker opacity-55">Need today</p>
          <p className="num mt-1 text-[22px] font-[600] leading-none">
            {fmt(farm.volumeM3)}
            <span className="text-[12px] opacity-60"> m³</span>
          </p>
          <p className="mt-1 text-[11px] opacity-55">{farm.deferred ? 'deferred for rain' : `${fmt(farm.pumpHours, 1)} h of pumping`}</p>
        </div>
        <div>
          <p className="kicker opacity-55">Urgency</p>
          <p className="mt-1 text-[22px] font-[650] leading-none" style={{ color: PRIORITY_COLOR[urgency] }}>
            {urgency}
          </p>
          <p className="mt-1 text-[11px] opacity-55">score {fmt(farm.priority.score, 2)}</p>
        </div>
      </div>
      <p className="mt-4 rounded-xl bg-ink px-3.5 py-2.5 text-[13px] leading-snug text-ivory">
        <span className="kicker mr-2 text-sun">Plan</span>
        {farm.decision}
      </p>
    </article>
  )
}
