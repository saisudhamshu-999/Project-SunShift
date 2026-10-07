// Greedy list-scheduling heuristic, mirrored from backend/app/engine/heuristic.py.
// In the browser it is the fallback when the CP-SAT API is unreachable, and it is always
// labelled as a heuristic in the UI.

export interface Job {
  farmId: number
  powerKw: number
  flowM3h: number
  requiredSlots: number
  allowed: number[]
  weight: number
  minRun: number
  maxStarts: number
  executed?: number[]
  carry?: number
}

export interface Problem {
  jobs: Job[]
  solarKw: number[]
  feederLimitKw: number
  gridCapKw: number
  slots: number
  fixedUntil?: number
  mode?: 'sunshift' | 'throughput'
}

const UNIT = 0.1
const units = (kw: number) => Math.round(kw / UNIT)
const solarUnits = (kw: number) => Math.max(0, Math.floor(kw / UNIT))

export function greedy(p: Problem): Record<number, number[]> {
  const T = p.slots
  const t0 = p.fixedUntil ?? 0
  const F = units(p.feederLimitKw)
  const G = units(p.gridCapKw)
  const S = p.solarKw.map(solarUnits)
  const P = new Map(p.jobs.map((j) => [j.farmId, units(j.powerKw)]))
  const load = new Array<number>(T).fill(0)
  const assigned = new Map<number, Set<number>>()
  for (const job of p.jobs) {
    const done = new Set((job.executed ?? []).filter((s) => s < t0))
    assigned.set(job.farmId, done)
    for (const s of done) load[s] += P.get(job.farmId)!
  }

  const fits = (t: number, job: Job) => {
    const pw = P.get(job.farmId)!
    return load[t] + pw <= F && load[t] + pw <= S[t] + G
  }
  const blocks = (slots: Set<number>) => [...slots].filter((s) => !slots.has(s - 1)).length

  const place = (job: Job, length: number): boolean => {
    const allowed = new Set(job.allowed)
    const mine = assigned.get(job.farmId)!
    const ok = Array.from({ length: T }, (_, t) => t >= t0 && allowed.has(t) && !mine.has(t) && fits(t, job))
    const runs = new Array<number>(T + 1).fill(0)
    for (let t = T - 1; t >= 0; t--) runs[t] = ok[t] ? runs[t + 1] + 1 : 0
    const bestLen = Math.min(length, Math.max(...runs.slice(0, T)))
    if (bestLen < job.minRun) return false
    const pw = P.get(job.farmId)!
    let bestS = -1
    let bestScore = -Infinity
    for (let s = 0; s < T; s++) {
      if (runs[s] < bestLen) continue
      let score = 0
      for (let t = s; t < s + bestLen; t++) score += S[t] - load[t] - pw
      if (score > bestScore) {
        bestScore = score
        bestS = s
      }
    }
    if (bestS < 0) return false
    for (let t = bestS; t < bestS + bestLen; t++) {
      mine.add(t)
      load[t] += pw
    }
    return true
  }

  const extend = (job: Job, extra: number): number => {
    const mine = assigned.get(job.farmId)!
    const allowed = new Set(job.allowed)
    const pw = P.get(job.farmId)!
    let added = 0
    while (added < extra) {
      let best: [number, number] | null = null
      for (const s of mine) {
        for (const nb of [s - 1, s + 1]) {
          if (nb >= t0 && nb < T && allowed.has(nb) && !mine.has(nb) && fits(nb, job)) {
            const score = S[nb] - load[nb]
            if (!best || score > best[0] || (score === best[0] && nb > best[1])) best = [score, nb]
          }
        }
      }
      if (!best) break
      mine.add(best[1])
      load[best[1]] += pw
      added++
    }
    return added
  }

  const order = p.jobs
    .filter((j) => j.requiredSlots > 0)
    .sort((a, b) => (p.mode === 'throughput' ? b.flowM3h - a.flowM3h : b.weight - a.weight) || a.requiredSlots - b.requiredSlots)
  const remaining = new Map(order.map((j) => [j.farmId, Math.max(0, j.requiredSlots - assigned.get(j.farmId)!.size)]))

  // Pass A: a fair first share for everyone (skipped when maximising raw throughput).
  if (p.mode !== 'throughput') {
    for (const job of order) {
      const need = remaining.get(job.farmId)!
      const past = new Set([...assigned.get(job.farmId)!].filter((s) => s < t0))
      if (need <= 0 || blocks(past) >= job.maxStarts) continue
      const share = Math.max(job.minRun, Math.ceil(need * 0.5))
      if (place(job, Math.min(share, need))) remaining.set(job.farmId, job.requiredSlots - assigned.get(job.farmId)!.size)
    }
  }
  // Pass B: fill, extending existing blocks first, then a second block if starts allow.
  for (const job of order) {
    let need = remaining.get(job.farmId)!
    if (need <= 0) continue
    if ([...assigned.get(job.farmId)!].some((s) => s >= t0)) need -= extend(job, need)
    if (need >= job.minRun && blocks(assigned.get(job.farmId)!) < job.maxStarts) {
      if (place(job, need)) need = job.requiredSlots - assigned.get(job.farmId)!.size
    }
    remaining.set(job.farmId, Math.max(0, need))
  }

  const out: Record<number, number[]> = {}
  for (const job of p.jobs) out[job.farmId] = [...assigned.get(job.farmId)!].sort((a, b) => a - b)
  return out
}
