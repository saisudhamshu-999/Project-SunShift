// Schedule metrics, mirrored from backend/app/engine/metrics.py.
import type { Metrics } from '@/api/types'
import type { FarmDef, FeederDef } from './scenario'

export function jainIndex(values: number[]): number {
  if (!values.length) return 1
  const s = values.reduce((a, b) => a + b, 0)
  const sq = values.reduce((a, b) => a + b * b, 0)
  return sq === 0 ? 0 : (s * s) / (values.length * sq)
}

const r = (v: number, n = 2) => Math.round(v * 10 ** n) / 10 ** n

export function evaluate(a: {
  on: Record<number, number[]>
  farms: Map<number, FarmDef>
  solarKw: number[]
  feeder: FeederDef
  needM3: Record<number, number>
}): Metrics {
  const T = a.feeder.slots
  const h = a.feeder.slot_minutes / 60
  const F = a.feeder.feeder_limit_kw
  const demand = new Array<number>(T).fill(0)
  let starts = 0
  for (const [fid, slots] of Object.entries(a.on)) {
    const p = a.farms.get(Number(fid))!.pumpKw
    let prev: number | null = null
    for (const t of [...slots].sort((x, y) => x - y)) {
      demand[t] += p
      if (prev === null || t !== prev + 1) starts++
      prev = t
    }
  }
  const frac = demand.map((d) => (d <= F + 1e-9 ? 1 : F / d))
  const delivered = demand.map((d, t) => d * frac[t])
  const solarUsed = delivered.map((d, t) => Math.min(d, a.solarKw[t]))
  const grid = delivered.map((d, t) => Math.max(0, d - a.solarKw[t]))
  const unused = delivered.map((d, t) => Math.max(0, a.solarKw[t] - d))
  const overload = demand.map((d) => d > F + 1e-9)

  const waterByFarm: Record<string, number> = {}
  for (const [fid, slots] of Object.entries(a.on)) {
    const q = a.farms.get(Number(fid))!.flowM3h
    waterByFarm[fid] = slots.reduce((acc, t) => acc + q * h * frac[t], 0)
  }
  const needing = Object.entries(a.needM3).filter(([, v]) => v > 1e-6).map(([k]) => Number(k))
  const served: Record<string, number> = {}
  for (const fid of needing) served[fid] = Math.min(1, (waterByFarm[fid] ?? 0) / a.needM3[fid])
  const totalNeed = needing.reduce((acc, f) => acc + a.needM3[f], 0)
  const useful = needing.reduce((acc, f) => acc + Math.min(waterByFarm[f] ?? 0, a.needM3[f]), 0)
  const water = Object.values(waterByFarm).reduce((x, y) => x + y, 0)
  const excess = Object.entries(waterByFarm).reduce((acc, [f, w]) => acc + Math.max(0, w - (a.needM3[Number(f)] ?? 0)), 0)
  const sum = (v: number[]) => v.reduce((x, y) => x + y, 0)
  const energy = sum(delivered) * h
  const solarUsedKwh = sum(solarUsed) * h
  const solarAvail = sum(a.solarKw) * h
  const servedVals = Object.values(served)
  return {
    waterM3: r(water),
    usefulWaterM3: r(useful),
    excessWaterM3: r(excess),
    needM3: r(totalNeed),
    energyKwh: r(energy),
    solarUsedKwh: r(solarUsedKwh),
    gridKwh: r(sum(grid) * h),
    solarAvailableKwh: r(solarAvail),
    unusedSolarKwh: r(sum(unused) * h),
    peakDemandKw: r(Math.max(0, ...demand)),
    peakDeliveredKw: r(Math.max(0, ...delivered)),
    overloadSlots: overload.filter(Boolean).length,
    curtailedKwh: r(sum(demand.map((d, t) => d - delivered[t])) * h),
    solarShare: energy > 0 ? r(solarUsedKwh / energy, 4) : 0,
    solarUtilisation: solarAvail > 0 ? r(solarUsedKwh / solarAvail, 4) : 0,
    adequacy: totalNeed > 0 ? r(useful / totalNeed, 4) : 1,
    fairnessJain: r(jainIndex(servedVals), 4),
    minServed: servedVals.length ? r(Math.min(...servedVals), 4) : 1,
    servedByFarm: Object.fromEntries(Object.entries(served).map(([k, v]) => [k, r(v, 4)])),
    waterByFarm: Object.fromEntries(Object.entries(waterByFarm).map(([k, v]) => [k, r(v)])),
    farmsNeeding: needing.length,
    farmsFullyServed: servedVals.filter((v) => v >= 0.98).length,
    pumpStarts: starts,
    series: {
      demandKw: demand.map((v) => r(v)),
      deliveredKw: delivered.map((v) => r(v)),
      gridKw: grid.map((v) => r(v)),
      solarUsedKw: solarUsed.map((v) => r(v)),
      overload,
    },
  }
}
