"""Reference outputs of the Python engine, shared with the TypeScript fallback engine.

``shared/fixtures/engine-parity.json`` holds fixed inputs and what the Python engine
returns for them. test_parity.py checks Python still matches it; the frontend's
engine.test.ts checks the TypeScript port does too. After an intended change to the
engine, regenerate it with:

    python -m tests.parity
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

from app.engine import agronomy as ag
from app.engine.heuristic import greedy
from app.engine.optimiser import Job, Problem
from app.engine.scenario import REPO_ROOT, available_slots, load_scenario

FIXTURE = REPO_ROOT / "shared" / "fixtures" / "engine-parity.json"

ET0_CASES = [
    dict(tmax=21.5, tmin=12.3, rs=22.07, u2=2.078, lat=50.8, elevation=100, doy=187, rh_max=84, rh_min=63),
    dict(tmax=34.8, tmin=21.2, rs=24.5, u2=1.6, lat=17.97, elevation=266, doy=74, rh_max=78, rh_min=31),
    dict(tmax=41.0, tmin=27.5, rs=26.9, u2=2.9, lat=14.68, elevation=350, doy=135, rh_mean=28),
    dict(tmax=30.2, tmin=23.9, rs=11.3, u2=3.4, lat=19.84, elevation=505, doy=200),
]
WEATHER_CASES = [  # (et0, rain forecast mm, rain probability %)
    (5.2, 0.0, 0.0),
    (4.1, 22.0, 80.0),
    (6.8, 3.0, 40.0),
]


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(w.title() for w in rest)


def _problems() -> list[Problem]:
    out = []
    for seed, scarce, fixed_until in [(11, False, 0), (12, True, 0), (13, False, 18)]:
        rng = random.Random(seed)
        jobs = []
        for i in range(1, 15):
            a = rng.choice([0, 0, 8, 12])
            b = rng.choice([48, 48, 32, 28])
            allowed = list(range(a, b))
            ran_before = [s for s in allowed if s < fixed_until]
            # Some farms already ran a short block before the re-plan point.
            executed = ran_before[:2] if ran_before and rng.random() < 0.4 else []
            jobs.append(Job(
                farm_id=i, power_kw=rng.choice([2.9, 4.8, 4.8, 7.2]), flow_m3h=round(rng.uniform(9, 17), 3),
                required_slots=rng.randint(0, 24), allowed=allowed, weight=rng.randint(5, 50),
                min_run=2, max_starts=2, executed=executed,
            ))
        peak = 35 if scarce else 75
        solar = [round(max(0.0, peak * math.sin(math.pi * (t + 0.5) / 48)), 4) for t in range(48)]
        out.append(Problem(jobs=jobs, solar_kw=solar, feeder_limit_kw=60, grid_cap_kw=0 if scarce else 15, slots=48,
                           fixed_until=fixed_until))
    return out


def build() -> dict:
    sc = load_scenario()
    et0 = []
    for case in ET0_CASES:
        r = ag.et0_penman_monteith(**case)
        et0.append({"input": {_camel(k): v for k, v in case.items()},
                    "output": {"et0": r.et0, "ea": r.ea, "es": r.es, "rn": r.rn, "rnl": r.rnl}})
    assess = []
    for et0_v, rain_mm, rain_prob in WEATHER_CASES:
        for farm in sc.farms:
            crop, soil = sc.crops[farm.crop], sc.soils[farm.soil]
            taw = ag.total_available_water(soil, ag.root_depth(crop, farm.das))
            dr_start = farm.dr0_frac * taw
            slots = len(available_slots(farm, sc.feeder))
            r = ag.assess_farm(sc=sc, farm=farm, das=farm.das, dr_start=dr_start, et0=et0_v,
                               rain_forecast_mm=rain_mm, rain_prob=rain_prob, available_slot_count=slots)
            assess.append({
                "input": {"farmId": farm.id, "das": farm.das, "drStart": dr_start, "et0": et0_v,
                          "rainForecastMm": rain_mm, "rainProb": rain_prob, "availableSlotCount": slots},
                "output": {"kc": r.kc, "taw": r.taw, "raw": r.raw, "needNetMm": r.need_net_mm,
                           "needAfterRainMm": r.need_after_rain_mm, "deferred": r.deferred_for_rain,
                           "requiredSlots": r.required_slots, "status": r.status},
            })
    schedules = []
    for p in _problems():
        schedules.append({
            "problem": {
                "jobs": [{"farmId": j.farm_id, "powerKw": j.power_kw, "flowM3h": j.flow_m3h, "requiredSlots": j.required_slots,
                          "allowed": j.allowed, "weight": j.weight, "minRun": j.min_run, "maxStarts": j.max_starts,
                          "executed": j.executed} for j in p.jobs],
                "solarKw": p.solar_kw, "feederLimitKw": p.feeder_limit_kw, "gridCapKw": p.grid_cap_kw,
                "slots": p.slots, "fixedUntil": p.fixed_until,
            },
            "on": {str(k): v for k, v in greedy(p).items()},
        })
    return {"et0": et0, "assess": assess, "greedy": schedules}


if __name__ == "__main__":
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(build(), indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {FIXTURE.relative_to(REPO_ROOT)}")
