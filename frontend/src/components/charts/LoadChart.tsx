import { useId, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { clockFromSlot, fmt } from '@/lib/format'
import { useSize } from '@/lib/useSize'
import { useTweenedArray } from './useTweenedArray'

export interface LoadChartProps {
  solar: number[]
  load: number[]
  limit: number
  gridCap?: number
  clearSky?: number[]
  height?: number
  cursor?: number | null
  onCursor?: (slot: number) => void
  showOverload?: boolean
  loadLabel?: string
  fixedUntil?: number
  title: string
  className?: string
  yMax?: number
}

const PAD = { l: 44, r: 12, t: 18, b: 28 }

/** Feeder day: solar supply, the feeder limit and the pump load, slot by slot. */
export function LoadChart({
  solar,
  load,
  limit,
  gridCap,
  clearSky,
  height = 300,
  cursor = null,
  onCursor,
  showOverload = true,
  loadLabel = 'Pump load',
  fixedUntil = 0,
  title,
  className = '',
  yMax,
}: LoadChartProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { width } = useSize(ref)
  const hatch = useId().replace(/:/g, '')
  const loadT = useTweenedArray(load)
  const solarT = useTweenedArray(solar)
  const n = solar.length || 48
  const top = yMax ?? Math.max(limit * 1.25, ...solar, ...load, ...(clearSky ?? [0])) * 1.05
  const w = Math.max(0, width - PAD.l - PAD.r)
  const h = height - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (i / n) * w
  const y = (v: number) => PAD.t + h - (Math.max(0, v) / top) * h

  const stepPath = (vals: number[]) => {
    let d = `M${x(0)},${y(0)}`
    vals.forEach((v, i) => {
      d += `L${x(i)},${y(v)}L${x(i + 1)},${y(v)}`
    })
    return `${d}L${x(n)},${y(0)}Z`
  }
  const linePath = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i + 0.5)},${y(v)}`).join('')
  const smoothArea = (vals: number[]) => `M${x(0.5)},${y(0)}${vals.map((v, i) => `L${x(i + 0.5)},${y(v)}`).join('')}L${x(n - 0.5)},${y(0)}Z`

  const overloadRects = showOverload
    ? loadT.map((v, i) => (v > limit + 1e-6 ? <rect key={i} x={x(i)} y={y(v)} width={Math.max(0, x(i + 1) - x(i))} height={Math.max(0, y(limit) - y(v))} fill={`url(#${hatch})`} /> : null))
    : null

  const ticks = [0, Math.round(top / 2 / 10) * 10, Math.round(top / 10) * 10].filter((v, i, a) => v <= top && a.indexOf(v) === i)
  const hours = [6, 8, 10, 12, 14, 16, 18]

  const handlePointer = (e: PointerEvent<SVGSVGElement>) => {
    if (!onCursor || w <= 0) return
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const slot = Math.floor(((e.clientX - rect.left - PAD.l) / w) * n)
    onCursor(Math.max(0, Math.min(n - 1, slot)))
  }
  const handleKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!onCursor || cursor == null) return
    if (e.key === 'ArrowRight') onCursor(Math.min(n - 1, cursor + 1))
    else if (e.key === 'ArrowLeft') onCursor(Math.max(0, cursor - 1))
    else return
    e.preventDefault()
  }

  const summary = `${title}. Solar peaks at ${fmt(Math.max(...solar), 0)} kW; pump load peaks at ${fmt(Math.max(...load), 0)} kW against a ${fmt(limit, 0)} kW feeder limit.`

  return (
    <div ref={ref} className={`relative w-full select-none ${className}`}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role={onCursor ? 'slider' : 'img'}
          aria-label={summary}
          aria-valuemin={onCursor ? 0 : undefined}
          aria-valuemax={onCursor ? n - 1 : undefined}
          aria-valuenow={onCursor && cursor != null ? cursor : undefined}
          aria-valuetext={onCursor && cursor != null ? clockFromSlot(cursor) : undefined}
          tabIndex={onCursor ? 0 : undefined}
          onPointerDown={(e) => {
            ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
            handlePointer(e)
          }}
          onPointerMove={(e) => (e.buttons ? handlePointer(e) : e.pointerType === 'mouse' && handlePointer(e))}
          onKeyDown={handleKey}
          className={onCursor ? 'cursor-crosshair touch-pan-y outline-none' : ''}
        >
          <defs>
            <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="#d04a2f" fillOpacity="0.22" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="#d04a2f" strokeWidth="2.4" />
            </pattern>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={PAD.l + w} y1={y(t)} y2={y(t)} stroke="var(--line)" />
              <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" className="num" fontSize="10.5" fill="var(--fg-2)">
                {t}
              </text>
            </g>
          ))}
          <text x={PAD.l - 8} y={PAD.t - 6} textAnchor="end" fontSize="10" fill="var(--fg-2)" className="mono">
            kW
          </text>
          {hours.map((hh) => {
            const i = ((hh - 6) * 60) / 15
            return (
              <text key={hh} x={x(i)} y={height - 8} textAnchor="middle" fontSize="10.5" fill="var(--fg-2)" className="num">
                {String(hh).padStart(2, '0')}
              </text>
            )
          })}
          {fixedUntil > 0 && <rect x={x(0)} y={PAD.t} width={x(fixedUntil) - x(0)} height={h} fill="var(--fg)" fillOpacity="0.05" />}

          {/* solar supply */}
          <path d={smoothArea(solarT)} fill="#f2a900" fillOpacity="0.2" />
          <path d={linePath(solarT)} fill="none" stroke="#e09c00" strokeWidth="1.6" />
          {clearSky && <path d={linePath(clearSky)} fill="none" stroke="#e09c00" strokeOpacity="0.55" strokeWidth="1" strokeDasharray="3 4" />}
          {gridCap != null && gridCap > 0 && (
            <path d={linePath(solarT.map((v) => Math.min(limit, v + gridCap)))} fill="none" stroke="var(--fg-2)" strokeWidth="1" strokeDasharray="1 3" />
          )}

          {/* pump load */}
          <path d={stepPath(loadT)} fill="var(--fg)" fillOpacity="0.1" stroke="var(--fg)" strokeWidth="1.8" strokeLinejoin="round" />
          {overloadRects}

          {/* feeder limit */}
          <line x1={PAD.l} x2={PAD.l + w} y1={y(limit)} y2={y(limit)} stroke="#d04a2f" strokeWidth="1.4" strokeDasharray="6 4" />
          <text x={PAD.l + w} y={y(limit) - 6} textAnchor="end" fontSize="10" fill="#d04a2f" className="mono" letterSpacing="0.08em">
            FEEDER LIMIT {fmt(limit, 0)} KW
          </text>

          {cursor != null && (
            <g pointerEvents="none">
              <line x1={x(cursor + 0.5)} x2={x(cursor + 0.5)} y1={PAD.t} y2={PAD.t + h} stroke="var(--fg)" strokeWidth="1" />
              <circle cx={x(cursor + 0.5)} cy={y(solarT[cursor] ?? 0)} r="4" fill="#f2a900" stroke="var(--bg)" strokeWidth="2" />
              <circle cx={x(cursor + 0.5)} cy={y(loadT[cursor] ?? 0)} r="4" fill="var(--fg)" stroke="var(--bg)" strokeWidth="2" />
            </g>
          )}
        </svg>
      )}
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 kicker opacity-70" aria-hidden>
        <span className="inline-flex items-center gap-2"><i className="inline-block h-2 w-4 rounded-sm bg-sun/60" /> Solar AC</span>
        <span className="inline-flex items-center gap-2"><i className="inline-block h-2 w-4 rounded-sm" style={{ background: 'var(--fg)', opacity: 0.6 }} /> {loadLabel}</span>
        {showOverload && <span className="inline-flex items-center gap-2"><i className="inline-block h-2 w-4 rounded-sm bg-alert/60" /> Overload</span>}
        {gridCap != null && gridCap > 0 && <span className="inline-flex items-center gap-2"><i className="inline-block w-4 border-t border-dotted" style={{ borderColor: 'var(--fg-2)' }} /> Solar + {gridCap} kW grid</span>}
      </div>
    </div>
  )
}
