import { Reveal, Rise } from '@/components/text/Reveal'
import { ActLabel } from '@/components/ui/primitives'

const CHAIN = [
  { k: 'PM-KUSUM', v: 'Component C supports solarising agricultural pumping, including whole agricultural feeders.' },
  { k: 'Solarised feeder', v: 'A solar plant near the substation feeds the agricultural feeder in daytime.' },
  { k: 'Many pumps', v: 'Dozens to hundreds of smallholder pumpsets share that feeder.' },
  { k: 'Shared resource', v: 'Daylight energy and line capacity become a commons that every pump draws on.' },
  { k: 'SunShift', v: 'Coordinates when each pump draws on it.' },
]

const ACTORS = [
  { k: 'Smallholder farms', v: 'Receive the schedule by SMS or voice; keep the final say over their pump.' },
  { k: 'FPO', v: 'Farmer producer organisations enrol farmers, collect consent and carry feedback.' },
  { k: 'DISCOM', v: 'Owns the feeder and its limits; gains a flatter daytime load and fewer trips.' },
  { k: 'RESCO / plant developer', v: 'Operates the solar plant; more of its output is used on the feeder it was built for.' },
  { k: 'The feeder', v: 'The unit of deployment: one SunShift instance per feeder, scaling feeder by feeder.' },
]

const DEPLOYERS = [
  { k: 'DISCOM', v: 'Feeder coordination', d: 'Keep daytime agricultural load within feeder and transformer limits; fewer trips and burnt motors.' },
  { k: 'FPO', v: 'Farmer aggregation', d: 'Enrolment, consent, language and trust; the human channel for the schedule.' },
  { k: 'RESCO', v: 'Solar asset optimisation', d: 'Match pumping to generation so the plant serves the farms it was built for.' },
  { k: 'State agencies', v: 'Water + energy programmes', d: 'Groundwater and energy-efficiency goals, measured feeder by feeder.' },
]

const SCALE = ['Solar feeder', 'SunShift platform', '20–50 farms', 'Measured impact', '100s → 1,000s of feeders']

export function IndiaFit() {
  return (
    <section id="india" className="relative bg-ivory py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <ActLabel act="X" title="The future" />
        <Reveal as="h2" className="t-display t-xl mt-8 max-w-[15ch]" split="words">
          Built for how India is solarising farms.
        </Reveal>
        <p className="lede mt-6">
          India is moving agricultural pumping onto daytime solar. Feeder-level solarisation creates the coordination problem SunShift exists to
          solve: one plant, one line, many pumps.
        </p>

        <div className="mt-16 grid gap-14 lg:grid-cols-2">
          <ol className="relative space-y-0" aria-label="Deployment logic">
            {CHAIN.map((c, i) => (
              <li key={c.k} className="grid grid-cols-[36px_1fr] gap-4">
                <div className="flex flex-col items-center">
                  <span className={`mt-1 grid h-8 w-8 place-items-center rounded-full border text-[12px] font-[650] ${i === CHAIN.length - 1 ? 'border-sun bg-sun' : ''}`} style={i === CHAIN.length - 1 ? undefined : { borderColor: 'var(--line-2)' }}>
                    {i + 1}
                  </span>
                  {i < CHAIN.length - 1 && <span className="w-px flex-1 bg-ink/20" aria-hidden />}
                </div>
                <div className="pb-8">
                  <p className="t-display text-[clamp(1.4rem,2.4vw,2rem)]">{c.k}</p>
                  <p className="mt-1 max-w-md text-[15px] leading-relaxed opacity-70">{c.v}</p>
                </div>
              </li>
            ))}
          </ol>
          <div>
            <p className="kicker opacity-60">Who is around the feeder</p>
            <dl className="mt-5 divide-y" style={{ borderColor: 'var(--line)' }}>
              {ACTORS.map((a) => (
                <div key={a.k} className="grid gap-1 py-4 sm:grid-cols-[180px_1fr]" style={{ borderColor: 'var(--line)' }}>
                  <dt className="font-[620]">{a.k}</dt>
                  <dd className="text-[15px] opacity-70">{a.v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-6 text-[13px] leading-relaxed opacity-55">
              Programme details vary by state and change over time; SunShift is designed around the feeder as the unit, not around any single scheme's rules.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

export function WhoDeploys() {
  return (
    <section className="relative bg-sand py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <p className="kicker">Deployment model</p>
        <Reveal as="h2" className="t-display t-xl mt-6" split="words">
          Who deploys SunShift?
        </Reveal>
        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {DEPLOYERS.map((d, i) => (
            <Rise key={d.k} delay={i * 0.06}>
              <article className="card h-full p-6">
                <p className="t-display text-[30px]">{d.k}</p>
                <p className="kicker mt-2 text-earth">{d.v}</p>
                <p className="mt-5 text-[14.5px] leading-relaxed opacity-75">{d.d}</p>
              </article>
            </Rise>
          ))}
        </div>
        <ol className="mt-16 flex flex-col gap-3 md:flex-row md:items-center" aria-label="Path to scale">
          {SCALE.map((s, i) => (
            <li key={s} className="flex items-center gap-3 md:flex-1">
              <span className={`flex-1 rounded-full border px-4 py-3 text-center text-[14.5px] font-[560] ${i === SCALE.length - 1 ? 'border-ink bg-ink text-ivory' : ''}`} style={i === SCALE.length - 1 ? undefined : { borderColor: 'var(--line-2)' }}>
                {s}
              </span>
              {i < SCALE.length - 1 && <span aria-hidden className="text-[18px] opacity-40 max-md:rotate-90">→</span>}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
