import { create } from 'zustand'
import type { Health } from '@/api/types'
import { sound } from '@/lib/sound'

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: preferences just won't persist */
  }
}

const prefersReduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
const savedMotion = stored('sunshift:motion')

interface UiState {
  reducedMotion: boolean
  sound: boolean
  apiStatus: 'unknown' | 'online' | 'offline'
  health: Health | null
  selectedFarm: number | null
  cursorSlot: number
  setReducedMotion: (v: boolean) => void
  toggleSound: () => void
  setApi: (h: Health | null) => void
  selectFarm: (id: number | null) => void
  setCursorSlot: (slot: number) => void
}

export const useUi = create<UiState>((set, get) => ({
  reducedMotion: savedMotion ? savedMotion === 'reduced' : prefersReduced,
  sound: false, // never autoplay: sound starts only from the toggle
  apiStatus: 'unknown',
  health: null,
  selectedFarm: 7,
  cursorSlot: 25,
  setReducedMotion: (v) => {
    store('sunshift:motion', v ? 'reduced' : 'full')
    document.documentElement.dataset.motion = v ? 'reduced' : 'full'
    set({ reducedMotion: v })
  },
  toggleSound: () => {
    const next = !get().sound
    if (next) void sound.enable()
    else sound.disable()
    set({ sound: next })
  },
  setApi: (h) => set({ health: h, apiStatus: h ? 'online' : 'offline' }),
  selectFarm: (id) => set({ selectedFarm: id }),
  setCursorSlot: (slot) => set({ cursorSlot: Math.max(0, Math.min(47, slot)) }),
}))

if (typeof document !== 'undefined') {
  document.documentElement.dataset.motion = useUi.getState().reducedMotion ? 'reduced' : 'full'
}
