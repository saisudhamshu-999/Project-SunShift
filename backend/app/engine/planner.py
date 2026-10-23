"""Day planner: weather -> PV -> agronomy -> priorities -> CP-SAT -> baselines -> metrics."""

from __future__ import annotations

import copy
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from datetime import date as Date
from datetime import datetime, timedelta, timezone

import numpy as np

from .. import db, registry
from ..ml import models as ml_models
from . import baseline, explain, metrics
from .agronomy import FarmAgronomy, assess_farm, root_depth, total_available_water
from .optimiser import Job, Problem, Solution, solve
from .scenario import (
    Scenario,
    available_slots,
    contiguous_blocks,
    slot_label,
    window_label,
    with_overrides,
)
from .solar import SolarProfile, pv_profile
from .weather import DayWeather, apply_mode, climatology_day, forecast_day, replay_days

IST = timezone(timedelta(hours=5, minutes=30))
WEATHER_MODES = ("live", "clear", "cloudy", "rain", "heatwave")
FAILURES = ("weather_api", "solar_forecast", "internet", "pump_feedback", "capacity")


@dataclass
class PlanParams:
    date: str | None = None
    feeder: str | None = None
    location: str | None = None
    pv_kwp: float | None = None
    feeder_limit_kw: float | None = None
    grid_backup_kw: float | None = None
    weather_mode: str = "live"
    rain_mm: float = 18.0
    rain_prob: float = 85.0
    rain_start_hour: float = 13.0
    solar_event: dict | None = None
    demand_scale: float = 1.0
    crop_overrides: dict[int, str] = field(default_factory=dict)
    served_yesterday: dict[int, float] = field(default_factory=dict)
    fairness_weight: float | None = None
    mode: str = "sunshift"
    fixed_until: int = 0
    executed: dict[int, list[int]] = field(default_factory=dict)
    failure: str | None = None
    time_limit_s: float = 3.0
    persist: bool = True

    def echo(self) -> dict:
        d = copy.deepcopy(self.__dict__)
        d["crop_overrides"] = {str(k): v for k, v in self.crop_overrides.items()}
        d["served_yesterday"] = {str(k): v for k, v in self.served_yesterday.items()}
        d["executed"] = {str(k): v for k, v in self.executed.items()}
        return d


@dataclass
class DayContext:
    sc: Scenario
    params: PlanParams
    loc_id: str
    day: str
    dw: DayWeather
    base_dw: DayWeather
    pv: SolarProfile
    ags: dict[int, FarmAgronomy]
    prios: dict[int, dict]
    allowed: dict[int, list[int]]
    jobs: list[Job]
    notes: list[str]
    ml: dict = field(default_factory=dict)
    solar_low_kw: np.ndarray | None = None  # cautious (P10) AC curve, when the ML band applies


def ist_now() -> datetime:
    return datetime.now(IST)


def default_plan_date() -> str:
    now = ist_now()
    # After the solar window has mostly passed, the useful plan is tomorrow's.
    d = now.date() if now.hour < 16 else now.date() + timedelta(days=1)
    return d.isoformat()


def _now_slot(day: str, sc: Scenario) -> int | None:
    now = ist_now()
    if now.date().isoformat() != day:
        return None
    minutes = now.hour * 60 + now.minute - sc.feeder.day_start_hour * 60
    slot = minutes // sc.feeder.slot_minutes
    return int(slot) if 0 <= slot < sc.feeder.slots else None


def _weather_for(day: str, sc: Scenario, loc_id: str, params: PlanParams) -> tuple[DayWeather, list[str]]:
    loc = sc.locations[loc_id]
    notes: list[str] = []
    today = ist_now().date()
    d = Date.fromisoformat(day)
    if d < today - timedelta(days=1):
        try:
            dw = replay_days(loc, day, 1, sc.feeder, sc.policy)[0]
        except Exception:
            dw = climatology_day(day, loc, sc.feeder)
        notes.append("Past date: weather replayed from the ERA5 archive")
    elif d > today + timedelta(days=3):
        dw = climatology_day(day, loc, sc.feeder)
        notes.append("Beyond the forecast horizon: climatology used")
    else:
        dw = forecast_day(day, loc, sc.feeder, sc.policy, simulate_outage=params.failure == "weather_api")
    return dw, notes


def build_context(params: PlanParams, weather: DayWeather | None = None) -> DayContext:
    """Everything a solve needs. ``weather`` replaces the weather lookup (backtests, tests)."""
    day = params.date or default_plan_date()
    base_sc = registry.scenario(params.feeder, day)
    sc = with_overrides(
        base_sc,
        pv_kwp=params.pv_kwp,
        feeder_limit_kw=params.feeder_limit_kw,
        grid_backup_kw=params.grid_backup_kw,
        crop_overrides=params.crop_overrides,
        served_yesterday=params.served_yesterday,
    )
    loc_id = params.location if params.location in sc.locations else sc.default_location
    loc = sc.locations[loc_id]

    if weather is not None:
        base_dw, notes = weather, []
    else:
        base_dw, notes = _weather_for(day, sc, loc_id, params)
    # ML corrections apply to real forecasts only (see app/ml).
    base_dw, low_ratio, ml_info = ml_models.apply_to_forecast(base_dw, loc, sc.feeder)
    mode = params.weather_mode if params.weather_mode in WEATHER_MODES else "live"
    solar_event = params.solar_event
    if params.failure == "solar_forecast" and not solar_event:
        solar_event = {"from_slot": 22, "factor": 0.55}
        notes.append("Failure drill: actual solar 45% below forecast from 11:30; plan re-optimised")
    dw = apply_mode(
        base_dw, mode=mode, loc=loc, feeder=sc.feeder, rain_mm=params.rain_mm, rain_prob=params.rain_prob,
        rain_start_hour=params.rain_start_hour, solar_event=solar_event,
    )
    pv = pv_profile(dw, loc, sc.feeder)
    solar_low = None
    if low_ratio is not None:
        if mode == "live":
            solar_low = pv.ac_kw * low_ratio
        else:
            ml_info["solar"]["riskNote"] = f"cautious curve not used: '{mode}' is a scenario, not the forecast"

    ags: dict[int, FarmAgronomy] = {}
    prios: dict[int, dict] = {}
    allowed: dict[int, list[int]] = {}
    jobs: list[Job] = []
    for farm in sc.farms:
        crop, soil = sc.crops[farm.crop], sc.soils[farm.soil]
        taw0 = total_available_water(soil, root_depth(crop, farm.das))
        allowed[farm.id] = available_slots(farm, sc.feeder)
        ag = assess_farm(
            sc=sc, farm=farm, das=farm.das, dr_start=farm.dr0_frac * taw0, et0=dw.et0,
            rain_forecast_mm=dw.lookahead_rain_mm, rain_prob=dw.lookahead_rain_prob,
            available_slot_count=len(allowed[farm.id]), demand_scale=params.demand_scale,
        )
        ags[farm.id] = ag
        pr = explain.priority(ag, farm, dw.lookahead_rain_prob)
        prios[farm.id] = pr
        jobs.append(Job(
            farm_id=farm.id, power_kw=farm.pump_kw, flow_m3h=farm.flow_m3h, required_slots=ag.required_slots,
            allowed=allowed[farm.id], weight=pr["weight"], min_run=sc.feeder.min_run_slots,
            max_starts=sc.feeder.max_starts, min_off=sc.feeder.min_off_slots, executed=sorted(params.executed.get(farm.id, [])),
            carry=farm.served_yesterday,
        ))
    if params.failure == "capacity":
        notes.append("Failure drill: demand exceeds what the feeder can serve; fair allocation applies")
    return DayContext(sc, params, loc_id, day, dw, base_dw, pv, ags, prios, allowed, jobs, notes, ml_info, solar_low)


def _problem(ctx: DayContext, *, mode: str | None = None, time_limit: float | None = None,
             solar_scale: float = 1.0, feeder_scale: float = 1.0, grid_extra: float = 0.0,
             relax_availability: bool = False) -> Problem:
    sc, params = ctx.sc, ctx.params
    jobs = ctx.jobs
    if relax_availability:
        every = list(range(sc.feeder.slots))
        jobs = [replace(j, allowed=every) for j in jobs]
    fairness = params.fairness_weight if params.fairness_weight is not None else sc.policy.fairness_weight
    return Problem(
        jobs=jobs,
        solar_kw=[float(v) * solar_scale for v in ctx.pv.ac_kw],
        solar_low_kw=None if ctx.solar_low_kw is None else [float(v) * solar_scale for v in ctx.solar_low_kw],
        feeder_limit_kw=sc.feeder.feeder_limit_kw * feeder_scale,
        grid_cap_kw=sc.feeder.grid_backup_kw + grid_extra,
        slots=sc.feeder.slots,
        fairness_weight=fairness,
        mode=mode or params.mode,
        fixed_until=params.fixed_until,
        time_limit_s=time_limit or params.time_limit_s,
    )


def _need_m3(ctx: DayContext) -> dict[int, float]:
    return {fid: ag.volume_m3 for fid, ag in ctx.ags.items()}


def scheduled_water(sol: Solution, ctx: DayContext, from_slot: int = 0) -> float:
    h = ctx.sc.feeder.slot_hours
    return sum(
        ctx.sc.farm(fid).flow_m3h * h * sum(1 for t in slots if t >= from_slot) for fid, slots in sol.on.items()
    )


def binding_analysis(ctx: DayContext, sol: Solution, m_sun: dict) -> dict:
    sc = ctx.sc
    F, G = sc.feeder.feeder_limit_kw, sc.feeder.grid_backup_kw
    S = [float(v) for v in ctx.pv.ac_kw]
    load = sol.load_kw
    t0 = ctx.params.fixed_until
    unmet = [j for j in ctx.jobs if len(sol.on[j.farm_id]) < j.required_slots]
    flags: list[str | None] = [None] * sc.feeder.slots
    counts = {"SOLAR": 0, "FEEDER": 0}
    for t in range(t0, sc.feeder.slots):
        cand = [j for j in unmet if t in j.allowed and t not in sol.on[j.farm_id]]
        if not cand:
            continue
        pmin = min(j.power_kw for j in cand)
        head_feeder = F - load[t]
        head_supply = S[t] + G - load[t]
        if head_supply < pmin and head_supply <= head_feeder:
            flags[t] = "SOLAR"
            counts["SOLAR"] += 1
        elif head_feeder < pmin:
            flags[t] = "FEEDER"
            counts["FEEDER"] += 1

    demand_m3 = sum(ag.volume_m3 for ag in ctx.ags.values())
    if not unmet:
        constraint = "NONE"
        detail = "Every requested irrigation fits inside today's solar and feeder limits. Water demand is the active limit."
    elif counts["SOLAR"] == 0 and counts["FEEDER"] == 0:
        constraint = "AVAILABILITY"
        detail = "Unmet demand is limited by farmer availability windows and pump run-time, not by energy."
    elif counts["SOLAR"] >= counts["FEEDER"]:
        constraint = "SOLAR"
        detail = f"Solar output (plus {G:.0f} kW permitted grid backup) runs out in {counts['SOLAR']} slots where farms still need water."
    else:
        constraint = "FEEDER"
        detail = f"The {F:.0f} kW feeder limit is full in {counts['FEEDER']} slots where farms still need water."
    return {
        "constraint": constraint,
        "detail": detail,
        "slotFlags": flags,
        "counts": counts,
        "unmetFarms": [j.farm_id for j in unmet],
        "utilisation": {
            "solar": m_sun["solarUtilisation"],
            "feederPeak": round(max(load) / F, 4) if F > 0 else 0.0,
            "demandScheduled": round(m_sun["usefulWaterM3"] / demand_m3, 4) if demand_m3 > 0 else 1.0,
        },
    }


def _farm_payload(ctx: DayContext, sol: Solution, unc_plans: dict[int, list[int]], m_sun: dict, m_unc: dict) -> list[dict]:
    sc = ctx.sc
    out = []
    for farm in sc.farms:
        ag, pr = ctx.ags[farm.id], ctx.prios[farm.id]
        slots = sol.on.get(farm.id, [])
        served = m_sun["servedByFarm"].get(str(farm.id), 1.0 if ag.volume_m3 <= 0 else 0.0)
        unc_slots = unc_plans.get(farm.id, [])
        crop, soil, method = sc.crops[farm.crop], sc.soils[farm.soil], sc.methods[farm.method]
        out.append({
            "id": farm.id, "code": farm.code, "crop": farm.crop, "cropLabel": crop.label,
            "areaHa": farm.area_ha, "soil": farm.soil, "soilLabel": soil.label, "pumpHp": farm.pump_hp,
            "pumpKw": round(farm.pump_kw, 2), "flowM3h": round(farm.flow_m3h, 2), "headM": farm.head_m,
            "method": farm.method, "methodLabel": method.label, "efficiency": method.efficiency,
            "das": ag.das, "stage": ag.stage, "stageLabel": ag.stage_label, "seasonDays": crop.season_days,
            "kc": round(ag.kc, 3), "etc": round(ag.etc, 2), "zr": round(ag.zr, 3), "taw": round(ag.taw, 1),
            "raw": round(ag.raw, 1), "p": round(ag.p, 3), "drStart": round(ag.dr_start, 1),
            "drProjected": round(ag.dr_projected, 1), "depletionPct": round(ag.depletion_pct, 1),
            "soilWaterPct": round(ag.soil_water_pct, 1), "ksStart": round(ag.ks_start, 3), "status": ag.status,
            "triggerMm": round(ag.trigger_mm, 1), "targetMm": round(ag.target_mm, 1),
            "needNetMm": round(ag.need_net_mm, 1), "rainExpectedMm": round(ag.rain_expected_mm, 1),
            "needAfterRainMm": round(ag.need_after_rain_mm, 1), "deferred": ag.deferred_for_rain,
            "grossMm": round(ag.gross_mm, 1), "volumeM3": round(ag.volume_m3, 1),
            "pumpHours": round(ag.pump_hours, 2), "requiredSlots": ag.required_slots,
            "capacityLimited": ag.capacity_limited, "priority": pr,
            "available": [list(w) for w in farm.available], "habitStart": farm.habit_start,
            "servedYesterday": farm.served_yesterday, "pos": list(farm.pos),
            "schedule": {
                "slots": slots, "blocks": contiguous_blocks(slots), "window": window_label(slots, sc.feeder),
                "scheduledM3": round(farm.flow_m3h * sc.feeder.slot_hours * len(slots), 1),
                "servedFraction": round(served, 4),
            },
            "uncoordinated": {
                "slots": unc_slots, "window": window_label(unc_slots, sc.feeder),
                "deliveredM3": m_unc["waterByFarm"].get(str(farm.id), 0.0),
                "servedFraction": m_unc["servedByFarm"].get(str(farm.id), 1.0 if ag.volume_m3 <= 0 else 0.0),
            },
            "decision": explain.decision_text(sc=sc, farm=farm, ag=ag, slots=slots, served=served),
            "reasons": explain.reasons(
                sc=sc, farm=farm, ag=ag, pr=pr, slots=slots, solar_kw=[float(v) for v in ctx.pv.ac_kw],
                load_kw=sol.load_kw, rain_prob=ctx.dw.lookahead_rain_prob,
            ),
        })
    return out


def _solar_payload(ctx: DayContext, sol: Solution) -> dict:
    out = ctx.pv.to_dict(ctx.sc.feeder.slot_hours)
    if ctx.solar_low_kw is not None:
        h = ctx.sc.feeder.slot_hours
        low = np.asarray(ctx.solar_low_kw, dtype=float)
        out["cautiousAcKw"] = [round(float(v), 2) for v in low]
        out["cautiousEnergyKwh"] = round(float(low.sum() * h), 1)
        # Pumping the plan puts above the cautious curve: what would need grid power on a dim day.
        out["loadAboveCautiousKwh"] = round(float(np.clip(np.asarray(sol.load_kw) - low, 0, None).sum() * h), 1)
    return out


def assemble(ctx: DayContext, sol: Solution) -> dict:
    sc = ctx.sc
    farms_by_id = {f.id: f for f in sc.farms}
    solar = [float(v) for v in ctx.pv.ac_kw]
    need = _need_m3(ctx)
    required = {j.farm_id: j.required_slots for j in ctx.jobs}
    unc = baseline.uncoordinated(list(sc.farms), required, sc.feeder)
    unc_on = {p.farm_id: p.slots for p in unc}
    m_sun = metrics.evaluate(on=sol.on, farms=farms_by_id, solar_kw=solar, feeder=sc.feeder, need_m3=need)
    m_unc = metrics.evaluate(on=unc_on, farms=farms_by_id, solar_kw=solar, feeder=sc.feeder, need_m3=need)
    bind = binding_analysis(ctx, sol, m_sun)
    loc = sc.locations[ctx.loc_id]
    d = Date.fromisoformat(ctx.day)
    deferred = [fid for fid, ag in ctx.ags.items() if ag.deferred_for_rain]
    params = ctx.params

    result = {
        "meta": {
            "runId": None,
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "engine": "cp-sat",
            "date": ctx.day,
            "dateLabel": d.strftime("%a %d %b %Y"),
            "nowSlot": _now_slot(ctx.day, sc),
            "location": {"id": loc.id, "name": loc.name, "state": loc.state, "lat": loc.lat, "lon": loc.lon,
                         "elevationM": loc.elevation_m},
            "slotMinutes": sc.feeder.slot_minutes,
            "dayStartHour": sc.feeder.day_start_hour,
            "slots": sc.feeder.slots,
            "slotLabels": [slot_label(t, sc.feeder) for t in range(sc.feeder.slots)],
            "params": params.echo(),
            "sources": {
                "weather": ctx.dw.source,
                "weatherDetail": ctx.dw.source_detail,
                "solar": "pvlib + ML correction" if ctx.ml.get("solar", {}).get("applied") else "pvlib",
                "farms": "simulation" if ctx.sc.all_simulated else "registry",
                "registry": ctx.sc.registry,
                "pumps": "simulation",
            },
            "failure": params.failure,
            "ml": ctx.ml,
            "notes": ctx.notes + ctx.dw.modifications,
            "fixedUntil": params.fixed_until,
        },
        "feeder": {
            "id": sc.feeder.id, "name": sc.feeder.name, "limitKw": sc.feeder.feeder_limit_kw,
            "pvKwp": sc.feeder.pv_kwp, "inverterKw": sc.feeder.inverter_kw, "gridBackupKw": sc.feeder.grid_backup_kw,
            "tiltDeg": sc.feeder.tilt_deg, "azimuthDeg": sc.feeder.azimuth_deg,
            "connectedLoadKw": round(sum(f.pump_kw for f in sc.farms), 1),
            "minRunSlots": sc.feeder.min_run_slots, "maxStarts": sc.feeder.max_starts, "minOffSlots": sc.feeder.min_off_slots,
        },
        "weather": ctx.dw.to_dict(),
        "solar": _solar_payload(ctx, sol),
        "farms": _farm_payload(ctx, sol, unc_on, m_sun, m_unc),
        "sunshift": {"metrics": m_sun, "solver": sol.stats(), "loadKw": sol.load_kw, "gridKw": sol.grid_kw},
        "uncoordinated": {"metrics": m_unc},
        "binding": bind,
        "totals": {
            "demandM3": round(sum(need.values()), 1),
            "farmsNeeding": sum(1 for v in need.values() if v > 0),
            "farmsDeferred": len(deferred),
            "deferredFarms": deferred,
            "farmsScheduled": sum(1 for s in sol.on.values() if s),
            "et0": round(ctx.dw.et0, 2),
        },
    }

    if params.persist:
        summary = {
            "status": sol.status, "wallTimeS": round(sol.wall_time, 3),
            "binding": bind["constraint"], "weather": ctx.dw.source, "mode": params.weather_mode,
            "waterM3": m_sun["waterM3"], "energyKwh": m_sun["energyKwh"], "peakKw": m_sun["peakDeliveredKw"],
            "solarShare": m_sun["solarShare"], "adequacy": m_sun["adequacy"],
            "uncoordinatedPeakKw": m_unc["peakDemandKw"], "farmsScheduled": result["totals"]["farmsScheduled"],
        }
        result["meta"]["runId"] = db.save_run(
            kind="plan", plan_date=ctx.day, location=ctx.loc_id, engine="cp-sat",
            solve_seconds=sol.wall_time, params=params.echo(), summary=summary,
        )
    return result


def plan_day(params: PlanParams) -> dict:
    ctx = build_context(params)
    sol = solve(_problem(ctx))
    return assemble(ctx, sol)


# ------------------------------------------------------------------- studies


def _service(sol: Solution, ctx: DayContext) -> float:
    """Priority-weighted served fraction: the main term of the CP-SAT objective."""
    total = 0.0
    for j in ctx.jobs:
        if j.required_slots > 0:
            total += j.weight * min(1.0, len(sol.on.get(j.farm_id, [])) / j.required_slots)
    return total


def _solve_parallel(problems: list[Problem]) -> list[Solution]:
    """Independent CP-SAT solves run concurrently (the solver releases the GIL)."""
    per_solve = max(2, (os.cpu_count() or 8) // max(1, len(problems)))
    for p in problems:
        p.workers = min(8, per_solve)
    with ThreadPoolExecutor(max_workers=len(problems)) as pool:
        return list(pool.map(solve, problems))


def sensitivity(params: PlanParams) -> dict:
    """Relax one constraint at a time and measure how much more irrigation the optimiser
    can schedule. The constraint whose relaxation helps most is the one actually binding."""
    params = replace(params, persist=False)
    ctx = build_context(params)
    variants = {
        "solar": {"label": "+20% solar", "kw": {"solar_scale": 1.2}},
        "feeder": {"label": "+20% feeder limit", "kw": {"feeder_scale": 1.2}},
        "grid": {"label": "+20 kW grid backup", "kw": {"grid_extra": 20.0}},
        "availability": {"label": "Farmers available 06:00–18:00", "kw": {"relax_availability": True}},
    }
    sols = _solve_parallel([_problem(ctx, time_limit=2.0)] + [_problem(ctx, time_limit=2.0, **v["kw"]) for v in variants.values()])
    base, rest = sols[0], sols[1:]
    base_w, base_s = scheduled_water(base, ctx), _service(base, ctx)
    max_service = sum(j.weight for j in ctx.jobs if j.required_slots > 0) or 1.0
    rows = []
    for (key, v), sol in zip(variants.items(), rest):
        w, sv = scheduled_water(sol, ctx), _service(sol, ctx)
        rows.append({
            "key": key, "label": v["label"], "waterM3": round(w, 1), "deltaM3": round(w - base_w, 1),
            "serviceGainPct": round(100 * (sv - base_s) / max_service, 2), "status": sol.status,
        })
    rows.sort(key=lambda r: -r["serviceGainPct"])
    top = rows[0] if rows and rows[0]["serviceGainPct"] > 0.25 else None
    return {
        "baseWaterM3": round(base_w, 1),
        "baseServicePct": round(100 * base_s / max_service, 2),
        "demandM3": round(sum(_need_m3(ctx).values()), 1),
        "variants": rows,
        "binding": top["key"] if top else "none",
    }


def fairness_study(params: PlanParams) -> dict:
    """Scarcity: total-throughput maximisation vs SunShift's fair allocation, then the next
    day with yesterday's shortfalls carried into the two-day fairness term."""
    params = replace(params, persist=False, served_yesterday={})
    ctx = build_context(params)
    need = _need_m3(ctx)
    farms_by_id = {f.id: f for f in ctx.sc.farms}
    solar = [float(v) for v in ctx.pv.ac_kw]

    def evaluate(sol: Solution, needs: dict[int, float]) -> dict:
        return metrics.evaluate(on=sol.on, farms=farms_by_id, solar_kw=solar, feeder=ctx.sc.feeder, need_m3=needs)

    thr_sol, fair_sol = _solve_parallel([
        _problem(ctx, mode="throughput", time_limit=2.5), _problem(ctx, mode="sunshift", time_limit=2.5),
    ])
    thr, fair = evaluate(thr_sol, need), evaluate(fair_sol, need)

    carried = {int(k): v for k, v in fair["servedByFarm"].items()}
    ctx2 = build_context(replace(params, served_yesterday=carried))
    next_sol = solve(_problem(ctx2, mode="sunshift", time_limit=2.5))
    nxt = evaluate(next_sol, _need_m3(ctx2))

    rows = []
    for f in ctx.sc.farms:
        if need[f.id] <= 0:
            continue
        today, tomorrow = fair["servedByFarm"].get(str(f.id), 0.0), nxt["servedByFarm"].get(str(f.id), 0.0)
        rows.append({
            "id": f.id, "code": f.code, "crop": f.crop, "needM3": round(need[f.id], 1),
            "throughput": thr["servedByFarm"].get(str(f.id), 0.0),
            "fair": today,
            "nextDay": tomorrow,
            "twoDay": round((today + tomorrow) / 2, 4),
            "priorityToday": ctx.prios[f.id]["score"],
            "priorityNextDay": ctx2.prios[f.id]["score"],
        })
    two_day = [r["twoDay"] for r in rows]

    def summary(m: dict, s: Solution) -> dict:
        return {
            "waterM3": m["waterM3"], "usefulWaterM3": m["usefulWaterM3"], "jain": m["fairnessJain"],
            "minServed": m["minServed"], "adequacy": m["adequacy"],
            "farmsUnserved": sum(1 for v in m["servedByFarm"].values() if v < 0.05),
            "status": s.status, "wallTimeS": round(s.wall_time, 3), "gap": round(s.gap, 5),
        }

    return {
        "date": ctx.day,
        "weather": {"mode": params.weather_mode, "source": ctx.dw.source, "et0": round(ctx.dw.et0, 2),
                    "notes": ctx.dw.modifications},
        "supplyKwh": round(sum(solar) * ctx.sc.feeder.slot_hours, 1),
        "demandM3": round(sum(need.values()), 1),
        "throughput": summary(thr, thr_sol),
        "fair": summary(fair, fair_sol),
        "nextDay": summary(nxt, next_sol),
        "twoDay": {"jain": round(metrics.jain_index(two_day), 4), "minServed": round(min(two_day), 4) if two_day else 1.0},
        "farms": rows,
    }


def rain_event_study(params: PlanParams, forecast_slot: int = 20) -> dict:
    """Irrigation is running when a rain forecast arrives: re-plan from that moment."""
    base_params = replace(params, weather_mode=params.weather_mode if params.weather_mode != "rain" else "live",
                          persist=False, fixed_until=0, executed={})
    base_ctx = build_context(base_params)
    base_sol = solve(_problem(base_ctx))
    base = assemble(base_ctx, base_sol)

    executed = {fid: [t for t in slots if t < forecast_slot] for fid, slots in base_sol.on.items()}
    rain_params = replace(base_params, weather_mode="rain", fixed_until=forecast_slot, executed=executed)
    rain_ctx = build_context(rain_params)
    rain_sol = solve(_problem(rain_ctx))
    replan = assemble(rain_ctx, rain_sol)

    h = base_ctx.sc.feeder.slot_hours
    farms = {f.id: f for f in base_ctx.sc.farms}
    after = lambda sol: (  # noqa: E731
        sum(farms[fid].flow_m3h * h * sum(1 for t in s if t >= forecast_slot) for fid, s in sol.on.items()),
        sum(farms[fid].pump_kw * h * sum(1 for t in s if t >= forecast_slot) for fid, s in sol.on.items()),
    )
    bw, be = after(base_sol)
    rw, re = after(rain_sol)
    cancelled = [
        fid for fid, s in base_sol.on.items()
        if any(t >= forecast_slot for t in s) and not any(t >= forecast_slot for t in rain_sol.on.get(fid, []))
    ]
    return {
        "forecastSlot": forecast_slot,
        "forecastTime": slot_label(forecast_slot, base_ctx.sc.feeder),
        "rain": {"mm": params.rain_mm, "prob": params.rain_prob, "startHour": params.rain_start_hour},
        "savedM3": round(bw - rw, 2),
        "savedLitres": round((bw - rw) * 1000),
        "savedKwh": round(be - re, 2),
        "cancelledFarms": cancelled,
        "base": base,
        "replan": replan,
    }
