// The browser fallback engine must agree with FAO-56 and keep the same hard constraints
// as the CP-SAT model (mirrors backend/tests/test_agronomy.py and test_optimiser.py).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import parity from '@shared/fixtures/engine-parity.json'
import {
  assessFarm,
  atmosphericPressure,
  effectiveRain,
  et0PenmanMonteith,
  extraterrestrialRadiation,
  psychrometricConstant,
  satVapourPressure,
  waterBalanceDay,
  windAt2m,
} from './fao56'
import { greedy, type Problem } from './heuristic'
import { planInBrowser } from './plan'
import { FARMS, FEEDER } from './scenario'
import { solarPosition } from './solar'

describe('FAO-56', () => {
  it('reproduces Example 18 (Uccle, 6 July): ET0 = 3.9 mm/day', () => {
    const lat = 50.8
    const doy = 187
    expect(extraterrestrialRadiation(lat, doy)).toBeCloseTo(41.09, 1)
    const u2 = windAt2m(10 / 3.6, 10)
    expect(u2).toBeCloseTo(2.078, 2)
    const r = et0PenmanMonteith({ tmax: 21.5, tmin: 12.3, rhMax: 84, rhMin: 63, rs: 22.07, u2, lat, elevation: 100, doy })
    expect(r.es).toBeCloseTo(1.997, 2)
    expect(r.ea).toBeCloseTo(1.409, 2)
    expect(r.rnl).toBeCloseTo(3.71, 1)
    expect(r.rn).toBeCloseTo(13.28, 1)
    expect(Math.abs(r.et0 - 3.9)).toBeLessThan(0.05)
  })

  it('matches the atmospheric constants of Examples 2 and 3', () => {
    expect(atmosphericPressure(1800)).toBeCloseTo(81.8, 1)
    expect(psychrometricConstant(81.8)).toBeCloseTo(0.054, 3)
    expect(satVapourPressure(25)).toBeCloseTo(3.168, 2)
  })

  it('keeps the root-zone water balance consistent', () => {
    let day = waterBalanceDay({ dr: 40, taw: 100, raw: 50, etc: 5, rain: 0, et0: 5, irrigationNet: 0 })
    expect(day.drEnd).toBeCloseTo(45)
    expect(day.ks).toBe(1)
    // 30 mm of rain: 1.75 mm runs off, 10 mm refills the root zone, 4 mm is used, the rest drains
    day = waterBalanceDay({ dr: 10, taw: 100, raw: 50, etc: 4, rain: 30, et0: 4, irrigationNet: 0 })
    expect(day.drEnd).toBe(0)
    expect(day.runoff).toBeCloseTo(1.75)
    expect(day.deepPercolation).toBeCloseTo(30 - 1.75 - 10 - 4)
    // past RAW the crop is stressed and actual ET drops
    day = waterBalanceDay({ dr: 80, taw: 100, raw: 50, etc: 6, rain: 0, et0: 6, irrigationNet: 0 })
    expect(day.ks).toBeCloseTo(0.4)
    expect(day.eta).toBeCloseTo(2.4)
  })

  it('ignores light rain and splits heavy rain into effective rain and runoff', () => {
    expect(effectiveRain(0.5, 5)).toEqual([0, 0])
    const [eff, ro] = effectiveRain(40, 5)
    expect(ro).toBeGreaterThan(0)
    expect(eff + ro).toBeCloseTo(40)
  })
})

describe('solar geometry', () => {
  it('puts the sun near the zenith at Anantapur solar noon on the June solstice', () => {
    // 14.68 N, 77.6 E; solar noon there is about 12:13 IST (06:43 UTC)
    const pos = solarPosition(new Date(Date.UTC(2026, 5, 21, 6, 43)), 14.68, 77.6)
    expect(Math.abs(pos.zenith - Math.abs(14.68 - 23.44))).toBeLessThan(1)
  })
})

/** Seeded PRNG so failures are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomProblem(seed: number, scarce: boolean): Problem {
  const rnd = mulberry32(seed)
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
  const jobs = Array.from({ length: 16 }, (_, i) => {
    const a = pick([0, 0, 8, 12])
    const b = pick([48, 48, 32, 28])
    return {
      farmId: i + 1, powerKw: pick([2.9, 4.8, 4.8, 7.2]), flowM3h: 9 + rnd() * 8,
      requiredSlots: Math.floor(rnd() * 29), allowed: Array.from({ length: b - a }, (_, k) => a + k),
      weight: 5 + Math.floor(rnd() * 46), minRun: 2, maxStarts: 2, carry: 1,
    }
  })
  const peak = scarce ? 35 : 75
  const solarKw = Array.from({ length: 48 }, (_, t) => Math.max(0, peak * Math.sin((Math.PI * (t + 0.5)) / 48)))
  return { jobs, solarKw, feederLimitKw: 60, gridCapKw: scarce ? 0 : 15, slots: 48 }
}

function checkSchedule(p: Problem, on: Record<number, number[]>) {
  const load = new Array<number>(p.slots).fill(0)
  for (const job of p.jobs) {
    const slots = on[job.farmId]
    expect(slots.length).toBeLessThanOrEqual(job.requiredSlots)
    const allowed = new Set(job.allowed)
    for (const s of slots) expect(allowed.has(s)).toBe(true)
    const blocks: number[][] = []
    for (const s of slots) {
      const last = blocks.at(-1)
      if (last && s === last[last.length - 1] + 1) last.push(s)
      else blocks.push([s])
    }
    expect(blocks.length).toBeLessThanOrEqual(job.maxStarts)
    for (const b of blocks) expect(b.length).toBeGreaterThanOrEqual(job.minRun)
    for (const s of slots) load[s] += job.powerKw
  }
  for (let t = 0; t < p.slots; t++) {
    expect(load[t]).toBeLessThanOrEqual(p.feederLimitKw + 1e-6)
    expect(load[t]).toBeLessThanOrEqual(p.solarKw[t] + p.gridCapKw + 0.1 + 1e-6)
  }
}

describe('greedy heuristic', () => {
  for (const scarce of [false, true]) {
    for (let seed = 0; seed < 6; seed++) {
      it(`respects every hard constraint (seed ${seed}${scarce ? ', scarce' : ''})`, () => {
        const p = randomProblem(seed, scarce)
        checkSchedule(p, greedy(p))
      })
    }
  }

  it('keeps what already ran when re-planning mid-day', () => {
    const p = randomProblem(3, false)
    const job = p.jobs.find((j) => j.requiredSlots >= 6 && j.allowed.includes(10) && j.allowed.includes(11))!
    job.executed = [10, 11]
    const on = greedy({ ...p, fixedUntil: 20 })
    expect(on[job.farmId]).toEqual(expect.arrayContaining([10, 11]))
    for (const other of p.jobs) if (other !== job) for (const s of on[other.farmId]) expect(s).toBeGreaterThanOrEqual(20)
  })
})

describe('planInBrowser', () => {
  beforeEach(() => vi.stubGlobal('fetch', () => Promise.reject(new Error('offline in tests'))))
  afterEach(() => vi.unstubAllGlobals())

  it('plans the 20-farm feeder offline, labelled as heuristic on climatology', async () => {
    const plan = await planInBrowser({ date: '2026-03-12', failure: 'weather_api' })
    expect(plan.meta.engine).toBe('heuristic')
    expect(plan.meta.sources.weather).toBe('browser-clear-sky')
    expect(plan.meta.sources.pumps).toBe('simulation')
    expect(plan.farms).toHaveLength(20)
    for (const kw of plan.sunshift.loadKw) expect(kw).toBeLessThanOrEqual(FEEDER.feeder_limit_kw + 1e-6)
    expect(plan.sunshift.metrics.overloadSlots).toBe(0)
    expect(plan.sunshift.metrics.peakDemandKw).toBeLessThanOrEqual(plan.uncoordinated.metrics.peakDemandKw)
  })

  it('defers farms when heavy rain is forecast', async () => {
    const dry = await planInBrowser({ date: '2026-03-12', failure: 'weather_api' })
    const wet = await planInBrowser({ date: '2026-03-12', failure: 'weather_api', weatherMode: 'rain', rainMm: 18, rainProb: 85, rainStartHour: 15 })
    expect(wet.totals.farmsDeferred).toBeGreaterThan(dry.totals.farmsDeferred)
    expect(wet.sunshift.metrics.waterM3).toBeLessThan(dry.sunshift.metrics.waterM3)
  })
})

// The same inputs through both engines must give the same answers (fixture written by
// backend/tests/parity.py; regenerate it there after an intended engine change).
describe('parity with the Python engine', () => {
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))

  it('computes the same ET0', () => {
    for (const { input, output } of parity.et0) {
      const r = et0PenmanMonteith(input as Parameters<typeof et0PenmanMonteith>[0])
      for (const k of ['et0', 'ea', 'es', 'rn', 'rnl'] as const) expect(close(r[k], output[k]), `${k} for ${JSON.stringify(input)}`).toBe(true)
    }
  })

  it('assesses every farm the same way', () => {
    for (const { input, output } of parity.assess) {
      const farm = FARMS.find((f) => f.id === input.farmId)!
      const r = assessFarm({ farm, das: input.das, drStart: input.drStart, et0: input.et0, rainForecastMm: input.rainForecastMm, rainProb: input.rainProb, availableSlotCount: input.availableSlotCount })
      const where = `farm ${input.farmId} at ET0 ${input.et0}, rain ${input.rainForecastMm} mm`
      expect(r.requiredSlots, where).toBe(output.requiredSlots)
      expect(r.deferred, where).toBe(output.deferred)
      expect(r.status, where).toBe(output.status)
      for (const [mine, theirs] of [[r.kc, output.kc], [r.taw, output.taw], [r.raw, output.raw], [r.needNetMm, output.needNetMm], [r.needAfterRainMm, output.needAfterRainMm]]) {
        expect(close(mine, theirs), where).toBe(true)
      }
    }
  })

  it('builds the same greedy schedules', () => {
    for (const { problem, on } of parity.greedy) {
      const mine = greedy(problem as Problem)
      for (const [id, slots] of Object.entries(on)) expect(mine[Number(id)], `farm ${id}`).toEqual(slots)
    }
  })
})

describe('farmer SMS parity with the backend', () => {
  it('builds exactly the SMS the server sends', async () => {
    const { smsFor } = await import('@/components/farmer/messages')
    for (const { farm, lang, lines } of parity.sms) {
      expect(smsFor(farm as unknown as Parameters<typeof smsFor>[0], lang as 'en' | 'hi' | 'te').lines, `${farm.code} ${lang}`).toEqual(lines)
    }
  })
})
