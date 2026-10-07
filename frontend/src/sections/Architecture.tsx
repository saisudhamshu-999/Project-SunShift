import { useState } from 'react'
import { Reveal } from '@/components/text/Reveal'
import { useIsMobile } from '@/lib/hooks'

interface ArchNode {
  id: string
  title: string
  tech: string
  x: number
  y: number
  input: string
  output: string
  purpose: string
  module: string
  status?: 'built' | 'design'
  tone?: 'external' | 'core' | 'out' | 'edge'
}

const NODES: ArchNode[] = [
  { id: 'om', title: 'Open-Meteo', tech: 'forecast + ERA5 archive', x: 260, y: 60, tone: 'external', input: 'Feeder latitude and longitude', output: '15-minute radiation, hourly weather, daily FAO ET₀ reference; historical reanalysis for replays', purpose: 'Real weather without proprietary APIs', module: 'external API, cached in the database' },
  { id: 'wx', title: 'Weather engine', tech: 'Python · httpx · numpy', x: 260, y: 175, tone: 'core', input: 'Raw forecast (or archive)', output: 'One DayWeather: 48 slots of irradiance, temperature and wind, daily FAO-56 aggregates, rain look-ahead, provenance', purpose: 'A clean, labelled weather object per day, with cached and climatology fallbacks', module: 'backend/app/engine/weather.py' },
  { id: 'pv', title: 'PV model', tech: 'pvlib', x: 260, y: 290, tone: 'core', input: 'GHI, DNI, DHI, air temperature, wind', output: 'AC kW per 15-minute slot, plus clear-sky potential', purpose: 'What the feeder can actually use, not just what reaches the ground', module: 'backend/app/engine/solar.py' },
  { id: 'ag', title: 'Agronomy engine', tech: 'FAO-56', x: 260, y: 405, tone: 'core', input: 'Weather, crop, sowing date, soil', output: 'ET₀, Kc, ETc, TAW, RAW, root-zone depletion, stress', purpose: 'Crop water use, computed the way agronomists do', module: 'backend/app/engine/agronomy.py' },
  { id: 'fr', title: 'Farm water requirement', tech: 'rain-aware · pump-aware', x: 260, y: 520, tone: 'core', input: 'Depletion, rain forecast, pump hydraulics, method efficiency', output: "Today's dose in m³, pump slots, priority weight with reasons", purpose: 'Turn agronomy into pump-hours on each farm', module: 'agronomy.assess_farm · explain.py' },
  { id: 'cp', title: 'CP-SAT optimiser', tech: 'Google OR-Tools', x: 260, y: 650, tone: 'core', input: 'Jobs, solar AC per slot, feeder limit, grid cap, availability, fairness carry-over', output: 'On/off decision for every pump in every 15-minute slot, with solver statistics', purpose: 'Decide under physical constraints, fairly and explainably', module: 'backend/app/engine/optimiser.py · heuristic.py' },
  { id: 'db', title: 'PostgreSQL', tech: 'runs · weather cache', x: 260, y: 790, tone: 'edge', input: 'Plans, season runs, forecasts', output: 'Run history, cached forecasts for outages', purpose: 'Audit trail and persistence fallback (SQLite in development)', module: 'backend/app/db.py' },
  { id: 'fs', title: 'Feeder schedule', tech: 'DISCOM dashboard', x: 740, y: 560, tone: 'out', input: 'Optimised plan', output: 'Live feeder view: load vs limit, binding constraint, schedule', purpose: 'Operators see and trust the plan', module: 'frontend /app' },
  { id: 'fm', title: 'Farmer schedule', tech: 'SMS · voice (IVR)', x: 740, y: 665, tone: 'out', input: "Each farm's window and reasons", output: 'Telugu, Hindi or English message; 1 = confirm, 2 = change', purpose: 'A complex plan becomes one simple instruction', module: 'frontend/src/components/farmer/messages.ts', status: 'built' },
  { id: 'pc', title: 'Pump control', tech: 'opt-in only', x: 740, y: 770, tone: 'out', input: 'Schedule for consenting farms', output: 'Switch commands with a cached day plan', purpose: 'Automation only where the farmer chose it', module: 'API → controller (design)', status: 'design' },
  { id: 'esp', title: 'ESP32 controller', tech: 'relay · contactor', x: 740, y: 875, tone: 'edge', input: 'Switch commands, cached schedule', output: 'Coil signal to the contactor; pump state reports', purpose: 'Execute safely, even offline', module: 'reference design (not in this prototype)', status: 'design' },
  { id: 'pump', title: 'Pump', tech: 'existing 3–7.5 HP', x: 740, y: 980, tone: 'edge', input: 'Contactor', output: 'Water to the field', purpose: 'Unchanged farm equipment', module: 'field' },
  { id: 'fb', title: 'Feedback', tech: 'planned vs actual', x: 740, y: 1085, tone: 'edge', input: 'Pump states, feeder meter, weather updates', output: 'Executed slots + deviations', purpose: 'Triggers re-optimisation of the rest of the day', module: 'POST /api/plan with fixedUntil + executed' },
]

const LINKS: [string, string][] = [
  ['om', 'wx'], ['wx', 'pv'], ['wx', 'ag'], ['pv', 'cp'], ['ag', 'fr'], ['fr', 'cp'], ['cp', 'db'], ['cp', 'fs'], ['cp', 'fm'], ['cp', 'pc'], ['pc', 'esp'], ['esp', 'pump'], ['pump', 'fb'],
]

const TONE = { external: '#2f74c0', core: '#15140f', out: '#f2a900', edge: '#8a8270' }
const W = 300
const H = 70

function path(a: ArchNode, b: ArchNode) {
  if (a.x === b.x) return `M${a.x},${a.y + H / 2} L${b.x},${b.y - H / 2}`
  if (a.id === 'pv') return `M${a.x + W / 2},${a.y} C${a.x + W / 2 + 80},${a.y} ${b.x + W / 2 + 80},${b.y} ${b.x + W / 2},${b.y - 12}`
  return `M${a.x + W / 2},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x - W / 2},${b.y}`
}

export function Architecture() {
  const [active, setActive] = useState('cp')
  const mobile = useIsMobile()
  const node = NODES.find((n) => n.id === active)!
  const byId = (id: string) => NODES.find((n) => n.id === id)!

  return (
    <section id="architecture" className="survey-grid relative bg-paper py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <p className="kicker">System architecture</p>
        <Reveal as="h2" className="t-display t-xl mt-6 max-w-[15ch]" split="words">
          From a forecast to a switch.
        </Reveal>
        <div className="mt-14 grid gap-10 lg:grid-cols-[1.5fr_1fr]">
          {mobile ? (
            <ol className="space-y-2">
              {NODES.map((n) => (
                <li key={n.id}>
                  <button onClick={() => setActive(n.id)} aria-pressed={active === n.id} className={`w-full rounded-2xl border px-4 py-3 text-left ${active === n.id ? 'border-ink bg-ink text-ivory' : ''}`} style={active === n.id ? undefined : { borderColor: 'var(--line-2)' }}>
                    <span className="block font-[620]">{n.title}</span>
                    <span className="kicker opacity-60">{n.tech}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <svg viewBox="40 0 920 1140" className="w-full" role="group" aria-label="SunShift architecture: select a layer for details">
              <style>{`.flow{stroke-dasharray:5 7;animation:flow 1.4s linear infinite}@keyframes flow{to{stroke-dashoffset:-24}}[data-motion=reduced] .flow{animation:none}`}</style>
              {LINKS.map(([a, b]) => (
                <path key={`${a}-${b}`} d={path(byId(a), byId(b))} fill="none" stroke={active === a || active === b ? '#f2a900' : '#15140f'} strokeOpacity={active === a || active === b ? 1 : 0.35} strokeWidth="1.6" className="flow" />
              ))}
              {/* re-optimise loop */}
              <path d={`M${740 - W / 2},1085 L90,1085 L90,650 L${260 - W / 2},650`} fill="none" stroke="#f2a900" strokeWidth="1.6" className="flow" />
              <text x="100" y="870" fill="#e08a00" fontSize="13" className="mono" letterSpacing="0.14em" transform="rotate(-90 100 870)">
                RE-OPTIMISE
              </text>
              {NODES.map((n) => {
                const on = active === n.id
                return (
                  <g
                    key={n.id}
                    tabIndex={0}
                    role="button"
                    aria-pressed={on}
                    aria-label={`${n.title}: ${n.tech}`}
                    onMouseEnter={() => setActive(n.id)}
                    onFocus={() => setActive(n.id)}
                    onClick={() => setActive(n.id)}
                    className="cursor-pointer outline-none"
                  >
                    <rect x={n.x - W / 2} y={n.y - H / 2} width={W} height={H} rx="16" fill={on ? '#15140f' : '#faf7f0'} stroke={TONE[n.tone ?? 'core']} strokeWidth={on ? 2 : 1.2} strokeDasharray={n.status === 'design' ? '5 4' : undefined} />
                    <text x={n.x - W / 2 + 20} y={n.y - 4} fontSize="17" fontWeight="620" fill={on ? '#f3eee4' : '#15140f'}>
                      {n.title}
                    </text>
                    <text x={n.x - W / 2 + 20} y={n.y + 18} fontSize="11.5" fill={on ? '#f2a900' : '#6f6857'} className="mono" letterSpacing="0.08em">
                      {n.tech.toUpperCase()}
                    </text>
                  </g>
                )
              })}
            </svg>
          )}
          <aside className="card h-fit p-7 lg:sticky lg:top-24" aria-live="polite">
            <p className="kicker" style={{ color: TONE[node.tone ?? 'core'] === '#15140f' ? undefined : TONE[node.tone ?? 'core'] }}>
              {node.status === 'design' ? 'Design · not built in this prototype' : 'Layer'}
            </p>
            <h3 className="t-display t-m mt-3">{node.title}</h3>
            <dl className="mt-6 space-y-4 text-[14.5px]">
              {(
                [
                  ['Input', node.input],
                  ['Output', node.output],
                  ['Purpose', node.purpose],
                  ['Technology', node.tech],
                  ['Where in the code', node.module],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="kicker opacity-55">{k}</dt>
                  <dd className={`mt-1 leading-relaxed ${k === 'Where in the code' ? 'mono text-[12.5px]' : ''}`}>{v}</dd>
                </div>
              ))}
            </dl>
          </aside>
        </div>
      </div>
    </section>
  )
}
