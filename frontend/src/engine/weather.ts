// Browser weather: Open-Meteo directly (it allows CORS), assembled with the same rules as
// backend/app/engine/weather.py. Falls back to clear-sky shaped climatology.
import type { DayWeather, WeatherMode } from '@/api/types'
import { dayOfYear, et0PenmanMonteith, windAt2m } from './fao56'
import type { FeederDef, LocationDef } from './scenario'
import { FEEDER, POLICY } from './scenario'
import { clearSky, erbs, slotMidUtc, solarPosition } from './solar'

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const HOURLY = [
  'temperature_2m', 'relative_humidity_2m', 'wind_speed_10m', 'shortwave_radiation',
  'direct_normal_irradiance', 'diffuse_radiation', 'cloud_cover', 'precipitation', 'precipitation_probability',
]
const M15 = ['shortwave_radiation', 'direct_normal_irradiance', 'diffuse_radiation', 'temperature_2m', 'wind_speed_10m']

// Monthly normals for the Deccan plateau: Tmax, Tmin, RH mean, u2, Rs, rain mm, rainy days.
const CLIMATOLOGY: Record<number, [number, number, number, number, number, number, number]> = {
  1: [29.5, 15.5, 60, 1.8, 17.5, 8, 1], 2: [32.5, 18, 52, 2, 20, 8, 1], 3: [36, 21.5, 44, 2.1, 22, 12, 1],
  4: [39, 25, 42, 2.3, 23.5, 18, 2], 5: [41, 28, 42, 2.8, 24, 30, 3], 6: [36, 26.5, 60, 3.3, 19, 130, 8],
  7: [31.5, 24.5, 75, 3.2, 15.5, 230, 14], 8: [31, 24, 78, 2.8, 15.5, 220, 14], 9: [32, 23.5, 75, 2, 16.5, 170, 10],
  10: [31.5, 21.5, 68, 1.7, 17, 90, 5], 11: [30, 17.5, 62, 1.7, 16.5, 20, 2], 12: [29, 14.5, 60, 1.7, 16, 5, 0.5],
}

type Payload = {
  hourly: Record<string, (number | null)[]> & { time: string[] }
  minutely_15?: Record<string, (number | null)[]> & { time: string[] }
  daily?: Record<string, (number | string | null)[]> & { time: string[] }
}

const cache = new Map<string, { at: number; data: Payload }>()

function clean(values: (number | null | undefined)[]): number[] {
  const arr = values.map((v) => (v == null ? NaN : v))
  const good = arr.map((v, i) => [i, v] as const).filter(([, v]) => !Number.isNaN(v))
  if (!good.length) return arr.map(() => 0)
  return arr.map((v, i) => {
    if (!Number.isNaN(v)) return v
    const before = [...good].reverse().find(([j]) => j < i)
    const after = good.find(([j]) => j > i)
    if (before && after) return before[1] + ((after[1] - before[1]) * (i - before[0])) / (after[0] - before[0])
    return (before ?? after)![1]
  })
}

function interp(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) return ys[0]
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1]
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1])
  }
  return ys[ys.length - 1]
}

export async function fetchForecast(loc: LocationDef, signal?: AbortSignal): Promise<Payload> {
  const key = `${loc.lat},${loc.lon}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 20 * 60 * 1000) return hit.data
  const params = new URLSearchParams({
    latitude: String(loc.lat), longitude: String(loc.lon), timezone: 'Asia/Kolkata', wind_speed_unit: 'ms',
    past_days: '1', forecast_days: '4', hourly: HOURLY.join(','), minutely_15: M15.join(','),
    daily: 'et0_fao_evapotranspiration,precipitation_sum,precipitation_probability_max,sunrise,sunset',
  })
  const res = await fetch(`${FORECAST_URL}?${params}`, { signal })
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`)
  const data = (await res.json()) as Payload
  cache.set(key, { at: Date.now(), data })
  return data
}

export function assembleDay(payload: Payload, day: string, loc: LocationDef, feeder: FeederDef = FEEDER): DayWeather {
  const h = payload.hourly
  const idx = h.time.map((t, i) => [t, i] as const).filter(([t]) => t.startsWith(day)).map(([, i]) => i)
  if (idx.length < 24) throw new Error(`no hourly data for ${day}`)
  const pick = (k: string) => clean(idx.map((i) => h[k]?.[i] ?? null))
  const hours = Array.from({ length: 24 }, (_, i) => i)
  const mids = Array.from({ length: feeder.slots }, (_, s) => feeder.day_start_hour + ((s + 0.5) * feeder.slot_minutes) / 60)
  const H = Object.fromEntries(HOURLY.map((k) => [k, pick(k)])) as Record<string, number[]>

  let ghi: number[], dni: number[], dhi: number[], temp: number[], wind: number[]
  const m15 = payload.minutely_15
  const ends = Array.from({ length: feeder.slots }, (_, s) => {
    const minutes = feeder.day_start_hour * 60 + (s + 1) * feeder.slot_minutes
    return `${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  })
  const mIndex = m15 ? new Map(m15.time.map((t, i) => [t, i])) : null
  if (m15 && mIndex && ends.every((e) => mIndex.has(e))) {
    const sel = (k: string) => clean(ends.map((e) => m15[k]?.[mIndex.get(e)!] ?? null))
    ghi = sel('shortwave_radiation'); dni = sel('direct_normal_irradiance'); dhi = sel('diffuse_radiation')
    temp = sel('temperature_2m'); wind = sel('wind_speed_10m')
  } else {
    const centred = hours.map((x) => x - 0.5)
    ghi = mids.map((m) => interp(m, centred, H.shortwave_radiation))
    dni = mids.map((m) => interp(m, centred, H.direct_normal_irradiance))
    dhi = mids.map((m) => interp(m, centred, H.diffuse_radiation))
    temp = mids.map((m) => interp(m, hours, H.temperature_2m))
    wind = mids.map((m) => interp(m, hours, H.wind_speed_10m))
  }
  const bucket = mids.map((m) => Math.min(23, Math.ceil(m)))
  const slotH = feeder.slot_minutes / 60
  const precip = bucket.map((b) => H.precipitation[b] * slotH)
  const prob = bucket.map((b) => H.precipitation_probability[b])

  const tmax = Math.max(...H.temperature_2m)
  const tmin = Math.min(...H.temperature_2m)
  const rhMax = Math.max(...H.relative_humidity_2m)
  const rhMin = Math.min(...H.relative_humidity_2m)
  const rhMean = H.relative_humidity_2m.reduce((a, b) => a + b, 0) / 24
  const u2 = windAt2m(H.wind_speed_10m.reduce((a, b) => a + b, 0) / 24)
  const rs = (H.shortwave_radiation.reduce((a, b) => a + b, 0) * 3600) / 1e6
  const et = et0PenmanMonteith({ tmax, tmin, rs, u2, lat: loc.lat, elevation: loc.elevation_m, doy: dayOfYear(day), rhMax, rhMin })

  const start = idx[0] + feeder.day_start_hour
  const end = Math.min(h.time.length, start + POLICY.rain_lookahead_h)
  const look = clean((h.precipitation ?? []).slice(start, end))
  const lookProb = clean((h.precipitation_probability ?? []).slice(start, end))
  const d = payload.daily
  const di = d ? d.time.indexOf(day) : -1
  const r1 = (v: number) => Math.round(v * 10) / 10

  return {
    date: day,
    source: 'browser-live',
    sourceDetail: 'Open-Meteo forecast fetched by the browser (API offline)',
    fetchedAt: new Date().toISOString(),
    slots: {
      ghi: ghi.map((v) => Math.max(0, v)), dni: dni.map((v) => Math.max(0, v)), dhi: dhi.map((v) => Math.max(0, v)),
      temp, wind10: wind, cloud: mids.map((m) => interp(m, hours, H.cloud_cover)), precip, precipProb: prob,
    },
    daily: {
      tmax: r1(tmax), tmin: r1(tmin), rhMax: Math.round(rhMax), rhMin: Math.round(rhMin), rhMean: Math.round(rhMean),
      u2: Math.round(u2 * 100) / 100, rs: Math.round(rs * 100) / 100,
      rainMm: r1(H.precipitation.reduce((a, b) => a + b, 0)), rainProb: Math.max(...H.precipitation_probability),
      et0: Math.round(et.et0 * 100) / 100,
      et0Reference: di >= 0 ? (d!.et0_fao_evapotranspiration?.[di] as number | null) ?? null : null,
      et0Parts: { ...et } as unknown as Record<string, number>,
      sunrise: di >= 0 ? (d!.sunrise?.[di] as string) ?? null : null,
      sunset: di >= 0 ? (d!.sunset?.[di] as string) ?? null : null,
      lookaheadRainMm: r1(look.reduce((a, b) => a + b, 0)), lookaheadRainProb: Math.max(0, ...lookProb),
    },
    hourly: hours.map((hh) => ({
      hour: hh, temp: H.temperature_2m[hh], rh: H.relative_humidity_2m[hh], wind10: H.wind_speed_10m[hh],
      ghi: H.shortwave_radiation[hh], cloud: H.cloud_cover[hh], precip: H.precipitation[hh], prob: H.precipitation_probability[hh],
    })),
    modifications: [],
  }
}

export function climatologicalEt0(month: number, loc: LocationDef): number {
  const [tmax, tmin, rhMean, u2, rs] = CLIMATOLOGY[month]
  return et0PenmanMonteith({ tmax, tmin, rs, u2, lat: loc.lat, elevation: loc.elevation_m, doy: dayOfYear(`2025-${String(month).padStart(2, '0')}-15`), rhMean }).et0
}

export async function fetchArchive(loc: LocationDef, start: string, end: string, signal?: AbortSignal): Promise<Payload> {
  const params = new URLSearchParams({
    latitude: String(loc.lat), longitude: String(loc.lon), timezone: 'Asia/Kolkata', wind_speed_unit: 'ms',
    start_date: start, end_date: end, hourly: HOURLY.filter((k) => k !== 'precipitation_probability').join(','),
    daily: 'et0_fao_evapotranspiration,precipitation_sum',
  })
  const res = await fetch(`https://archive-api.open-meteo.com/v1/archive?${params}`, { signal })
  if (!res.ok) throw new Error(`Open-Meteo archive ${res.status}`)
  return (await res.json()) as Payload
}

export function climatologyDay(day: string, loc: LocationDef, feeder: FeederDef = FEEDER): DayWeather {
  const month = Number(day.slice(5, 7))
  const [tmax, tmin, rhMean, u2, rsNorm, rainMonth, rainDays] = CLIMATOLOGY[month]
  const doy = dayOfYear(day)
  let rsClear = 0
  for (let hh = 0; hh < 24; hh++) {
    const sun = solarPosition(new Date(Date.parse(`${day}T00:00:00Z`) + (hh * 60 + 30 - 330) * 60000), loc.lat, loc.lon)
    rsClear += (clearSky(sun.zenith, loc.elevation_m, doy).ghi * 3600) / 1e6
  }
  const kt = rsClear > 0 ? Math.min(1, rsNorm / rsClear) : 0.7
  const ghi: number[] = [], dni: number[] = [], dhi: number[] = [], temp: number[] = []
  for (let s = 0; s < feeder.slots; s++) {
    const sun = solarPosition(slotMidUtc(day, s, feeder), loc.lat, loc.lon)
    const g = clearSky(sun.zenith, loc.elevation_m, doy).ghi * kt
    const split = erbs(g, sun.zenith, doy)
    ghi.push(g); dni.push(split.dni); dhi.push(split.dhi)
    const mid = feeder.day_start_hour + ((s + 0.5) * feeder.slot_minutes) / 60
    temp.push(tmin + (tmax - tmin) * Math.max(0, Math.sin((Math.PI * (mid - 6)) / 18)) ** 1.2)
  }
  const prob = Math.min(95, (100 * rainDays) / 30)
  const et = et0PenmanMonteith({ tmax, tmin, rs: rsNorm, u2, lat: loc.lat, elevation: loc.elevation_m, doy, rhMean })
  void rainMonth
  return {
    date: day,
    source: 'browser-clear-sky',
    sourceDetail: 'No forecast reachable: approximate monthly normals shaped by a clear-sky model',
    fetchedAt: null,
    slots: {
      ghi, dni, dhi, temp, wind10: ghi.map(() => u2 / 0.748), cloud: ghi.map(() => 100 * (1 - kt)),
      precip: ghi.map(() => 0), precipProb: ghi.map(() => prob),
    },
    daily: {
      tmax, tmin, rhMax: Math.min(100, rhMean + 18), rhMin: Math.max(15, rhMean - 18), rhMean, u2, rs: rsNorm,
      rainMm: 0, rainProb: prob, et0: Math.round(et.et0 * 100) / 100, et0Reference: null,
      et0Parts: { ...et } as unknown as Record<string, number>, sunrise: null, sunset: null,
      lookaheadRainMm: 0, lookaheadRainProb: prob,
    },
    hourly: [],
    modifications: [],
  }
}

/** Apply the same scenario modes as the backend, on top of the base weather. */
export function applyMode(
  base: DayWeather,
  mode: WeatherMode,
  loc: LocationDef,
  opts: { rainMm?: number; rainProb?: number; rainStartHour?: number; solarEvent?: { fromSlot: number; factor: number } | null } = {},
  feeder: FeederDef = FEEDER,
): DayWeather {
  const dw: DayWeather = JSON.parse(JSON.stringify(base))
  const s = dw.slots
  const doy = dayOfYear(dw.date)
  const mids = s.ghi.map((_, k) => feeder.day_start_hour + ((k + 0.5) * feeder.slot_minutes) / 60)
  const recompute = () => {
    const et = et0PenmanMonteith({
      tmax: dw.daily.tmax, tmin: dw.daily.tmin, rs: dw.daily.rs, u2: dw.daily.u2, lat: loc.lat,
      elevation: loc.elevation_m, doy, rhMax: dw.daily.rhMax, rhMin: dw.daily.rhMin,
    })
    dw.daily.et0 = Math.round(et.et0 * 100) / 100
  }
  const scaleRs = (old: number[]) => {
    const before = old.reduce((a, b) => a + b, 0)
    if (before > 0) dw.daily.rs *= s.ghi.reduce((a, b) => a + b, 0) / before
  }
  if (mode === 'clear' || mode === 'cloudy') {
    const old = [...s.ghi]
    for (let k = 0; k < s.ghi.length; k++) {
      const sun = solarPosition(slotMidUtc(dw.date, k, feeder), loc.lat, loc.lon)
      const cs = clearSky(sun.zenith, loc.elevation_m, doy)
      if (mode === 'clear') {
        s.ghi[k] = cs.ghi; s.dni[k] = cs.dni; s.dhi[k] = cs.dhi
      } else {
        const ripple = 1 + 0.18 * Math.sin(mids[k] * 2.1) * Math.cos(mids[k] * 0.7)
        s.ghi[k] = cs.ghi * 0.38 * ripple
        s.dni[k] = cs.dni * 0.05
        s.dhi[k] = Math.max(0, s.ghi[k] - s.dni[k] * Math.cos((sun.zenith * Math.PI) / 180))
      }
    }
    scaleRs(old)
    if (mode === 'clear') {
      s.cloud = s.cloud.map(() => 0); s.precip = s.precip.map(() => 0); s.precipProb = s.precipProb.map(() => 0)
      dw.daily.rainMm = 0; dw.daily.rainProb = 0; dw.daily.lookaheadRainMm = 0; dw.daily.lookaheadRainProb = 0
      dw.modifications.push('Clear-sky irradiance; forecast rain removed')
    } else {
      s.cloud = s.cloud.map(() => 92)
      dw.daily.rhMax = Math.min(100, dw.daily.rhMax + 8); dw.daily.rhMin = Math.min(100, dw.daily.rhMin + 12)
      dw.modifications.push('Overcast day: irradiance ~38% of clear-sky')
    }
    recompute()
  } else if (mode === 'heatwave') {
    dw.daily.tmax += 4; dw.daily.tmin += 2.5; s.temp = s.temp.map((t) => t + 3.5)
    dw.daily.rhMax = Math.max(20, dw.daily.rhMax - 15); dw.daily.rhMin = Math.max(8, dw.daily.rhMin - 15)
    dw.daily.u2 *= 1.3
    recompute()
    dw.modifications.push('Heatwave: +4 °C, −15% RH, +30% wind')
  } else if (mode === 'rain') {
    const mm = opts.rainMm ?? 18, prob = opts.rainProb ?? 85, onset = opts.rainStartHour ?? 13
    const old = [...s.ghi]
    const shares = [0.4, 0.35, 0.25]
    mids.forEach((mid, k) => {
      if (mid >= onset - 1 && mid < onset) { s.ghi[k] *= 0.55; s.dni[k] *= 0.3 }
      else if (mid >= onset && mid < onset + 3) {
        s.ghi[k] *= 0.18; s.dni[k] *= 0.02
        s.precip[k] += (mm * shares[Math.min(2, Math.floor(mid - onset))] * feeder.slot_minutes) / 60
        s.precipProb[k] = Math.max(s.precipProb[k], prob); s.cloud[k] = 100
      } else if (mid >= onset + 3) { s.ghi[k] *= 0.5; s.dni[k] *= 0.35 }
      s.dhi[k] = Math.min(s.dhi[k], s.ghi[k])
    })
    scaleRs(old)
    dw.daily.rainMm += mm; dw.daily.rainProb = Math.max(dw.daily.rainProb, prob)
    dw.daily.lookaheadRainMm += mm; dw.daily.lookaheadRainProb = Math.max(dw.daily.lookaheadRainProb, prob)
    dw.daily.rhMin = Math.min(100, dw.daily.rhMin + 20)
    recompute()
    dw.modifications.push(`Rain event injected: ${mm.toFixed(0)} mm from ${String(Math.floor(onset)).padStart(2, '0')}:00 (${prob}% probability)`)
  }
  if (opts.solarEvent) {
    const { fromSlot, factor } = opts.solarEvent
    for (let k = fromSlot; k < s.ghi.length; k++) { s.ghi[k] *= factor; s.dni[k] *= factor; s.dhi[k] *= factor }
    dw.modifications.push(`Cloud bank from slot ${fromSlot}: irradiance × ${factor.toFixed(2)} (solar forecast revised)`)
  }
  return dw
}
