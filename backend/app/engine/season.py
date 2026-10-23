"""Multi-day simulation: SunShift vs business-as-usual over replayed real weather.

Weather is replayed from the ERA5 archive. SunShift does not get perfect foresight:
each morning it plans on a *forecast* derived from the actual day with a modelled
error (rain detection 85%, false alarms 8%, solar error σ≈10%), then the day is
executed against the actual weather. Both strategies run through the same FAO-56
soil-water balance, pumps and feeder physics.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field, replace
from datetime import date as Date
from datetime import timedelta
from typing import Iterator

from . import baseline, explain, metrics
from .agronomy import (
    assess_farm,
    crop_stage,
    depletion_fraction,
    kc_at,
    root_depth,
    total_available_water,
    water_balance_day,
)
from .optimiser import Job, Problem, solve
from .planner import ist_now
from .. import registry
from .scenario import available_slots, load_scenario, with_overrides
from .solar import pv_profile
from .weather import climatological_et0, replay_days

FORECAST_MODEL = {
    "rainDetection": 0.85,
    "falseAlarm": 0.08,
    "solarSigma": 0.10,
    "et0Sigma": 0.06,
}


@dataclass
class SeasonParams:
    season: str = "rabi-2025"
    start: str | None = None
    days: int = 30
    location: str | None = None
    pv_kwp: float | None = None
    feeder_limit_kw: float | None = None
    grid_backup_kw: float | None = None
    demand_scale: float = 1.0
    crop_overrides: dict[int, str] = field(default_factory=dict)
    seed: int = 2026
    time_limit_s: float = 0.8
    bau_factor: float | None = None  # business-as-usual over-application (None = scenario default)


@dataclass
class _FarmState:
    dr: float
    das: int
    refilling: bool = False
    served_yesterday: float = 1.0
    days_since: int = 0
    eta_sum: float = 0.0
    etc_sum: float = 0.0
    stress_days: int = 0
    deep_perc_mm: float = 0.0
    need_m3: float = 0.0
    useful_m3: float = 0.0


def _forecast(rng: random.Random, actual_mm: float) -> tuple[float, float]:
    """Synthetic forecast (amount, probability) around the actual next-30h rainfall."""
    if actual_mm >= 5:
        if rng.random() < FORECAST_MODEL["rainDetection"]:
            return actual_mm * rng.uniform(0.7, 1.3), rng.uniform(60, 95)
        return 0.0, rng.uniform(10, 35)
    if actual_mm >= 1:
        return actual_mm * rng.uniform(0.5, 1.5), rng.uniform(30, 70)
    if rng.random() < FORECAST_MODEL["falseAlarm"]:
        return rng.uniform(4, 14), rng.uniform(50, 70)
    return 0.0, rng.uniform(0, 25)


def _clamp_days(start: str, days: int) -> int:
    latest = ist_now().date() - timedelta(days=2)
    d0 = Date.fromisoformat(start)
    return max(1, min(days, (latest - d0).days + 1))


def simulate(params: SeasonParams) -> Iterator[dict]:
    t_start = time.perf_counter()
    file_sc = load_scenario()
    season_def = next((s for s in file_sc.seasons if s["id"] == params.season), file_sc.seasons[0])
    base_sc = registry.scenario(day=params.start or season_def["start"])
    sc = with_overrides(
        base_sc, pv_kwp=params.pv_kwp, feeder_limit_kw=params.feeder_limit_kw,
        grid_backup_kw=params.grid_backup_kw, crop_overrides=params.crop_overrides,
    )
    loc_id = params.location if params.location in sc.locations else sc.default_location
    loc = sc.locations[loc_id]
    season = next((s for s in sc.seasons if s["id"] == params.season), sc.seasons[0])
    start = params.start or season["start"]
    n_days = _clamp_days(start, max(1, min(120, params.days)))
    feeder = sc.feeder
    h = feeder.slot_hours
    farms = {f.id: f for f in sc.farms}
    allowed = {f.id: available_slots(f, feeder) for f in sc.farms}
    bau_factor = params.bau_factor if params.bau_factor is not None else sc.policy.bau["factor"]

    yield {
        "type": "meta",
        "season": season,
        "start": start,
        "days": n_days,
        "location": {"id": loc.id, "name": loc.name, "state": loc.state, "lat": loc.lat, "lon": loc.lon},
        "weatherSource": "Open-Meteo historical archive (ERA5/ERA5T reanalysis)",
        "forecastModel": FORECAST_MODEL,
        "bau": {**sc.policy.bau, "factor": bau_factor},
        "feeder": {"limitKw": feeder.feeder_limit_kw, "pvKwp": feeder.pv_kwp, "gridBackupKw": feeder.grid_backup_kw},
    }

    try:
        days = replay_days(loc, start, n_days, feeder, sc.policy)
    except Exception as exc:
        yield {"type": "error", "message": f"Weather archive unavailable: {exc}"}
        return

    def init_state() -> dict[int, _FarmState]:
        out = {}
        for f in sc.farms:
            crop, soil = sc.crops[f.crop], sc.soils[f.soil]
            taw = total_available_water(soil, root_depth(crop, f.das))
            out[f.id] = _FarmState(dr=f.dr0_frac * taw, das=f.das, served_yesterday=f.served_yesterday,
                                   days_since=f.last_irrigated_days)
        return out

    ss, bau = init_state(), init_state()
    rng = random.Random(params.seed)
    totals = {k: {"water": 0.0, "energy": 0.0, "grid": 0.0, "solarUsed": 0.0, "solarAvail": 0.0, "overload": 0,
                  "deepPerc": 0.0, "peak": 0.0, "stressFarmDays": 0} for k in ("sunshift", "bau")}
    prev_rain = 0.0

    for k, dw in enumerate(days):
        pv = pv_profile(dw, loc, feeder)
        solar_actual = [float(v) for v in pv.ac_kw]
        solar_factor = max(0.7, min(1.25, rng.gauss(1.0, FORECAST_MODEL["solarSigma"])))
        solar_fc = [v * solar_factor for v in solar_actual]
        et0_fc = dw.et0 * max(0.8, min(1.2, rng.gauss(1.0, FORECAST_MODEL["et0Sigma"])))
        rain_fc, prob_fc = _forecast(rng, dw.lookahead_rain_mm)

        # ---------------- SunShift: plan on the forecast
        jobs, ags, need_today = [], {}, {}
        for f in sc.farms:
            st = ss[f.id]
            ag = assess_farm(
                sc=sc, farm=f, das=st.das, dr_start=st.dr, et0=et0_fc, rain_forecast_mm=rain_fc, rain_prob=prob_fc,
                available_slot_count=len(allowed[f.id]), demand_scale=params.demand_scale, refilling=st.refilling,
            )
            pr = explain.priority(ag, replace(f, served_yesterday=st.served_yesterday), prob_fc)
            ags[f.id] = ag
            need_today[f.id] = ag.volume_m3
            jobs.append(Job(farm_id=f.id, power_kw=f.pump_kw, flow_m3h=f.flow_m3h, required_slots=ag.required_slots,
                            allowed=allowed[f.id], weight=pr["weight"], min_run=feeder.min_run_slots,
                            max_starts=feeder.max_starts, min_off=feeder.min_off_slots, carry=st.served_yesterday))
        sol = solve(Problem(jobs=jobs, solar_kw=solar_fc, feeder_limit_kw=feeder.feeder_limit_kw,
                            grid_cap_kw=feeder.grid_backup_kw, slots=feeder.slots,
                            fairness_weight=sc.policy.fairness_weight, time_limit_s=params.time_limit_s,
                            gap_limit=1e-3, workers=8))
        m_ss = metrics.evaluate(on=sol.on, farms=farms, solar_kw=solar_actual, feeder=feeder, need_m3=need_today)

        # ---------------- Business as usual
        seasonal_et0 = climatological_et0(Date.fromisoformat(dw.date).month, loc)
        bau_on, bau_need = {}, {}
        for f in sc.farms:
            st = bau[f.id]
            crop, soil = sc.crops[f.crop], sc.soils[f.soil]
            taw = total_available_water(soil, root_depth(crop, st.das))
            stage = crop_stage(crop, st.das)
            ag_true = assess_farm(sc=sc, farm=f, das=st.das, dr_start=st.dr, et0=dw.et0, rain_forecast_mm=0.0,
                                  rain_prob=0.0, available_slot_count=len(allowed[f.id]),
                                  demand_scale=params.demand_scale)
            bau_need[f.id] = ag_true.volume_m3
            if stage in (-1, 4):
                continue
            slots = baseline.bau_plan(sc, f, st.das, seasonal_et0, bau_factor)
            method = sc.methods[f.method]
            hpd = bau_factor * kc_at(crop, st.das) * seasonal_et0 * f.area_ha * 10 / method.efficiency / f.flow_m3h
            rotation = baseline.effective_rotation(sc, f, hpd, len(allowed[f.id]) * h)
            go, _ = baseline.bau_decision(sc, f, days_since_irrigation=st.days_since,
                                          observed_rain_yesterday=prev_rain, dr=st.dr, taw=taw, rotation=rotation)
            if go:
                bau_on[f.id] = slots
        m_bau = metrics.evaluate(on=bau_on, farms=farms, solar_kw=solar_actual, feeder=feeder, need_m3=bau_need)

        # ---------------- Physics: both strategies through the same soil-water balance
        day_stats = {}
        for key, states, m, needs in (("sunshift", ss, m_ss, need_today), ("bau", bau, m_bau, bau_need)):
            stress, ks_sum, dp_sum = 0, 0.0, 0.0
            for f in sc.farms:
                st = states[f.id]
                crop, soil, method = sc.crops[f.crop], sc.soils[f.soil], sc.methods[f.method]
                stage = crop_stage(crop, st.das)
                kc = kc_at(crop, st.das)
                etc = kc * dw.et0 * params.demand_scale
                taw = total_available_water(soil, root_depth(crop, st.das))
                raw = depletion_fraction(crop, etc) * taw
                water = m["waterByFarm"].get(str(f.id), 0.0)
                irr_net = water / (f.area_ha * 10) * method.efficiency if f.area_ha > 0 else 0.0
                wb = water_balance_day(dr=min(st.dr, taw), taw=taw, raw=raw, etc=etc, rain=dw.rain_mm, et0=dw.et0,
                                       irrigation_net=irr_net)
                st.dr = wb.dr_end
                if 0 <= stage <= 3:
                    st.eta_sum += wb.eta
                    st.etc_sum += wb.etc
                    if wb.ks < 0.999:
                        stress += 1
                        st.stress_days += 1
                    ks_sum += wb.ks
                # losses: deep percolation plus field application losses
                dp_sum += wb.deep_percolation * f.area_ha * 10
                st.deep_perc_mm += wb.deep_percolation
                st.das += 1
                need = needs.get(f.id, 0.0)
                st.need_m3 += need
                st.useful_m3 += min(water, need)
                if key == "sunshift":
                    ag = ags[f.id]
                    st.refilling = water > 0 and wb.dr_end > ag.target_mm + 1.0
                    st.served_yesterday = min(1.0, water / need) if need > 1e-6 else 1.0
                else:
                    st.days_since = 0 if water > 0 else st.days_since + 1
            active = sum(1 for f in sc.farms if 0 <= crop_stage(sc.crops[f.crop], states[f.id].das - 1) <= 3)
            day_stats[key] = {
                "waterM3": m["waterM3"], "energyKwh": m["energyKwh"], "gridKwh": m["gridKwh"],
                "solarUsedKwh": m["solarUsedKwh"], "solarAvailableKwh": m["solarAvailableKwh"],
                "peakKw": m["peakDeliveredKw"], "peakDemandKw": m["peakDemandKw"], "overloadSlots": m["overloadSlots"],
                "stressFarms": stress, "meanKs": round(ks_sum / active, 4) if active else 1.0,
                "deepPercolationM3": round(dp_sum, 1), "adequacy": m["adequacy"], "jain": m["fairnessJain"],
                "solarUtilisation": m["solarUtilisation"], "farmsIrrigated": sum(1 for v in m["waterByFarm"].values() if v > 0),
            }
            t = totals[key]
            t["water"] += m["waterM3"]
            t["energy"] += m["energyKwh"]
            t["grid"] += m["gridKwh"]
            t["solarUsed"] += m["solarUsedKwh"]
            t["solarAvail"] += m["solarAvailableKwh"]
            t["overload"] += m["overloadSlots"]
            t["deepPerc"] += dp_sum
            t["peak"] = max(t["peak"], m["peakDeliveredKw"])
            t["stressFarmDays"] += stress
        day_stats["sunshift"]["solver"] = {"status": sol.status, "wallTimeS": round(sol.wall_time, 3)}
        prev_rain = dw.rain_mm

        yield {
            "type": "day", "index": k, "date": dw.date, "et0": round(dw.et0, 2), "rainMm": round(dw.rain_mm, 1),
            "forecastRainMm": round(rain_fc, 1), "forecastRainProb": round(prob_fc), "solarKwh": round(sum(solar_actual) * h, 1),
            "solarForecastFactor": round(solar_factor, 3), "sunshift": day_stats["sunshift"], "bau": day_stats["bau"],
        }

    def summarise(states: dict[int, _FarmState], key: str) -> dict:
        t = totals[key]
        ry, served = [], []
        for f in sc.farms:
            st = states[f.id]
            if st.etc_sum > 0:
                ry.append(max(0.0, 1 - sc.crops[f.crop].ky * (1 - st.eta_sum / st.etc_sum)))
            if st.need_m3 > 1e-6:
                served.append(min(1.0, st.useful_m3 / st.need_m3))
        return {
            "waterM3": round(t["water"], 1), "energyKwh": round(t["energy"], 1), "gridKwh": round(t["grid"], 1),
            "solarUsedKwh": round(t["solarUsed"], 1), "solarAvailableKwh": round(t["solarAvail"], 1),
            "solarShare": round(t["solarUsed"] / t["energy"], 4) if t["energy"] > 0 else 0.0,
            "solarUtilisation": round(t["solarUsed"] / t["solarAvail"], 4) if t["solarAvail"] > 0 else 0.0,
            "peakKw": round(t["peak"], 1), "overloadSlots": t["overload"], "deepPercolationM3": round(t["deepPerc"], 1),
            "stressFarmDays": t["stressFarmDays"],
            "relativeYield": round(sum(ry) / len(ry), 4) if ry else 1.0,
            "fairnessJain": round(metrics.jain_index(served), 4),
        }

    yield {
        "type": "summary",
        "sunshift": summarise(ss, "sunshift"),
        "bau": summarise(bau, "bau"),
        "elapsedS": round(time.perf_counter() - t_start, 2),
        "notes": [
            "Relative yield uses FAO-33 seasonal Ky with the simulated ETa/ETc; it is an indicator, not a yield forecast.",
            f"Business-as-usual: {bau_factor:.2f}× the month's climatological crop need on fixed rotations at habitual start times; no forecasts; skips only after observed heavy rain.",
            "SunShift plans each morning on a forecast with modelled error, then executes against the actual weather.",
        ],
    }

