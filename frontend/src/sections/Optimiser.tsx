import { useEffect, useMemo, useState } from 'react'
import type { PlanResult } from '@/api/types'
import { Convergence } from '@/components/charts/Convergence'
import { PlanBadges } from '@/components/ui/PlanStatus'
import { ActLabel, Working } from '@/components/ui/primitives'
import { Reveal } from '@/components/text/Reveal'
import { clockFromSlot, fmt, pct } from '@/lib/format'
import { PRIORITY_COLOR } from '@/lib/palette'
import { sound } from '@/lib/sound'
import { usePlan } from '@/state/plan'
import { useUi } from '@/state/ui'

const LEVEL_COLOR: Record<string, string> = {
  LOW: '#a59d8a', MODERATE: '#6aa8e6', HIGH: '#f2a900', SEVERE: '#d04a2f', CRITICAL: '#d04a2f',
  AVAILABLE: '#84b85c', TIGHT: '#d04a2f', BOOST: '#f2a900', MEDIUM: '#6aa8e6',
}

/** 20 x 48 decision grid: every cell is one CP-SAT boolean (pump on in that slot). */
function DecisionGrid({ plan, solving, revealKey }: { plan: PlanResult; solving: boolean; revealKey: number }) {
  const rows = plan.farms
  return (
    <div className="relative" role="img" aria-label="Decision grid: one row per farm, one column per 15-minute slot; lit cells are scheduled pump slots">
      <div className="grid gap-[3px]" style={{ gridTemplateRows: `repeat(${rows.length}, 1fr)` }}>
        {rows.map((f, r) => {
          const on = new Set(f.schedule.slots)
          return (
            <div key={`${f.id}-${revealKey}`} className="grid gap-[2px]" style={{ gridTemplateColumns: 'repeat(48, 1fr)' }}>
              {Array.from({ length: 48 }, (_, c) => {
                const lit = on.has(c)
                return (
                  <span
                    key={c}
                    className="aspect-square rounded-[2px]"
                    style={{
                      background: solving ? '#f3eee4' : lit ? '#f2a900' : 'rgb(243 238 228 / 0.07)',
                      opacity: solving ? undefined : 1,
                      animation: solving
                        ? `search-flicker ${0.6 + ((r * 7 + c * 13) % 9) / 10}s ${((r * 31 + c * 17) % 23) / 23}s infinite alternate`
                        : lit
                          ? `cell-in .5s ${0.04 * r + c * 0.004}s both`
                          : undefined,
                    }}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
      <style>{`
        @keyframes search-flicker { from { opacity: .04 } to { opacity: .55 } }
        @keyframes cell-in { from { opacity: 0; transform: scale(.3) } to { opacity: 1; transform: scale(1) } }
      `}</style>
    </div>
  )
}

export function Optimiser() {
  const plan = usePlan((s) => s.result)
  const status = usePlan((s) => s.status)
  const run = usePlan((s) => s.run)
  const engine = usePlan((s) => s.engine)
  const selected = useUi((s) => s.selectedFarm)
  const selectFarm = useUi((s) => s.selectFarm)
  const [revealKey, setRevealKey] = useState(0)
  const [ran, setRan] = useState(false)
  const solving = status === 'loading'
  useEffect(() => {
    if (status === 'ready' && ran) {
      setRevealKey((k) => k + 1)
      sound.chime()
    }
  }, [status, ran])

  const farm = plan?.farms.find((f) => f.id === selected) ?? plan?.farms.find((f) => f.schedule.slots.length > 0) ?? null
  const scheduled = useMemo(() => (plan ? plan.farms.filter((f) => f.schedule.slots.length).sort((a, b) => a.schedule.slots[0] - b.schedule.slots[0]) : []), [plan])
  const solver = plan?.sunshift.solver
  const restricted = plan ? plan.farms.filter((f) => !(f.available.length === 1 && f.available[0][0] <= 6 && f.available[0][1] >= 18)).length : 0
  const isCp = plan?.meta.engine === 'cp-sat' && engine !== 'heuristic'

  const inputs = plan
    ? [
        ['Farms', `${plan.farms.length}`, `${plan.totals.farmsNeeding} need water today`],
        ['Time slots', '48', '15 minutes each, 06:00–18:00'],
        ['Solar forecast', `${fmt(plan.solar.energyKwh)} kWh`, `peak ${fmt(plan.solar.peakKw, 1)} kW AC`],
        ['Feeder limit', `${fmt(plan.feeder.limitKw)} kW`, `+ ${fmt(plan.feeder.gridBackupKw)} kW grid backup allowed`],
        ['Crop demand', `${fmt(plan.totals.demandM3)} m³`, 'FAO-56 requirement, after rain'],
        ['Pump constraints', '≥30 min', `per run · ≤${plan.feeder.maxStarts} starts/day · no over-irrigation`],
        ['Farmer availability', `${restricted}`, 'farmers with restricted windows'],
        ['Fairness', '2-day', 'max-min floor, shortfalls repaid'],
      ]
    : []

  return (
    <section id="simulation" data-theme="dark" className="theme-surface relative overflow-hidden py-[clamp(80px,11vw,170px)]">
      <div className="wrap">
        <ActLabel act="VI" title="The optimiser" />
        <h2 className="t-display t-xl mt-8 max-w-[18ch]">
          <Reveal as="span" className="block" split="words">
            The hard part isn't predicting.
          </Reveal>
          {' '}
          <Reveal as="span" className="block text-sun" split="words" delay={0.2}>
            It's deciding.
          </Reveal>
        </h2>
        <p className="lede mt-8 text-ivory/65">
          Every morning SunShift solves a constrained optimisation problem with Google OR-Tools CP-SAT: which pump runs in which quarter-hour,
          so that the crops that need water most get it, nobody is left behind, and the feeder never breaks its limit.
        </p>

        <div className="mt-16 grid gap-10 lg:grid-cols-[270px_1fr] xl:grid-cols-[280px_1fr_300px]">
          <div>
            <p className="kicker text-ivory/50">What goes in</p>
            <dl className="mt-5 divide-y divide-ivory/10">
              {inputs.map(([k, v, note]) => (
                <div key={k} className="py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-[14px] text-ivory/70">{k}</dt>
                    <dd className="num text-[20px] font-[600]">{v}</dd>
                  </div>
                  <p className="text-[12px] text-ivory/40">{note}</p>
                </div>
              ))}
            </dl>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <button
                className="btn btn-sun h-14 px-7 text-[16px]"
                onClick={() => {
                  setRan(true)
                  sound.click()
                  void run()
                }}
                disabled={solving}
              >
                {solving ? 'Solving…' : isCp || !plan ? 'Run CP-SAT now' : 'Re-run (browser heuristic)'}
              </button>
              {solving ? (
                <Working label="CP-SAT searching" />
              ) : solver ? (
                <p className="kicker num text-ivory/60">
                  {isCp ? solver.status : 'HEURISTIC'} · {fmt(solver.wallTimeS, 2)} s{isCp && solver.gap > 0 ? ` · gap ${pct(solver.gap, 2)}` : ''}
                </p>
              ) : null}
            </div>
            <div className="mt-6">{plan && <DecisionGrid plan={plan} solving={solving} revealKey={revealKey} />}</div>
            {plan && (
              <div className="mt-2 flex justify-between kicker num text-ivory/40">
                <span>06:00</span>
                <span>12:00</span>
                <span>18:00</span>
              </div>
            )}
            {solver && isCp && (
              <div className="mt-8 grid gap-6 sm:grid-cols-2">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
                  {(
                    [
                      ['Decisions', fmt(solver.numBooleans)],
                      ['Constraints', fmt(solver.numConstraints)],
                      ['Improving solutions', fmt(solver.convergence.filter((c) => (c.phase ?? 2) === 2).length)],
                      ['Optimality gap', solver.gap < 1e-6 ? '0 (proven)' : pct(solver.gap, 2)],
                      ['Fairness floor', solver.phase1 ? pct(solver.phase1.guaranteed, 1) : '–'],
                      ['vs greedy warm start', solver.improvementOverWarmStart != null ? `+${pct(Math.max(0, solver.improvementOverWarmStart), 2)}` : '–'],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k}>
                      <dt className="kicker text-ivory/45">{k}</dt>
                      <dd className="num text-[18px] font-[600]">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div>
                  <p className="kicker text-ivory/45">Improving solutions</p>
                  <div className="mt-2">
                    <Convergence points={solver.convergence} timeLimit={solver.timeLimitS} />
                  </div>
                </div>
              </div>
            )}
            {plan && !isCp && (
              <p className="mt-6 rounded-xl border border-alert/50 p-4 text-[13.5px] text-ivory/75">
                The CP-SAT API is not reachable from this page, so this schedule comes from SunShift's greedy fallback heuristic. It respects
                every hard constraint but is not proven optimal.
              </p>
            )}
          </div>

          <div className="lg:col-span-2 xl:col-span-1">
            <p className="kicker text-ivory/50">What comes out</p>
            <ol className="mt-5 max-h-[420px] space-y-1.5 overflow-y-auto pr-2 lg:grid lg:max-h-none lg:grid-cols-2 lg:gap-x-10 lg:space-y-0 xl:block xl:max-h-[420px] xl:space-y-1.5" data-lenis-prevent>
              {scheduled.map((f, k) => (
                <li key={`${f.id}-${revealKey}`} className="num flex items-baseline justify-between gap-3 text-[14px]" style={{ animation: `cell-in .4s ${k * 0.05}s both` }}>
                  <button className="text-left hover:text-sun" onClick={() => selectFarm(f.id)}>
                    Farm {f.code.slice(1)} →
                  </button>
                  <span className="text-ivory/80">{f.schedule.window}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        {farm && (
          <div className="mt-20 grid gap-10 border-t border-ivory/10 pt-14 lg:grid-cols-[1fr_1.3fr]">
            <div>
              <p className="kicker text-sun">Explainable by design</p>
              <h3 className="t-display t-m mt-4">Why was Farm {farm.code.slice(1)} {farm.schedule.slots.length ? 'scheduled' : 'not scheduled'}?</h3>
              <p className="mt-5 max-w-md text-[15px] leading-relaxed text-ivory/65">
                Each farm's weight in the objective comes from transparent agronomic factors. The same numbers that drive the decision explain it.
              </p>
              <label className="mt-6 block max-w-xs">
                <span className="kicker text-ivory/50">Farm</span>
                <select
                  className="mt-2 block w-full rounded-xl border border-ivory/20 bg-transparent px-3 py-2.5 text-[15px]"
                  value={farm.id}
                  onChange={(e) => selectFarm(Number(e.target.value))}
                >
                  {plan?.farms.map((f) => (
                    <option key={f.id} value={f.id} className="text-ink">
                      {f.code} · {f.cropLabel} · {f.priority.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="panel-dark p-6 md:p-8">
              <div className="flex items-baseline justify-between gap-4">
                <p className="kicker text-ivory/50">Farm {farm.code.slice(1)} · {farm.cropLabel}</p>
                <p className="num kicker text-ivory/50">{farm.schedule.window || 'no window'}</p>
              </div>
              <dl className="mt-5 space-y-3">
                {farm.reasons.map((r) => (
                  <div key={r.factor} className="grid grid-cols-[150px_110px_1fr] items-baseline gap-3 border-b border-ivory/10 pb-3 max-sm:grid-cols-[1fr_auto]">
                    <dt className="text-[14px] text-ivory/75">{r.factor}</dt>
                    <dd className="kicker font-[600]" style={{ color: r.factor === 'Priority' ? PRIORITY_COLOR[r.level] : LEVEL_COLOR[r.level] ?? '#f3eee4' }}>
                      {r.level}
                    </dd>
                    <dd className="text-[12.5px] text-ivory/50 max-sm:col-span-2">{r.detail}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-5 text-[14px] text-ivory/80">{farm.decision}</p>
              {farm.schedule.slots.length > 0 && (
                <p className="mt-2 text-[12.5px] text-ivory/45">
                  Starts {clockFromSlot(farm.schedule.slots[0])} · {fmt(farm.schedule.scheduledM3)} m³ scheduled of {fmt(farm.volumeM3)} m³ needed
                </p>
              )}
              <PlanBadges plan={plan} className="mt-6" />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
