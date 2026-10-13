import { useEffect, useState } from 'react'
import * as api from '@/api/client'
import type { MlCard, PlanResult } from '@/api/types'
import { fmt } from '@/lib/format'

const pctDrop = (from: number, to: number) => `${fmt((100 * (from - to)) / from, 0)}%`

/** What the ML weather corrections changed in this plan, and how they did on held-out data. */
export function ForecastModels({ plan }: { plan: PlanResult }) {
  const [card, setCard] = useState<MlCard | null>(null)
  useEffect(() => {
    let alive = true
    void api.mlCard().then((c) => alive && setCard(c))
    return () => {
      alive = false
    }
  }, [])
  const ml = plan.meta.ml
  const { solar, rain } = ml ?? { solar: null, rain: null }

  return (
    <div>
      <p className="kicker text-ivory/50">Forecast models (ML)</p>
      {!ml ? (
        <p className="mt-2 text-[13px] text-ivory/55">Not available: this plan came from the browser fallback, which uses the raw forecast.</p>
      ) : (
        <dl className="mt-2 space-y-2.5 text-[13px] text-ivory/75">
          <div>
            <dt className="text-ivory">Solar</dt>
            <dd>
              {solar?.applied ? (
                <>
                  Forecast {fmt(solar.forecastKwhM2 ?? 0, 2)} → likely <span className="text-ivory">{fmt(solar.likelyKwhM2 ?? 0, 2)}</span> kWh/m² today
                  (cautious {fmt(solar.cautiousKwhM2 ?? 0, 2)}).
                  {plan.solar.loadAboveCautiousKwh != null && <> {fmt(plan.solar.loadAboveCautiousKwh, 1)} kWh of pumping sits above the cautious curve.</>}
                  {solar.riskNote && <span className="block text-ivory/50">{solar.riskNote}.</span>}
                </>
              ) : (
                <span className="text-ivory/55">Not applied: {solar?.reason}.</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-ivory">Rain</dt>
            <dd>
              {rain?.applied ? (
                <>
                  Chance of meaningful rain in the next 30 h: forecast {fmt(rain.forecastProb ?? 0)}% → calibrated{' '}
                  <span className="text-ivory">{fmt(rain.calibratedProb ?? 0)}%</span>. Deferral uses the calibrated value.
                </>
              ) : (
                <span className="text-ivory/55">Not applied: {rain?.reason}.</span>
              )}
            </dd>
          </div>
        </dl>
      )}
      {card && (
        <p className="mt-3 text-[12px] leading-relaxed text-ivory/50">
          Held-out year ({card.data.test[0].slice(0, 7)} to {card.data.test[1].slice(0, 7)}, {card.data.locations.length} locations): solar error{' '}
          {fmt(card.solar.hourlyRmseRaw)} → {fmt(card.solar.hourlyRmseLikely)} W/m² RMSE; rain Brier score {fmt(card.rain.forecastYesNo.brier, 3)} →{' '}
          {fmt(card.rain.calibrated.brier, 3)}
          {card.backtest && (
            <>
              ; grid use −{pctDrop(card.backtest.perDay.raw.gridKwh, card.backtest.perDay.ml.gridKwh)} over {card.backtest.days} replayed days
            </>
          )}
          . Checked against ERA5 reanalysis, not ground stations.
        </p>
      )}
    </div>
  )
}
