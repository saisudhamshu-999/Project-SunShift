"""Metrics computed from schedules. Nothing here is hard-coded: every number shown in
the UI is derived from the slot-level schedule, the PV profile and the feeder limit."""

from __future__ import annotations

from .scenario import Farm, Feeder


def jain_index(values: list[float]) -> float:
    if not values:
        return 1.0
    s = sum(values)
    sq = sum(v * v for v in values)
    if sq == 0:
        return 0.0
    return s * s / (len(values) * sq)


def evaluate(
    *,
    on: dict[int, list[int]],
    farms: dict[int, Farm],
    solar_kw: list[float],
    feeder: Feeder,
    need_m3: dict[int, float],
) -> dict:
    T = feeder.slots
    h = feeder.slot_hours
    F = feeder.feeder_limit_kw

    demand = [0.0] * T
    starts = 0
    for fid, slots in on.items():
        p = farms[fid].pump_kw
        prev = None
        for t in sorted(slots):
            demand[t] += p
            if prev is None or t != prev + 1:
                starts += 1
            prev = t

    delivered_frac = [1.0 if d <= F + 1e-9 else F / d for d in demand]
    delivered = [d * fr for d, fr in zip(demand, delivered_frac)]
    solar_used = [min(d, s) for d, s in zip(delivered, solar_kw)]
    grid = [max(0.0, d - s) for d, s in zip(delivered, solar_kw)]
    unused_solar = [max(0.0, s - d) for d, s in zip(delivered, solar_kw)]
    overload = [d > F + 1e-9 for d in demand]

    water_by_farm: dict[int, float] = {}
    for fid, slots in on.items():
        q = farms[fid].flow_m3h
        water_by_farm[fid] = sum(q * h * delivered_frac[t] for t in slots)

    needing = [fid for fid, v in need_m3.items() if v > 1e-6]
    served = {fid: min(1.0, water_by_farm.get(fid, 0.0) / need_m3[fid]) for fid in needing}
    total_need = sum(need_m3[f] for f in needing)
    useful = sum(min(water_by_farm.get(f, 0.0), need_m3[f]) for f in needing)
    water = sum(water_by_farm.values())
    excess = sum(max(0.0, water_by_farm.get(f, 0.0) - need_m3.get(f, 0.0)) for f in water_by_farm)

    energy = sum(delivered) * h
    solar_used_kwh = sum(solar_used) * h
    solar_avail = sum(solar_kw) * h

    return {
        "waterM3": round(water, 2),
        "usefulWaterM3": round(useful, 2),
        "excessWaterM3": round(excess, 2),
        "needM3": round(total_need, 2),
        "energyKwh": round(energy, 2),
        "solarUsedKwh": round(solar_used_kwh, 2),
        "gridKwh": round(sum(grid) * h, 2),
        "solarAvailableKwh": round(solar_avail, 2),
        "unusedSolarKwh": round(sum(unused_solar) * h, 2),
        "peakDemandKw": round(max(demand) if demand else 0.0, 2),
        "peakDeliveredKw": round(max(delivered) if delivered else 0.0, 2),
        "overloadSlots": sum(overload),
        "curtailedKwh": round(sum(d - dl for d, dl in zip(demand, delivered)) * h, 2),
        "solarShare": round(solar_used_kwh / energy, 4) if energy > 0 else 0.0,
        "solarUtilisation": round(solar_used_kwh / solar_avail, 4) if solar_avail > 0 else 0.0,
        "adequacy": round(useful / total_need, 4) if total_need > 0 else 1.0,
        "fairnessJain": round(jain_index(list(served.values())), 4),
        "minServed": round(min(served.values()), 4) if served else 1.0,
        "servedByFarm": {str(k): round(v, 4) for k, v in served.items()},
        "waterByFarm": {str(k): round(v, 2) for k, v in water_by_farm.items()},
        "farmsNeeding": len(needing),
        "farmsFullyServed": sum(1 for v in served.values() if v >= 0.98),
        "pumpStarts": starts,
        "series": {
            "demandKw": [round(v, 2) for v in demand],
            "deliveredKw": [round(v, 2) for v in delivered],
            "gridKw": [round(v, 2) for v in grid],
            "solarUsedKw": [round(v, 2) for v in solar_used],
            "overload": overload,
        },
    }
