"""Baselines the optimiser is compared against.

uncoordinated
    The same farms need the same water as in the SunShift plan, but each farmer switches
    the pump on at their habitual time and runs until done. This isolates the value of
    coordination (timing) from the value of better agronomy.

business_as_usual
    Habitual practice for multi-day simulations. Farmers know their crop stage and the season
    but not this week's weather: they apply ``factor`` × the month's climatological crop need
    on a fixed rotation (drip daily,
    sprinkler every 2 days, furrow every 3), start at their habitual time, and skip a turn
    only after observing heavy rain (or irrigate early if the crop is visibly wilting).

Physical model shared by both: when demanded load exceeds the feeder limit the
excess cannot be delivered (protection trips / voltage collapse); delivered energy is
proportionally curtailed to the limit and overload slots are counted.
"""

from __future__ import annotations

from dataclasses import dataclass

from .agronomy import kc_at
from .scenario import Farm, Feeder, Scenario, available_slots, time_to_slot


@dataclass
class BaselineFarmPlan:
    farm_id: int
    slots: list[int]
    reason: str


def _run_from(start: int, n_slots: int, allowed: list[int]) -> list[int]:
    """Run starting at the first allowed slot >= start, continuing after gaps."""
    seq = [s for s in allowed if s >= start]
    return seq[:n_slots]


def uncoordinated(farms: list[Farm], required: dict[int, int], feeder: Feeder) -> list[BaselineFarmPlan]:
    plans = []
    for f in farms:
        req = required.get(f.id, 0)
        if req <= 0:
            continue
        allowed = available_slots(f, feeder)
        slots = _run_from(max(0, time_to_slot(f.habit_start, feeder)), req, allowed)
        plans.append(BaselineFarmPlan(f.id, slots, f"Switches on at {f.habit_start} out of habit"))
    return plans


def bau_rotation(sc: Scenario, farm: Farm) -> int:
    return int(sc.policy.bau["rotation_days"][farm.method])


def bau_decision(
    sc: Scenario, farm: Farm, *, days_since_irrigation: int, observed_rain_yesterday: float, dr: float, taw: float,
    rotation: int | None = None,
) -> tuple[bool, str]:
    rotation = bau_rotation(sc, farm) if rotation is None else rotation
    if taw > 0 and dr >= 0.9 * taw:
        return True, "Crop visibly wilting"
    if observed_rain_yesterday >= sc.policy.observed_rain_skip_mm and days_since_irrigation < rotation + 2:
        return False, f"Skipped: {observed_rain_yesterday:.0f} mm rain yesterday"
    if days_since_irrigation + 1 >= rotation:
        return True, f"Rotation: every {rotation} day(s)"
    return False, "Not due in rotation"


def bau_plan(sc: Scenario, farm: Farm, das: int, seasonal_et0: float, factor: float | None = None) -> list[int]:
    """Habitual set: factor x the season's typical crop need for the rotation interval,
    started at the farmer's habitual time."""
    feeder = sc.feeder
    factor = sc.policy.bau["factor"] if factor is None else factor
    crop, method = sc.crops[farm.crop], sc.methods[farm.method]
    allowed = available_slots(farm, feeder)
    start = max(0, time_to_slot(farm.habit_start, feeder))
    window_h = len([s for s in allowed if s >= start]) * feeder.slot_hours
    hours_per_day = factor * kc_at(crop, das) * seasonal_et0 * farm.area_ha * 10 / method.efficiency / farm.flow_m3h
    rotation = effective_rotation(sc, farm, hours_per_day, window_h)
    hours = min(window_h, hours_per_day * rotation)
    n = max(feeder.min_run_slots, int(round(hours * 60 / feeder.slot_minutes)))
    return _run_from(start, min(n, len(allowed)), allowed)


def effective_rotation(sc: Scenario, farm: Farm, hours_per_day: float, window_h: float) -> int:
    """A pump that cannot deliver a whole rotation's dose in one day is run daily instead."""
    rotation = bau_rotation(sc, farm)
    if hours_per_day <= 0:
        return rotation
    return max(1, min(rotation, int(window_h // hours_per_day)))
