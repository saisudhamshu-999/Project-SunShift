import { create } from 'zustand'
import * as api from '@/api/client'
import type { Engine, PlanRequest, PlanResult } from '@/api/types'
import { useUi } from './ui'

/** The feeder plan shared by the story, the dashboard and the demo. */
interface PlanState {
  params: PlanRequest
  result: PlanResult | null
  engine: Engine | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  runs: number
  setParams: (p: Partial<PlanRequest>, opts?: { debounceMs?: number }) => void
  resetParams: () => void
  run: () => Promise<PlanResult | null>
  ensure: () => void
  /** Replace the current plan with an in-day re-plan computed elsewhere. */
  adopt: (result: PlanResult, engine: Engine) => void
}

export const DEFAULT_PARAMS: PlanRequest = { weatherMode: 'live', timeLimitS: 3, persist: true }

let ctrl: AbortController | null = null
let timer: number | undefined
let seq = 0

export const usePlan = create<PlanState>((set, get) => ({
  params: { ...DEFAULT_PARAMS },
  result: null,
  engine: null,
  status: 'idle',
  error: null,
  runs: 0,
  setParams: (p, opts) => {
    set({ params: { ...get().params, ...p } })
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void get().run(), opts?.debounceMs ?? 350)
  },
  resetParams: () => {
    set({ params: { ...DEFAULT_PARAMS } })
    void get().run()
  },
  run: async () => {
    ctrl?.abort()
    ctrl = new AbortController()
    const id = ++seq
    set({ status: 'loading', error: null })
    try {
      const { data, engine } = await api.plan(get().params, ctrl.signal)
      if (id !== seq) return null
      useUi.getState().setApi(engine === 'cp-sat' ? useUi.getState().health ?? (await api.health()) : null)
      set({ result: data, engine, status: 'ready', runs: get().runs + 1 })
      return data
    } catch (err) {
      if (id !== seq || (err as Error).name === 'AbortError') return null
      set({ status: 'error', error: (err as Error).message })
      return null
    }
  },
  ensure: () => {
    const s = get()
    if (s.status === 'idle') void s.run()
  },
  adopt: (result, engine) => {
    ctrl?.abort()
    seq++
    set({ result, engine, status: 'ready', error: null, runs: get().runs + 1 })
  },
}))
