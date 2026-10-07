let webgl: boolean | null = null

export function webglAvailable(): boolean {
  if (webgl !== null) return webgl
  try {
    const c = document.createElement('canvas')
    webgl = !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    webgl = false
  }
  return webgl
}

export type Tier = 'high' | 'mid' | 'low'

/** Rough capability tier used to scale geometry, DPR and particle counts. */
export function deviceTier(): Tier {
  if (typeof window === 'undefined') return 'mid'
  const narrow = window.matchMedia('(max-width: 767px)').matches
  const coarse = window.matchMedia('(pointer: coarse)').matches
  const cores = navigator.hardwareConcurrency ?? 4
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  if (narrow || (coarse && cores <= 6) || memory <= 3) return 'low'
  if (cores <= 4 || memory <= 4 || coarse) return 'mid'
  return 'high'
}

export const isTouch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
