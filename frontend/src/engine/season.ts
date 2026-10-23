// Season replay in the browser (fallback for static hosting). Mirrors
// backend/app/engine/season.py but schedules each day with the greedy heuristic.
import type { SeasonDayStrategy, SeasonEvent, SeasonRequest, SeasonSummary } from '@/api/types'
import { assessFarm, cropStage, depletionFraction, kcAt, rootDepth, totalAvailableWater, waterBalanceDay } from './fao56'
import { greedy, type Job } from './heuristic'
import { evaluate, jainIndex } from './metrics'
import { priorityFor } from './plan'
import { CROPS, FARMS, FEEDER, METHODS, POLICY, SEASONS, SOILS, availableSlots, location, timeToSlot, type FarmDef, type FeederDef } from './scenario'
import { pvProfile } from './solar'
import { assembleDay, climatologicalEt0, fetchArchive } from './weather'

const FORECAST_MODEL = { rainDetection: 0.85, falseAlarm: 0.08, solarSigma: 0.1, et0Sigma: 0.06 }

function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const uniform = (lo: number, hi: number) => lo + (hi - lo) * next()
  const gauss = (mu: number, sigma: number) => {
    const u = 1 - next()
    const v = next()
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  return { next, uniform, gauss }
}

interface State {
  dr: number
  das: number
  refilling: boolean
  servedYesterday: number
  daysSince: number
  etaSum: number
  etcSum: number
  needM3: number
  usefulM3: number
}

function bauRotation(farm: FarmDef, hoursPerDay: number, windowH: number): number {
  const rotation = POLICY.bau.rotation_days[farm.method]
  if (hoursPerDay <= 0) return rotation
  return Math.max(1, Math.min(rotation, Math.floor(windowH / hoursPerDay)))
}

export async function simulateSeasonInBrowser(req: SeasonRequest, onEvent: (e: SeasonEvent) => void, signal?: AbortSignal) {
  const feeder: FeederDef = { ...FEEDER }
  if (req.pvKwp != null) {
    const ratio = FEEDER.pv_kwp / FEEDER.inverter_kw
    feeder.pv_kwp = req.pvKwp
    feeder.inverter_kw = req.pvKwp / ratio
  }
  if (req.feederLimitKw != null) feeder.feeder_limit_kw = req.feederLimitKw
  if (req.gridBackupKw != null) feeder.grid_backup_kw = req.gridBackupKw
  const loc = location(req.location)
  const season = SEASONS.find((s) => s.id === req.season) ?? SEASONS[0]
  const latest = new Date(Date.now() + 330 * 60000 - 2 * 86400000)
  const startDate = new Date(`${season.start}T00:00:00Z`)
  const nDays = Math.max(1, Math.min(req.days, Math.floor((latest.getTime() - startDate.getTime()) / 86400000) + 1))
  const end = new Date(startDate.getTime() + nDays * 86400000).toISOString().slice(0, 10)
  const factor = req.bauFactor ?? POLICY.bau.factor
  const h = feeder.slot_minutes / 60
  const farms = new Map(FARMS.map((f) => [f.id, f]))
  const allowed = new Map(FARMS.map((f) => [f.id, availableSlots(f, feeder)]))
  const t0 = performance.now()

  onEvent({
    type: 'meta', season, start: season.start, days: nDays,
    location: { id: loc.id, name: loc.name, state: loc.state, lat: loc.lat, lon: loc.lon },
    weatherSource: 'Open-Meteo historical archive (ERA5) fetched by the browser; schedules by greedy heuristic',
    forecastModel: FORECAST_MODEL, bau: { ...POLICY.bau, factor },
    feeder: { limitKw: feeder.feeder_limit_kw, pvKwp: feeder.pv_kwp, gridBackupKw: feeder.grid_backup_kw },
  })
  let payload
  try {
    payload = await fetchArchive(loc, season.start, end, signal)
  } catch (err) {
    onEvent({ type: 'error', message: `Weather archive unavailable: ${String(err)}` })
    return
  }

  const init = (): Map<number, State> =>
    new Map(FARMS.map((f) => {
      const taw = totalAvailableWater(SOILS[f.soil], rootDepth(CROPS[f.crop], f.das))
      return [f.id, { dr: f.dr0_frac * taw, das: f.das, refilling: false, servedYesterday: f.served_yesterday, daysSince: f.last_irrigated_days, etaSum: 0, etcSum: 0, needM3: 0, usefulM3: 0 }]
    }))
  const ss = init()
  const bau = init()
  const r = rng(req.seed ?? 2026)
  const totals = {
    sunshift: { water: 0, energy: 0, grid: 0, solarUsed: 0, solarAvail: 0, overload: 0, deepPerc: 0, peak: 0, stress: 0 },
    bau: { water: 0, energy: 0, grid: 0, solarUsed: 0, solarAvail: 0, overload: 0, deepPerc: 0, peak: 0, stress: 0 },
  }
  let prevRain = 0

  for (let k = 0; k < nDays; k++) {
    if (signal?.aborted) return
    const day = new Date(startDate.getTime() + k * 86400000).toISOString().slice(0, 10)
    const dw = assembleDay(payload, day, loc, feeder)
    const pv = pvProfile(day, loc, dw.slots, feeder)
    const solarFactor = Math.max(0.7, Math.min(1.25, r.gauss(1, FORECAST_MODEL.solarSigma)))
    const solarFc = pv.acKw.map((v) => v * solarFactor)
    const et0Fc = dw.daily.et0 * Math.max(0.8, Math.min(1.2, r.gauss(1, FORECAST_MODEL.et0Sigma)))
    const actual = dw.daily.lookaheadRainMm
    let rainFc = 0, probFc = r.uniform(0, 25)
    if (actual >= 5) {
      if (r.next() < FORECAST_MODEL.rainDetection) { rainFc = actual * r.uniform(0.7, 1.3); probFc = r.uniform(60, 95) } else probFc = r.uniform(10, 35)
    } else if (actual >= 1) { rainFc = actual * r.uniform(0.5, 1.5); probFc = r.uniform(30, 70) }
    else if (r.next() < FORECAST_MODEL.falseAlarm) { rainFc = r.uniform(4, 14); probFc = r.uniform(50, 70) }

    // SunShift plans on the forecast.
    const jobs: Job[] = []
    const need: Record<number, number> = {}
    const ags = new Map<number, ReturnType<typeof assessFarm>>()
    for (const f of FARMS) {
      const st = ss.get(f.id)!
      const ag = assessFarm({ farm: f, das: st.das, drStart: st.dr, et0: et0Fc, rainForecastMm: rainFc, rainProb: probFc, availableSlotCount: allowed.get(f.id)!.length, demandScale: req.demandScale ?? 1, refilling: st.refilling, feeder })
      ags.set(f.id, ag)
      need[f.id] = ag.volumeM3
      const pr = priorityFor(ag, st.servedYesterday, probFc)
      jobs.push({ farmId: f.id, powerKw: f.pumpKw, flowM3h: f.flowM3h, requiredSlots: ag.requiredSlots, allowed: allowed.get(f.id)!, weight: pr.weight, minRun: feeder.min_run_slots, maxStarts: feeder.max_starts, minOff: feeder.min_off_slots, carry: st.servedYesterday })
    }
    const on = greedy({ jobs, solarKw: solarFc, feederLimitKw: feeder.feeder_limit_kw, gridCapKw: feeder.grid_backup_kw, slots: feeder.slots })
    const mSs = evaluate({ on, farms, solarKw: pv.acKw, feeder, needM3: need })

    // Business as usual.
    const seasonalEt0 = climatologicalEt0(Number(day.slice(5, 7)), loc)
    const bauOn: Record<number, number[]> = {}
    const bauNeed: Record<number, number> = {}
    for (const f of FARMS) {
      const st = bau.get(f.id)!
      const crop = CROPS[f.crop]
      const taw = totalAvailableWater(SOILS[f.soil], rootDepth(crop, st.das))
      const agTrue = assessFarm({ farm: f, das: st.das, drStart: st.dr, et0: dw.daily.et0, rainForecastMm: 0, rainProb: 0, availableSlotCount: allowed.get(f.id)!.length, demandScale: req.demandScale ?? 1, feeder })
      bauNeed[f.id] = agTrue.volumeM3
      const stage = cropStage(crop, st.das)
      if (stage === -1 || stage === 4) continue
      const method = METHODS[f.method]
      const startSlot = Math.max(0, timeToSlot(f.habit_start, feeder))
      const window = allowed.get(f.id)!.filter((s) => s >= startSlot)
      const hpd = (factor * kcAt(crop, st.das) * seasonalEt0 * f.area_ha * 10) / method.efficiency / f.flowM3h
      const rotation = bauRotation(f, hpd, allowed.get(f.id)!.length * h)
      let go: boolean
      if (taw > 0 && st.dr >= 0.9 * taw) go = true
      else if (prevRain >= POLICY.observed_rain_skip_mm && st.daysSince < rotation + 2) go = false
      else go = st.daysSince + 1 >= rotation
      if (!go) continue
      const hours = Math.min(window.length * h, hpd * rotation)
      const n = Math.max(feeder.min_run_slots, Math.round((hours * 60) / feeder.slot_minutes))
      bauOn[f.id] = window.slice(0, n)
    }
    const mBau = evaluate({ on: bauOn, farms, solarKw: pv.acKw, feeder, needM3: bauNeed })

    const stats: Record<'sunshift' | 'bau', SeasonDayStrategy> = {} as never
    for (const [key, states, m, needs] of [['sunshift', ss, mSs, need], ['bau', bau, mBau, bauNeed]] as const) {
      let stress = 0, ksSum = 0, dpSum = 0, active = 0
      for (const f of FARMS) {
        const st = states.get(f.id)!
        const crop = CROPS[f.crop]
        const stage = cropStage(crop, st.das)
        const etc = kcAt(crop, st.das) * dw.daily.et0 * (req.demandScale ?? 1)
        const taw = totalAvailableWater(SOILS[f.soil], rootDepth(crop, st.das))
        const raw = depletionFraction(crop, etc) * taw
        const water = m.waterByFarm[f.id] ?? 0
        const irrNet = (water / (f.area_ha * 10)) * METHODS[f.method].efficiency
        const wb = waterBalanceDay({ dr: Math.min(st.dr, taw), taw, raw, etc, rain: dw.daily.rainMm, et0: dw.daily.et0, irrigationNet: irrNet })
        st.dr = wb.drEnd
        if (stage >= 0 && stage <= 3) {
          active++
          st.etaSum += wb.eta
          st.etcSum += wb.etc
          if (wb.ks < 0.999) stress++
          ksSum += wb.ks
        }
        dpSum += wb.deepPercolation * f.area_ha * 10
        st.das++
        const nd = needs[f.id] ?? 0
        st.needM3 += nd
        st.usefulM3 += Math.min(water, nd)
        if (key === 'sunshift') {
          st.refilling = water > 0 && wb.drEnd > ags.get(f.id)!.targetMm + 1
          st.servedYesterday = nd > 1e-6 ? Math.min(1, water / nd) : 1
        } else st.daysSince = water > 0 ? 0 : st.daysSince + 1
      }
      stats[key] = {
        waterM3: m.waterM3, energyKwh: m.energyKwh, gridKwh: m.gridKwh, solarUsedKwh: m.solarUsedKwh,
        solarAvailableKwh: m.solarAvailableKwh, peakKw: m.peakDeliveredKw, peakDemandKw: m.peakDemandKw,
        overloadSlots: m.overloadSlots, stressFarms: stress, meanKs: active ? ksSum / active : 1,
        deepPercolationM3: dpSum, adequacy: m.adequacy, jain: m.fairnessJain, solarUtilisation: m.solarUtilisation,
        farmsIrrigated: Object.values(m.waterByFarm).filter((v) => v > 0).length,
      }
      const t = totals[key]
      t.water += m.waterM3; t.energy += m.energyKwh; t.grid += m.gridKwh; t.solarUsed += m.solarUsedKwh
      t.solarAvail += m.solarAvailableKwh; t.overload += m.overloadSlots; t.deepPerc += dpSum
      t.peak = Math.max(t.peak, m.peakDeliveredKw); t.stress += stress
    }
    stats.sunshift.solver = { status: 'HEURISTIC', wallTimeS: 0 }
    prevRain = dw.daily.rainMm
    onEvent({
      type: 'day', index: k, date: day, et0: dw.daily.et0, rainMm: dw.daily.rainMm, forecastRainMm: rainFc,
      forecastRainProb: probFc, solarKwh: pv.energyKwh, solarForecastFactor: solarFactor, sunshift: stats.sunshift, bau: stats.bau,
    })
    await new Promise((res) => setTimeout(res, 0))
  }

  const summarise = (states: Map<number, State>, key: 'sunshift' | 'bau'): SeasonSummary => {
    const t = totals[key]
    const ry: number[] = []
    const served: number[] = []
    for (const f of FARMS) {
      const st = states.get(f.id)!
      if (st.etcSum > 0) ry.push(Math.max(0, 1 - CROPS[f.crop].ky * (1 - st.etaSum / st.etcSum)))
      if (st.needM3 > 1e-6) served.push(Math.min(1, st.usefulM3 / st.needM3))
    }
    return {
      waterM3: t.water, energyKwh: t.energy, gridKwh: t.grid, solarUsedKwh: t.solarUsed, solarAvailableKwh: t.solarAvail,
      solarShare: t.energy > 0 ? t.solarUsed / t.energy : 0, solarUtilisation: t.solarAvail > 0 ? t.solarUsed / t.solarAvail : 0,
      peakKw: t.peak, overloadSlots: t.overload, deepPercolationM3: t.deepPerc, stressFarmDays: t.stress,
      relativeYield: ry.length ? ry.reduce((a, b) => a + b, 0) / ry.length : 1, fairnessJain: jainIndex(served),
    }
  }
  onEvent({
    type: 'summary', sunshift: summarise(ss, 'sunshift'), bau: summarise(bau, 'bau'), elapsedS: (performance.now() - t0) / 1000,
    notes: [
      'Computed in the browser with the greedy heuristic because the CP-SAT API is unreachable.',
      `Business-as-usual: ${factor.toFixed(2)}× the month's climatological crop need on fixed rotations at habitual start times.`,
    ],
  })
}
