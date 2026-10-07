import { useState } from 'react'
import * as api from '@/api/client'
import type { PlanResult, SensitivityResult } from '@/api/types'
import { Working } from '@/components/ui/primitives'
import { clockFromSlot, fmt } from '@/lib/format'
import { usePlan } from '@/state/plan'

const LABEL: Record<string, string> = { NONE: 'None: all demand fits', SOLAR: 'Solar availability', FEEDER: 'Feeder capacity', AVAILABILITY: 'Farmer availability' }

function Row({ label, used, cap, unit, tone, hot }: { label: string; used: number; cap: number; unit: string; tone: string; hot: boolean }) {
  const share = cap > 0 ? Math.min(1, used / cap) : 0
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className={`kicker ${hot ? '' : 'opacity-60'}`}>{label}</span>
        <span className="num text-[15px] font-[600]">
          {fmt(used, 0)} / {fmt(cap, 0)} {unit}
        </span>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${share * 100}%`, background: tone, opacity: hot ? 1 : 0.65 }} />
      </div>
    </div>
  )
}

/** Proves the system is solving something: what is tight right now, and which limit binds today. */
export function ConstraintMonitor({ plan, slot }: { plan: PlanResult; slot: number }) {
  const params = usePlan((s) => s.params)
  const [sens, setSens] = useState<SensitivityResult | null>(null)
  const [busy, setBusy] = useState(false)
  const solar = plan.solar.acKw[slot] ?? 0
  const load = plan.sunshift.loadKw[slot] ?? 0
  const limit = plan.feeder.limitKw
  const flag = plan.binding.slotFlags[slot]
  const scheduled = plan.farms.reduce((a, f) => a + Math.min(f.schedule.scheduledM3, f.volumeM3), 0)
  const test = async () => {
    setBusy(true)
    try {
      setSens((await api.sensitivity(params)).data)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-5">
      <div>
        <p className="kicker opacity-60">Binding constraint today</p>
        <p className="t-display mt-2 text-[28px] leading-none" style={{ color: plan.binding.constraint === 'NONE' ? '#4c8a3b' : '#d04a2f' }}>
          {LABEL[plan.binding.constraint]}
        </p>
        <p className="mt-2 text-[13px] leading-relaxed opacity-65">{plan.binding.detail}</p>
      </div>
      <p className="kicker num opacity-60">At {clockFromSlot(slot)}{flag ? ` · ${flag.toLowerCase()} is tight` : ''}</p>
      <Row label="Solar availability" used={Math.min(load, solar)} cap={solar} unit="kW" tone="#f2a900" hot={flag === 'SOLAR'} />
      <Row label="Feeder capacity" used={load} cap={limit} unit="kW" tone="#d04a2f" hot={flag === 'FEEDER'} />
      <Row label="Water demand (today)" used={scheduled} cap={plan.totals.demandM3} unit="m³" tone="#2f74c0" hot={plan.binding.constraint === 'NONE'} />
      <div className="border-t pt-4" style={{ borderColor: 'var(--line)' }}>
        <button className="kicker underline disabled:opacity-40" onClick={test} disabled={busy}>
          {busy ? <Working label="Relaxing each constraint" /> : 'Test it: relax each limit by 20% and re-solve'}
        </button>
        {sens && !busy && (
          <ul className="mt-3 space-y-1.5 text-[13px]">
            {sens.variants.map((v) => (
              <li key={v.key} className="flex justify-between gap-3">
                <span className={v.key === sens.binding ? 'font-[650]' : 'opacity-70'}>{v.label}</span>
                <span className="num">{v.serviceGainPct > 0.25 ? `+${fmt(v.serviceGainPct, 1)}% service · ${v.deltaM3 >= 0 ? '+' : ''}${fmt(v.deltaM3)} m³` : 'no gain'}</span>
              </li>
            ))}
            <li className="pt-1 text-[12px] opacity-60">
              {sens.binding === 'none' ? 'No relaxation helps: demand, not energy, is the limit.' : `Relaxing the ${sens.binding} helps most: it is the constraint actually binding.`}
            </li>
          </ul>
        )}
      </div>
    </div>
  )
}
