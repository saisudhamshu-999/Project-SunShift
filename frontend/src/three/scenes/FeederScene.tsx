import { OrbitControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef, type RefObject } from 'react'
import { Vector3 } from 'three'
import type { PlanResult } from '@/api/types'
import type { Tier } from '@/lib/device'
import { LabelProjector, type LabelRegistry } from '../common/ProjectedLabels'
import { useDynamics } from '../world/dynamics'
import { sunAt } from '../world/sun'
import { World } from '../world/World'

export type TwinLayer = 'solar' | 'weather' | 'water' | 'energy' | 'farmers'

export interface FeederSceneProps {
  plan: PlanResult | null
  tier: Tier
  /** Fractional slot (0..48) written by the parent, read every frame. */
  slot: RefObject<number>
  mode?: 'sunshift' | 'uncoordinated'
  selected?: number | null
  onSelect?: (id: number) => void
  layer?: TwinLayer | null
  /** DOM label registry (see ProjectedLabels); labels are rendered by the section. */
  labels?: LabelRegistry
  autoRotate?: boolean
  rainOverride?: RefObject<number>
}

const TARGET = new Vector3(4, 0, -1)

/** The interactive digital twin: the same world, driven by the solver's schedule. */
export function FeederScene({ plan, tier, slot, mode = 'sunshift', selected = null, onSelect, layer = null, labels, autoRotate = false, rainOverride }: FeederSceneProps) {
  const dyn = useDynamics()
  const schedule = useMemo(() => {
    const m = new Map<number, Set<number>>()
    plan?.farms.forEach((f) => m.set(f.id, new Set(mode === 'sunshift' ? f.schedule.slots : f.uncoordinated.slots)))
    return m
  }, [plan, mode])
  const loads = useMemo(() => (plan ? (mode === 'sunshift' ? plan.sunshift.metrics.series.demandKw : plan.uncoordinated.metrics.series.demandKw) : []), [plan, mode])
  const crops = useMemo(() => (plan ? Object.fromEntries(plan.farms.map((f) => [f.id, f.crop])) : undefined), [plan])
  const das = useMemo(() => (plan ? Object.fromEntries(plan.farms.map((f) => [f.id, f.das])) : undefined), [plan])
  const lastSlot = useRef(-1)

  useFrame(() => {
    const d = dyn.current
    if (!d) return
    const s = Math.max(0, Math.min(47.99, slot.current ?? 24))
    const i = Math.floor(s)
    const date = plan?.meta.date ?? new Date().toISOString().slice(0, 10)
    d.sun = sunAt(date, (plan?.meta.dayStartHour ?? 6) + (s * (plan?.meta.slotMinutes ?? 15)) / 60, plan?.meta.location.id)
    if (i !== lastSlot.current) {
      lastSlot.current = i
      const active = new Set<number>()
      schedule.forEach((slots, id) => slots.has(i) && active.add(id))
      d.active = active
      d.overload = plan ? (loads[i] ?? 0) > plan.feeder.limitKw + 1e-6 : false
      d.solarOutput = plan ? Math.min(1, (plan.solar.acKw[i] ?? 0) / Math.max(1, plan.feeder.inverterKw)) : 0.6
      const precip = plan?.weather.slots.precip[i] ?? 0
      d.rain = rainOverride?.current ?? Math.min(1, precip * 4)
      d.moisture = new Map()
      if (layer === 'water' && plan) plan.farms.forEach((f) => d.moisture.set(f.id, Math.max(0, Math.min(1, f.soilWaterPct / 100))))
    }
    if (rainOverride) d.rain = rainOverride.current ?? 0
    d.highlight = selected
    d.flowSpeed = layer === 'energy' ? 1.6 : 1
  })

  return (
    <>
      <World dyn={dyn} tier={tier} crops={crops} das={das} selected={selected} onSelect={onSelect} interactive={!!onSelect} rain shadows={tier === 'high'} />
      <OrbitControls
        target={TARGET}
        enableDamping
        dampingFactor={0.08}
        minDistance={28}
        maxDistance={170}
        maxPolarAngle={Math.PI * 0.42}
        minPolarAngle={0.12}
        enablePan={false}
        autoRotate={autoRotate}
        autoRotateSpeed={0.35}
        makeDefault
      />
      {labels && <LabelProjector registry={labels} />}
    </>
  )
}

