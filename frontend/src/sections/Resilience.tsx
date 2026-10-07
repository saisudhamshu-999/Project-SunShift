import { useState } from 'react'
import * as api from '@/api/client'
import type { PlanResult } from '@/api/types'
import { scrollToTarget } from '@/components/layout/SmoothScroll'
import { Reveal } from '@/components/text/Reveal'
import { Working } from '@/components/ui/primitives'
import { clockFromSlot, fmt, pct } from '@/lib/format'
import { usePlan } from '@/state/plan'

type DrillResult = { lines: string[]; engine: string }

interface Card {
  id: string
  problem: string
  response: string
  drill?: (base: PlanResult) => Promise<DrillResult>
  link?: string
  design?: boolean
}

const executedBefore = (base: PlanResult, slot: number, except?: number) =>
  Object.fromEntries(base.farms.map((f) => [f.id, f.id === except ? [] : f.schedule.slots.filter((s) => s < slot)]))

const CARDS: Card[] = [
  {
    id: 'weather',
    problem: 'Weather API fails',
    response: 'Use the last cached forecast; if there is none, monthly climatology. The plan says which.',
    drill: async () => {
      const { data, engine } = await api.plan({ failure: 'weather_api', persist: false, timeLimitS: 2 })
      return { engine, lines: [`Weather source: ${data.meta.sources.weather.toUpperCase()}`, data.meta.sources.weatherDetail, `Plan still produced: ${data.totals.farmsScheduled} farms scheduled, ${data.sunshift.solver.status}`] }
    },
  },
  {
    id: 'solar',
    problem: 'Solar forecast is wrong',
    response: 'At 11:30 actual output runs 45% below forecast. Keep what already ran; re-optimise the rest of the day.',
    drill: async (base) => {
      const { data, engine } = await api.plan({ failure: 'solar_forecast', fixedUntil: 22, executed: executedBefore(base, 22), persist: false, timeLimitS: 2.5 })
      const moved = data.farms.filter((f) => f.schedule.window !== base.farms.find((b) => b.id === f.id)?.schedule.window).length
      return {
        engine,
        lines: [
          `Re-planned from 11:30: ${moved} farm windows changed`,
          `Grid energy ${fmt(base.sunshift.metrics.gridKwh, 1)} → ${fmt(data.sunshift.metrics.gridKwh, 1)} kWh; water delivered ${pct(data.sunshift.metrics.adequacy)} of need`,
          `Binding constraint now: ${data.binding.constraint}`,
        ],
      }
    },
  },
  { id: 'rain', problem: 'Rain arrives', response: 'Cancel what the rain will do for free; keep water for crops that would stress before it lands.', link: '#rain' },
  {
    id: 'internet',
    problem: 'Internet fails',
    response: "Each controller holds the day's schedule and runs it locally; reports sync when the link returns. Without consent or controller, the SMS already sent still stands.",
    design: true,
  },
  {
    id: 'pump',
    problem: "A pump doesn't respond",
    response: 'Missing feedback is detected at the next check; the farmer is called, and the freed capacity goes to others.',
    drill: async (base) => {
      const at = 16
      const victim = base.farms.find((f) => f.schedule.slots.some((s) => s < at)) ?? base.farms.find((f) => f.schedule.slots.length)
      if (!victim) return { engine: '–', lines: ['No pump was scheduled before 10:00 today.'] }
      const { data, engine } = await api.plan({ fixedUntil: at, executed: executedBefore(base, at, victim.id), persist: false, timeLimitS: 2.5 })
      const after = data.farms.find((f) => f.id === victim.id)!
      return {
        engine,
        lines: [
          `${victim.code} did not start (planned ${victim.schedule.window})`,
          `Re-planned at ${clockFromSlot(at)}: ${victim.code} now ${after.schedule.slots.filter((s) => s >= at).length ? after.schedule.window : 'cannot be fitted today; priority rises tomorrow'}`,
          `Feeder still within ${fmt(data.feeder.limitKw)} kW: peak ${fmt(data.sunshift.metrics.peakDemandKw, 1)} kW`,
        ],
      }
    },
  },
  {
    id: 'capacity',
    problem: "Optimiser can't satisfy all demand",
    response: 'Guarantee every farm a fair floor first, then maximise the rest; carry shortfalls into tomorrow.',
    drill: async () => {
      const { data, engine } = await api.plan({ failure: 'capacity', weatherMode: 'cloudy', demandScale: 1.6, gridBackupKw: 0, persist: false, timeLimitS: 3 })
      const m = data.sunshift.metrics
      return {
        engine,
        lines: [
          `Demand ${fmt(data.totals.demandM3)} m³ vs ${fmt(data.solar.energyKwh)} kWh of sun`,
          `Delivered ${pct(m.adequacy)} of need; least-served farm ${pct(m.minServed)}`,
          data.sunshift.solver.phase1 ? `Fairness floor guaranteed by phase 1: ${pct(data.sunshift.solver.phase1.guaranteed)}` : `Fairness (Jain): ${fmt(m.fairnessJain, 2)}`,
        ],
      }
    },
  },
]

export function Resilience() {
  const plan = usePlan((s) => s.result)
  const [results, setResults] = useState<Record<string, DrillResult | 'busy' | string>>({})
  const run = async (c: Card) => {
    if (!c.drill || !plan) return
    setResults((r) => ({ ...r, [c.id]: 'busy' }))
    try {
      const res = await c.drill(plan)
      setResults((r) => ({ ...r, [c.id]: res }))
    } catch (e) {
      setResults((r) => ({ ...r, [c.id]: `Drill failed: ${String(e)}` }))
    }
  }
  return (
    <section id="resilience" className="relative bg-ivory py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <p className="kicker">Resilience</p>
        <Reveal as="h2" className="t-display t-xl mt-6 max-w-[16ch]" split="words">
          What happens when things go wrong?
        </Reveal>
        <p className="lede mt-6">Most of these are live drills: the button runs the real planner with the failure injected.</p>
        <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((c) => {
            const r = results[c.id]
            return (
              <article key={c.id} className="card flex flex-col p-6">
                <p className="kicker text-alert">If</p>
                <h3 className="mt-2 text-[22px] font-[640] tracking-[-0.02em]">{c.problem}</h3>
                <p className="kicker mt-5 text-crop">Then</p>
                <p className="mt-2 text-[15px] leading-relaxed opacity-75">{c.response}</p>
                <div className="mt-auto pt-6">
                  {c.drill && (
                    <button className="btn btn-ghost h-10 text-[14px]" onClick={() => void run(c)} disabled={!plan || r === 'busy'}>
                      {r === 'busy' ? <Working label="Running drill" /> : r ? 'Run again' : 'Run drill'}
                    </button>
                  )}
                  {c.link && (
                    <button className="btn btn-ghost h-10 text-[14px]" onClick={() => scrollToTarget(c.link!)}>
                      See it happen ↑
                    </button>
                  )}
                  {c.design && <span className="chip chip-wrap" style={{ borderStyle: 'dashed' }}>Controller design · not in this prototype</span>}
                  {r && r !== 'busy' && (
                    <div className="mt-4 rounded-xl bg-ink p-4 text-[13px] leading-relaxed text-ivory" aria-live="polite">
                      {typeof r === 'string' ? (
                        <p className="text-alert">{r}</p>
                      ) : (
                        <>
                          {r.lines.map((l) => (
                            <p key={l}>{l}</p>
                          ))}
                          <p className="kicker mt-2 text-ivory/50">{r.engine === 'cp-sat' ? 'Solved by CP-SAT' : r.engine === 'heuristic' ? 'Browser heuristic' : ''}</p>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}
