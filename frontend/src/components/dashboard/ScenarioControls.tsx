import type { WeatherMode } from '@/api/types'
import { Segmented, Slider, Working } from '@/components/ui/primitives'
import { FEEDER } from '@/engine/scenario'
import { usePlan } from '@/state/plan'

const MODES: { value: WeatherMode; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'clear', label: 'Clear' },
  { value: 'cloudy', label: 'Cloudy' },
  { value: 'rain', label: 'Rain' },
  { value: 'heatwave', label: 'Heatwave' },
]

/** Scenario inputs: every change re-runs the planner (CP-SAT when the API is up). */
export function ScenarioControls({ compact = false }: { compact?: boolean }) {
  const params = usePlan((s) => s.params)
  const setParams = usePlan((s) => s.setParams)
  const reset = usePlan((s) => s.resetParams)
  const status = usePlan((s) => s.status)
  const engine = usePlan((s) => s.engine)
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="kicker opacity-60">Scenario</p>
        {status === 'loading' ? <Working label={engine === 'heuristic' ? 'Re-planning' : 'CP-SAT re-planning'} /> : <button className="kicker underline opacity-70 hover:opacity-100" onClick={reset}>Reset</button>}
      </div>
      <Segmented<WeatherMode> label="Weather" size="sm" value={params.weatherMode ?? 'live'} onChange={(v) => setParams({ weatherMode: v }, { debounceMs: 0 })} options={MODES} />
      <div className={`grid gap-4 ${compact ? '' : 'sm:grid-cols-2'}`}>
        <Slider label="Solar plant" value={params.pvKwp ?? FEEDER.pv_kwp} min={40} max={260} step={10} unit="kWp" onChange={(v) => setParams({ pvKwp: v })} />
        <Slider label="Feeder limit" value={params.feederLimitKw ?? FEEDER.feeder_limit_kw} min={30} max={120} step={2} unit="kW" onChange={(v) => setParams({ feederLimitKw: v })} />
        <Slider label="Grid backup" value={params.gridBackupKw ?? FEEDER.grid_backup_kw} min={0} max={60} step={5} unit="kW" onChange={(v) => setParams({ gridBackupKw: v })} hint="0 = solar-only daytime supply" />
        <Slider label="Crop demand" value={params.demandScale ?? 1} min={0.5} max={1.6} step={0.05} unit="×" onChange={(v) => setParams({ demandScale: v })} format={(v) => v.toFixed(2)} />
      </div>
    </div>
  )
}
