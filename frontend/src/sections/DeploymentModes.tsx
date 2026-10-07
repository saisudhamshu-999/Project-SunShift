import { Reveal, Rise } from '@/components/text/Reveal'

const MODES = [
  {
    n: '01',
    name: 'Advisory',
    chain: ['SunShift', 'SMS / voice call', 'Farmer switches the pump'],
    control: 'The farmer decides and switches.',
    needs: 'Any phone. No hardware.',
    when: 'Day one on any feeder.',
  },
  {
    n: '02',
    name: 'Assisted',
    chain: ['SunShift', 'Farmer confirms (press 1)', 'Controller switches'],
    control: 'The farmer approves every run.',
    needs: 'Controller + contactor at the pump.',
    when: 'Where farmers want convenience.',
  },
  {
    n: '03',
    name: 'Automated',
    chain: ['SunShift', 'Controller', 'Pump'],
    control: 'Runs the plan; manual override always wins.',
    needs: 'Controller + written consent.',
    when: 'Where the farmer has opted in.',
  },
]

export function DeploymentModes() {
  return (
    <section id="deployment" className="relative bg-ivory py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <p className="kicker">Three ways to deploy</p>
        <Reveal as="h2" className="t-display t-xl mt-6 max-w-[16ch]" split="words">
          Start with a message. Add control only when asked.
        </Reveal>
        <div className="mt-16 grid gap-5 md:grid-cols-3">
          {MODES.map((m, i) => (
            <Rise key={m.n} delay={i * 0.08}>
              <article className="card group flex h-full flex-col p-7 transition-[transform,box-shadow] duration-500 hover:-translate-y-1.5 hover:shadow-[0_30px_60px_-30px_rgba(21,20,15,0.35)]">
                <header className="flex items-baseline justify-between">
                  <span className="kicker">Mode {m.n}</span>
                  {i === 2 && <span className="chip border-alert/60 text-alert">Opt-in</span>}
                </header>
                <h3 className="t-display t-m mt-6">{m.name}</h3>
                <ol className="mt-8 flex flex-col gap-0" aria-label={`${m.name} control chain`}>
                  {m.chain.map((step, k) => (
                    <li key={step} className="flex flex-col items-start">
                      <span className={`rounded-full border px-4 py-2 text-[14px] font-[560] ${k === 0 ? 'border-ink bg-ink text-ivory' : ''}`} style={k ? { borderColor: 'var(--line-2)' } : undefined}>
                        {step}
                      </span>
                      {k < m.chain.length - 1 && <span className="ml-6 h-6 w-px bg-ink/30" aria-hidden />}
                    </li>
                  ))}
                </ol>
                <dl className="mt-auto space-y-3 border-t pt-6 text-[14px]" style={{ borderColor: 'var(--line)' }}>
                  <div>
                    <dt className="kicker opacity-55">Who is in control</dt>
                    <dd className="mt-1">{m.control}</dd>
                  </div>
                  <div>
                    <dt className="kicker opacity-55">Needs</dt>
                    <dd className="mt-1">{m.needs}</dd>
                  </div>
                  <div>
                    <dt className="kicker opacity-55">Fits</dt>
                    <dd className="mt-1">{m.when}</dd>
                  </div>
                </dl>
              </article>
            </Rise>
          ))}
        </div>
        <p className="t-display t-m mt-16 max-w-[22ch]">
          Automatic control is <span className="text-alert">opt-in</span>. The farmer can always take back the switch.
        </p>
      </div>
    </section>
  )
}
