import { useRef } from 'react'
import { sunFromAngles, type SunState } from './sun'

/**
 * Per-frame world state. Scenes mutate this object (from scroll, the solver's schedule or
 * a playback clock); world components read it inside useFrame, so animation never
 * re-renders React.
 */
export interface Dynamics {
  sun: SunState
  active: Set<number> // pumps running now
  overload: boolean // feeder over its limit right now
  illuminate: number // 0..1, farms lighting up in sequence (hero ending)
  rain: number // 0..1 rain intensity
  solarOutput: number // 0..1 share of plant capacity
  moisture: Map<number, number> // 0..1 relative soil water per farm
  underground: number // 0..1, camera below the soil surface (hero opening)
  highlight: number | null
  flowSpeed: number
}

export function createDynamics(): Dynamics {
  return {
    sun: sunFromAngles(35, 120),
    active: new Set(),
    overload: false,
    illuminate: 0,
    rain: 0,
    solarOutput: 0.7,
    moisture: new Map(),
    underground: 0,
    highlight: null,
    flowSpeed: 1,
  }
}

export function useDynamics() {
  const ref = useRef<Dynamics | null>(null)
  if (!ref.current) ref.current = createDynamics()
  return ref as React.RefObject<Dynamics>
}
