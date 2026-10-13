import { useRef } from 'react'
import { fmt } from '@/lib/format'
import { useSize } from '@/lib/useSize'

/** Small multiple: SunShift vs business-as-usual, drawn as the season streams in. */
export function SeasonChart({
  title,
  unit,
  ss,
  bau,
  final,
  days,
  better,
  digits = 0,
  dark = false,
}: {
  title: string
  unit: string
  ss: number[]
  bau: number[]
  /** Exact season totals once the summary arrives (the curves sum rounded daily values). */
  final?: [number, number]
  days: number
  better: 'lower' | 'higher' | 'neutral'
  digits?: number
  dark?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { width } = useSize(ref)
  const H = 120
  const max = Math.max(1e-9, ...ss, ...bau)
  const x = (i: number) => (days <= 1 ? 0 : (i / (days - 1)) * (width - 2) + 1)
  const y = (v: number) => H - 6 - (v / max) * (H - 16)
  const line = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('')
  const a = final?.[0] ?? ss[ss.length - 1] ?? 0
  const b = final?.[1] ?? bau[bau.length - 1] ?? 0
  const delta = b ? (a - b) / Math.abs(b) : 0
  const good = better === 'lower' ? a <= b : a >= b
  const ink = dark ? '#f3eee4' : '#15140f'
  return (
    <figure className="min-w-0">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="kicker opacity-60">{title}</span>
        {ss.length > 0 && b !== 0 && (
          <span className="num text-[12px] font-[600]" style={{ color: better === 'neutral' || Math.abs(delta) < 0.005 ? undefined : good ? '#84b85c' : '#ef8a6c' }}>
            {delta > 0 ? '+' : ''}
            {fmt(delta * 100, 0)}%
          </span>
        )}
      </figcaption>
      <div ref={ref} className="mt-2">
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={`${title}: SunShift ${fmt(a, digits)} ${unit}, business as usual ${fmt(b, digits)} ${unit}`}>
            <line x1="0" x2={width} y1={H - 6} y2={H - 6} stroke={dark ? 'rgb(243 238 228 / .15)' : 'var(--line)'} />
            <path d={line(bau)} fill="none" stroke={ink} strokeOpacity="0.4" strokeWidth="1.6" strokeDasharray="4 3" />
            <path d={line(ss)} fill="none" stroke="#f2a900" strokeWidth="2.2" />
          </svg>
        )}
      </div>
      <div className="mt-1 flex justify-between gap-2 text-[12.5px]">
        <span className="num">
          <i className="mr-1.5 inline-block h-0.5 w-3 bg-sun align-middle" aria-hidden />
          {fmt(a, digits)} {unit}
        </span>
        <span className="num opacity-60">
          <i className="mr-1.5 inline-block w-3 border-t border-dashed align-middle" style={{ borderColor: ink }} aria-hidden />
          {fmt(b, digits)} {unit}
        </span>
      </div>
    </figure>
  )
}
