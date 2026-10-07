import { useEffect } from 'react'
import { Vector3 } from 'three'
import type { PlanResult } from '@/api/types'
import type { LabelRegistry } from '@/three/common/ProjectedLabels'
import { PLOTS } from '@/three/world/layout'
import type { TwinLayer } from '@/three/scenes/FeederScene'

/** Farm tags over the 3D feeder: ordinary, focusable DOM, positioned by <LabelProjector>. */
export function FarmLabelOverlay({
  plan,
  registry,
  slot,
  mode = 'sunshift',
  layer = null,
  selected,
  onSelect,
}: {
  plan: PlanResult | null
  registry: LabelRegistry
  slot: number
  mode?: 'sunshift' | 'uncoordinated'
  layer?: TwinLayer | null
  selected: number | null
  onSelect?: (id: number) => void
}) {
  useEffect(() => {
    for (const p of PLOTS) registry.anchors.set(`farm-${p.id}`, new Vector3(p.center[0], 1.4, p.center[1] - p.size[1] / 2 - 0.6))
  }, [registry])

  if (!plan) return null
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden={!onSelect}>
      {plan.farms.map((f) => {
        const on = (mode === 'sunshift' ? f.schedule.slots : f.uncoordinated.slots).includes(slot)
        const info =
          layer === 'farmers' ? (mode === 'sunshift' ? f.schedule.window : f.uncoordinated.window) || 'no irrigation'
          : layer === 'water' ? `${Math.round(f.soilWaterPct)}%`
          : layer === 'solar' ? f.cropLabel
          : null
        const id = `farm-${f.id}`
        return (
          <button
            key={f.id}
            ref={(el) => {
              if (el) registry.els.set(id, el)
              else registry.els.delete(id)
            }}
            type="button"
            tabIndex={onSelect ? 0 : -1}
            onClick={onSelect ? () => onSelect(f.id) : undefined}
            aria-label={`Select farm ${f.code}`}
            className={`absolute left-0 top-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] leading-4 tracking-[0.08em] backdrop-blur-sm transition-colors ${
              selected === f.id ? 'border-ink bg-ink text-ivory' : on ? 'border-sun bg-sun text-ink' : 'border-ink/20 bg-ivory/80 text-ink'
            }`}
            style={{ pointerEvents: onSelect ? 'auto' : 'none', fontFamily: 'var(--font-mono)', visibility: 'hidden' }}
          >
            {f.code}
            {info && <span className="ml-1.5 opacity-70">{info}</span>}
          </button>
        )
      })}
    </div>
  )
}
