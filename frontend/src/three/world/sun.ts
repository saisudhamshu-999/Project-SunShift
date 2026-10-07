import { Color, Vector3 } from 'three'
import { istToUtc, solarPosition } from '@/engine/solar'
import { location } from '@/engine/scenario'

export interface SunState {
  dir: Vector3 // unit vector towards the sun
  elevation: number
  azimuth: number
  light: Color
  intensity: number
  skyTop: Color
  skyHorizon: Color
  ground: Color
  ambient: number
}

const KEYS: [number, string, string, string, number, number][] = [
  // elevation, sky top, horizon, light colour, light intensity, ambient
  [-12, '#0d1222', '#1b2236', '#3a4a7a', 0.0, 0.25],
  [-4, '#27304c', '#d98a5f', '#ff9a66', 0.15, 0.35],
  [2, '#5f7aa3', '#f0b27e', '#ffb27a', 0.9, 0.55],
  [10, '#8daed1', '#f3d2a6', '#ffd9a8', 1.9, 0.75],
  [25, '#a8c4df', '#f1e4cc', '#fff0d8', 2.6, 0.9],
  [60, '#b4cde3', '#f1ebdd', '#fffaf0', 3.0, 1.0],
]

const tmp = { a: new Color(), b: new Color() }

function mix(hexA: string, hexB: string, t: number, out: Color) {
  tmp.a.set(hexA)
  tmp.b.set(hexB)
  return out.copy(tmp.a).lerp(tmp.b, t)
}

/** Sky and light colours as a function of solar elevation. */
export function sunFromAngles(elevation: number, azimuth: number): SunState {
  let i = 0
  while (i < KEYS.length - 2 && elevation > KEYS[i + 1][0]) i++
  const [e0, top0, hor0, light0, int0, amb0] = KEYS[i]
  const [e1, top1, hor1, light1, int1, amb1] = KEYS[i + 1]
  const t = Math.max(0, Math.min(1, (elevation - e0) / (e1 - e0)))
  const el = (elevation * Math.PI) / 180
  const az = (azimuth * Math.PI) / 180
  const dir = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize()
  return {
    dir,
    elevation,
    azimuth,
    skyTop: mix(top0, top1, t, new Color()),
    skyHorizon: mix(hor0, hor1, t, new Color()),
    light: mix(light0, light1, t, new Color()),
    intensity: int0 + (int1 - int0) * t,
    ambient: amb0 + (amb1 - amb0) * t,
    ground: new Color('#b49a74').multiplyScalar(0.55 + 0.45 * Math.min(1, Math.max(0, (elevation + 6) / 30))),
  }
}

/** Sun for a clock time (decimal hours, IST) on a date at a scenario location. */
export function sunAt(date: string, hour: number, locationId?: string): SunState {
  const loc = location(locationId)
  const pos = solarPosition(istToUtc(date, hour * 60), loc.lat, loc.lon)
  return sunFromAngles(pos.elevation, pos.azimuth)
}

export function todayIso(): string {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)
}
