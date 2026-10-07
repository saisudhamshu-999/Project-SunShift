import { useRef } from 'react'
import type { ConvergencePoint } from '@/api/types'
import { fmt } from '@/lib/format'
import { useSize } from '@/lib/useSize'

/** Improving solutions found by CP-SAT over time (phase 2: the service objective). */
export function Convergence({ points, timeLimit }: { points: ConvergencePoint[]; timeLimit: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const { width } = useSize(ref)
  const H = 120
  const pts = points.filter((p) => (p.phase ?? 2) === 2)
  if (!pts.length) return <div ref={ref} className="h-[120px] text-[12px] opacity-50">No improving solutions recorded.</div>
  const tMax = Math.max(timeLimit, ...pts.map((p) => p.t)) || 1
  const lo = Math.min(...pts.map((p) => p.objective))
  const hi = Math.max(...pts.map((p) => Math.max(p.objective, p.bound)))
  const y = (v: number) => 10 + (H - 24) * (1 - (v - lo) / Math.max(1, hi - lo))
  const x = (t: number) => 4 + (width - 8) * (t / tMax)
  let d = ''
  pts.forEach((p, i) => {
    d += i ? `L${x(p.t)},${y(pts[i - 1].objective)}L${x(p.t)},${y(p.objective)}` : `M${x(p.t)},${y(p.objective)}`
  })
  d += `L${x(tMax)},${y(pts[pts.length - 1].objective)}`
  const bound = pts[pts.length - 1].bound
  return (
    <div ref={ref} className="w-full">
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={`${pts.length} improving solutions; final objective ${fmt(pts[pts.length - 1].objective)} against bound ${fmt(bound)}`}>
          <line x1={x(0)} x2={x(tMax)} y1={y(bound)} y2={y(bound)} stroke="#f2a900" strokeDasharray="3 4" strokeOpacity="0.8" />
          <text x={x(tMax)} y={y(bound) - 5} textAnchor="end" fontSize="9.5" fill="#f2a900" className="mono">BEST BOUND</text>
          <path d={d} fill="none" stroke="#f3eee4" strokeWidth="1.6" />
          {pts.map((p, i) => (
            <circle key={i} cx={x(p.t)} cy={y(p.objective)} r="2.4" fill="#f3eee4" />
          ))}
          <text x={x(0)} y={H - 2} fontSize="9.5" fill="currentColor" opacity="0.5" className="num">0 s</text>
          <text x={x(tMax)} y={H - 2} fontSize="9.5" fill="currentColor" opacity="0.5" textAnchor="end" className="num">{fmt(tMax, 1)} s</text>
        </svg>
      )}
    </div>
  )
}
