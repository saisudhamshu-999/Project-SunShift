import { useMemo, useRef } from 'react'
import { Link } from 'react-router'
import { scrollToTarget } from '@/components/layout/SmoothScroll'
import { LogoMark } from '@/components/layout/Logo'
import { Reveal } from '@/components/text/Reveal'
import { defaultPlanDate } from '@/engine/plan'
import { usePlan } from '@/state/plan'
import { LazyCanvas } from '@/three/common/LazyCanvas'
import { HeroScene } from '@/three/scenes/HeroScene'
import { HeroPoster } from './Hero'

/** Back to the opening landscape, now alive: pumps take turns on the sun, the feeder stays in limits. */
export function FinalCta() {
  const plan = usePlan((s) => s.result)
  const progress = useRef(1)
  const schedule = useMemo(() => (plan ? Object.fromEntries(plan.farms.map((f) => [f.id, f.schedule.slots])) : undefined), [plan])
  const crops = useMemo(() => (plan ? Object.fromEntries(plan.farms.map((f) => [f.id, f.crop])) : undefined), [plan])
  const das = useMemo(() => (plan ? Object.fromEntries(plan.farms.map((f) => [f.id, f.das])) : undefined), [plan])
  return (
    <section id="finale" data-theme="dark" className="relative h-[110svh] min-h-[640px] overflow-hidden bg-ink text-ivory" aria-label="Closing">
      <LazyCanvas
        className="absolute inset-0"
        label="The feeder at work through a full day: pumps start in turn as the sun crosses the sky"
        fallback={<HeroPoster />}
        camera={{ position: [60, 54, 60], fov: 38, near: 0.5, far: 2000 }}
      >
        {(tier) => <HeroScene progress={progress} tier={tier} date={plan?.meta.date ?? defaultPlanDate()} alive schedule={schedule} crops={crops} das={das} />}
      </LazyCanvas>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_30%_60%,rgba(10,8,5,0.72),rgba(10,8,5,0.15)_70%)]" aria-hidden />
      <div className="wrap relative flex h-full flex-col justify-center">
        <h2 className="t-display t-xl max-w-[16ch]">
          <Reveal as="span" className="block" split="words">
            When the sun rises,
          </Reveal>
          {' '}
          <Reveal as="span" className="block text-sun" split="words" delay={0.2}>
            every pump doesn't have to.
          </Reveal>
        </h2>
        <div className="mt-14 flex items-center gap-4">
          <LogoMark size={44} ink="#f3eee4" />
          <div>
            <p className="text-[22px] font-[680] tracking-[0.18em]">SUNSHIFT</p>
            <p className="text-[15px] text-ivory/70">Irrigation scheduling for the solar era.</p>
          </div>
        </div>
        <div className="pointer-events-auto mt-12 flex flex-wrap gap-3">
          <Link to="/app" className="btn btn-sun h-14 px-7 text-[16px]">
            Explore the feeder <span aria-hidden>→</span>
          </Link>
          <button onClick={() => scrollToTarget('#system')} className="btn h-14 border border-ivory/40 px-7 text-[16px] text-ivory hover:bg-ivory/10">
            View the system <span aria-hidden>→</span>
          </button>
          <Link to="/demo" className="btn h-14 px-5 text-[16px] text-ivory/80 underline-offset-4 hover:underline">
            Demo mode
          </Link>
        </div>
      </div>
    </section>
  )
}
