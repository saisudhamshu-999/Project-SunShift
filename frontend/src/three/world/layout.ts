// World geometry derived from shared/scenario.json, so the 3D feeder is the same feeder
// the optimiser plans for. Layout units are 12 m; +x is east, +z is south, north is -z.
import { FARMS, LAYOUT } from '@/engine/scenario'
import type { CropKey } from '@/api/types'

export type V2 = [number, number]
export type V3 = [number, number, number]

export const UNIT_M = LAYOUT.unit_m
export const HA_SIDE = 100 / UNIT_M // one hectare is 100 m x 100 m

export interface PlotGeom {
  id: number
  crop: CropKey
  center: V2
  size: V2 // x, z extents
  pump: V2 // pump house position
  tap: V2 // connection point on the feeder
  path: V3[] // substation -> tap -> pump (for energy particles)
  rowsAlongX: boolean
}

export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const trunk = LAYOUT.trunk as V2[]
const branches = LAYOUT.branches as V2[][]
export const SUBSTATION = LAYOUT.substation as V2
export const SOLAR_PLANT = LAYOUT.solar_plant

/** All feeder polylines, trunk first. */
export const FEEDER_LINES: V2[][] = [trunk, ...branches]

function closestOnSegment(p: V2, a: V2, b: V2): { point: V2; t: number; d: number } {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const len2 = dx * dx + dz * dz || 1
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2))
  const point: V2 = [a[0] + t * dx, a[1] + t * dz]
  return { point, t, d: Math.hypot(p[0] - point[0], p[1] - point[1]) }
}

/** Path from the substation along the trunk (and branch) to a tap point. */
function routeTo(lineIndex: number, tap: V2): V2[] {
  const sub = SUBSTATION
  if (lineIndex === 0) return [sub, tap]
  const branch = branches[lineIndex - 1]
  const junction = branch[0]
  return [sub, junction, tap]
}

const rnd = rng(7)

export const PLOTS: PlotGeom[] = FARMS.map((f) => {
  const side = Math.sqrt(f.area_ha) * HA_SIDE
  const aspect = 0.82 + rnd() * 0.36
  const size: V2 = [side * Math.sqrt(aspect), side / Math.sqrt(aspect)]
  const center = f.pos as V2
  let best = { line: 0, point: trunk[0] as V2, d: Infinity }
  FEEDER_LINES.forEach((line, li) => {
    for (let i = 0; i < line.length - 1; i++) {
      const c = closestOnSegment(center, line[i], line[i + 1])
      if (c.d < best.d) best = { line: li, point: c.point, d: c.d }
    }
  })
  // Pump house on the plot edge facing the feeder.
  const dx = best.point[0] - center[0]
  const dz = best.point[1] - center[1]
  const pump: V2 =
    Math.abs(dx) / size[0] > Math.abs(dz) / size[1]
      ? [center[0] + Math.sign(dx) * (size[0] / 2 + 0.7), center[1] + Math.max(-size[1] / 2 + 1, Math.min(size[1] / 2 - 1, dz))]
      : [center[0] + Math.max(-size[0] / 2 + 1, Math.min(size[0] / 2 - 1, dx)), center[1] + Math.sign(dz) * (size[1] / 2 + 0.7)]
  const route = routeTo(best.line, best.point)
  const path: V3[] = [...route, pump].map(([x, z], i, arr) => [x, i === arr.length - 1 ? 1.2 : 2.35, z])
  return { id: f.id, crop: f.crop, center, size, pump, tap: best.point, path, rowsAlongX: rnd() > 0.5 }
})

/** Pole positions every ~5 units along the feeder lines, plus service poles to each pump. */
export function polePositions(): { pos: V2; dir: number; small?: boolean }[] {
  const out: { pos: V2; dir: number; small?: boolean }[] = []
  for (const line of FEEDER_LINES) {
    for (let i = 0; i < line.length - 1; i++) {
      const [a, b] = [line[i], line[i + 1]]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const n = Math.max(1, Math.round(len / 5))
      const dir = Math.atan2(b[0] - a[0], b[1] - a[1])
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        out.push({ pos: [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], dir })
      }
    }
  }
  for (const p of PLOTS) {
    const mid: V2 = [(p.tap[0] + p.pump[0]) / 2, (p.tap[1] + p.pump[1]) / 2]
    if (Math.hypot(p.tap[0] - p.pump[0], p.tap[1] - p.pump[1]) > 4) out.push({ pos: mid, dir: Math.atan2(p.pump[0] - p.tap[0], p.pump[1] - p.tap[1]), small: true })
  }
  return out
}

/** Conductor spans: three phases on the 11 kV lines, one on the service drops, with sag. */
export function wireSegments(): Float32Array {
  const pts: number[] = []
  const sagSpan = (a: V3, b: V3, sag: number) => {
    const N = 8
    for (let i = 0; i < N; i++) {
      const t0 = i / N
      const t1 = (i + 1) / N
      const p = (t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - 4 * sag * t * (1 - t), a[2] + (b[2] - a[2]) * t]
      pts.push(...p(t0), ...p(t1))
    }
  }
  for (const line of FEEDER_LINES) {
    for (let i = 0; i < line.length - 1; i++) {
      const [a, b] = [line[i], line[i + 1]]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const n = Math.max(1, Math.round(len / 5))
      const nx = -(b[1] - a[1]) / len
      const nz = (b[0] - a[0]) / len
      for (let k = 0; k < n; k++) {
        const s: V2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]
        const e: V2 = [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n]
        for (const off of [-0.55, 0, 0.55]) {
          const h = off === 0 ? 2.55 : 2.35
          sagSpan([s[0] + nx * off, h, s[1] + nz * off], [e[0] + nx * off, h, e[1] + nz * off], 0.18)
        }
      }
    }
  }
  for (const p of PLOTS) sagSpan([p.tap[0], 2.35, p.tap[1]], [p.pump[0], 1.25, p.pump[1]], 0.25)
  return new Float32Array(pts)
}

export function plotById(id: number): PlotGeom | undefined {
  return PLOTS.find((p) => p.id === id)
}

/** Point along a polyline at fraction t (0..1) by length. */
export function along(path: V3[], t: number): V3 {
  const lens: number[] = []
  let total = 0
  for (let i = 0; i < path.length - 1; i++) {
    const l = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1], path[i + 1][2] - path[i][2])
    lens.push(l)
    total += l
  }
  let d = t * total
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i] || i === lens.length - 1) {
      const f = lens[i] > 0 ? Math.min(1, d / lens[i]) : 0
      const a = path[i]
      const b = path[i + 1]
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
    }
    d -= lens[i]
  }
  return path[path.length - 1]
}
