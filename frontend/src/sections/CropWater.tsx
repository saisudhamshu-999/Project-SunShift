import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { CropKey } from '@/api/types'
import { Reveal } from '@/components/text/Reveal'
import { SourceBadge } from '@/components/ui/SourceBadge'
import { CROPS, CROP_KEYS, SCENARIO } from '@/engine/scenario'
import { kcAt, seasonDays } from '@/engine/fao56'
import { fmt } from '@/lib/format'
import { useTween } from '@/lib/hooks'
import { CROP_COLOR } from '@/lib/palette'
import { sound } from '@/lib/sound'
import { useSize } from '@/lib/useSize'
import { usePlan } from '@/state/plan'

export function CropWater() {
  const plan = usePlan((s) => s.result)
  const [crop, setCrop] = useState<CropKey>('cotton')
  const def = CROPS[crop]
  const total = seasonDays(def)
  const farms = plan?.farms.filter((f) => f.crop === crop) ?? []
  const [day, setDay] = useState(100)
  useEffect(() => {
    const avg = farms.length ? Math.round(farms.reduce((a, f) => a + f.das, 0) / farms.length) : Math.round(total * 0.55)
    setDay(Math.min(total, avg))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crop, plan])

  const chart = useRef<HTMLDivElement>(null)
  const { width } = useSize(chart)
  const H = 260
  const P = { l: 40, r: 16, t: 20, b: 40 }
  const w = Math.max(0, width - P.l - P.r)
  const h = H - P.t - P.b
  const x = (d: number) => P.l + (d / total) * w
  const y = (k: number) => P.t + h - (k / 1.3) * h
  const curve = useMemo(() => Array.from({ length: total + 1 }, (_, d) => [d, kcAt(def, d)] as const), [def, total])
  const path = curve.map(([d, k], i) => `${i ? 'L' : 'M'}${x(d)},${y(k)}`).join('')
  const area = `${path}L${x(total)},${y(0)}L${x(0)},${y(0)}Z`
  const bounds = def.stages.reduce<number[]>((acc, l) => [...acc, (acc[acc.length - 1] ?? 0) + l], [])

  const et0 = plan?.weather.daily.et0 ?? 4.5
  const kc = kcAt(def, day)
  const etc = et0 * kc
  const etcShown = useTween(etc, 0.5)
  const kcShown = useTween(kc, 0.5)

  const drag = (e: PointerEvent<SVGSVGElement>) => {
    if (w <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    setDay(Math.round(Math.max(0, Math.min(total, ((e.clientX - rect.left - P.l) / w) * total))))
  }

  return (
    <section className="relative bg-ivory py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <p className="kicker text-crop">Step 02 · Crop water requirement</p>
        <Reveal as="h2" className="t-display t-xl mt-6 max-w-[16ch]" split="words">
          Every crop has a water requirement.
        </Reveal>

        <div role="tablist" aria-label="Crop" className="mt-12 flex flex-wrap gap-x-8 gap-y-2 border-b" style={{ borderColor: 'var(--line)' }}>
          {CROP_KEYS.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={crop === k}
              onClick={() => (sound.tick(), setCrop(k))}
              className={`t-display -mb-px border-b-2 pb-3 text-[clamp(1.6rem,3.2vw,3rem)] transition-colors ${crop === k ? 'border-ink' : 'border-transparent opacity-30 hover:opacity-70'}`}
            >
              {CROPS[k].label}
            </button>
          ))}
        </div>

        <div className="mt-10 grid gap-12 lg:grid-cols-[1.6fr_1fr]">
          <div ref={chart}>
            {width > 0 && (
              <svg
                width={width}
                height={H}
                role="slider"
                tabIndex={0}
                aria-label={`${def.label} crop coefficient across the season. Drag to choose a day after sowing.`}
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={day}
                aria-valuetext={`Day ${day}: Kc ${kc.toFixed(2)}`}
                onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), drag(e))}
                onPointerMove={(e) => e.buttons && drag(e)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') setDay((d) => Math.min(total, d + 1))
                  else if (e.key === 'ArrowLeft') setDay((d) => Math.max(0, d - 1))
                }}
                className="cursor-ew-resize touch-pan-y outline-none"
              >
                {bounds.map((b, i) => {
                  const a = i ? bounds[i - 1] : 0
                  return (
                    <g key={i}>
                      <rect x={x(a)} y={P.t} width={x(b) - x(a)} height={h} fill={i % 2 ? 'var(--line)' : 'transparent'} opacity="0.6" />
                      <text x={(x(a) + x(b)) / 2} y={H - 22} textAnchor="middle" fontSize="10.5" fill="var(--fg-2)" className="mono" letterSpacing="0.06em">
                        {['INITIAL', 'DEVELOPMENT', 'MID-SEASON', 'LATE'][i]}
                      </text>
                      <text x={(x(a) + x(b)) / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--fg-2)">
                        {width > 640 ? def.stage_labels[i] : ''}
                      </text>
                    </g>
                  )
                })}
                {[0.5, 1.0].map((k) => (
                  <g key={k}>
                    <line x1={P.l} x2={P.l + w} y1={y(k)} y2={y(k)} stroke="var(--line)" />
                    <text x={P.l - 8} y={y(k) + 4} textAnchor="end" fontSize="10.5" fill="var(--fg-2)" className="num">
                      {k.toFixed(1)}
                    </text>
                  </g>
                ))}
                <text x={P.l - 8} y={P.t - 6} textAnchor="end" fontSize="10" className="mono" fill="var(--fg-2)">
                  Kc
                </text>
                <path d={area} fill={CROP_COLOR[crop]} fillOpacity="0.18" />
                <path d={path} fill="none" stroke={CROP_COLOR[crop]} strokeWidth="2.4" />
                {farms.map((f) => (
                  <circle key={f.id} cx={x(Math.min(f.das, total))} cy={y(kcAt(def, f.das))} r="5" fill="var(--bg)" stroke="#15140f" strokeWidth="1.5">
                    <title>{`${f.code}: day ${f.das}`}</title>
                  </circle>
                ))}
                {farms.length > 0 && (() => {
                  const lo = Math.min(...farms.map((f) => f.das))
                  const hi = Math.max(...farms.map((f) => f.das))
                  const cx = x(Math.min(total, (lo + hi) / 2))
                  const cy = y(kcAt(def, (lo + hi) / 2)) + 26
                  return (
                    <text x={cx} y={Math.min(P.t + h - 6, cy)} textAnchor="middle" fontSize="10.5" className="mono" fill="var(--fg-2)">
                      {farms.length} FARM{farms.length === 1 ? '' : 'S'} · DAY {lo === hi ? lo : `${lo}–${hi}`}
                    </text>
                  )
                })()}
                <line x1={x(day)} x2={x(day)} y1={P.t} y2={P.t + h} stroke="#15140f" />
                <circle cx={x(day)} cy={y(kc)} r="7" fill="#15140f" />
                <text x={x(day) + (x(day) > P.l + w - 70 ? -10 : 10)} y={P.t + 12} textAnchor={x(day) > P.l + w - 70 ? 'end' : 'start'} fontSize="11" className="num">
                  Day {day} · Kc {kc.toFixed(2)}
                </text>
              </svg>
            )}
            <p className="mt-4 text-[13px] opacity-60">
              Circles are the {farms.length} {def.label.toLowerCase()} farm{farms.length === 1 ? '' : 's'} on Feeder 07 today. Drag along the curve to explore the season.
              Coefficients: FAO-56 Tables 11–12.
            </p>
          </div>

          <div className="flex flex-col justify-center">
            <div className="grid grid-cols-[auto_auto_1fr] items-end gap-x-4 gap-y-2">
              <span className="kicker opacity-60">ET₀</span>
              <span />
              <span className="num text-[clamp(2.4rem,4vw,3.6rem)] font-[600] leading-none tracking-[-0.04em]">{fmt(et0, 2)}</span>
              <span className="kicker opacity-60">× Kc</span>
              <span />
              <span className="num text-[clamp(2.4rem,4vw,3.6rem)] font-[600] leading-none tracking-[-0.04em]" style={{ color: CROP_COLOR[crop] }}>
                {fmt(kcShown, 2)}
              </span>
              <span className="col-span-3 my-2 h-px bg-ink" />
              <span className="kicker">= ETc</span>
              <span />
              <span className="num text-[clamp(3.4rem,6vw,5.4rem)] font-[640] leading-none tracking-[-0.05em]">
                {fmt(etcShown, 2)}
                <span className="ml-2 text-[16px] font-[500] tracking-normal opacity-60">mm/day</span>
              </span>
            </div>
            <p className="mt-6 text-[14.5px] leading-relaxed opacity-70">
              On day {day}, {def.label.toLowerCase()} transpires {fmt(etc, 1)} mm a day: {fmt(etc * 10, 0)} m³ for every hectare, before any
              losses in the field.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {plan && <SourceBadge kind={plan.weather.source} />}
              <SourceBadge kind="computed" />
            </div>
            <p className="mt-8 border-l-2 pl-4 text-[13px] leading-relaxed opacity-60" style={{ borderColor: 'var(--line-2)' }}>
              <strong className="font-[600]">Why not paddy?</strong> {SCENARIO.excluded_crops.paddy}
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
