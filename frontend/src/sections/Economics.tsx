import { useEffect, useId, useRef, useState } from 'react'
import * as api from '@/api/client'
import type { PlanResult } from '@/api/types'
import { Reveal } from '@/components/text/Reveal'
import { PlanLoading } from '@/components/ui/PlanStatus'
import { Segmented } from '@/components/ui/primitives'
import { fmt } from '@/lib/format'
import { useInView } from '@/lib/hooks'
import { usePlan } from '@/state/plan'

interface Assumption {
  key: string
  label: string
  unit: string
  value: number
  step: number
  min: number
  note: string
}

// Illustrative defaults only: not quotes, tariffs or official figures. Every one is editable.
const DEFAULTS: Assumption[] = [
  { key: 'days', label: 'Irrigation days per year', unit: 'days', value: 180, step: 10, min: 0, note: 'days the feeder runs pumps on a schedule' },
  { key: 'supply', label: 'Cost of supplying farm power', unit: '₹/kWh', value: 7, step: 0.5, min: 0, note: "the DISCOM's or state's cost per grid kWh avoided" },
  { key: 'water', label: 'Value of water delivered', unit: '₹/m³', value: 0, step: 1, min: 0, note: 'groundwater has no market price; 0 counts none' },
  { key: 'sms', label: 'SMS price', unit: '₹/message', value: 0.25, step: 0.05, min: 0, note: 'bulk transactional SMS' },
  { key: 'smsPerDay', label: 'Messages per farmer per day', unit: 'messages', value: 2, step: 1, min: 0, note: 'schedule plus one reply or update' },
  { key: 'hosting', label: 'Server and support per feeder', unit: '₹/year', value: 12000, step: 1000, min: 0, note: 'hosting, monitoring and upkeep' },
  { key: 'kit', label: 'Pump controller kit per farm', unit: '₹', value: 7500, step: 500, min: 0, note: 'controller, relay, contactor, enclosure, fitting' },
  { key: 'life', label: 'Controller life', unit: 'years', value: 5, step: 1, min: 1, note: 'years to spread the kit cost over' },
  { key: 'dtFailures', label: 'Transformer failures avoided', unit: 'per year', value: 0, step: 0.5, min: 0, note: 'set from your feeder history; 0 counts none' },
  { key: 'dtCost', label: 'Cost of one transformer failure', unit: '₹', value: 150000, step: 10000, min: 0, note: 'repair or replacement, crew, downtime' },
]

const rupees = (v: number) => {
  const sign = v < 0 ? '−' : ''
  const a = Math.abs(v)
  return a >= 100000 ? `${sign}₹${fmt(a / 100000, 2)} lakh` : `${sign}₹${fmt(a)}`
}

function Field({ a, onChange }: { a: Assumption; onChange: (v: number) => void }) {
  const id = useId()
  return (
    <div className="rounded-2xl border border-ink/10 bg-paper p-4">
      <label htmlFor={id} className="kicker block text-ink/55">
        {a.label}
      </label>
      <div className="mt-2 flex items-baseline gap-2">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          className="num w-full min-w-0 rounded-lg border border-ink/15 bg-ivory px-2.5 py-1.5 text-[18px] font-[560] focus:border-ink/40"
          value={a.value}
          min={a.min}
          step={a.step}
          onChange={(e) => onChange(Math.max(a.min, Number(e.target.value) || 0))}
        />
        <span className="shrink-0 text-[13px] text-ink/55">{a.unit}</span>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-ink/50">{a.note}</p>
    </div>
  )
}

/** What SunShift is worth to a feeder: energy from today's plan, prices from editable assumptions. */
export function Economics() {
  const plan = usePlan((s) => s.result)
  const params = usePlan((s) => s.params)
  const ref = useRef<HTMLElement>(null)
  const near = useInView(ref, { margin: '600px 0px', once: true })
  const [mode, setMode] = useState<'solar' | 'backup'>('solar')
  const [solarOnly, setSolarOnly] = useState<PlanResult | null>(null)
  const key = JSON.stringify(params)
  // The same day on solar alone (no grid backup), as the impact table compares it.
  useEffect(() => {
    if (!near || !plan) return
    const ctrl = new AbortController()
    setSolarOnly(null)
    api.plan({ ...params, gridBackupKw: 0, persist: false, timeLimitS: 2.5 }, ctrl.signal).then((r) => setSolarOnly(r.data)).catch(() => undefined)
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, key, plan?.meta.createdAt])
  const [vals, setVals] = useState<Record<string, number>>(() => Object.fromEntries(DEFAULTS.map((a) => [a.key, a.value])))
  const v = (k: string) => vals[k] ?? 0

  const chosen = mode === 'solar' ? solarOnly : plan
  let body = <PlanLoading label={mode === 'solar' ? 'Planning the same day on solar alone' : undefined} />
  if (plan && chosen) {
    const u = plan.uncoordinated.metrics
    const s = chosen.sunshift.metrics
    const farms = plan.farms.length
    const gridSavedDay = u.gridKwh - s.gridKwh // negative when SunShift draws more to deliver more water
    const waterDay = s.waterM3 - u.waterM3
    const lostAvoidedDay = Math.max(0, u.curtailedKwh - s.curtailedKwh)
    const overloadMinutes = (u.overloadSlots - s.overloadSlots) * 15
    const energyValue = gridSavedDay * v('days') * v('supply')
    const waterValue = waterDay * v('days') * v('water')
    const dtValue = v('dtFailures') * v('dtCost')
    const value = energyValue + waterValue + dtValue
    const advisoryCost = farms * v('smsPerDay') * v('days') * v('sms') + v('hosting')
    const kitTotal = farms * v('kit')
    const automatedCost = advisoryCost + kitTotal / Math.max(1, v('life'))
    const paybackYears = value - advisoryCost > 0 ? kitTotal / (value - advisoryCost) : null
    const tiers = [
      { name: 'Advisory', detail: 'SMS schedules; farmers switch their own pumps', cost: advisoryCost, net: value - advisoryCost },
      { name: 'Automated', detail: `adds a controller at each pump (${rupees(kitTotal)} up front)`, cost: automatedCost, net: value - automatedCost },
    ]
    body = (
      <>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          <div className="rounded-[22px] bg-ink p-6 text-ivory">
            <p className="kicker text-ivory/55">{gridSavedDay >= 0 ? 'Grid energy avoided' : 'Extra grid energy'}</p>
            <p className="num mt-3 text-[34px] font-[620] leading-none">{fmt(Math.abs(gridSavedDay) * v('days'))} kWh</p>
            <p className="mt-2 text-[13px] text-ivory/60">
              per year: {fmt(Math.abs(gridSavedDay), 1)} kWh a day, and {waterDay >= 0 ? `${fmt(waterDay)} m³ more` : `${fmt(-waterDay)} m³ less`} water a day,
              against farmers pumping at their usual times
            </p>
          </div>
          <div className="rounded-[22px] bg-ink p-6 text-ivory">
            <p className="kicker text-ivory/55">Value to the feeder</p>
            <p className="num mt-3 text-[34px] font-[620] leading-none">{rupees(value)}</p>
            <p className="mt-2 text-[13px] text-ivory/60">
              per year: energy {rupees(energyValue)}
              {waterValue !== 0 && <>, water {rupees(waterValue)}</>}
              {dtValue > 0 && <>, transformer failures {rupees(dtValue)}</>}
            </p>
          </div>
          <div className="rounded-[22px] bg-ink p-6 text-ivory">
            <p className="kicker text-ivory/55">Automated tier pays back in</p>
            <p className="num mt-3 text-[34px] font-[620] leading-none">{paybackYears == null ? 'never' : `${fmt(paybackYears, 1)} years`}</p>
            <p className="mt-2 text-[13px] text-ivory/60">controller kits for {farms} farms, against the value left after running costs</p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {tiers.map((t) => (
            <div key={t.name} className="rounded-[22px] border border-ink/10 p-6">
              <p className="t-display t-s">{t.name}</p>
              <p className="mt-1 text-[13px] text-ink/55">{t.detail}</p>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-[14px]">
                <div>
                  <dt className="kicker text-ink/50">Cost per year</dt>
                  <dd className="num mt-1 text-[20px] font-[600]">{rupees(t.cost)}</dd>
                </div>
                <div>
                  <dt className="kicker text-ink/50">Net per year</dt>
                  <dd className={`num mt-1 text-[20px] font-[600] ${t.net >= 0 ? 'text-crop' : 'text-alert'}`}>{rupees(t.net)}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-ink/60">
          Also avoided today: {fmt(overloadMinutes)} minutes over the feeder limit and {fmt(lostAvoidedDay, 1)} kWh of pumping the overloaded line
          could not deliver. Not counted in rupees unless you price them: water, crop yield, motor wear, and farmers' time.
        </p>
      </>
    )
  }

  return (
    <section ref={ref} id="economics" className="relative bg-ivory py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <p className="kicker">The economics</p>
        <Reveal as="h2" className="t-display t-xl mt-6 max-w-[16ch]" split="words">
          What it is worth to a feeder.
        </Reveal>
        <p className="lede mt-6 max-w-[60ch]">
          Energy comes from today's plan for this feeder. Every price below is an illustrative default, not a quote or a tariff: replace it with
          your DISCOM's figures and the numbers update.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <span className="chip chip-wrap border-alert text-alert" style={{ borderStyle: 'dashed' }}>
            Simulated feeder · illustrative prices
          </span>
        </div>
        <div className="mt-8">
          <Segmented<'solar' | 'backup'>
            label="How SunShift runs the feeder"
            value={mode}
            onChange={setMode}
            options={[{ value: 'solar', label: 'Solar only: save grid energy' }, { value: 'backup', label: 'With grid backup: deliver more water' }]}
          />
        </div>
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {DEFAULTS.map((a) => (
            <Field key={a.key} a={{ ...a, value: v(a.key) }} onChange={(x) => setVals((cur) => ({ ...cur, [a.key]: x }))} />
          ))}
        </div>
        {body}
      </div>
    </section>
  )
}
