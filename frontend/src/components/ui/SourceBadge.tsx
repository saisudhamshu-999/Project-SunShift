import type { WeatherSource } from '@/api/types'

export type BadgeKind = WeatherSource | 'simulation' | 'demo' | 'cp-sat' | 'heuristic' | 'computed'

const STYLES: Record<BadgeKind, { label: string; dot: string; title: string }> = {
  live: { label: 'Live weather', dot: '#4c8a3b', title: 'Open-Meteo forecast fetched by the SunShift API' },
  'browser-live': { label: 'Live weather · browser', dot: '#4c8a3b', title: 'Open-Meteo forecast fetched directly by your browser' },
  cached: { label: 'Cached forecast', dot: '#f2a900', title: 'Forecast service unreachable: last cached forecast in use' },
  climatology: { label: 'Climatology fallback', dot: '#8a8270', title: 'No forecast available: monthly climate normals in use' },
  'browser-clear-sky': { label: 'Climatology · browser', dot: '#8a8270', title: 'No forecast reachable: monthly normals shaped by a clear-sky model' },
  replay: { label: 'ERA5 replay', dot: '#2f74c0', title: 'Historical weather from the Open-Meteo archive (ERA5 reanalysis)' },
  simulation: { label: 'Simulation · 20-farm feeder', dot: '#d04a2f', title: 'Farms, pumps and schedules are simulated, not field measurements' },
  demo: { label: 'Demo data', dot: '#d04a2f', title: 'Illustrative values' },
  'cp-sat': { label: 'CP-SAT optimiser', dot: '#f2a900', title: 'Schedule solved by Google OR-Tools CP-SAT on the SunShift API' },
  heuristic: { label: 'Browser heuristic · not CP-SAT', dot: '#d04a2f', title: 'API unreachable: schedule from the greedy fallback heuristic' },
  computed: { label: 'Computed live', dot: '#4c8a3b', title: 'Calculated in your browser from the equations shown' },
}

export function SourceBadge({ kind, className = '' }: { kind: BadgeKind; className?: string }) {
  const s = STYLES[kind] ?? STYLES.simulation
  return (
    <span className={`chip ${className}`} title={s.title} style={kind === 'simulation' || kind === 'demo' ? { borderStyle: 'dashed' } : undefined}>
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.dot }} />
      {s.label}
    </span>
  )
}
