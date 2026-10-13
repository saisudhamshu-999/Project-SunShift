// The same shared/scenario.json the Python engine reads: one feeder, two engines.
import raw from '@shared/scenario.json'
import type { CropKey } from '@/api/types'

export interface CropDef {
  label: string
  kc: [number, number, number]
  stages: [number, number, number, number]
  zr: [number, number]
  p: number
  ky: number
  stage_labels: [string, string, string, string]
  stage_ky: [number, number, number, number]
}

export interface SoilDef {
  label: string
  fc: number
  wp: number
}

export interface MethodDef {
  label: string
  efficiency: number
  trigger_frac_raw: number
  target_frac_raw: number
  max_daily_hours: number
}

export interface FarmDef {
  id: number
  crop: CropKey
  area_ha: number
  soil: string
  pump_hp: number
  head_m: number
  method: 'drip' | 'sprinkler' | 'furrow'
  das: number
  dr0_frac: number
  available: [number, number][]
  habit_start: string
  last_irrigated_days: number
  served_yesterday: number
  pos: [number, number]
  pumpKw: number
  flowM3h: number
  code: string
}

export interface FeederDef {
  id: string
  name: string
  pv_kwp: number
  inverter_kw: number
  feeder_limit_kw: number
  grid_backup_kw: number
  tilt_deg: number
  azimuth_deg: number
  system_losses: number
  gamma_pdc: number
  slot_minutes: number
  day_start_hour: number
  slots: number
  min_run_slots: number
  max_starts: number
}

export interface LocationDef {
  id: string
  name: string
  state: string
  lat: number
  lon: number
  elevation_m: number
}

interface ScenarioJson {
  feeder: FeederDef
  pump_model: { motor_efficiency: number; wire_to_water_efficiency: number; note: string }
  policy: {
    rain_defer_prob: number
    rain_min_mm: number
    rain_lookahead_h: number
    observed_rain_skip_mm: number
    fairness_weight: number
    catch_up_rate: number
    bau: { factor: number; rotation_days: Record<string, number>; note: string }
  }
  locations: LocationDef[]
  default_location: string
  seasons: { id: string; label: string; start: string; note: string }[]
  crops: Record<CropKey, CropDef>
  excluded_crops: Record<string, string>
  soils: Record<string, SoilDef>
  methods: Record<string, MethodDef>
  layout: {
    unit_m: number
    solar_plant: { center: [number, number]; size: [number, number] }
    substation: [number, number]
    trunk: [number, number][]
    branches: [number, number][][]
  }
  farms: Omit<FarmDef, 'pumpKw' | 'flowM3h' | 'code'>[]
  note: string
}

export const SCENARIO = raw as unknown as ScenarioJson

const RHO_G = 1000 * 9.81

export function pumpElectricalKw(hp: number): number {
  return (hp * 0.746) / SCENARIO.pump_model.motor_efficiency
}

export function pumpFlowM3h(kw: number, headM: number): number {
  return ((kw * 1000 * SCENARIO.pump_model.wire_to_water_efficiency) / (RHO_G * headM)) * 3600
}

const round3 = (v: number) => Math.round(v * 1000) / 1000

export const FARMS: FarmDef[] = SCENARIO.farms.map((f) => {
  const kw = pumpElectricalKw(f.pump_hp)
  return {
    ...f,
    available: f.available as [number, number][],
    pos: f.pos as [number, number],
    // Rounded exactly as backend/app/engine/scenario.py does, so both engines agree.
    pumpKw: round3(kw),
    flowM3h: round3(pumpFlowM3h(kw, f.head_m)),
    code: `F${String(f.id).padStart(2, '0')}`,
  }
})

export const FEEDER = SCENARIO.feeder
export const CROPS = SCENARIO.crops
export const SOILS = SCENARIO.soils
export const METHODS = SCENARIO.methods
export const POLICY = SCENARIO.policy
export const LOCATIONS = SCENARIO.locations
export const SEASONS = SCENARIO.seasons
export const LAYOUT = SCENARIO.layout
export const CROP_KEYS: CropKey[] = ['cotton', 'maize', 'groundnut', 'chilli']

export function location(id?: string): LocationDef {
  return LOCATIONS.find((l) => l.id === id) ?? LOCATIONS.find((l) => l.id === SCENARIO.default_location)!
}

export const SLOT_HOURS = FEEDER.slot_minutes / 60

export function slotLabel(slot: number, feeder: FeederDef = FEEDER): string {
  const minutes = feeder.day_start_hour * 60 + slot * feeder.slot_minutes
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export function timeToSlot(hhmm: string, feeder: FeederDef = FEEDER): number {
  const [h, m] = hhmm.split(':').map(Number)
  return Math.floor((h * 60 + m - feeder.day_start_hour * 60) / feeder.slot_minutes)
}

export function hourToSlot(hour: number, feeder: FeederDef = FEEDER): number {
  return Math.round(((hour - feeder.day_start_hour) * 60) / feeder.slot_minutes)
}

export function availableSlots(farm: Pick<FarmDef, 'available'>, feeder: FeederDef = FEEDER): number[] {
  const out = new Set<number>()
  for (const [h0, h1] of farm.available) {
    const a = Math.max(0, hourToSlot(h0, feeder))
    const b = Math.min(feeder.slots, hourToSlot(h1, feeder))
    for (let s = a; s < b; s++) out.add(s)
  }
  return [...out].sort((a, b) => a - b)
}

export function contiguousBlocks(slots: number[]): [number, number][] {
  const blocks: [number, number][] = []
  for (const s of [...slots].sort((a, b) => a - b)) {
    const last = blocks[blocks.length - 1]
    if (last && s === last[1] + 1) last[1] = s
    else blocks.push([s, s])
  }
  return blocks
}

export function windowLabel(slots: number[], feeder: FeederDef = FEEDER): string {
  return contiguousBlocks(slots)
    .map(([a, b]) => `${slotLabel(a, feeder)}–${slotLabel(b + 1, feeder)}`)
    .join(', ')
}
