import { Reveal } from '@/components/text/Reveal'

const LIMITS = [
  ['Groundwater data is coarse.', 'Borewell yield and depth vary farm to farm and season to season. SunShift estimates pump discharge from rated power and head until flow is measured.'],
  ['Pump discharge is estimated.', 'A wire-to-water efficiency of 38% stands in for each pumpset until field data replaces it.'],
  ['Forecasts are uncertain.', 'Rain is missed sometimes and forecast sometimes when it never comes. The plan re-optimises during the day, and the season simulation includes these errors on purpose.'],
  ['Farmers decide.', 'Adherence is uncertain, and that is by design. Replies and observed pump states feed back into tomorrow’s plan.'],
  ['Soil and crop parameters are tabulated.', 'FAO-56 values are a sound start; field moisture readings and local crop calendars make them better.'],
  ['This feeder is simulated.', 'The 20 farms, their pumps and states are a realistic scenario, not a measured feeder. Weather is real.'],
]

export function NotMagic() {
  return (
    <section id="honesty" data-theme="dark" className="theme-surface relative py-[clamp(80px,11vw,170px)]">
      <div className="wrap">
        <p className="kicker text-alert">Not magic</p>
        <Reveal as="h2" className="t-display t-xl mt-6 max-w-[17ch]" split="words">
          We don't pretend the data is perfect.
        </Reveal>
        <dl className="mt-14 grid gap-x-12 gap-y-10 md:grid-cols-2">
          {LIMITS.map(([k, v]) => (
            <div key={k} className="border-t border-ivory/15 pt-5">
              <dt className="text-[21px] font-[620] tracking-[-0.02em]">{k}</dt>
              <dd className="mt-2 max-w-[52ch] text-[15px] leading-relaxed text-ivory/65">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="t-display t-m mt-16 max-w-[24ch]">
          SunShift is designed to get <span className="text-sun">more accurate</span> as deployment data improves.
        </p>
      </div>
    </section>
  )
}
