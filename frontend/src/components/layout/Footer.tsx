import { Link } from 'react-router'
import { Logo } from './Logo'

const COLS = [
  { title: 'System', links: [['How it works', '/#system'], ['Simulation', '/#simulation'], ['Feeder', '/#feeder'], ['Technology', '/#technology']] },
  { title: 'Impact', links: [['Water', '/#impact'], ['Energy', '/#impact'], ['Economics', '/#economics'], ['Agriculture', '/#farm']] },
  { title: 'Build', links: [['Architecture', '/#architecture'], ['Deployment', '/#deployment'], ['Roadmap', '/#roadmap']] },
  { title: 'Product', links: [['Live feeder', '/app'], ['Demo mode', '/demo']] },
]

export function Footer() {
  return (
    <footer data-theme="dark" className="theme-surface border-t hairline">
      <div className="wrap grid gap-12 py-16 md:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div>
          <Logo />
          <p className="mt-4 max-w-[22ch] text-[22px] font-[560] leading-[1.1] tracking-[-0.02em]">Irrigation scheduling for the solar era.</p>
        </div>
        {COLS.map((c) => (
          <div key={c.title}>
            <p className="kicker text-[var(--fg-2)]">{c.title}</p>
            <ul className="mt-4 space-y-2.5">
              {c.links.map(([label, href]) => (
                <li key={label}>
                  <Link to={href} className="text-[15px] opacity-85 transition-opacity hover:opacity-100">{label}</Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="wrap border-t hairline py-8">
        <p className="max-w-[90ch] text-[13px] leading-relaxed text-[var(--fg-2)]">
          Data honesty: farms, pumps, schedules and savings shown on this site come from a simulated 20-farm solarised feeder,
          not from field measurements. Weather is live (Open-Meteo) or replayed (ERA5 reanalysis) wherever it is labelled so.
          Schedules are solved by Google OR-Tools CP-SAT when the API is reachable, and by a clearly labelled heuristic when it is not.
        </p>
        <p className="mt-3 max-w-[90ch] text-[13px] leading-relaxed text-[var(--fg-2)]">
          <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="underline underline-offset-2 transition-colors hover:text-[var(--fg)]">
            Weather data by Open-Meteo.com
          </a>{' '}
          (CC BY 4.0). Historical replays contain modified Copernicus Climate Change Service information (ERA5). PV model: pvlib. Agronomy: FAO
          Irrigation and Drainage Paper 56.
        </p>
        <div className="mt-6 flex flex-col justify-between gap-3 kicker text-[var(--fg-2)] sm:flex-row">
          <span>Yuva Yodha 2026 · Schneider Electric Energy Tech Hackathon · Sustainable Agriculture track</span>
          <span>© 2026 SunShift</span>
        </div>
      </div>
    </footer>
  )
}
