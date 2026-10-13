import { useMemo, useRef, useState } from 'react'
import * as api from '@/api/client'
import type { SeasonEvent, SeasonSummary } from '@/api/types'
import { SeasonChart } from '@/components/charts/SeasonChart'
import { Reveal } from '@/components/text/Reveal'
import { SourceBadge } from '@/components/ui/SourceBadge'
import { Segmented, Slider, Working } from '@/components/ui/primitives'
import { POLICY, SEASONS } from '@/engine/scenario'
import { fmt, pct } from '@/lib/format'
import { sound } from '@/lib/sound'

type DayEv = Extract<SeasonEvent, { type: 'day' }>
type MetaEv = Extract<SeasonEvent, { type: 'meta' }>
type SumEv = Extract<SeasonEvent, { type: 'summary' }>

const cumulative = (vals: number[]) => vals.reduce<number[]>((acc, v) => [...acc, (acc[acc.length - 1] ?? 0) + v], [])

const SUMMARY_ROWS: { k: keyof SeasonSummary; label: string; show: (v: number) => string; better: 'lower' | 'higher' | 'neutral' }[] = [
  // Neutral: pumping more is right when the baseline was under-watering the crop.
  { k: 'waterM3', label: 'Water pumped', show: (v) => `${fmt(v)} m³`, better: 'neutral' },
  { k: 'energyKwh', label: 'Pump energy', show: (v) => `${fmt(v)} kWh`, better: 'neutral' },
  { k: 'gridKwh', label: 'Energy from the grid', show: (v) => `${fmt(v)} kWh`, better: 'lower' },
  { k: 'solarShare', label: 'Pumping on solar', show: (v) => pct(v, 1), better: 'higher' },
  { k: 'overloadSlots', label: 'Feeder overload', show: (v) => `${fmt(v * 15)} min`, better: 'lower' },
  { k: 'deepPercolationM3', label: 'Water lost below roots', show: (v) => `${fmt(v)} m³`, better: 'lower' },
  { k: 'stressFarmDays', label: 'Crop stress (farm-days)', show: (v) => fmt(v), better: 'lower' },
  { k: 'relativeYield', label: 'Relative yield index', show: (v) => fmt(v, 3), better: 'higher' },
  { k: 'fairnessJain', label: 'Fairness (Jain)', show: (v) => fmt(v, 3), better: 'higher' },
]

export function Season() {
  const [season, setSeason] = useState(SEASONS[0].id)
  const [length, setLength] = useState<'7' | '30' | '90'>('30')
  const [factor, setFactor] = useState(POLICY.bau.factor)
  const [meta, setMeta] = useState<MetaEv | null>(null)
  const [days, setDays] = useState<DayEv[]>([])
  const [summary, setSummary] = useState<SumEv | null>(null)
  const [running, setRunning] = useState(false)
  const [engine, setEngine] = useState<'cp-sat' | 'heuristic' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ctrl = useRef<AbortController | null>(null)

  const run = async () => {
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    setDays([])
    setSummary(null)
    setMeta(null)
    setError(null)
    setRunning(true)
    sound.click()
    try {
      const eng = await api.season({ season, days: Number(length), bauFactor: factor }, (e) => {
        if (e.type === 'meta') setMeta(e)
        else if (e.type === 'day') setDays((d) => [...d, e])
        else if (e.type === 'summary') {
          setSummary(e)
          sound.chime()
        } else if (e.type === 'error') setError(e.message)
      }, c.signal)
      setEngine(eng)
    } catch (e) {
      if (!c.signal.aborted) setError(String(e))
    } finally {
      setRunning(false)
    }
  }
  const stop = () => {
    ctrl.current?.abort()
    setRunning(false)
  }

  const total = meta?.days ?? Number(length)
  const series = useMemo(() => {
    const pick = (f: (d: DayEv) => [number, number]) => {
      const pairs = days.map(f)
      return { ss: cumulative(pairs.map((p) => p[0])), bau: cumulative(pairs.map((p) => p[1])) }
    }
    return {
      water: pick((d) => [d.sunshift.waterM3, d.bau.waterM3]),
      energy: pick((d) => [d.sunshift.energyKwh, d.bau.energyKwh]),
      grid: pick((d) => [d.sunshift.gridKwh, d.bau.gridKwh]),
      overload: pick((d) => [d.sunshift.overloadSlots * 15, d.bau.overloadSlots * 15]),
      stress: pick((d) => [d.sunshift.stressFarms, d.bau.stressFarms]),
      waste: pick((d) => [d.sunshift.deepPercolationM3, d.bau.deepPercolationM3]),
    }
  }, [days])
  const last = days[days.length - 1]
  const fin = (k: keyof SeasonSummary, scale = 1): [number, number] | undefined =>
    summary ? [Number(summary.sunshift[k]) * scale, Number(summary.bau[k]) * scale] : undefined
  const maxRain = Math.max(5, ...days.map((d) => d.rainMm))

  return (
    <section id="season" data-theme="dark" className="theme-surface relative py-[clamp(80px,11vw,170px)]">
      <div className="wrap">
        <p className="kicker text-sun">Season simulation</p>
        <Reveal as="h2" className="t-display t-xxl mt-6" split="chars">
          Run a season.
        </Reveal>
        <p className="lede mt-6 text-ivory/65">
          Replay real weather (ERA5 reanalysis) over the feeder. Each morning SunShift plans on a forecast with realistic error and CP-SAT
          schedules the day; the day is then executed against what actually happened. A business-as-usual baseline lives through the same
          weather, soils and feeder.
        </p>

        <div className="mt-12 grid gap-8 lg:grid-cols-[auto_auto_1fr_auto] lg:items-end">
          <div>
            <p className="kicker text-ivory/50">Season</p>
            <div className="mt-3">
              <Segmented label="Season" size="sm" value={season} onChange={setSeason} options={SEASONS.map((s) => ({ value: s.id, label: s.label }))} />
            </div>
          </div>
          <div>
            <p className="kicker text-ivory/50">Length</p>
            <div className="mt-3">
              <Segmented<'7' | '30' | '90'> label="Length in days" size="sm" value={length} onChange={setLength} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
            </div>
          </div>
          <div className="max-w-sm">
            <Slider label="Baseline over-application" value={factor} min={1} max={1.6} step={0.05} unit="× crop need" format={(v) => v.toFixed(2)} onChange={setFactor} hint="How much more than the crop needs farmers apply today. Adjustable because it varies by place." />
          </div>
          <div className="flex gap-2">
            {running ? (
              <button className="btn btn-ghost h-12" onClick={stop}>
                Stop
              </button>
            ) : (
              <button className="btn btn-sun h-12 px-6" onClick={() => void run()}>
                Run {length} days
              </button>
            )}
          </div>
        </div>
        <p className="mt-4 text-[13px] text-ivory/45">{SEASONS.find((s) => s.id === season)?.note}. Starts {SEASONS.find((s) => s.id === season)?.start}.</p>

        {(running || days.length > 0) && (
          <div className="mt-12 rounded-[22px] border border-ivory/10 p-5 md:p-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="kicker num text-ivory/70">
                Day {days.length} / {total}
                {last ? ` · ${last.date} · ET₀ ${fmt(last.et0, 1)} mm · rain ${fmt(last.rainMm, 1)} mm · solar ${fmt(last.solarKwh)} kWh` : ''}
              </p>
              {running ? <Working label={engine === 'heuristic' ? 'Simulating (browser)' : 'Simulating with CP-SAT'} /> : summary && <p className="kicker num text-ivory/50">done in {fmt(summary.elapsedS, 1)} s</p>}
            </div>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-ivory/10">
              <div className="h-full bg-sun transition-[width] duration-300" style={{ width: `${(days.length / Math.max(1, total)) * 100}%` }} />
            </div>

            <div className="mt-8 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              <SeasonChart dark final={fin('waterM3')} title="Water pumped" unit="m³" ss={series.water.ss} bau={series.water.bau} days={total} better="neutral" />
              <SeasonChart dark final={fin('energyKwh')} title="Pump energy" unit="kWh" ss={series.energy.ss} bau={series.energy.bau} days={total} better="neutral" />
              <SeasonChart dark final={fin('gridKwh')} title="Energy from the grid" unit="kWh" ss={series.grid.ss} bau={series.grid.bau} days={total} better="lower" />
              <SeasonChart dark final={fin('overloadSlots', 15)} title="Feeder overload" unit="min" ss={series.overload.ss} bau={series.overload.bau} days={total} better="lower" />
              <SeasonChart dark final={fin('stressFarmDays')} title="Crop stress" unit="farm-days" ss={series.stress.ss} bau={series.stress.bau} days={total} better="lower" />
              <SeasonChart dark final={fin('deepPercolationM3')} title="Water lost below roots" unit="m³" ss={series.waste.ss} bau={series.waste.bau} days={total} better="lower" />
            </div>

            <div className="mt-10">
              <p className="kicker text-ivory/45">Daily rain (bars) on the replayed weather</p>
              <div className="mt-3 flex h-14 items-end gap-[2px]" role="img" aria-label="Daily rainfall over the replayed period">
                {Array.from({ length: total }, (_, i) => {
                  const d = days[i]
                  return <span key={i} className="flex-1 rounded-t-[2px] bg-water-2/70" style={{ height: d ? `${Math.max(2, (d.rainMm / maxRain) * 100)}%` : '2%', opacity: d ? 1 : 0.15 }} title={d ? `${d.date}: ${d.rainMm} mm` : undefined} />
                })}
              </div>
            </div>
          </div>
        )}

        {error && <p className="mt-6 text-alert">{error}</p>}

        {summary && (
          <div className="mt-12 grid gap-10 lg:grid-cols-[1.4fr_1fr]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left">
                <caption className="sr-only">Season totals: SunShift versus business as usual</caption>
                <thead>
                  <tr className="border-b border-ivory/15">
                    <th className="kicker py-3 font-[500] text-ivory/50">{meta?.season.label} · {days.length} days</th>
                    <th className="kicker py-3 text-right font-[500] text-ivory/50">Business as usual</th>
                    <th className="kicker py-3 text-right font-[500]">SunShift</th>
                  </tr>
                </thead>
                <tbody>
                  {SUMMARY_ROWS.map((r) => {
                    const a = summary.bau[r.k]
                    const b = summary.sunshift[r.k]
                    const good = r.better === 'lower' ? b <= a : b >= a
                    const tone = r.better === 'neutral' || Math.abs(a - b) < 1e-9 ? undefined : good ? '#84b85c' : '#ef8a6c'
                    return (
                      <tr key={r.k} className="border-b border-ivory/10">
                        <th scope="row" className="py-3 text-[15px] font-[500] text-ivory/80">{r.label}</th>
                        <td className="num py-3 text-right text-ivory/55">{r.show(a)}</td>
                        <td className="num py-3 text-right text-[17px] font-[640]" style={{ color: tone }}>
                          {r.show(b)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="space-y-4 text-[14px] leading-relaxed text-ivory/60">
              {summary.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
              <p>Weather: {meta?.weatherSource}. Forecast error model: rain detected {pct(meta?.forecastModel.rainDetection ?? 0.85)} of the time, {pct(meta?.forecastModel.falseAlarm ?? 0.08)} false alarms, solar σ {pct(meta?.forecastModel.solarSigma ?? 0.1)}.</p>
              <div className="flex flex-wrap gap-2">
                <SourceBadge kind="replay" />
                <SourceBadge kind="simulation" />
                <SourceBadge kind={engine === 'heuristic' ? 'heuristic' : 'cp-sat'} />
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
