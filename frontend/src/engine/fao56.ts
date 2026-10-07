// FAO-56 agronomy, mirrored from backend/app/engine/agronomy.py.
// Equation numbers refer to FAO Irrigation and Drainage Paper 56.
import type { CropDef, FarmDef, FeederDef, MethodDef, SoilDef } from './scenario'
import { CROPS, FEEDER, METHODS, POLICY, SOILS } from './scenario'

const SIGMA = 4.903e-9
const ALBEDO = 0.23

export const satVapourPressure = (t: number) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3)) // Eq. 11
export const svpSlope = (t: number) => (4098 * satVapourPressure(t)) / (t + 237.3) ** 2 // Eq. 13
export const atmosphericPressure = (z: number) => 101.3 * ((293 - 0.0065 * z) / 293) ** 5.26 // Eq. 7
export const psychrometricConstant = (p: number) => 0.000665 * p // Eq. 8
export const windAt2m = (u: number, h = 10) => (u * 4.87) / Math.log(67.8 * h - 5.42) // Eq. 47

export function extraterrestrialRadiation(latDeg: number, doy: number): number {
  const phi = (latDeg * Math.PI) / 180
  const dr = 1 + 0.033 * Math.cos(((2 * Math.PI) / 365) * doy)
  const dec = 0.409 * Math.sin(((2 * Math.PI) / 365) * doy - 1.39)
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(dec))))
  return ((24 * 60) / Math.PI) * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(ws))
}

export interface ET0Input {
  tmax: number
  tmin: number
  rs: number // MJ m-2 d-1
  u2: number // m/s at 2 m
  lat: number
  elevation: number
  doy: number
  rhMax?: number
  rhMin?: number
  rhMean?: number
}

export interface ET0Result {
  et0: number
  tmean: number
  delta: number
  gamma: number
  es: number
  ea: number
  ra: number
  rso: number
  rns: number
  rnl: number
  rn: number
  u2: number
  radiationTerm: number
  aeroTerm: number
}

export function et0PenmanMonteith(i: ET0Input): ET0Result {
  const tmean = (i.tmax + i.tmin) / 2
  const delta = svpSlope(tmean)
  const gamma = psychrometricConstant(atmosphericPressure(i.elevation))
  const es = (satVapourPressure(i.tmax) + satVapourPressure(i.tmin)) / 2
  let ea: number
  if (i.rhMax != null && i.rhMin != null) {
    ea = ((satVapourPressure(i.tmin) * i.rhMax) / 100 + (satVapourPressure(i.tmax) * i.rhMin) / 100) / 2 // Eq. 17
  } else if (i.rhMean != null) {
    ea = (i.rhMean / 100) * es // Eq. 19
  } else {
    ea = satVapourPressure(i.tmin)
  }
  const ra = extraterrestrialRadiation(i.lat, i.doy)
  const rso = (0.75 + 2e-5 * i.elevation) * ra
  const rns = (1 - ALBEDO) * i.rs
  const rel = rso > 0 ? Math.min(i.rs / rso, 1) : 0.5
  const rnl =
    SIGMA *
    (((i.tmax + 273.16) ** 4 + (i.tmin + 273.16) ** 4) / 2) *
    (0.34 - 0.14 * Math.sqrt(Math.max(ea, 0))) *
    (1.35 * rel - 0.35)
  const rn = rns - rnl
  const den = delta + gamma * (1 + 0.34 * i.u2)
  const radiationTerm = (0.408 * delta * rn) / den
  const aeroTerm = (gamma * (900 / (tmean + 273)) * i.u2 * (es - ea)) / den
  return {
    et0: Math.max(0, radiationTerm + aeroTerm),
    tmean, delta, gamma, es, ea, ra, rso, rns, rnl, rn, u2: i.u2, radiationTerm, aeroTerm,
  }
}

export const dayOfYear = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  const start = Date.UTC(d.getUTCFullYear(), 0, 0)
  return Math.round((d.getTime() - start) / 86400000)
}

// ------------------------------------------------------------- crops

export function seasonDays(crop: CropDef): number {
  return crop.stages.reduce((a, b) => a + b, 0)
}

export function cropStage(crop: CropDef, das: number): number {
  if (das < 0) return -1
  let acc = 0
  for (let i = 0; i < 4; i++) {
    acc += crop.stages[i]
    if (das < acc) return i
  }
  return 4
}

export function kcAt(crop: CropDef, das: number): number {
  const [li, ld, lm, ll] = crop.stages
  const [ki, km, ke] = crop.kc
  if (das < 0) return 0
  if (das <= li) return ki
  if (das <= li + ld) return ki + ((das - li) / ld) * (km - ki)
  if (das <= li + ld + lm) return km
  if (das <= seasonDays(crop)) return km + ((das - li - ld - lm) / ll) * (ke - km)
  return 0
}

export function rootDepth(crop: CropDef, das: number): number {
  const [zmin, zmax] = crop.zr
  const grow = crop.stages[0] + crop.stages[1]
  return zmin + (zmax - zmin) * Math.max(0, Math.min(1, das / grow))
}

export const depletionFraction = (crop: CropDef, etc: number) => Math.max(0.1, Math.min(0.8, crop.p + 0.04 * (5 - etc)))
export const totalAvailableWater = (soil: SoilDef, zr: number) => 1000 * (soil.fc - soil.wp) * zr

export function stressCoefficient(dr: number, taw: number, raw: number): number {
  if (dr <= raw) return 1
  if (taw <= raw) return 0
  return Math.max(0, (taw - dr) / (taw - raw))
}

export function effectiveRain(rain: number, et0: number): [number, number] {
  if (rain < 0.2 * et0 || rain < 0.5) return [0, 0]
  const runoff = Math.max(0, rain - 25) * 0.35
  return [rain - runoff, runoff]
}

export interface WaterBalanceDay {
  drStart: number
  drEnd: number
  etc: number
  eta: number
  ks: number
  rainEffective: number
  runoff: number
  irrigationNet: number
  deepPercolation: number
}

export function waterBalanceDay(a: {
  dr: number
  taw: number
  raw: number
  etc: number
  rain: number
  et0: number
  irrigationNet: number
}): WaterBalanceDay {
  const ks = stressCoefficient(a.dr, a.taw, a.raw)
  const eta = ks * a.etc
  const [pe, ro] = effectiveRain(a.rain, a.et0)
  let dr = a.dr - pe - a.irrigationNet + eta
  let dp = 0
  if (dr < 0) {
    dp = -dr
    dr = 0
  }
  dr = Math.min(dr, a.taw)
  return { drStart: a.dr, drEnd: dr, etc: a.etc, eta, ks, rainEffective: pe, runoff: ro, irrigationNet: a.irrigationNet, deepPercolation: dp }
}

export interface FarmAgronomy {
  das: number
  stage: number
  stageLabel: string
  kc: number
  etc: number
  zr: number
  taw: number
  raw: number
  p: number
  drStart: number
  drProjected: number
  ksStart: number
  triggerMm: number
  targetMm: number
  needNetMm: number
  rainExpectedMm: number
  needAfterRainMm: number
  deferred: boolean
  grossMm: number
  volumeM3: number
  pumpHours: number
  requiredSlots: number
  capacityLimited: boolean
  status: 'SAFE' | 'WATCH' | 'STRESS'
  sensitivity: number
}

export function assessFarm(a: {
  farm: FarmDef
  das: number
  drStart: number
  et0: number
  rainForecastMm: number
  rainProb: number
  availableSlotCount: number
  demandScale?: number
  refilling?: boolean
  feeder?: FeederDef
}): FarmAgronomy {
  const feeder = a.feeder ?? FEEDER
  const crop = CROPS[a.farm.crop]
  const soil = SOILS[a.farm.soil]
  const method: MethodDef = METHODS[a.farm.method]
  const stage = cropStage(crop, a.das)
  const kc = kcAt(crop, a.das)
  const etc = kc * a.et0 * (a.demandScale ?? 1)
  const zr = rootDepth(crop, a.das)
  const taw = totalAvailableWater(soil, zr)
  const p = depletionFraction(crop, etc)
  const raw = p * taw
  const drStart = Math.min(a.drStart, taw)
  const ksStart = stressCoefficient(drStart, taw, raw)
  const drProj = Math.min(taw, drStart + etc)
  const trigger = method.trigger_frac_raw * raw
  const target = method.target_frac_raw * raw

  let needNet = 0
  if (stage !== -1 && stage !== 4 && (drProj >= trigger || (a.refilling && drProj > target + 1))) {
    const backlog = Math.max(0, drStart - target)
    needNet = Math.min(Math.max(0, drProj - target), etc + POLICY.catch_up_rate * backlog)
  }

  let rainExpected = 0
  if (a.rainProb >= POLICY.rain_defer_prob && a.rainForecastMm >= POLICY.rain_min_mm) {
    rainExpected = effectiveRain(a.rainForecastMm, a.et0)[0]
  }
  let needAfter = needNet
  let deferred = false
  if (needNet > 0 && rainExpected > 0 && drProj - rainExpected < raw) {
    needAfter = Math.max(0, needNet - rainExpected)
    if (needAfter < 0.5 * Math.max(trigger - target, 3)) {
      needAfter = 0
      deferred = true
    }
  }

  let gross = needAfter / method.efficiency
  let volume = gross * a.farm.area_ha * 10
  let hours = a.farm.flowM3h > 0 ? volume / a.farm.flowM3h : 0
  const windowHours = (a.availableSlotCount * feeder.slot_minutes) / 60
  const maxHours = drProj >= raw ? windowHours : Math.min(method.max_daily_hours, windowHours)
  const capacityLimited = hours > maxHours + 1e-9
  if (capacityLimited) {
    hours = maxHours
    volume = hours * a.farm.flowM3h
    gross = volume / (a.farm.area_ha * 10)
    needAfter = gross * method.efficiency
  }
  let slots = hours > 0 ? Math.ceil((hours * 60) / feeder.slot_minutes - 1e-6) : 0
  if (slots > 0 && slots < feeder.min_run_slots) slots = feeder.min_run_slots
  slots = Math.min(slots, a.availableSlotCount)

  const status = ksStart < 1 ? 'STRESS' : drProj >= trigger ? 'WATCH' : 'SAFE'
  const sensitivity = stage >= 0 && stage <= 3 ? Math.min(1, crop.stage_ky[stage] / 1.5) : 0
  const stageLabel = stage >= 0 && stage <= 3 ? crop.stage_labels[stage] : stage === 4 ? 'Harvested' : 'Not sown'

  return {
    das: a.das, stage, stageLabel, kc, etc, zr, taw, raw, p, drStart, drProjected: drProj, ksStart,
    triggerMm: trigger, targetMm: target, needNetMm: needNet, rainExpectedMm: rainExpected,
    needAfterRainMm: needAfter, deferred, grossMm: gross, volumeM3: volume, pumpHours: hours,
    requiredSlots: slots, capacityLimited, status, sensitivity,
  }
}
