import { beforeEach, describe, expect, it } from 'vitest'
import { claim, liveCount, MAX_LIVE, resetBudget } from './glBudget'

describe('WebGL context budget', () => {
  beforeEach(() => resetBudget())

  it('evicts the off-screen canvas seen least recently when the budget is exceeded', () => {
    const evicted: string[] = []
    const a = claim(() => evicted.push('a'), false)
    claim(() => evicted.push('b'), false)
    claim(() => evicted.push('c'), true)
    a.setVisible(false) // seen again more recently than b
    claim(() => evicted.push('d'), true)
    expect(evicted).toEqual(['b'])
    expect(liveCount()).toBe(MAX_LIVE)
  })

  it('never evicts a canvas that is on screen', () => {
    const evicted: string[] = []
    for (const name of ['a', 'b', 'c']) claim(() => evicted.push(name), true)
    claim(() => evicted.push('d'), true)
    expect(evicted).toEqual([])
    expect(liveCount()).toBe(4) // rare: four canvases on screen at once; nothing is dropped
  })

  it('frees the slot when a canvas unmounts', () => {
    const slots = [1, 2, 3].map(() => claim(() => undefined, false))
    slots[0].release()
    const evicted: string[] = []
    claim(() => evicted.push('x'), false)
    expect(evicted).toEqual([])
    expect(liveCount()).toBe(MAX_LIVE)
  })
})
