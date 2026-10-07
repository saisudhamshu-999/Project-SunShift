import { useEffect, useRef, useState } from 'react'
import { Reveal } from '@/components/text/Reveal'
import { ActLabel } from '@/components/ui/primitives'
import { ScrollTrigger } from '@/lib/gsap'
import { useUi } from '@/state/ui'
import { LazyCanvas } from '@/three/common/LazyCanvas'
import { HardwareScene, PARTS } from '@/three/scenes/HardwareScene'

const STEPS: { title: string; voltage: 'Signal · 3.3 V' | 'Coil · 230 V' | 'Power · 415 V, 3-phase' | 'Farmer'; body: string }[] = [
  { title: PARTS[0], voltage: 'Signal · 3.3 V', body: "Receives the day's schedule over GSM or Wi-Fi, keeps a cached copy so it can run offline, and reports pump state every minute." },
  { title: PARTS[1], voltage: 'Coil · 230 V', body: 'An opto-isolated relay turns a 3.3 V logic signal into the contactor coil circuit. Low voltage never meets motor power.' },
  { title: PARTS[2], voltage: 'Power · 415 V, 3-phase', body: "The contactor's contacts carry the motor's three-phase current. The controller only energises its coil; release the coil and the motor stops." },
  { title: PARTS[3], voltage: 'Power · 415 V, 3-phase', body: 'Overload (thermal or MPCB), phase-failure and dry-run relays trip the contactor on their own, whatever the software says.' },
  { title: PARTS[4], voltage: 'Farmer', body: 'AUTO · OFF · MANUAL. A physical selector puts the farmer in charge at any moment. Automation is opt-in.' },
  { title: PARTS[5], voltage: 'Power · 415 V, 3-phase', body: "The farm's existing 3–7.5 HP submersible pump. No change to the pump, its starter protection or its wiring standard." },
]

const SAFETY = ['Contactor-switched', 'Overload protection', 'Phase-failure protection', 'Dry-run protection', 'Manual override', 'Fails safe: no signal, no pump']

export function Hardware() {
  const section = useRef<HTMLElement>(null)
  const steps = useRef<(HTMLDivElement | null)[]>([])
  const explode = useRef(0)
  const active = useRef(-1)
  const [current, setCurrent] = useState(0)
  const reduced = useUi((s) => s.reducedMotion)

  useEffect(() => {
    const el = section.current
    if (!el) return
    if (reduced) explode.current = 1
    const triggers = [
      ScrollTrigger.create({
        trigger: el,
        start: 'top 60%',
        end: 'bottom bottom',
        onUpdate: (self) => void (explode.current = reduced ? 1 : Math.min(1, self.progress * 2.2)),
      }),
      ...steps.current.map((node, i) =>
        ScrollTrigger.create({
          trigger: node,
          start: 'top 55%',
          end: 'bottom 55%',
          onToggle: (self) => {
            if (self.isActive) {
              active.current = i
              setCurrent(i)
            }
          },
        }),
      ),
    ]
    return () => triggers.forEach((t) => t.kill())
  }, [reduced])

  return (
    <section ref={section} id="hardware" data-theme="dark" className="relative bg-[#1b1a16] text-ivory">
      <div className="wrap pt-[clamp(80px,11vw,170px)]">
        <ActLabel act="VIII" title="The control" />
        <h2 className="t-display t-xl mt-8 max-w-[16ch]">
          <Reveal as="span" className="block" split="words">
            The controller never
          </Reveal>
          {' '}
          <Reveal as="span" className="block text-sun" split="words" delay={0.15}>
            drives the motor.
          </Reveal>
        </h2>
        <p className="lede mt-8 text-ivory/65">
          Optional pump control is built like an electrician would build it. A small controller asks; a contactor switches; independent protection
          relays have the last word; the farmer can always take over.
        </p>
        <ul className="mt-8 flex flex-wrap gap-2">
          {SAFETY.map((s) => (
            <li key={s} className="chip border-ivory/25">
              <span className="h-1.5 w-1.5 rounded-full bg-crop-2" aria-hidden />
              {s}
            </li>
          ))}
        </ul>
      </div>

      <div className="wrap grid gap-10 pb-[clamp(80px,11vw,170px)] lg:grid-cols-[1.15fr_1fr]">
        <div className="relative lg:order-1">
          <div className="sticky top-0 flex h-[70svh] items-center lg:h-svh">
            <LazyCanvas
              className="relative h-[64svh] w-full overflow-hidden rounded-[28px] lg:h-[78svh]"
              label={`Exploded view of the pump controller. Highlighted: ${PARTS[current]}`}
              fallback={<div className="absolute inset-0 bg-[#1b1a16]" />}
              camera={{ position: [2.2, 0.6, 13], fov: 44 }}
            >
              {() => <HardwareScene explode={explode} active={active} />}
            </LazyCanvas>
            <div className="pointer-events-none absolute bottom-[8%] left-5 flex gap-4 kicker">
              <span className="flex items-center gap-2"><i className="h-2 w-4 rounded-sm bg-water" aria-hidden /> Signal</span>
              <span className="flex items-center gap-2"><i className="h-2 w-4 rounded-sm bg-[#e08a00]" aria-hidden /> Power</span>
            </div>
          </div>
        </div>
        <div className="lg:order-2 lg:pt-[20svh]">
          {STEPS.map((s, i) => (
            <div key={s.title} ref={(el) => void (steps.current[i] = el)} className="flex min-h-[46svh] flex-col justify-center py-8 lg:min-h-[64svh]">
              <p className="kicker num text-ivory/40">{String(i + 1).padStart(2, '0')} / 06</p>
              <h3 className={`t-display t-m mt-3 transition-colors duration-500 ${current === i ? 'text-ivory' : 'text-ivory/35'}`}>{s.title}</h3>
              <p className="kicker mt-3" style={{ color: s.voltage.startsWith('Signal') ? '#6aa8e6' : s.voltage === 'Farmer' ? '#84b85c' : '#e08a00' }}>
                {s.voltage}
              </p>
              <p className={`mt-4 max-w-md text-[16px] leading-relaxed transition-opacity duration-500 ${current === i ? 'opacity-80' : 'opacity-40'}`}>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
