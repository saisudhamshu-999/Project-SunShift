import { Reveal } from '@/components/text/Reveal'
import { useUi } from '@/state/ui'

const STACK = [
  { k: 'Forecasting', v: 'Open-Meteo', d: '15-minute radiation and hourly weather; ERA5 archive for replays. Cached; climatology fallback.' },
  { k: 'Solar', v: 'pvlib', d: 'Solar position, Hay–Davies transposition, Faiman cell temperature, PVWatts DC and inverter.' },
  { k: 'Agronomy', v: 'FAO-56', d: 'Penman–Monteith ET₀, single crop coefficients, root-zone water balance. Tested against the paper’s worked example.' },
  { k: 'Optimisation', v: 'OR-Tools CP-SAT', d: 'Time-indexed scheduling, lexicographic fairness, greedy warm start, honest status and gap.' },
  { k: 'Backend', v: 'FastAPI', d: 'Typed API, streaming season simulation, one service that also serves this site.' },
  { k: 'Database', v: 'PostgreSQL', d: 'Run history and forecast cache through SQLAlchemy; SQLite in development.' },
  { k: 'Interface', v: 'React · Three.js', d: 'React Three Fiber digital twin, GSAP motion, a browser fallback engine for static hosting.' },
  { k: 'Hardware', v: 'ESP32 + contactor', d: 'Reference design: contactor-switched, independently protected, manual override.' },
]

export function TechCredibility() {
  const health = useUi((s) => s.health)
  const status = useUi((s) => s.apiStatus)
  return (
    <section id="technology" data-theme="dark" className="theme-surface relative py-[clamp(80px,11vw,170px)]">
      <div className="wrap">
        <p className="kicker text-sun">Technical credibility</p>
        <h2 className="t-display t-l mt-6 max-w-[22ch]">
          <Reveal as="span" className="block" split="words">
            AI where prediction benefits from data.
          </Reveal>
          {' '}
          <Reveal as="span" className="block text-sun" split="words" delay={0.15}>
            Optimisation where physics sets the limits.
          </Reveal>
        </h2>
        <p className="lede mt-8 text-ivory/65">
          SunShift does not call everything AI. Today its forecasts come from numerical weather prediction via Open-Meteo, its water model from
          FAO-56 and its decisions from a constraint solver. Learning from feeder telemetry, to correct forecasts and pump models, comes with
          deployment data.
        </p>
        <div className="mt-14 grid gap-px overflow-hidden rounded-[22px] border border-ivory/10 bg-ivory/10 sm:grid-cols-2 lg:grid-cols-4">
          {STACK.map((s) => (
            <div key={s.k} className="bg-[#12110e] p-6">
              <p className="kicker text-ivory/45">{s.k}</p>
              <p className="mt-3 text-[22px] font-[620] tracking-[-0.02em]">{s.v}</p>
              <p className="mt-3 text-[13.5px] leading-relaxed text-ivory/60">{s.d}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-3 kicker text-ivory/60">
          {status === 'online' && health ? (
            <>
              <span className="chip border-crop-2/60 text-crop-2">
                <span className="h-1.5 w-1.5 rounded-full bg-crop-2" /> Engine running now
              </span>
              <span>OR-Tools {health.ortools}</span>
              <span>· pvlib {health.pvlib}</span>
              <span>· database {health.db}</span>
            </>
          ) : status === 'offline' ? (
            <span className="chip chip-wrap border-alert/60 text-alert">API unreachable from this page: the browser fallback engine is running</span>
          ) : null}
        </div>
      </div>
    </section>
  )
}
