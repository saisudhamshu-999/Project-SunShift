"""FAO-56 agronomy: reference evapotranspiration, crop coefficients and the
root-zone soil-water balance.

References
----------
Allen, R.G., Pereira, L.S., Raes, D., Smith, M. (1998). Crop evapotranspiration:
guidelines for computing crop water requirements. FAO Irrigation and Drainage Paper 56.
Equation numbers in comments refer to that paper.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .scenario import Crop, Farm, Method, Policy, Scenario, Soil

STEFAN_BOLTZMANN = 4.903e-9  # MJ K-4 m-2 day-1
ALBEDO = 0.23


# --------------------------------------------------------------------- ET0


def sat_vapour_pressure(t: float) -> float:
    """e°(T) in kPa (Eq. 11)."""
    return 0.6108 * math.exp(17.27 * t / (t + 237.3))


def svp_slope(t: float) -> float:
    """Δ, slope of the saturation vapour pressure curve, kPa/°C (Eq. 13)."""
    return 4098 * sat_vapour_pressure(t) / (t + 237.3) ** 2


def atmospheric_pressure(z: float) -> float:
    """P in kPa at elevation z metres (Eq. 7)."""
    return 101.3 * ((293 - 0.0065 * z) / 293) ** 5.26


def psychrometric_constant(p_kpa: float) -> float:
    """γ in kPa/°C (Eq. 8)."""
    return 0.000665 * p_kpa


def extraterrestrial_radiation(lat_deg: float, doy: int) -> float:
    """Ra in MJ m-2 day-1 (Eq. 21)."""
    phi = math.radians(lat_deg)
    dr = 1 + 0.033 * math.cos(2 * math.pi / 365 * doy)
    dec = 0.409 * math.sin(2 * math.pi / 365 * doy - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(dec))))
    return (
        24 * 60 / math.pi * 0.0820 * dr
        * (ws * math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.sin(ws))
    )


def daylight_hours(lat_deg: float, doy: int) -> float:
    """N, maximum possible sunshine duration (Eq. 34)."""
    phi = math.radians(lat_deg)
    dec = 0.409 * math.sin(2 * math.pi / 365 * doy - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(dec))))
    return 24 / math.pi * ws


def wind_at_2m(u: float, height_m: float = 10.0) -> float:
    """Convert wind speed measured at height_m to 2 m (Eq. 47)."""
    return u * 4.87 / math.log(67.8 * height_m - 5.42)


@dataclass(frozen=True)
class ET0Result:
    et0: float
    tmean: float
    delta: float
    gamma: float
    es: float
    ea: float
    ra: float
    rso: float
    rns: float
    rnl: float
    rn: float
    u2: float
    radiation_term: float
    aero_term: float

    def as_dict(self) -> dict[str, float]:
        return {k: round(v, 4) for k, v in self.__dict__.items()}


def et0_penman_monteith(
    *,
    tmax: float,
    tmin: float,
    rs: float,
    u2: float,
    lat: float,
    elevation: float,
    doy: int,
    rh_max: float | None = None,
    rh_min: float | None = None,
    rh_mean: float | None = None,
) -> ET0Result:
    """Daily FAO-56 Penman-Monteith reference evapotranspiration (Eq. 6).

    rs is incoming shortwave radiation in MJ m-2 day-1; u2 is wind at 2 m in m/s.
    """
    tmean = (tmax + tmin) / 2
    delta = svp_slope(tmean)
    gamma = psychrometric_constant(atmospheric_pressure(elevation))
    es = (sat_vapour_pressure(tmax) + sat_vapour_pressure(tmin)) / 2  # Eq. 12
    if rh_max is not None and rh_min is not None:
        ea = (sat_vapour_pressure(tmin) * rh_max / 100 + sat_vapour_pressure(tmax) * rh_min / 100) / 2  # Eq. 17
    elif rh_mean is not None:
        ea = rh_mean / 100 * es  # Eq. 19
    else:
        ea = sat_vapour_pressure(tmin)  # Eq. 48, Tdew ≈ Tmin
    ra = extraterrestrial_radiation(lat, doy)
    rso = (0.75 + 2e-5 * elevation) * ra  # Eq. 37
    rns = (1 - ALBEDO) * rs  # Eq. 38
    rel = min(rs / rso, 1.0) if rso > 0 else 0.5
    rnl = (
        STEFAN_BOLTZMANN
        * ((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4) / 2
        * (0.34 - 0.14 * math.sqrt(max(ea, 0.0)))
        * (1.35 * rel - 0.35)
    )  # Eq. 39
    rn = rns - rnl  # Eq. 40
    g = 0.0  # daily soil heat flux is negligible (Eq. 42)
    den = delta + gamma * (1 + 0.34 * u2)
    radiation_term = 0.408 * delta * (rn - g) / den
    aero_term = gamma * (900 / (tmean + 273)) * u2 * (es - ea) / den
    et0 = max(0.0, radiation_term + aero_term)
    return ET0Result(et0, tmean, delta, gamma, es, ea, ra, rso, rns, rnl, rn, u2, radiation_term, aero_term)


# ------------------------------------------------------------ crop stages

STAGE_KEYS = ("initial", "development", "mid", "late")


def crop_stage(crop: Crop, das: int) -> int:
    """0..3 for FAO-56 stages, 4 once harvested, -1 before sowing."""
    if das < 0:
        return -1
    acc = 0
    for i, length in enumerate(crop.stages):
        acc += length
        if das < acc:
            return i
    return 4


def kc_at(crop: Crop, das: float) -> float:
    """Single crop coefficient with FAO-56 linear interpolation (Fig. 25, Eq. 66)."""
    l_ini, l_dev, l_mid, l_late = crop.stages
    kc_ini, kc_mid, kc_end = crop.kc
    if das < 0:
        return 0.0
    if das <= l_ini:
        return kc_ini
    if das <= l_ini + l_dev:
        return kc_ini + (das - l_ini) / l_dev * (kc_mid - kc_ini)
    if das <= l_ini + l_dev + l_mid:
        return kc_mid
    if das <= crop.season_days:
        return kc_mid + (das - l_ini - l_dev - l_mid) / l_late * (kc_end - kc_mid)
    return 0.0


def kc_curve(crop: Crop, step: int = 2) -> list[tuple[int, float]]:
    return [(d, round(kc_at(crop, d), 4)) for d in range(0, crop.season_days + 1, step)]


def root_depth(crop: Crop, das: float) -> float:
    """Effective rooting depth grows linearly until the start of mid-season."""
    zmin, zmax = crop.zr
    grow = crop.stages[0] + crop.stages[1]
    return zmin + (zmax - zmin) * max(0.0, min(1.0, das / grow))


def depletion_fraction(crop: Crop, etc: float) -> float:
    """p adjusted for evaporative demand (FAO-56 Table 22 footnote)."""
    return max(0.1, min(0.8, crop.p + 0.04 * (5 - etc)))


def total_available_water(soil: Soil, zr: float) -> float:
    """TAW in mm (Eq. 82)."""
    return 1000 * (soil.fc - soil.wp) * zr


def water_stress_coefficient(dr: float, taw: float, raw: float) -> float:
    """Ks (Eq. 84)."""
    if dr <= raw:
        return 1.0
    if taw <= raw:
        return 0.0
    return max(0.0, (taw - dr) / (taw - raw))


def effective_rain(rain_mm: float, et0: float) -> tuple[float, float]:
    """Split rainfall into (effective, runoff).

    Light showers below 0.2·ET0 are intercepted and evaporate (FAO-56 §8);
    intense events above 25 mm lose a share to runoff.
    """
    if rain_mm < 0.2 * et0 or rain_mm < 0.5:
        return 0.0, 0.0
    runoff = max(0.0, rain_mm - 25.0) * 0.35
    return rain_mm - runoff, runoff


@dataclass
class WaterBalanceDay:
    dr_start: float
    dr_end: float
    etc: float
    eta: float
    ks: float
    rain: float
    rain_effective: float
    runoff: float
    irrigation_net: float
    deep_percolation: float
    taw: float
    raw: float


def water_balance_day(
    *, dr: float, taw: float, raw: float, etc: float, rain: float, et0: float, irrigation_net: float
) -> WaterBalanceDay:
    """One daily step of the root-zone depletion balance (Eq. 85)."""
    ks = water_stress_coefficient(dr, taw, raw)
    eta = ks * etc
    p_eff, ro = effective_rain(rain, et0)
    dr_new = dr - p_eff - irrigation_net + eta
    dp = 0.0
    if dr_new < 0:
        dp = -dr_new  # water above field capacity drains below the root zone (Eq. 88)
        dr_new = 0.0
    dr_new = min(dr_new, taw)
    return WaterBalanceDay(dr, dr_new, etc, eta, ks, rain, p_eff, ro, irrigation_net, dp, taw, raw)


# ------------------------------------------------------------ farm demand


@dataclass
class FarmAgronomy:
    """Agronomic state and today's irrigation requirement for one farm."""

    farm_id: int
    das: int
    stage: int
    stage_label: str
    kc: float
    etc: float
    zr: float
    taw: float
    raw: float
    p: float
    dr_start: float
    dr_projected: float
    ks_start: float
    trigger_mm: float
    target_mm: float
    need_net_mm: float  # before rain consideration
    rain_expected_mm: float
    need_after_rain_mm: float  # today's net dose after rain and pump-capacity limits
    deferred_for_rain: bool
    gross_mm: float
    volume_m3: float
    pump_hours: float
    required_slots: int
    capacity_limited: bool
    status: str  # SAFE | WATCH | STRESS
    sensitivity: float  # 0..1, yield sensitivity of the current stage

    @property
    def depletion_pct(self) -> float:
        return 100 * self.dr_start / self.taw if self.taw else 0.0

    @property
    def soil_water_pct(self) -> float:
        """Relative available water in the root zone (100% = field capacity)."""
        return 100 - self.depletion_pct


def assess_farm(
    *,
    sc: Scenario,
    farm: Farm,
    das: int,
    dr_start: float,
    et0: float,
    rain_forecast_mm: float,
    rain_prob: float,
    available_slot_count: int,
    demand_scale: float = 1.0,
    refilling: bool = False,
) -> FarmAgronomy:
    crop = sc.crops[farm.crop]
    soil = sc.soils[farm.soil]
    method: Method = sc.methods[farm.method]
    policy: Policy = sc.policy
    feeder = sc.feeder

    stage = crop_stage(crop, das)
    kc = kc_at(crop, das)
    etc = kc * et0 * demand_scale
    zr = root_depth(crop, das)
    taw = total_available_water(soil, zr)
    p = depletion_fraction(crop, etc)
    raw = p * taw
    dr_start = min(dr_start, taw)
    ks_start = water_stress_coefficient(dr_start, taw, raw)

    dr_proj = min(taw, dr_start + etc)
    trigger = method.trigger_frac_raw * raw
    # Refill only into a comfort band below RAW: no stress, and room left to capture rain.
    target = method.target_frac_raw * raw

    # Smallholder pumps cannot refill a large root-zone deficit in one day. Each day's
    # dose replaces today's crop use plus a share of the backlog; the field is brought
    # back towards the target over several days (as farmers do, set by set).
    if stage in (-1, 4):
        need_net = 0.0
    elif dr_proj >= trigger or (refilling and dr_proj > target + 1.0):
        backlog = max(0.0, dr_start - target)
        need_net = min(max(0.0, dr_proj - target), etc + policy.catch_up_rate * backlog)
    else:
        need_net = 0.0

    # Rain-aware deferral: a confident forecast that covers the need cancels or
    # reduces today's irrigation, unless the crop would already be stressed before it.
    rain_expected = 0.0
    if rain_prob >= policy.rain_defer_prob and rain_forecast_mm >= policy.rain_min_mm:
        rain_expected, _ = effective_rain(rain_forecast_mm, et0)
    need_after = need_net
    deferred = False
    if need_net > 0 and rain_expected > 0:
        if dr_proj - rain_expected < raw:
            need_after = max(0.0, need_net - rain_expected)
            if need_after < 0.5 * max(trigger - target, 3.0):
                need_after = 0.0
                deferred = True

    gross = need_after / method.efficiency
    volume = gross * farm.area_ha * 10  # 1 mm over 1 ha = 10 m3
    hours = volume / farm.flow_m3h if farm.flow_m3h > 0 else 0.0
    # The practical daily cap applies while the crop is comfortable; once projected depletion
    # passes RAW (stress), the pump may run through the whole availability window.
    window_hours = available_slot_count * feeder.slot_minutes / 60
    max_hours = window_hours if dr_proj >= raw else min(method.max_daily_hours, window_hours)
    capacity_limited = hours > max_hours + 1e-9
    if capacity_limited:
        hours = max_hours
        volume = hours * farm.flow_m3h
        gross = volume / (farm.area_ha * 10)
        need_after = gross * method.efficiency
    slots = math.ceil(hours * 60 / feeder.slot_minutes - 1e-6) if hours > 0 else 0
    if 0 < slots < feeder.min_run_slots:
        slots = feeder.min_run_slots
    slots = min(slots, available_slot_count)

    if ks_start < 1.0:
        status = "STRESS"
    elif dr_proj >= trigger:
        status = "WATCH"
    else:
        status = "SAFE"

    sensitivity = 0.0
    if 0 <= stage <= 3:
        sensitivity = min(1.0, crop.stage_ky[stage] / 1.5)
    stage_label = crop.stage_labels[stage] if 0 <= stage <= 3 else ("Harvested" if stage == 4 else "Not sown")

    return FarmAgronomy(
        farm_id=farm.id,
        das=das,
        stage=stage,
        stage_label=stage_label,
        kc=kc,
        etc=etc,
        zr=zr,
        taw=taw,
        raw=raw,
        p=p,
        dr_start=dr_start,
        dr_projected=dr_proj,
        ks_start=ks_start,
        trigger_mm=trigger,
        target_mm=target,
        need_net_mm=need_net,
        rain_expected_mm=rain_expected,
        need_after_rain_mm=need_after,
        deferred_for_rain=deferred,
        gross_mm=gross,
        volume_m3=volume,
        pump_hours=hours,
        required_slots=slots,
        capacity_limited=capacity_limited,
        status=status,
        sensitivity=sensitivity,
    )


def net_mm_from_volume(volume_m3: float, farm: Farm, method: Method) -> float:
    """Net depth reaching the root zone for a pumped volume."""
    if farm.area_ha <= 0:
        return 0.0
    return volume_m3 / (farm.area_ha * 10) * method.efficiency
