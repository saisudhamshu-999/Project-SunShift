// In-browser planner: the API's PlanResult, computed with the greedy heuristic instead of
// CP-SAT. Used only when the API is unreachable, and always labelled as such.
import type {
  Binding,
  DayWeather,
  FairnessResult,
  FarmPlan,
  PlanRequest,
  PlanResult,
  Priority,
  Reason,
  RainEventResult,
  SensitivityResult,
} from '@/api/types'
import { assessFarm, rootDepth, totalAvailableWater, type FarmAgronomy } from './fao56'
import { greedy, type Job, type Problem } from './heuristic'
import { evaluate } from './metrics'
import {
  CROPS,
  FARMS,
  FEEDER,
  METHODS,
  POLICY,
  SOILS,
  availableSlots,
  contiguousBlocks,
  location,
  slotLabel,
  timeToSlot,
  windowLabel,
  type FarmDef,
  type FeederDef,
} from './scenario'
import { pvProfile } from './solar'
import { applyMode, assembleDay, climatologyDay, fetchForecast } from './weather'

const IST_MS = 330 * 60000

export function istNow(): Date {
  return new Date(Date.now() + IST_MS)
}

export function defaultPlanDate(): string {
  const now = istNow()
  const d = now.getUTCHours() < 16 ? now : new Date(now.getTime() + 86400000)
  return d.toISOString().slice(0, 10)
}

function nowSlot(day: string, feeder: FeederDef): number | null {
  const now = istNow()
  if (now.toISOString().slice(0, 10) !== day) return null
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes() - feeder.day_start_hour * 60
  const slot = Math.floor(minutes / feeder.slot_minutes)
  return slot >= 0 && slot < feeder.slots ? slot : null
}

function level(value: number, cuts: number[], labels = ['LOW', 'MODERATE', 'HIGH', 'SEVERE']): string {
  for (let i = 0; i < cuts.length; i++) if (value < cuts[i]) return labels[i]
  return labels[labels.length - 1]
}

export function priorityFor(ag: FarmAgronomy, servedYesterday: number, rainProb: number): Priority {
  const ratio = ag.raw > 0 ? ag.drProjected / ag.raw : 0
  const soil = Math.max(0, Math.min(1.5, (ratio - 0.4) / 0.8))
  const stage = ag.sensitivity
  const debt = Math.max(0, 1 - servedYesterday)
  const rain = rainProb / 100
  const score = 1 + 2 * soil + 1.2 * stage + 1.5 * debt - 1 * rain
  const label: Priority['label'] = score >= 3.6 ? 'CRITICAL' : score >= 2.7 ? 'HIGH' : score >= 1.9 ? 'MEDIUM' : 'LOW'
  return {
    score: Math.round(score * 1000) / 1000,
    label,
    weight: Math.max(5, Math.round(10 * score)),
    components: { soilStress: soil, stageSensitivity: stage, fairnessDebt: debt, rainProbability: rain },
  }
}

interface Context {
  feeder: FeederDef
  farms: FarmDef[]
  day: string
  base: DayWeather // weather before scenario modes, so studies can re-apply them cleanly
  dw: DayWeather
  pv: ReturnType<typeof pvProfile>
  ags: Map<number, FarmAgronomy>
  prios: Map<number, Priority>
  allowed: Map<number, number[]>
  jobs: Job[]
  req: PlanRequest
  notes: string[]
}

async function weatherFor(day: string, req: PlanRequest, signal?: AbortSignal): Promise<DayWeather> {
  const loc = location(req.location)
  if (req.failure === 'weather_api') return climatologyDay(day, loc)
  try {
    return assembleDay(await fetchForecast(loc, signal), day, loc)
  } catch {
    return climatologyDay(day, loc)
  }
}

export async function buildContext(req: PlanRequest, signal?: AbortSignal, baseWeather?: DayWeather): Promise<Context> {
  const feeder: FeederDef = { ...FEEDER }
  if (req.pvKwp != null) {
    const ratio = FEEDER.pv_kwp / FEEDER.inverter_kw
    feeder.pv_kwp = req.pvKwp
    feeder.inverter_kw = Math.round((req.pvKwp / ratio) * 10) / 10
  }
  if (req.feederLimitKw != null) feeder.feeder_limit_kw = req.feederLimitKw
  if (req.gridBackupKw != null) feeder.grid_backup_kw = req.gridBackupKw
  const farms = FARMS.map((f) => {
    const crop = req.cropOverrides?.[f.id]
    let out = { ...f }
    if (crop && crop !== f.crop) {
      const frac = Math.min(f.das / CROPS[f.crop].stages.reduce((a, b) => a + b, 0), 0.95)
      out = { ...out, crop, das: Math.round(frac * CROPS[crop].stages.reduce((a, b) => a + b, 0)) }
    }
    if (req.servedYesterday?.[f.id] != null) out.served_yesterday = req.servedYesterday[f.id]
    return out
  })
  const loc = location(req.location)
  const day = req.date ?? defaultPlanDate()
  const notes: string[] = []
  const base = baseWeather ?? (await weatherFor(day, req, signal))
  let solarEvent = req.solarEvent ?? null
  if (req.failure === 'solar_forecast' && !solarEvent) {
    solarEvent = { fromSlot: 22, factor: 0.55 }
    notes.push('Failure drill: actual solar 45% below forecast from 11:30; plan re-optimised')
  }
  const dw = applyMode(base, req.weatherMode ?? 'live', loc, { rainMm: req.rainMm, rainProb: req.rainProb, rainStartHour: req.rainStartHour, solarEvent }, feeder)
  const pv = pvProfile(day, loc, dw.slots, feeder)

  const ags = new Map<number, FarmAgronomy>()
  const prios = new Map<number, Priority>()
  const allowed = new Map<number, number[]>()
  const jobs: Job[] = []
  for (const farm of farms) {
    const taw0 = totalAvailableWater(SOILS[farm.soil], rootDepth(CROPS[farm.crop], farm.das))
    const slots = availableSlots(farm, feeder)
    allowed.set(farm.id, slots)
    const ag = assessFarm({
      farm, das: farm.das, drStart: farm.dr0_frac * taw0, et0: dw.daily.et0,
      rainForecastMm: dw.daily.lookaheadRainMm, rainProb: dw.daily.lookaheadRainProb,
      availableSlotCount: slots.length, demandScale: req.demandScale ?? 1, feeder,
    })
    ags.set(farm.id, ag)
    const pr = priorityFor(ag, farm.served_yesterday, dw.daily.lookaheadRainProb)
    prios.set(farm.id, pr)
    jobs.push({
      farmId: farm.id, powerKw: farm.pumpKw, flowM3h: farm.flowM3h, requiredSlots: ag.requiredSlots, allowed: slots,
      weight: pr.weight, minRun: feeder.min_run_slots, maxStarts: feeder.max_starts,
      executed: (req.executed?.[farm.id] ?? []).slice().sort((a, b) => a - b), carry: farm.served_yesterday,
    })
  }
  if (req.failure === 'capacity') notes.push('Failure drill: demand exceeds what the feeder can serve; fair allocation applies')
  return { feeder, farms, day, base, dw, pv, ags, prios, allowed, jobs, req, notes }
}

function problem(ctx: Context, over: Partial<Problem> = {}): Problem {
  return {
    jobs: ctx.jobs, solarKw: ctx.pv.acKw, feederLimitKw: ctx.feeder.feeder_limit_kw, gridCapKw: ctx.feeder.grid_backup_kw,
    slots: ctx.feeder.slots, fixedUntil: ctx.req.fixedUntil ?? 0, mode: ctx.req.mode ?? 'sunshift', ...over,
  }
}

function reasonsFor(ctx: Context, farm: FarmDef, ag: FarmAgronomy, pr: Priority, slots: number[], load: number[]): Reason[] {
  const rainProb = ctx.dw.daily.lookaheadRainProb
  const ratio = ag.raw > 0 ? ag.drProjected / ag.raw : 0
  const out: Reason[] = [
    { factor: 'Soil stress', level: level(ratio, [0.6, 0.9, 1.1]), detail: `Projected depletion ${ag.drProjected.toFixed(0)} mm vs ${ag.raw.toFixed(0)} mm readily available` },
    { factor: 'Crop stage', level: level(ag.sensitivity, [0.25, 0.5, 0.9], ['LOW', 'MODERATE', 'HIGH', 'CRITICAL']), detail: `${CROPS[farm.crop].label}: ${ag.stageLabel} (day ${ag.das})` },
    { factor: 'Rain probability', level: level(rainProb, [30, 60, 101], ['LOW', 'MODERATE', 'HIGH', 'HIGH']), detail: `${rainProb.toFixed(0)}% in the next ${POLICY.rain_lookahead_h} h${ag.rainExpectedMm > 0 ? `, ${ag.rainExpectedMm.toFixed(0)} mm counted` : ''}` },
  ]
  if (slots.length) {
    const solar = ctx.pv.acKw
    const mean = slots.reduce((a, t) => a + solar[t], 0) / slots.length
    const peak = Math.max(...solar) || 1
    const headroom = Math.min(...slots.map((t) => ctx.feeder.feeder_limit_kw - load[t]))
    out.push({ factor: 'Solar availability', level: level(mean / peak, [0.35, 0.7, 2], ['LOW', 'MODERATE', 'HIGH', 'HIGH']), detail: `${mean.toFixed(0)} kW average during ${windowLabel(slots, ctx.feeder)}` })
    out.push({ factor: 'Feeder capacity', level: headroom < 3 ? 'TIGHT' : 'AVAILABLE', detail: `${headroom.toFixed(1)} kW headroom left at the busiest slot of this window` })
  }
  if (farm.served_yesterday < 0.98) out.push({ factor: 'Fairness', level: 'BOOST', detail: `Received ${(farm.served_yesterday * 100).toFixed(0)}% of its requirement yesterday` })
  out.push({ factor: 'Priority', level: pr.label, detail: `Score ${pr.score.toFixed(2)} → weight ${pr.weight}` })
  return out
}

function decisionText(ctx: Context, ag: FarmAgronomy, slots: number[], served: number): string {
  if (ag.stage === 4) return 'Crop harvested: no irrigation'
  if (ag.deferred) return `Deferred: ${ag.rainExpectedMm.toFixed(0)} mm of effective rain expected covers today's need`
  if (ag.requiredSlots === 0) return `Not needed today: root zone at ${(100 - (100 * ag.drStart) / ag.taw).toFixed(0)}% of available water`
  if (!slots.length) return "Could not be scheduled within today's limits; carried to tomorrow with higher priority"
  const window = windowLabel(slots, ctx.feeder)
  return served < 0.98 ? `Partially scheduled ${window} (${(served * 100).toFixed(0)}% of requirement); remainder carried forward` : `Scheduled ${window}`
}

function uncoordinated(ctx: Context): Record<number, number[]> {
  const out: Record<number, number[]> = {}
  for (const job of ctx.jobs) {
    if (job.requiredSlots <= 0) continue
    const farm = ctx.farms.find((f) => f.id === job.farmId)!
    const start = Math.max(0, timeToSlot(farm.habit_start, ctx.feeder))
    out[job.farmId] = job.allowed.filter((s) => s >= start).slice(0, job.requiredSlots)
  }
  return out
}

function binding(ctx: Context, on: Record<number, number[]>, load: number[], solarUtil: number, useful: number): PlanResult['binding'] {
  const F = ctx.feeder.feeder_limit_kw
  const G = ctx.feeder.grid_backup_kw
  const S = ctx.pv.acKw
  const t0 = ctx.req.fixedUntil ?? 0
  const unmet = ctx.jobs.filter((j) => (on[j.farmId] ?? []).length < j.requiredSlots)
  const flags: (null | 'SOLAR' | 'FEEDER')[] = new Array(ctx.feeder.slots).fill(null)
  const counts = { SOLAR: 0, FEEDER: 0 }
  for (let t = t0; t < ctx.feeder.slots; t++) {
    const cand = unmet.filter((j) => j.allowed.includes(t) && !(on[j.farmId] ?? []).includes(t))
    if (!cand.length) continue
    const pmin = Math.min(...cand.map((j) => j.powerKw))
    const hf = F - load[t]
    const hs = S[t] + G - load[t]
    if (hs < pmin && hs <= hf) { flags[t] = 'SOLAR'; counts.SOLAR++ }
    else if (hf < pmin) { flags[t] = 'FEEDER'; counts.FEEDER++ }
  }
  const demand = [...ctx.ags.values()].reduce((a, g) => a + g.volumeM3, 0)
  let constraint: Binding
  let detail: string
  if (!unmet.length) { constraint = 'NONE'; detail = "Every requested irrigation fits inside today's solar and feeder limits. Water demand is the active limit." }
  else if (!counts.SOLAR && !counts.FEEDER) { constraint = 'AVAILABILITY'; detail = 'Unmet demand is limited by farmer availability windows and pump run-time, not by energy.' }
  else if (counts.SOLAR >= counts.FEEDER) { constraint = 'SOLAR'; detail = `Solar output (plus ${G.toFixed(0)} kW permitted grid backup) runs out in ${counts.SOLAR} slots where farms still need water.` }
  else { constraint = 'FEEDER'; detail = `The ${F.toFixed(0)} kW feeder limit is full in ${counts.FEEDER} slots where farms still need water.` }
  return {
    constraint, detail, slotFlags: flags, counts, unmetFarms: unmet.map((j) => j.farmId),
    utilisation: { solar: solarUtil, feederPeak: F > 0 ? Math.max(...load) / F : 0, demandScheduled: demand > 0 ? useful / demand : 1 },
  }
}

function assemble(ctx: Context, on: Record<number, number[]>, wallTimeS: number): PlanResult {
  const farmsById = new Map(ctx.farms.map((f) => [f.id, f]))
  const need: Record<number, number> = {}
  for (const [fid, ag] of ctx.ags) need[fid] = ag.volumeM3
  const unc = uncoordinated(ctx)
  const mSun = evaluate({ on, farms: farmsById, solarKw: ctx.pv.acKw, feeder: ctx.feeder, needM3: need })
  const mUnc = evaluate({ on: unc, farms: farmsById, solarKw: ctx.pv.acKw, feeder: ctx.feeder, needM3: need })
  const load = new Array<number>(ctx.feeder.slots).fill(0)
  for (const [fid, slots] of Object.entries(on)) for (const t of slots) load[t] += farmsById.get(Number(fid))!.pumpKw
  const loc = location(ctx.req.location)
  const farms: FarmPlan[] = ctx.farms.map((farm) => {
    const ag = ctx.ags.get(farm.id)!
    const pr = ctx.prios.get(farm.id)!
    const slots = on[farm.id] ?? []
    const served = mSun.servedByFarm[farm.id] ?? (ag.volumeM3 <= 0 ? 1 : 0)
    const uSlots = unc[farm.id] ?? []
    return {
      id: farm.id, code: farm.code, crop: farm.crop, cropLabel: CROPS[farm.crop].label, areaHa: farm.area_ha,
      soil: farm.soil, soilLabel: SOILS[farm.soil].label, pumpHp: farm.pump_hp, pumpKw: Math.round(farm.pumpKw * 100) / 100,
      flowM3h: Math.round(farm.flowM3h * 100) / 100, headM: farm.head_m, method: farm.method,
      methodLabel: METHODS[farm.method].label, efficiency: METHODS[farm.method].efficiency, das: ag.das,
      stage: ag.stage, stageLabel: ag.stageLabel, seasonDays: CROPS[farm.crop].stages.reduce((a, b) => a + b, 0),
      kc: ag.kc, etc: ag.etc, zr: ag.zr, taw: ag.taw, raw: ag.raw, p: ag.p, drStart: ag.drStart,
      drProjected: ag.drProjected, depletionPct: (100 * ag.drStart) / ag.taw, soilWaterPct: 100 - (100 * ag.drStart) / ag.taw,
      ksStart: ag.ksStart, status: ag.status, triggerMm: ag.triggerMm, targetMm: ag.targetMm, needNetMm: ag.needNetMm,
      rainExpectedMm: ag.rainExpectedMm, needAfterRainMm: ag.needAfterRainMm, deferred: ag.deferred, grossMm: ag.grossMm,
      volumeM3: ag.volumeM3, pumpHours: ag.pumpHours, requiredSlots: ag.requiredSlots, capacityLimited: ag.capacityLimited,
      priority: pr, available: farm.available, habitStart: farm.habit_start, servedYesterday: farm.served_yesterday,
      pos: farm.pos,
      schedule: { slots, blocks: contiguousBlocks(slots), window: windowLabel(slots, ctx.feeder), scheduledM3: farm.flowM3h * (ctx.feeder.slot_minutes / 60) * slots.length, servedFraction: served },
      uncoordinated: { slots: uSlots, window: windowLabel(uSlots, ctx.feeder), deliveredM3: mUnc.waterByFarm[farm.id] ?? 0, servedFraction: mUnc.servedByFarm[farm.id] ?? (ag.volumeM3 <= 0 ? 1 : 0) },
      decision: decisionText(ctx, ag, slots, served),
      reasons: reasonsFor(ctx, farm, ag, pr, slots, load),
    }
  })
  const deferred = [...ctx.ags.entries()].filter(([, a]) => a.deferred).map(([id]) => id)
  return {
    meta: {
      runId: null, createdAt: new Date().toISOString(), engine: 'heuristic', date: ctx.day,
      dateLabel: new Date(`${ctx.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }),
      nowSlot: nowSlot(ctx.day, ctx.feeder),
      location: { id: loc.id, name: loc.name, state: loc.state, lat: loc.lat, lon: loc.lon, elevationM: loc.elevation_m },
      slotMinutes: ctx.feeder.slot_minutes, dayStartHour: ctx.feeder.day_start_hour, slots: ctx.feeder.slots,
      slotLabels: Array.from({ length: ctx.feeder.slots }, (_, t) => slotLabel(t, ctx.feeder)),
      params: { ...ctx.req },
      sources: { weather: ctx.dw.source, weatherDetail: ctx.dw.sourceDetail, solar: 'browser-model', farms: 'simulation', pumps: 'simulation' },
      failure: ctx.req.failure ?? null, notes: [...ctx.notes, ...ctx.dw.modifications], fixedUntil: ctx.req.fixedUntil ?? 0,
    },
    feeder: {
      id: ctx.feeder.id, name: ctx.feeder.name, limitKw: ctx.feeder.feeder_limit_kw, pvKwp: ctx.feeder.pv_kwp,
      inverterKw: ctx.feeder.inverter_kw, gridBackupKw: ctx.feeder.grid_backup_kw, tiltDeg: ctx.feeder.tilt_deg,
      azimuthDeg: ctx.feeder.azimuth_deg, connectedLoadKw: ctx.farms.reduce((a, f) => a + f.pumpKw, 0),
      minRunSlots: ctx.feeder.min_run_slots, maxStarts: ctx.feeder.max_starts,
    },
    weather: ctx.dw,
    solar: ctx.pv,
    farms,
    sunshift: {
      metrics: mSun,
      solver: {
        status: 'HEURISTIC', objective: 0, bestBound: 0, gap: 0, wallTimeS, numBooleans: 0, numConstraints: 0,
        numConflicts: 0, numBranches: 0, convergence: [], timeLimitS: 0, gapLimit: 0, workers: 1,
        mode: ctx.req.mode ?? 'sunshift', fairnessFloor: null, phase1: null, warmStartObjective: null,
        improvementOverWarmStart: null, solver: 'Greedy heuristic (browser fallback, not CP-SAT)',
      },
      loadKw: load,
      gridKw: load.map((l, t) => Math.max(0, l - ctx.pv.acKw[t])),
    },
    uncoordinated: { metrics: mUnc },
    binding: binding(ctx, on, load, mSun.solarUtilisation, mSun.usefulWaterM3),
    totals: {
      demandM3: Object.values(need).reduce((a, b) => a + b, 0),
      farmsNeeding: Object.values(need).filter((v) => v > 0).length,
      farmsDeferred: deferred.length, deferredFarms: deferred,
      farmsScheduled: Object.values(on).filter((s) => s.length).length, et0: ctx.dw.daily.et0,
    },
  }
}

export async function planInBrowser(req: PlanRequest, signal?: AbortSignal): Promise<PlanResult> {
  const t = performance.now()
  const ctx = await buildContext(req, signal)
  const on = greedy(problem(ctx))
  return assemble(ctx, on, (performance.now() - t) / 1000)
}

export async function sensitivityInBrowser(req: PlanRequest): Promise<SensitivityResult> {
  const ctx = await buildContext(req)
  const water = (on: Record<number, number[]>) =>
    ctx.jobs.reduce((a, j) => a + j.flowM3h * (ctx.feeder.slot_minutes / 60) * (on[j.farmId]?.length ?? 0), 0)
  const service = (on: Record<number, number[]>) =>
    ctx.jobs.reduce((a, j) => a + (j.requiredSlots > 0 ? j.weight * Math.min(1, (on[j.farmId]?.length ?? 0) / j.requiredSlots) : 0), 0)
  const maxService = ctx.jobs.reduce((a, j) => a + (j.requiredSlots > 0 ? j.weight : 0), 0) || 1
  const base = greedy(problem(ctx))
  const every = Array.from({ length: ctx.feeder.slots }, (_, i) => i)
  const variants: [string, string, Partial<Problem>][] = [
    ['solar', '+20% solar', { solarKw: ctx.pv.acKw.map((v) => v * 1.2) }],
    ['feeder', '+20% feeder limit', { feederLimitKw: ctx.feeder.feeder_limit_kw * 1.2 }],
    ['grid', '+20 kW grid backup', { gridCapKw: ctx.feeder.grid_backup_kw + 20 }],
    ['availability', 'Farmers available 06:00–18:00', { jobs: ctx.jobs.map((j) => ({ ...j, allowed: every })) }],
  ]
  const rows = variants.map(([key, label, over]) => {
    const on = greedy(problem(ctx, over))
    return {
      key, label, waterM3: water(on), deltaM3: water(on) - water(base),
      serviceGainPct: (100 * (service(on) - service(base))) / maxService, status: 'HEURISTIC',
    }
  }).sort((a, b) => b.serviceGainPct - a.serviceGainPct)
  return {
    baseWaterM3: water(base), baseServicePct: (100 * service(base)) / maxService,
    demandM3: [...ctx.ags.values()].reduce((a, g) => a + g.volumeM3, 0), variants: rows,
    binding: rows[0] && rows[0].serviceGainPct > 0.25 ? rows[0].key : 'none',
  }
}

export async function fairnessInBrowser(req: PlanRequest): Promise<FairnessResult> {
  const ctx = await buildContext({ ...req, servedYesterday: {} })
  const farmsById = new Map(ctx.farms.map((f) => [f.id, f]))
  const need: Record<number, number> = {}
  for (const [fid, ag] of ctx.ags) need[fid] = ag.volumeM3
  const thrOn = greedy(problem(ctx, { mode: 'throughput' }))
  const fairOn = greedy(problem(ctx, { mode: 'sunshift' }))
  const ev = (on: Record<number, number[]>, needs: Record<number, number>) => evaluate({ on, farms: farmsById, solarKw: ctx.pv.acKw, feeder: ctx.feeder, needM3: needs })
  const thr = ev(thrOn, need)
  const fair = ev(fairOn, need)
  const carried = Object.fromEntries(Object.entries(fair.servedByFarm).map(([k, v]) => [Number(k), v]))
  const ctx2 = await buildContext({ ...req, servedYesterday: carried }, undefined, ctx.base)
  const need2: Record<number, number> = {}
  for (const [fid, ag] of ctx2.ags) need2[fid] = ag.volumeM3
  const nxt = ev(greedy(problem(ctx2)), need2)
  const rows = ctx.farms.filter((f) => need[f.id] > 0).map((f) => {
    const today = fair.servedByFarm[f.id] ?? 0
    const next = nxt.servedByFarm[f.id] ?? 0
    return {
      id: f.id, code: f.code, crop: f.crop, needM3: need[f.id], throughput: thr.servedByFarm[f.id] ?? 0, fair: today,
      nextDay: next, twoDay: (today + next) / 2, priorityToday: ctx.prios.get(f.id)!.score, priorityNextDay: ctx2.prios.get(f.id)!.score,
    }
  })
  const summary = (m: ReturnType<typeof ev>) => ({
    waterM3: m.waterM3, usefulWaterM3: m.usefulWaterM3, jain: m.fairnessJain, minServed: m.minServed, adequacy: m.adequacy,
    farmsUnserved: Object.values(m.servedByFarm).filter((v) => v < 0.05).length, status: 'HEURISTIC', wallTimeS: 0, gap: 0,
  })
  const two = rows.map((r) => r.twoDay)
  const jain = two.length ? (two.reduce((a, b) => a + b, 0) ** 2) / (two.length * two.reduce((a, b) => a + b * b, 0) || 1) : 1
  return {
    date: ctx.day, weather: { mode: req.weatherMode ?? 'live', source: ctx.dw.source, et0: ctx.dw.daily.et0, notes: ctx.dw.modifications },
    supplyKwh: ctx.pv.energyKwh, demandM3: Object.values(need).reduce((a, b) => a + b, 0),
    throughput: summary(thr), fair: summary(fair), nextDay: summary(nxt),
    twoDay: { jain, minServed: two.length ? Math.min(...two) : 1 }, farms: rows,
  }
}

export async function rainEventInBrowser(req: PlanRequest, forecastSlot = 20): Promise<RainEventResult> {
  const baseReq: PlanRequest = { ...req, weatherMode: req.weatherMode === 'rain' ? 'live' : req.weatherMode, fixedUntil: 0, executed: {} }
  const baseCtx = await buildContext(baseReq)
  const baseOn = greedy(problem(baseCtx))
  const base = assemble(baseCtx, baseOn, 0)
  const executed = Object.fromEntries(Object.entries(baseOn).map(([k, s]) => [Number(k), s.filter((t) => t < forecastSlot)]))
  const rainCtx = await buildContext({ ...baseReq, weatherMode: 'rain', fixedUntil: forecastSlot, executed }, undefined, baseCtx.base)
  const rainOn = greedy(problem(rainCtx))
  const replan = assemble(rainCtx, rainOn, 0)
  const h = FEEDER.slot_minutes / 60
  const after = (on: Record<number, number[]>) => {
    let w = 0, e = 0
    for (const [fid, s] of Object.entries(on)) {
      const f = FARMS.find((x) => x.id === Number(fid))!
      const n = s.filter((t) => t >= forecastSlot).length
      w += f.flowM3h * h * n
      e += f.pumpKw * h * n
    }
    return [w, e]
  }
  const [bw, be] = after(baseOn)
  const [rw, re] = after(rainOn)
  return {
    forecastSlot, forecastTime: slotLabel(forecastSlot),
    rain: { mm: req.rainMm ?? 18, prob: req.rainProb ?? 85, startHour: req.rainStartHour ?? 13 },
    savedM3: bw - rw, savedLitres: Math.round((bw - rw) * 1000), savedKwh: be - re,
    cancelledFarms: Object.entries(baseOn).filter(([k, s]) => s.some((t) => t >= forecastSlot) && !(rainOn[Number(k)] ?? []).some((t) => t >= forecastSlot)).map(([k]) => Number(k)),
    base, replan,
  }
}
