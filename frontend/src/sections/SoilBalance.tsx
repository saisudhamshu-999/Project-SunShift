import { useEffect, useMemo, useRef, useState } from 'react'
import type { FarmPlan } from '@/api/types'
import { Reveal } from '@/components/text/Reveal'
import { SourceBadge } from '@/components/ui/SourceBadge'
import { Meter } from '@/components/ui/primitives'
import { stressCoefficient, waterBalanceDay } from '@/engine/fao56'
import { fmt } from '@/lib/format'
import { sound } from '@/lib/sound'
import { usePlan } from '@/state/plan'
import { useUi } from '@/state/ui'
import { LazyCanvas } from '@/three/common/LazyCanvas'
import { useLabelRegistry } from '@/three/common/ProjectedLabels'
import { SoilScene, type SoilState } from '@/three/scenes/SoilScene'

interface LogRow {
  label: string
  dr: number
  note: string
}

function statusOf(dr: number, raw: number, taw: number) {
  if (dr <= raw) return { label: 'Safe', tone: '#4c8a3b', ks: 1 }
  const ks = stressCoefficient(dr, taw, raw)
  return { label: ks > 0.6 ? 'Mild stress' : 'Stress', tone: ks > 0.6 ? '#e08a00' : '#d04a2f', ks }
}

function SoilFallback({ fill }: { fill: number }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-ivory">
      <div className="relative h-[70%] w-[60%] overflow-hidden rounded-xl" style={{ background: 'linear-gradient(#3a2a1c 0 12%, #74452a 12% 55%, #94744f 55%)' }}>
        <div className="absolute inset-x-0 bottom-[38%] bg-water/45" style={{ height: `${fill * 50}%` }} />
      </div>
    </div>
  )
}

export function SoilBalance() {
  const plan = usePlan((s) => s.result)
  const selected = useUi((s) => s.selectedFarm)
  const [farmId, setFarmId] = useState<number>(selected ?? 7)
  const farm: FarmPlan | undefined = plan?.farms.find((f) => f.id === farmId)
  const [dr, setDr] = useState(30)
  const [log, setLog] = useState<LogRow[]>([])
  const state = useRef<SoilState>({ fill: 0.6, rawFrac: 0.5, rootDepthM: 1, et: 0.5, rainAt: 0, irrigateAt: 0, drainAt: 0 })
  const clock = useRef(performance.now())
  const labels = useLabelRegistry()

  useEffect(() => {
    if (!farm) return
    setDr(farm.drStart)
    setLog([{ label: 'Today', dr: farm.drStart, note: `from the live plan · ETc ${fmt(farm.etc, 1)} mm/day` }])
  }, [farm?.id, plan]) // eslint-disable-line react-hooks/exhaustive-deps

  const taw = farm?.taw ?? 100
  const raw = farm?.raw ?? 50
  const etc = farm?.etc ?? 4
  const et0 = plan?.weather.daily.et0 ?? 4.5
  const st = statusOf(dr, raw, taw)
  const fill = Math.max(0, 1 - dr / taw)
  state.current.fill = fill
  state.current.rawFrac = raw / taw
  state.current.rootDepthM = farm?.zr ?? 1
  state.current.et = Math.min(1, etc / 7)

  const now = () => (performance.now() - clock.current) / 1000
  const step = (label: string, a: { rain?: number; irrigation?: number; etcScale?: number }) => {
    const day = waterBalanceDay({ dr, taw, raw, etc: etc * (a.etcScale ?? 1), rain: a.rain ?? 0, et0, irrigationNet: a.irrigation ?? 0 })
    setDr(day.drEnd)
    const notes: string[] = []
    if (a.rain) notes.push(`${fmt(day.rainEffective, 1)} mm rain counted${day.runoff ? `, ${fmt(day.runoff, 1)} mm ran off` : ''}`)
    if (a.irrigation) notes.push(`${fmt(a.irrigation, 1)} mm irrigation`)
    notes.push(`crop used ${fmt(day.eta, 1)} mm${day.ks < 1 ? ` (stressed, Ks ${fmt(day.ks, 2)})` : ''}`)
    if (day.deepPercolation > 0.05) notes.push(`${fmt(day.deepPercolation, 1)} mm drained below the roots`)
    setLog((l) => [{ label, dr: day.drEnd, note: notes.join(' · ') }, ...l].slice(0, 6))
    const t = now()
    if (a.rain) {
      state.current.rainAt = t
      sound.rain(true)
      window.setTimeout(() => sound.rain(false), 2500)
    }
    if (a.irrigation) {
      state.current.irrigateAt = t
      sound.water()
    }
    if (day.deepPercolation > 0.05) state.current.drainAt = t + 1.2
  }

  const options = useMemo(() => plan?.farms ?? [], [plan])
  const needToday = farm ? Math.max(0, farm.needAfterRainMm) : 0

  return (
    <section className="relative bg-paper py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <p className="kicker text-earth">Step 03 · Soil-water balance</p>
        <Reveal as="h2" className="t-display t-xl mt-6 max-w-[15ch]" split="words">
          The root zone is a bucket with a clock.
        </Reveal>
        <p className="lede mt-6">
          Rain and irrigation fill it. The crop and the sun drain it. Below the RAW line the crop starts to suffer. SunShift tracks this bucket
          for every farm, every day (FAO-56 equation 85).
        </p>

        <div className="mt-14 grid gap-8 lg:grid-cols-[1.3fr_1fr]">
          <div className="relative h-[460px] overflow-hidden rounded-[24px] md:h-[560px]">
          <LazyCanvas
            className="absolute inset-0"
            label={`Cross-section of ${farm?.code ?? 'the farm'}'s soil: the root zone holds ${Math.round(fill * 100)} percent of its available water`}
            fallback={<SoilFallback fill={fill} />}
            camera={{ position: [0, 0.6, 9.5], fov: 40 }}
          >
            {() => <SoilScene state={state} crop={farm?.crop ?? 'cotton'} rawFrac={raw / taw} rootDepthM={farm?.zr ?? 1} labels={labels} />}
          </LazyCanvas>
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              {([
                ['fc', 'Field capacity', '#2f74c0'],
                ['raw', 'RAW: stress begins', '#e08a00'],
                ['wp', 'Wilting point · root depth', '#d04a2f'],
              ] as const).map(([id, text, tone]) => (
                <span
                  key={id}
                  ref={(el) => {
                    if (el) labels.els.set(`soil-${id}`, el)
                    else labels.els.delete(`soil-${id}`)
                  }}
                  data-align="left"
                  className="absolute left-0 top-0 whitespace-nowrap rounded-full bg-ivory/90 px-2 py-0.5 text-[10px] uppercase tracking-[0.1em]"
                  style={{ color: tone, fontFamily: 'var(--font-mono)', visibility: 'hidden' }}
                >
                  {text}
                </span>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <label className="block">
              <span className="kicker opacity-60">Farm</span>
              <select
                className="mt-2 block w-full rounded-xl border bg-transparent px-3 py-2.5 text-[15px]"
                style={{ borderColor: 'var(--line-2)' }}
                value={farmId}
                onChange={(e) => setFarmId(Number(e.target.value))}
              >
                {options.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.code} · {f.cropLabel} · {f.soilLabel} · root zone {fmt(f.zr, 2)} m
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="kicker opacity-55">Root-zone depletion</p>
                <p className="num mt-1 text-[34px] font-[620] leading-none">
                  {fmt(dr)}
                  <span className="text-[14px] opacity-55"> mm</span>
                </p>
              </div>
              <div>
                <p className="kicker opacity-55">RAW</p>
                <p className="num mt-1 text-[34px] font-[620] leading-none">
                  {fmt(raw)}
                  <span className="text-[14px] opacity-55"> mm</span>
                </p>
              </div>
              <div>
                <p className="kicker opacity-55">Status</p>
                <p className="mt-1 text-[30px] font-[680] leading-none tracking-[-0.02em]" style={{ color: st.tone }} aria-live="polite">
                  {st.label}
                </p>
              </div>
            </div>
            <Meter value={dr} max={taw} color={st.tone} label="Root-zone depletion" markers={[{ at: raw, label: 'RAW' }]} />
            <p className="-mt-3 text-[12px] opacity-55">
              0 mm = field capacity · {fmt(raw)} mm = stress begins · {fmt(taw)} mm = wilting point
            </p>

            <div className="grid grid-cols-2 gap-2">
              <button className="btn btn-ghost" onClick={() => step('+ Rain', { rain: 15 })}>Rain 15 mm</button>
              <button className="btn btn-ghost" onClick={() => step('+ Irrigate', { irrigation: Math.max(needToday, 8) })}>
                Irrigate {fmt(Math.max(needToday, 8), 0)} mm
              </button>
              <button className="btn btn-ghost" onClick={() => step('+1 day', {})}>Pass a day</button>
              <button className="btn btn-ghost" onClick={() => step('+1 heatwave day', { etcScale: 1.4 })}>Heatwave day</button>
            </div>

            <ol className="space-y-2 border-t pt-4" style={{ borderColor: 'var(--line)' }} aria-label="Water balance log">
              {log.map((row, i) => (
                <li key={i} className="flex gap-3 text-[13px]" style={{ opacity: 1 - i * 0.14 }}>
                  <span className="kicker w-28 shrink-0 pt-0.5">{row.label}</span>
                  <span className="num w-16 shrink-0 font-[600]">{fmt(row.dr)} mm</span>
                  <span className="opacity-65">{row.note}</span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              <SourceBadge kind="simulation" />
              <SourceBadge kind="computed" />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
