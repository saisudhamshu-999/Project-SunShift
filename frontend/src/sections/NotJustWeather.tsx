import { useEffect, useMemo, useState } from 'react'
import { Reveal } from '@/components/text/Reveal'
import { SourceBadge } from '@/components/ui/SourceBadge'
import { ActLabel, Disclosure, Slider } from '@/components/ui/primitives'
import { dayOfYear, et0PenmanMonteith } from '@/engine/fao56'
import { fmt } from '@/lib/format'
import { useTween } from '@/lib/hooks'
import { usePlan } from '@/state/plan'

interface Inputs {
  tmax: number
  tmin: number
  rhMax: number
  rhMin: number
  u2: number
  rs: number
}

function Fraction({ num, den }: { num: React.ReactNode; den: React.ReactNode }) {
  return (
    <span className="inline-flex flex-col items-center align-middle">
      <span className="px-2 pb-1">{num}</span>
      <span className="border-t border-current px-2 pt-1">{den}</span>
    </span>
  )
}

export function NotJustWeather() {
  const plan = usePlan((s) => s.result)
  const live: Inputs | null = plan
    ? { tmax: plan.weather.daily.tmax, tmin: plan.weather.daily.tmin, rhMax: plan.weather.daily.rhMax, rhMin: plan.weather.daily.rhMin, u2: plan.weather.daily.u2, rs: plan.weather.daily.rs }
    : null
  const [inp, setInp] = useState<Inputs>({ tmax: 32, tmin: 22, rhMax: 88, rhMin: 45, u2: 1.4, rs: 19 })
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (live && !touched) setInp(live)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan])

  const loc = plan?.meta.location ?? { lat: 17.97, elevationM: 267 }
  const doy = dayOfYear(plan?.meta.date ?? new Date().toISOString().slice(0, 10))
  const r = useMemo(
    () => et0PenmanMonteith({ ...inp, rhMax: Math.max(inp.rhMax, inp.rhMin), lat: loc.lat, elevation: loc.elevationM, doy }),
    [inp, loc.lat, loc.elevationM, doy],
  )
  const shown = useTween(r.et0, 0.6)
  const set = (k: keyof Inputs) => (v: number) => {
    setTouched(true)
    setInp((s) => ({ ...s, [k]: v }))
  }
  const radShare = r.et0 > 0 ? r.radiationTerm / (r.radiationTerm + r.aeroTerm) : 0.5
  const ref = plan?.weather.daily.et0Reference

  return (
    <section id="farm" className="relative bg-paper py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <ActLabel act="V" title="The model" />
        <Reveal as="h2" className="t-display t-xxl mt-8" split="chars">
          Not just weather.
        </Reveal>
        <p className="lede mt-8">
          Weather is the input. What the crop loses to the air is the signal. SunShift turns the forecast into crop water use with the
          equations agronomists already trust.
        </p>

        <div className="mt-20 grid gap-12 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <p className="kicker text-water">Step 01 · Reference evapotranspiration</p>
            <h3 className="t-display t-m mt-4">How thirsty is the air?</h3>
            <div className="mt-8 grid gap-5 sm:grid-cols-2">
              <Slider label="Max temperature" value={inp.tmax} min={18} max={46} step={0.1} unit="°C" onChange={set('tmax')} format={(v) => fmt(v, 1)} />
              <Slider label="Min temperature" value={inp.tmin} min={5} max={32} step={0.1} unit="°C" onChange={set('tmin')} format={(v) => fmt(v, 1)} />
              <Slider label="Max humidity" value={inp.rhMax} min={20} max={100} step={1} unit="%" onChange={set('rhMax')} />
              <Slider label="Min humidity" value={inp.rhMin} min={5} max={95} step={1} unit="%" onChange={set('rhMin')} />
              <Slider label="Wind at 2 m" value={inp.u2} min={0.2} max={6} step={0.05} unit="m/s" onChange={set('u2')} format={(v) => fmt(v, 2)} />
              <Slider label="Solar radiation" value={inp.rs} min={4} max={30} step={0.1} unit="MJ/m²" onChange={set('rs')} format={(v) => fmt(v, 1)} />
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              {plan && <SourceBadge kind={plan.weather.source} />}
              {touched && live && (
                <button className="kicker underline" onClick={() => (setInp(live), setTouched(false))}>
                  Reset to {plan?.meta.dateLabel} forecast
                </button>
              )}
            </div>
          </div>

          <div className="card flex flex-col justify-between p-[clamp(22px,3vw,40px)]">
            <div>
              <p className="kicker opacity-60">ET₀ · FAO-56 Penman–Monteith</p>
              <p className="num mt-4 flex items-baseline gap-3 leading-none">
                <span className="text-[clamp(5rem,12vw,10rem)] font-[620] tracking-[-0.05em]">{fmt(shown, 2)}</span>
                <span className="text-[20px] opacity-60">mm / day</span>
              </p>
              <p className="mt-3 text-[15px] opacity-70">
                ≈ <strong className="num font-[600]">{fmt(r.et0 * 10000)}</strong> litres per hectare, every day, from a well-watered grass reference.
              </p>
            </div>
            <div className="mt-10">
              <div className="flex justify-between kicker opacity-70">
                <span>Radiation-driven · {fmt(r.radiationTerm, 2)} mm</span>
                <span>Wind and dryness · {fmt(r.aeroTerm, 2)} mm</span>
              </div>
              <div className="mt-3 flex h-4 overflow-hidden rounded-full">
                <div className="bg-sun transition-[width] duration-500" style={{ width: `${radShare * 100}%` }} />
                <div className="flex-1 bg-water" />
              </div>
              {ref != null && !touched && (
                <p className="mt-5 text-[13.5px] leading-relaxed opacity-70">
                  Cross-check: Open-Meteo's own FAO ET₀ for {plan?.meta.dateLabel} is <strong className="num">{fmt(ref, 2)} mm</strong>; ours is{' '}
                  <strong className="num">{fmt(plan?.weather.daily.et0 ?? r.et0, 2)} mm</strong> (Δ {fmt(Math.abs((plan?.weather.daily.et0 ?? r.et0) - ref), 2)} mm). The
                  implementation is unit-tested against FAO-56 Example 18 (3.9 mm/day).
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="mt-14 max-w-5xl">
          <Disclosure summary="Show the equation · FAO-56 Penman–Monteith">
            <div className="overflow-x-auto pb-2">
              <p className="num whitespace-nowrap text-[clamp(1rem,1.8vw,1.5rem)] leading-loose">
                ET₀ ={' '}
                <Fraction
                  num={
                    <>
                      0.408 Δ (R<sub>n</sub> − G) + γ <Fraction num="900" den="T + 273" /> u<sub>2</sub> (e<sub>s</sub> − e<sub>a</sub>)
                    </>
                  }
                  den={
                    <>
                      Δ + γ (1 + 0.34 u<sub>2</sub>)
                    </>
                  }
                />
              </p>
            </div>
            <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-3 text-[13.5px] sm:grid-cols-4">
              {(
                [
                  ['Δ', `${fmt(r.delta, 3)} kPa/°C`, 'slope of the vapour pressure curve'],
                  ['γ', `${fmt(r.gamma, 4)} kPa/°C`, 'psychrometric constant at site altitude'],
                  ['Rₙ', `${fmt(r.rn, 2)} MJ/m²`, 'net radiation (G ≈ 0 for a day)'],
                  ['T', `${fmt(r.tmean, 1)} °C`, 'mean daily air temperature'],
                  ['u₂', `${fmt(r.u2, 2)} m/s`, 'wind speed at 2 m'],
                  ['eₛ', `${fmt(r.es, 3)} kPa`, 'saturation vapour pressure'],
                  ['eₐ', `${fmt(r.ea, 3)} kPa`, 'actual vapour pressure'],
                  ['Rₐ', `${fmt(r.ra, 2)} MJ/m²`, 'extraterrestrial radiation'],
                ] as const
              ).map(([k, v, note]) => (
                <div key={k}>
                  <dt className="t-display text-[22px] normal-case">{k}</dt>
                  <dd className="num">{v}</dd>
                  <dd className="text-[12px] opacity-55">{note}</dd>
                </div>
              ))}
            </dl>
          </Disclosure>
        </div>
      </div>
    </section>
  )
}
