"""Priority scoring and plain-language explanations.

The optimiser's weights come from these transparent factors, so the same numbers that
drive the decision also explain it.
"""

from __future__ import annotations

from .agronomy import FarmAgronomy
from .scenario import Farm, Feeder, Scenario, window_label


def _level(value: float, cuts: tuple[float, float, float], labels=("LOW", "MODERATE", "HIGH", "SEVERE")) -> str:
    for cut, label in zip(cuts, labels):
        if value < cut:
            return label
    return labels[-1]


def priority(ag: FarmAgronomy, farm: Farm, rain_prob: float) -> dict:
    ratio = ag.dr_projected / ag.raw if ag.raw > 0 else 0.0
    soil = max(0.0, min(1.5, (ratio - 0.4) / 0.8))
    stage = ag.sensitivity
    fairness_debt = max(0.0, 1.0 - farm.served_yesterday)
    rain = rain_prob / 100
    score = 1 + 2.0 * soil + 1.2 * stage + 1.5 * fairness_debt - 1.0 * rain
    if score >= 3.6:
        label = "CRITICAL"
    elif score >= 2.7:
        label = "HIGH"
    elif score >= 1.9:
        label = "MEDIUM"
    else:
        label = "LOW"
    return {
        "score": round(score, 3),
        "label": label,
        "weight": max(5, int(round(10 * score))),
        "components": {
            "soilStress": round(soil, 3),
            "stageSensitivity": round(stage, 3),
            "fairnessDebt": round(fairness_debt, 3),
            "rainProbability": round(rain, 3),
        },
    }


def reasons(
    *,
    sc: Scenario,
    farm: Farm,
    ag: FarmAgronomy,
    pr: dict,
    slots: list[int],
    solar_kw: list[float],
    load_kw: list[float],
    rain_prob: float,
) -> list[dict]:
    feeder: Feeder = sc.feeder
    ratio = ag.dr_projected / ag.raw if ag.raw > 0 else 0.0
    out = [
        {
            "factor": "Soil stress",
            "level": _level(ratio, (0.6, 0.9, 1.1)),
            "detail": f"Projected depletion {ag.dr_projected:.0f} mm vs {ag.raw:.0f} mm readily available",
        },
        {
            "factor": "Crop stage",
            "level": _level(ag.sensitivity, (0.25, 0.5, 0.9), ("LOW", "MODERATE", "HIGH", "CRITICAL")),
            "detail": f"{sc.crops[farm.crop].label}: {ag.stage_label} (day {ag.das})",
        },
        {
            "factor": "Rain probability",
            "level": _level(rain_prob, (30, 60, 101), ("LOW", "MODERATE", "HIGH", "HIGH")),
            "detail": f"{rain_prob:.0f}% in the next {sc.policy.rain_lookahead_h:.0f} h"
            + (f", {ag.rain_expected_mm:.0f} mm counted" if ag.rain_expected_mm > 0 else ""),
        },
    ]
    if slots:
        mean_solar = sum(solar_kw[t] for t in slots) / len(slots)
        peak_solar = max(solar_kw) or 1.0
        headroom = min(feeder.feeder_limit_kw - load_kw[t] for t in slots)
        out.append({
            "factor": "Solar availability",
            "level": _level(mean_solar / peak_solar, (0.35, 0.7, 2.0), ("LOW", "MODERATE", "HIGH", "HIGH")),
            "detail": f"{mean_solar:.0f} kW average during {window_label(slots, feeder)}",
        })
        out.append({
            "factor": "Feeder capacity",
            "level": "TIGHT" if headroom < 3 else "AVAILABLE",
            "detail": f"{headroom:.1f} kW headroom left at the busiest slot of this window",
        })
    if farm.served_yesterday < 0.98:
        out.append({
            "factor": "Fairness",
            "level": "BOOST",
            "detail": f"Received {farm.served_yesterday * 100:.0f}% of its requirement yesterday",
        })
    out.append({"factor": "Priority", "level": pr["label"], "detail": f"Score {pr['score']:.2f} → weight {pr['weight']}"})
    return out


def decision_text(*, sc: Scenario, farm: Farm, ag: FarmAgronomy, slots: list[int], served: float) -> str:
    feeder = sc.feeder
    if ag.stage == 4:
        return "Crop harvested: no irrigation"
    if ag.deferred_for_rain:
        return f"Deferred: {ag.rain_expected_mm:.0f} mm of effective rain expected covers today's need"
    if ag.required_slots == 0:
        return f"Not needed today: root zone at {ag.soil_water_pct:.0f}% of available water"
    if not slots:
        return "Could not be scheduled within today's limits; carried to tomorrow with higher priority"
    window = window_label(slots, feeder)
    if served < 0.98:
        return f"Partially scheduled {window} ({served * 100:.0f}% of requirement); remainder carried forward"
    return f"Scheduled {window}"
