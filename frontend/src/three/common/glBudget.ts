// A budget for live WebGL contexts. Browsers allow only a handful at once (often 8-16,
// fewer on phones) and drop the oldest when the limit is hit, leaving a blank canvas.
// LazyCanvas claims a slot before mounting; when more than MAX_LIVE are claimed, the
// off-screen canvas seen least recently is asked to unmount and remounts on its own when
// it scrolls back into view.

export const MAX_LIVE = 3

interface Entry {
  visible: boolean
  lastSeen: number
  evict: () => void
}

const live = new Map<number, Entry>()
let nextId = 1
let clock = 0 // a counter, not wall time: deterministic and fine for ordering

const tick = () => ++clock

export interface Claim {
  id: number
  setVisible: (visible: boolean) => void
  release: () => void
}

/** Take a context slot; may evict the longest-unseen off-screen canvas. */
export function claim(evict: () => void, visible: boolean): Claim {
  const id = nextId++
  live.set(id, { visible, lastSeen: tick(), evict })
  if (live.size > MAX_LIVE) {
    const victims = [...live.entries()].filter(([other, e]) => other !== id && !e.visible).sort((a, b) => a[1].lastSeen - b[1].lastSeen)
    for (const [other, e] of victims) {
      if (live.size <= MAX_LIVE) break
      live.delete(other)
      e.evict()
    }
  }
  return {
    id,
    setVisible: (v: boolean) => {
      const e = live.get(id)
      if (e) {
        e.visible = v
        e.lastSeen = tick()
      }
    },
    release: () => void live.delete(id),
  }
}

export function liveCount(): number {
  return live.size
}

/** Tests only. */
export function resetBudget(): void {
  live.clear()
}
