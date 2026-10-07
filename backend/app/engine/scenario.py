"""Scenario model: the 20-farm feeder, crop/soil tables and per-request overrides.

The JSON in ``shared/scenario.json`` is the single source of truth. The browser
fallback engine reads the same file, so both engines always describe the same feeder.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field, replace
from functools import lru_cache
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
SCENARIO_PATH = Path(os.environ.get("SUNSHIFT_SCENARIO", REPO_ROOT / "shared" / "scenario.json"))

RHO_G = 1000 * 9.81  # water density x gravity, N/m3
HP_KW = 0.746


@dataclass(frozen=True)
class Crop:
    key: str
    label: str
    kc: tuple[float, float, float]  # ini, mid, end
    stages: tuple[int, int, int, int]  # initial, development, mid-season, late (days)
    zr: tuple[float, float]  # min, max effective root depth (m)
    p: float  # FAO-56 Table 22 depletion fraction (at ETc = 5 mm/d)
    ky: float  # seasonal yield response factor (FAO-33)
    stage_labels: tuple[str, str, str, str]
    stage_ky: tuple[float, float, float, float]

    @property
    def season_days(self) -> int:
        return sum(self.stages)


@dataclass(frozen=True)
class Soil:
    key: str
    label: str
    fc: float  # volumetric water content at field capacity (m3/m3)
    wp: float  # volumetric water content at wilting point (m3/m3)


@dataclass(frozen=True)
class Method:
    key: str
    label: str
    efficiency: float
    trigger_frac_raw: float  # irrigate once projected depletion reaches this share of RAW
    target_frac_raw: float  # refill down to this depletion (share of RAW): keeps rain headroom
    max_daily_hours: float  # practical pump hours per day for this method (one irrigation set)


@dataclass(frozen=True)
class Farm:
    id: int
    crop: str
    area_ha: float
    soil: str
    pump_hp: float
    head_m: float
    method: str
    das: int
    dr0_frac: float
    available: tuple[tuple[float, float], ...]
    habit_start: str
    last_irrigated_days: int
    served_yesterday: float
    pos: tuple[float, float]
    pump_kw: float = 0.0
    flow_m3h: float = 0.0

    @property
    def code(self) -> str:
        return f"F{self.id:02d}"


@dataclass(frozen=True)
class Feeder:
    id: str
    name: str
    pv_kwp: float
    inverter_kw: float
    feeder_limit_kw: float
    grid_backup_kw: float
    tilt_deg: float
    azimuth_deg: float
    system_losses: float
    gamma_pdc: float
    slot_minutes: int
    day_start_hour: int
    slots: int
    min_run_slots: int
    max_starts: int

    @property
    def slot_hours(self) -> float:
        return self.slot_minutes / 60.0


@dataclass(frozen=True)
class Location:
    id: str
    name: str
    state: str
    lat: float
    lon: float
    elevation_m: float


@dataclass(frozen=True)
class Policy:
    rain_defer_prob: float
    rain_min_mm: float
    rain_lookahead_h: float
    observed_rain_skip_mm: float
    fairness_weight: float
    catch_up_rate: float  # share of the root-zone backlog recovered per day
    bau: dict[str, Any]  # business-as-usual baseline assumptions


@dataclass(frozen=True)
class Scenario:
    feeder: Feeder
    farms: tuple[Farm, ...]
    crops: dict[str, Crop]
    soils: dict[str, Soil]
    methods: dict[str, Method]
    policy: Policy
    locations: dict[str, Location]
    default_location: str
    seasons: tuple[dict[str, Any], ...]
    layout: dict[str, Any]
    pump_model: dict[str, Any]
    raw: dict[str, Any] = field(repr=False, compare=False)

    def farm(self, farm_id: int) -> Farm:
        for f in self.farms:
            if f.id == farm_id:
                return f
        raise KeyError(farm_id)


def pump_electrical_kw(hp: float, motor_efficiency: float) -> float:
    """Electrical input of an induction-motor pumpset at rated load."""
    return hp * HP_KW / motor_efficiency


def pump_flow_m3h(electrical_kw: float, head_m: float, wire_to_water: float) -> float:
    """Estimated discharge from P_elec * eta_ww = rho * g * Q * H."""
    q_m3s = electrical_kw * 1000 * wire_to_water / (RHO_G * head_m)
    return q_m3s * 3600


def _farm_from_json(d: dict[str, Any], pump_model: dict[str, Any]) -> Farm:
    kw = pump_electrical_kw(d["pump_hp"], pump_model["motor_efficiency"])
    flow = pump_flow_m3h(kw, d["head_m"], pump_model["wire_to_water_efficiency"])
    return Farm(
        id=d["id"],
        crop=d["crop"],
        area_ha=d["area_ha"],
        soil=d["soil"],
        pump_hp=d["pump_hp"],
        head_m=d["head_m"],
        method=d["method"],
        das=d["das"],
        dr0_frac=d["dr0_frac"],
        available=tuple((float(a), float(b)) for a, b in d["available"]),
        habit_start=d["habit_start"],
        last_irrigated_days=d["last_irrigated_days"],
        served_yesterday=d["served_yesterday"],
        pos=(float(d["pos"][0]), float(d["pos"][1])),
        pump_kw=round(kw, 3),
        flow_m3h=round(flow, 3),
    )


def parse_scenario(raw: dict[str, Any]) -> Scenario:
    pump_model = raw["pump_model"]
    crops = {
        k: Crop(
            key=k,
            label=v["label"],
            kc=tuple(v["kc"]),
            stages=tuple(v["stages"]),
            zr=tuple(v["zr"]),
            p=v["p"],
            ky=v["ky"],
            stage_labels=tuple(v["stage_labels"]),
            stage_ky=tuple(v["stage_ky"]),
        )
        for k, v in raw["crops"].items()
    }
    soils = {k: Soil(key=k, label=v["label"], fc=v["fc"], wp=v["wp"]) for k, v in raw["soils"].items()}
    methods = {
        k: Method(
            key=k,
            label=v["label"],
            efficiency=v["efficiency"],
            trigger_frac_raw=v["trigger_frac_raw"],
            target_frac_raw=v["target_frac_raw"],
            max_daily_hours=v["max_daily_hours"],
        )
        for k, v in raw["methods"].items()
    }
    locations = {
        loc["id"]: Location(
            id=loc["id"],
            name=loc["name"],
            state=loc["state"],
            lat=loc["lat"],
            lon=loc["lon"],
            elevation_m=loc["elevation_m"],
        )
        for loc in raw["locations"]
    }
    return Scenario(
        feeder=Feeder(**raw["feeder"]),
        farms=tuple(_farm_from_json(f, pump_model) for f in raw["farms"]),
        crops=crops,
        soils=soils,
        methods=methods,
        policy=Policy(**raw["policy"]),
        locations=locations,
        default_location=raw["default_location"],
        seasons=tuple(raw["seasons"]),
        layout=raw["layout"],
        pump_model=pump_model,
        raw=raw,
    )


@lru_cache(maxsize=1)
def load_scenario() -> Scenario:
    with open(SCENARIO_PATH, encoding="utf-8") as fh:
        return parse_scenario(json.load(fh))


def with_overrides(
    sc: Scenario,
    *,
    pv_kwp: float | None = None,
    feeder_limit_kw: float | None = None,
    grid_backup_kw: float | None = None,
    crop_overrides: dict[int, str] | None = None,
    served_yesterday: dict[int, float] | None = None,
) -> Scenario:
    """Return a scenario with user-controlled parameters applied."""
    feeder = sc.feeder
    if pv_kwp is not None:
        # Keep the DC/AC ratio of the reference plant when the array is resized.
        ratio = sc.feeder.pv_kwp / sc.feeder.inverter_kw
        feeder = replace(feeder, pv_kwp=pv_kwp, inverter_kw=round(pv_kwp / ratio, 1))
    if feeder_limit_kw is not None:
        feeder = replace(feeder, feeder_limit_kw=feeder_limit_kw)
    if grid_backup_kw is not None:
        feeder = replace(feeder, grid_backup_kw=grid_backup_kw)

    farms = list(sc.farms)
    if crop_overrides:
        for i, f in enumerate(farms):
            crop = crop_overrides.get(f.id)
            if crop and crop in sc.crops and crop != f.crop:
                # A newly chosen crop keeps the farm's position in the season: map the
                # current stage fraction onto the new crop's calendar.
                old, new = sc.crops[f.crop], sc.crops[crop]
                frac = min(f.das / old.season_days, 0.95)
                farms[i] = replace(f, crop=crop, das=int(round(frac * new.season_days)))
    if served_yesterday:
        farms = [replace(f, served_yesterday=served_yesterday.get(f.id, f.served_yesterday)) for f in farms]

    return replace(sc, feeder=feeder, farms=tuple(farms))


# ---------------------------------------------------------------- time slots


def slot_label(slot: int, feeder: Feeder) -> str:
    minutes = feeder.day_start_hour * 60 + slot * feeder.slot_minutes
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def time_to_slot(hhmm: str, feeder: Feeder) -> int:
    h, m = (int(x) for x in hhmm.split(":"))
    return int(math.floor(((h * 60 + m) - feeder.day_start_hour * 60) / feeder.slot_minutes))


def hour_to_slot(hour: float, feeder: Feeder) -> int:
    return int(round((hour - feeder.day_start_hour) * 60 / feeder.slot_minutes))


def available_slots(farm: Farm, feeder: Feeder) -> list[int]:
    out: set[int] = set()
    for h0, h1 in farm.available:
        a = max(0, hour_to_slot(h0, feeder))
        b = min(feeder.slots, hour_to_slot(h1, feeder))
        out.update(range(a, b))
    return sorted(out)


def window_label(slots: list[int], feeder: Feeder) -> str:
    """Human-readable windows, e.g. '09:30–10:15, 14:00–15:00'."""
    if not slots:
        return ""
    blocks = contiguous_blocks(slots)
    return ", ".join(f"{slot_label(a, feeder)}–{slot_label(b + 1, feeder)}" for a, b in blocks)


def contiguous_blocks(slots: list[int]) -> list[tuple[int, int]]:
    blocks: list[tuple[int, int]] = []
    for s in sorted(slots):
        if blocks and s == blocks[-1][1] + 1:
            blocks[-1] = (blocks[-1][0], s)
        else:
            blocks.append((s, s))
    return blocks
