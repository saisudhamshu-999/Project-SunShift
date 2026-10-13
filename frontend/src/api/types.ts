// Contract shared by the FastAPI engine and the in-browser fallback engine.

export type CropKey = 'cotton' | 'maize' | 'groundnut' | 'chilli'
export type WeatherMode = 'live' | 'clear' | 'cloudy' | 'rain' | 'heatwave'
export type FailureKind = 'weather_api' | 'solar_forecast' | 'internet' | 'pump_feedback' | 'capacity'
export type WeatherSource = 'live' | 'cached' | 'climatology' | 'replay' | 'browser-live' | 'browser-clear-sky'
export type Engine = 'cp-sat' | 'heuristic'
export type Binding = 'NONE' | 'SOLAR' | 'FEEDER' | 'AVAILABILITY'

export interface PlanRequest {
  date?: string
  /** Registry feeder id; the server's default feeder when omitted. */
  feeder?: string
  /** Solve again instead of reusing a recent identical result. */
  fresh?: boolean
  location?: string
  pvKwp?: number
  feederLimitKw?: number
  gridBackupKw?: number
  weatherMode?: WeatherMode
  rainMm?: number
  rainProb?: number
  rainStartHour?: number
  solarEvent?: { fromSlot: number; factor: number } | null
  demandScale?: number
  cropOverrides?: Record<number, CropKey>
  servedYesterday?: Record<number, number>
  fairnessWeight?: number
  mode?: 'sunshift' | 'throughput'
  fixedUntil?: number
  executed?: Record<number, number[]>
  failure?: FailureKind | null
  timeLimitS?: number
  persist?: boolean
}

export interface Metrics {
  waterM3: number
  usefulWaterM3: number
  excessWaterM3: number
  needM3: number
  energyKwh: number
  solarUsedKwh: number
  gridKwh: number
  solarAvailableKwh: number
  unusedSolarKwh: number
  peakDemandKw: number
  peakDeliveredKw: number
  overloadSlots: number
  curtailedKwh: number
  solarShare: number
  solarUtilisation: number
  adequacy: number
  fairnessJain: number
  minServed: number
  servedByFarm: Record<string, number>
  waterByFarm: Record<string, number>
  farmsNeeding: number
  farmsFullyServed: number
  pumpStarts: number
  series: {
    demandKw: number[]
    deliveredKw: number[]
    gridKw: number[]
    solarUsedKw: number[]
    overload: boolean[]
  }
}

export interface ConvergencePoint {
  t: number
  objective: number
  bound: number
  phase?: number
}

export interface SolverStats {
  status: string
  objective: number
  bestBound: number
  gap: number
  wallTimeS: number
  numBooleans: number
  numConstraints: number
  numConflicts: number
  numBranches: number
  convergence: ConvergencePoint[]
  timeLimitS: number
  gapLimit: number
  workers: number
  mode: string
  fairnessFloor: number | null
  phase1: { status: string; wallTimeS: number; floor: number; bound: number; guaranteed: number; greedyFloor: number | null } | null
  warmStartObjective: number | null
  improvementOverWarmStart: number | null
  solver: string
}

export interface Reason {
  factor: string
  level: string
  detail: string
}

export interface Priority {
  score: number
  label: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  weight: number
  components: { soilStress: number; stageSensitivity: number; fairnessDebt: number; rainProbability: number }
}

export interface FarmPlan {
  id: number
  code: string
  crop: CropKey
  cropLabel: string
  areaHa: number
  soil: string
  soilLabel: string
  pumpHp: number
  pumpKw: number
  flowM3h: number
  headM: number
  method: 'drip' | 'sprinkler' | 'furrow'
  methodLabel: string
  efficiency: number
  das: number
  stage: number
  stageLabel: string
  seasonDays: number
  kc: number
  etc: number
  zr: number
  taw: number
  raw: number
  p: number
  drStart: number
  drProjected: number
  depletionPct: number
  soilWaterPct: number
  ksStart: number
  status: 'SAFE' | 'WATCH' | 'STRESS'
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
  priority: Priority
  available: number[][]
  habitStart: string
  servedYesterday: number
  pos: [number, number]
  schedule: { slots: number[]; blocks: [number, number][]; window: string; scheduledM3: number; servedFraction: number }
  uncoordinated: { slots: number[]; window: string; deliveredM3: number; servedFraction: number }
  decision: string
  reasons: Reason[]
}

export interface DayWeather {
  date: string
  source: WeatherSource
  sourceDetail: string
  fetchedAt: string | null
  slots: {
    ghi: number[]
    dni: number[]
    dhi: number[]
    temp: number[]
    wind10: number[]
    cloud: number[]
    precip: number[]
    precipProb: number[]
  }
  daily: {
    tmax: number
    tmin: number
    rhMax: number
    rhMin: number
    rhMean: number
    u2: number
    rs: number
    rainMm: number
    rainProb: number
    et0: number
    et0Reference: number | null
    et0Parts: Record<string, number>
    sunrise: string | null
    sunset: string | null
    lookaheadRainMm: number
    lookaheadRainProb: number
  }
  hourly: { hour: number; temp: number; rh: number; wind10: number; ghi: number; cloud: number; precip: number; prob: number | null }[]
  modifications: string[]
}

export interface SolarProfileOut {
  zenith: number[]
  azimuth: number[]
  elevation: number[]
  ghi: number[]
  poa: number[]
  tcell: number[]
  dcKw: number[]
  acKw: number[]
  clearSkyAcKw: number[]
  energyKwh: number
  clearSkyEnergyKwh: number
  peakKw: number
  /** Cautious (P10) solar from the ML correction, when it applies to this plan. */
  cautiousAcKw?: number[]
  cautiousEnergyKwh?: number
  loadAboveCautiousKwh?: number
}

/** What the ML weather corrections did for one plan. */
export interface MlInfo {
  solar: { applied: boolean; reason?: string; model?: string; forecastKwhM2?: number; likelyKwhM2?: number; cautiousKwhM2?: number; riskNote?: string }
  rain: { applied: boolean; reason?: string; model?: string; forecastProb?: number; calibratedProb?: number; forecastMm?: number }
}

/** GET /api/ml: how the models were trained and how they did on the held-out year. */
export interface MlCard {
  version: string
  data: { forecast: string; observed: string; locations: string[]; train: [string, string]; test: [string, string] }
  solar: { hourlyRmseRaw: number; hourlyRmseLikely: number; dailyEnergyMaeRaw: number; dailyEnergyMaeLikely: number; biasRaw: number; biasLikely: number; belowCautious: number; cautiousTarget: number }
  rain: { days: number; calibrated: { brier: number; wrongDeferrals: number; missedRain: number }; forecastYesNo: { brier: number; wrongDeferrals: number; missedRain: number } }
  backtest: { days: number; perDay: Record<'raw' | 'ml', { gridKwh: number; waterM3: number; shortfallKwh: number; gridKwhPer100M3: number }> } | null
  limitations: string[]
  loaded: { solar: string | null; rain: string | null }
}

export interface PlanResult {
  meta: {
    runId: string | null
    createdAt: string
    engine: Engine
    date: string
    dateLabel: string
    nowSlot: number | null
    location: { id: string; name: string; state: string; lat: number; lon: number; elevationM: number }
    slotMinutes: number
    dayStartHour: number
    slots: number
    slotLabels: string[]
    params: Record<string, unknown>
    sources: { weather: WeatherSource; weatherDetail: string; solar: string; farms: string; pumps: string; registry?: string }
    failure: FailureKind | null
    /** Absent on browser-fallback plans. */
    ml?: MlInfo
    notes: string[]
    fixedUntil: number
  }
  feeder: {
    id: string
    name: string
    limitKw: number
    pvKwp: number
    inverterKw: number
    gridBackupKw: number
    tiltDeg: number
    azimuthDeg: number
    connectedLoadKw: number
    minRunSlots: number
    maxStarts: number
  }
  weather: DayWeather
  solar: SolarProfileOut
  farms: FarmPlan[]
  sunshift: { metrics: Metrics; solver: SolverStats; loadKw: number[]; gridKw: number[] }
  uncoordinated: { metrics: Metrics }
  binding: {
    constraint: Binding
    detail: string
    slotFlags: (null | 'SOLAR' | 'FEEDER')[]
    counts: { SOLAR: number; FEEDER: number }
    unmetFarms: number[]
    utilisation: { solar: number; feederPeak: number; demandScheduled: number }
  }
  totals: {
    demandM3: number
    farmsNeeding: number
    farmsDeferred: number
    deferredFarms: number[]
    farmsScheduled: number
    et0: number
  }
}

export interface SensitivityResult {
  baseWaterM3: number
  baseServicePct: number
  demandM3: number
  variants: { key: string; label: string; waterM3: number; deltaM3: number; serviceGainPct: number; status: string }[]
  binding: string
}

export interface FairnessSummary {
  waterM3: number
  usefulWaterM3: number
  jain: number
  minServed: number
  adequacy: number
  farmsUnserved: number
  status: string
  wallTimeS: number
  gap: number
}

export interface FairnessResult {
  date: string
  weather: { mode: string; source: string; et0: number; notes: string[] }
  supplyKwh: number
  demandM3: number
  throughput: FairnessSummary
  fair: FairnessSummary
  nextDay: FairnessSummary
  twoDay: { jain: number; minServed: number }
  farms: {
    id: number
    code: string
    crop: CropKey
    needM3: number
    throughput: number
    fair: number
    nextDay: number
    twoDay: number
    priorityToday: number
    priorityNextDay: number
  }[]
}

export interface RainEventResult {
  forecastSlot: number
  forecastTime: string
  rain: { mm: number; prob: number; startHour: number }
  savedM3: number
  savedLitres: number
  savedKwh: number
  cancelledFarms: number[]
  base: PlanResult
  replan: PlanResult
}

export interface SeasonDayStrategy {
  waterM3: number
  energyKwh: number
  gridKwh: number
  solarUsedKwh: number
  solarAvailableKwh: number
  peakKw: number
  peakDemandKw: number
  overloadSlots: number
  stressFarms: number
  meanKs: number
  deepPercolationM3: number
  adequacy: number
  jain: number
  solarUtilisation: number
  farmsIrrigated: number
  solver?: { status: string; wallTimeS: number }
}

export interface SeasonSummary {
  waterM3: number
  energyKwh: number
  gridKwh: number
  solarUsedKwh: number
  solarAvailableKwh: number
  solarShare: number
  solarUtilisation: number
  peakKw: number
  overloadSlots: number
  deepPercolationM3: number
  stressFarmDays: number
  relativeYield: number
  fairnessJain: number
}

export type SeasonEvent =
  | {
      type: 'meta'
      season: { id: string; label: string; start: string; note: string }
      start: string
      days: number
      location: { id: string; name: string; state: string; lat: number; lon: number }
      weatherSource: string
      forecastModel: Record<string, number>
      bau: { factor: number; rotation_days: Record<string, number>; note: string }
      feeder: { limitKw: number; pvKwp: number; gridBackupKw: number }
    }
  | {
      type: 'day'
      index: number
      date: string
      et0: number
      rainMm: number
      forecastRainMm: number
      forecastRainProb: number
      solarKwh: number
      solarForecastFactor: number
      sunshift: SeasonDayStrategy
      bau: SeasonDayStrategy
    }
  | { type: 'summary'; sunshift: SeasonSummary; bau: SeasonSummary; elapsedS: number; notes: string[] }
  | { type: 'error'; message: string }

export interface SeasonRequest {
  season: string
  days: number
  location?: string
  pvKwp?: number
  feederLimitKw?: number
  gridBackupKw?: number
  demandScale?: number
  bauFactor?: number
  seed?: number
}

export interface Health {
  status: string
  engine: string
  ortools: string
  pvlib: string
  db: string
  registry?: 'database' | 'file'
  ml?: { solar: string | null; rain: string | null }
  jobs?: { workers: number; running: number; queued: number; capacity: number; completed: number; failed: number }
  time: string
  defaultPlanDate: string
}

/** GET /api/messages: farmer SMS without phone numbers. */
export interface MessageRow {
  id: string
  farmId: number | null
  code: string | null
  direction: 'in' | 'out'
  language: 'en' | 'hi' | 'te'
  body: string
  status: 'simulated' | 'sent' | 'failed' | 'received'
  provider: string
  error: string | null
  createdAt: string
}

export type JobKind = 'plan' | 'sensitivity' | 'fairness' | 'rain-event'

/** A solver job (POST /api/jobs, GET /api/jobs/{id}). */
export interface Job<T> {
  id: string
  kind: JobKind
  status: 'queued' | 'running' | 'done' | 'failed'
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  result: T | null
  error: string | null
  cached: boolean
}

export interface RunRow {
  id: string
  createdAt: string
  kind: string
  date: string
  location: string
  engine: string
  solveSeconds: number
  params: Record<string, unknown>
  summary: Record<string, unknown>
}
