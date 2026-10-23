"""Weather inputs for the planner.

Sources, in order of preference:
  live         Open-Meteo forecast API (15-minute radiation, hourly met, daily ET0 reference)
  cached       last successful forecast for this location (persistence fallback)
  climatology  approximate monthly normals for the Deccan plateau (last resort)
  replay       Open-Meteo historical archive (ERA5 / ERA5T reanalysis) for season simulations

Every DayWeather carries its source so the UI can label it honestly.
"""

from __future__ import annotations

import calendar
import logging
import math
import time
from dataclasses import dataclass, field, replace
from datetime import date as Date
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import numpy as np
import pandas as pd
import pvlib

from .. import db
from .agronomy import et0_penman_monteith, wind_at_2m
from .scenario import Feeder, Location, Policy

log = logging.getLogger("sunshift.weather")

TZ = "Asia/Kolkata"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
HOURLY = [
    "temperature_2m", "relative_humidity_2m", "wind_speed_10m", "shortwave_radiation",
    "direct_normal_irradiance", "diffuse_radiation", "cloud_cover", "precipitation",
]
M15 = ["shortwave_radiation", "direct_normal_irradiance", "diffuse_radiation", "temperature_2m", "wind_speed_10m"]
FORECAST_TTL_S = 20 * 60
FORECAST_TIMEOUT = httpx.Timeout(5.0, connect=3.0)  # a slow forecast must not hold up planning
LIVE_RETRY_AFTER_S = 120  # after a failed fetch, serve the fallback without retrying for this long
ARCHIVE_TTL_S = 7 * 24 * 3600

# Approximate monthly normals for the Deccan plateau (Telangana), used only when no
# forecast or cache is available: Tmax, Tmin (°C), RH mean (%), u2 (m/s),
# Rs (MJ m-2 d-1), rainfall (mm/month), rainy days.
CLIMATOLOGY = {
    1: (29.5, 15.5, 60, 1.8, 17.5, 8, 1), 2: (32.5, 18.0, 52, 2.0, 20.0, 8, 1),
    3: (36.0, 21.5, 44, 2.1, 22.0, 12, 1), 4: (39.0, 25.0, 42, 2.3, 23.5, 18, 2),
    5: (41.0, 28.0, 42, 2.8, 24.0, 30, 3), 6: (36.0, 26.5, 60, 3.3, 19.0, 130, 8),
    7: (31.5, 24.5, 75, 3.2, 15.5, 230, 14), 8: (31.0, 24.0, 78, 2.8, 15.5, 220, 14),
    9: (32.0, 23.5, 75, 2.0, 16.5, 170, 10), 10: (31.5, 21.5, 68, 1.7, 17.0, 90, 5),
    11: (30.0, 17.5, 62, 1.7, 16.5, 20, 2), 12: (29.0, 14.5, 60, 1.7, 16.0, 5, 0.5),
}

_mem: dict[str, tuple[float, dict[str, Any]]] = {}
_live_failed_at: dict[str, float] = {}  # forecast key -> time of the last failed live fetch


class WeatherUnavailable(RuntimeError):
    pass


@dataclass
class DayWeather:
    date: str
    source: str  # live | cached | climatology | replay
    source_detail: str
    fetched_at: str | None
    ghi: np.ndarray  # W/m2, slot means
    dni: np.ndarray
    dhi: np.ndarray
    temp: np.ndarray  # °C
    wind10: np.ndarray  # m/s at 10 m
    cloud: np.ndarray  # %
    precip: np.ndarray  # mm per slot
    precip_prob: np.ndarray  # %
    tmax: float
    tmin: float
    rh_max: float
    rh_min: float
    rh_mean: float
    u2: float
    rs: float  # MJ m-2 day-1
    rain_mm: float
    rain_prob: float
    et0: float
    et0_reference: float | None  # Open-Meteo's own FAO ET0, for validation
    et0_parts: dict[str, float]
    lookahead_rain_mm: float
    lookahead_rain_prob: float
    sunrise: str | None = None
    sunset: str | None = None
    hourly: list[dict[str, float]] = field(default_factory=list)
    modifications: list[str] = field(default_factory=list)
    # Hourly forecast rain (mm) and cloud cover (%) over the rain look-ahead window, for the ML rain model
    lookahead_precip: list[float] = field(default_factory=list)
    lookahead_cloud: list[float] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        r = lambda a, n=1: [round(float(x), n) for x in a]  # noqa: E731
        return {
            "date": self.date,
            "source": self.source,
            "sourceDetail": self.source_detail,
            "fetchedAt": self.fetched_at,
            "slots": {
                "ghi": r(self.ghi), "dni": r(self.dni), "dhi": r(self.dhi), "temp": r(self.temp),
                "wind10": r(self.wind10, 2), "cloud": r(self.cloud, 0), "precip": r(self.precip, 2),
                "precipProb": r(self.precip_prob, 0),
            },
            "daily": {
                "tmax": round(self.tmax, 1), "tmin": round(self.tmin, 1), "rhMax": round(self.rh_max),
                "rhMin": round(self.rh_min), "rhMean": round(self.rh_mean), "u2": round(self.u2, 2),
                "rs": round(self.rs, 2), "rainMm": round(self.rain_mm, 1), "rainProb": round(self.rain_prob),
                "et0": round(self.et0, 2),
                "et0Reference": None if self.et0_reference is None else round(self.et0_reference, 2),
                "et0Parts": self.et0_parts, "sunrise": self.sunrise, "sunset": self.sunset,
                "lookaheadRainMm": round(self.lookahead_rain_mm, 1),
                "lookaheadRainProb": round(self.lookahead_rain_prob),
            },
            "hourly": self.hourly,
            "modifications": self.modifications,
        }


# ------------------------------------------------------------------ helpers


def slot_times(day: str, feeder: Feeder) -> pd.DatetimeIndex:
    start = pd.Timestamp(f"{day} {feeder.day_start_hour:02d}:00").tz_localize(TZ)
    return start + pd.to_timedelta((np.arange(feeder.slots) + 0.5) * feeder.slot_minutes, unit="min")


def slot_mid_hours(feeder: Feeder) -> np.ndarray:
    return feeder.day_start_hour + (np.arange(feeder.slots) + 0.5) * feeder.slot_minutes / 60


def _pv_location(loc: Location) -> pvlib.location.Location:
    return pvlib.location.Location(loc.lat, loc.lon, tz=TZ, altitude=loc.elevation_m)


def clear_sky(loc: Location, times: pd.DatetimeIndex) -> pd.DataFrame:
    site = _pv_location(loc)
    try:
        return site.get_clearsky(times, model="ineichen")
    except Exception:  # Linke turbidity table unavailable
        return site.get_clearsky(times, model="ineichen", linke_turbidity=4.0)


def _clean(values: list[Any]) -> np.ndarray:
    arr = np.array([np.nan if v is None else v for v in values], dtype=float)
    if np.isnan(arr).all():
        return np.zeros_like(arr)
    if np.isnan(arr).any():
        idx = np.arange(len(arr))
        good = ~np.isnan(arr)
        arr = np.interp(idx, idx[good], arr[good])
    return arr


def _get_json(url: str, params: dict[str, Any], timeout: float | httpx.Timeout = 10.0) -> dict[str, Any]:
    last: Exception | None = None
    for attempt in range(2):
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.get(url, params=params)
                resp.raise_for_status()
                data = resp.json()
                if data.get("error"):
                    raise WeatherUnavailable(str(data.get("reason")))
                return data
        except Exception as exc:  # network errors, HTTP errors, malformed JSON
            last = exc
            time.sleep(0.4 * (attempt + 1))
    raise WeatherUnavailable(str(last))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------------ fetching


def fetch_forecast(loc: Location, *, simulate_outage: bool = False) -> tuple[dict[str, Any], str, str]:
    """Return (payload, source, fetched_at_iso). Falls back to the persisted cache."""
    key = f"forecast:{loc.id}:{loc.lat:.3f}:{loc.lon:.3f}"
    now = time.time()
    recently_failed = now - _live_failed_at.get(key, -1e9) < LIVE_RETRY_AFTER_S
    if not simulate_outage:
        hit = _mem.get(key)
        if hit and now - hit[0] < FORECAST_TTL_S:
            return hit[1], "live", datetime.fromtimestamp(hit[0], timezone.utc).isoformat(timespec="seconds")
    if not simulate_outage and not recently_failed:
        params = {
            "latitude": loc.lat, "longitude": loc.lon, "timezone": TZ, "wind_speed_unit": "ms",
            "past_days": 1, "forecast_days": 4,
            "hourly": ",".join(HOURLY + ["precipitation_probability"]),
            "minutely_15": ",".join(M15),
            "daily": "et0_fao_evapotranspiration,precipitation_sum,precipitation_probability_max,sunrise,sunset",
        }
        try:
            data = _get_json(FORECAST_URL, params, timeout=FORECAST_TIMEOUT)
            _mem[key] = (now, data)
            _live_failed_at.pop(key, None)
            db.cache_put(key, data)
            return data, "live", _now_iso()
        except WeatherUnavailable as exc:
            _live_failed_at[key] = time.time()
            log.warning("Open-Meteo forecast unavailable (retrying in %d s): %s", LIVE_RETRY_AFTER_S, exc)
    hit = _mem.get(key)
    if hit:
        return hit[1], "cached", datetime.fromtimestamp(hit[0], timezone.utc).isoformat(timespec="seconds")
    cached = db.cache_get(key)
    if cached:
        fetched, payload = cached
        return payload, "cached", fetched.isoformat(timespec="seconds")
    raise WeatherUnavailable("no live forecast and no cached forecast")


def fetch_archive(loc: Location, start: str, end: str) -> dict[str, Any]:
    key = f"archive:{loc.id}:{start}:{end}"
    hit = _mem.get(key)
    if hit and time.time() - hit[0] < ARCHIVE_TTL_S:
        return hit[1]
    cached = db.cache_get(key)
    if cached and (datetime.now(timezone.utc) - cached[0]).total_seconds() < ARCHIVE_TTL_S:
        _mem[key] = (time.time(), cached[1])
        return cached[1]
    params = {
        "latitude": loc.lat, "longitude": loc.lon, "timezone": TZ, "wind_speed_unit": "ms",
        "start_date": start, "end_date": end, "hourly": ",".join(HOURLY),
        "daily": "et0_fao_evapotranspiration,precipitation_sum",
    }
    data = _get_json(ARCHIVE_URL, params, timeout=20.0)
    _mem[key] = (time.time(), data)
    db.cache_put(key, data)
    return data


# ------------------------------------------------------------- day assembly


def _day_indices(times: list[str], day: str) -> list[int]:
    return [i for i, t in enumerate(times) if t.startswith(day)]


def _assemble_day(
    *,
    payload: dict[str, Any],
    day: str,
    loc: Location,
    feeder: Feeder,
    policy: Policy,
    source: str,
    source_detail: str,
    fetched_at: str | None,
) -> DayWeather:
    hourly = payload["hourly"]
    times = hourly["time"]
    idx = _day_indices(times, day)
    if len(idx) < 24:
        raise WeatherUnavailable(f"no hourly data for {day}")
    h = {k: _clean([hourly[k][i] for i in idx]) for k in hourly if k != "time"}
    hours = np.arange(24, dtype=float)
    mids = slot_mid_hours(feeder)
    slot_hours = feeder.slot_minutes / 60

    # Radiation values are means over the preceding interval.
    m15 = payload.get("minutely_15")
    if m15 and "shortwave_radiation" in m15:
        m_index = {t: i for i, t in enumerate(m15["time"])}
        start = datetime.fromisoformat(f"{day}T{feeder.day_start_hour:02d}:00")
        ends = [(start + timedelta(minutes=feeder.slot_minutes * (k + 1))).strftime("%Y-%m-%dT%H:%M") for k in range(feeder.slots)]
        if all(e in m_index for e in ends):
            pick = lambda var: _clean([m15[var][m_index[e]] for e in ends])  # noqa: E731
            ghi, dni, dhi = pick("shortwave_radiation"), pick("direct_normal_irradiance"), pick("diffuse_radiation")
            temp, wind = pick("temperature_2m"), pick("wind_speed_10m")
        else:
            m15 = None
    if not m15 or "shortwave_radiation" not in (m15 or {}):
        ghi = np.interp(mids, hours - 0.5, h["shortwave_radiation"])
        dni = np.interp(mids, hours - 0.5, h["direct_normal_irradiance"])
        dhi = np.interp(mids, hours - 0.5, h["diffuse_radiation"])
        temp = np.interp(mids, hours, h["temperature_2m"])
        wind = np.interp(mids, hours, h["wind_speed_10m"])
    cloud = np.interp(mids, hours, h["cloud_cover"])
    bucket = np.clip(np.ceil(mids).astype(int), 0, 23)
    precip = h["precipitation"][bucket] * slot_hours
    prob = h["precipitation_probability"][bucket] if "precipitation_probability" in h else np.where(precip > 0.05, 100.0, 0.0)

    tmax, tmin = float(h["temperature_2m"].max()), float(h["temperature_2m"].min())
    rh_max, rh_min = float(h["relative_humidity_2m"].max()), float(h["relative_humidity_2m"].min())
    rh_mean = float(h["relative_humidity_2m"].mean())
    u2 = wind_at_2m(float(h["wind_speed_10m"].mean()))
    rs = float(h["shortwave_radiation"].sum() * 3600 / 1e6)
    rain = float(h["precipitation"].sum())
    rain_prob = float(h["precipitation_probability"].max()) if "precipitation_probability" in h else (100.0 if rain > 0.2 else 0.0)

    doy = Date.fromisoformat(day).timetuple().tm_yday
    et = et0_penman_monteith(
        tmax=tmax, tmin=tmin, rs=rs, u2=u2, lat=loc.lat, elevation=loc.elevation_m, doy=doy,
        rh_max=rh_max, rh_min=rh_min,
    )

    et0_ref = None
    sunrise = sunset = None
    daily = payload.get("daily") or {}
    if day in daily.get("time", []):
        di = daily["time"].index(day)
        v = (daily.get("et0_fao_evapotranspiration") or [None] * (di + 1))[di]
        et0_ref = None if v is None else float(v)
        sunrise = (daily.get("sunrise") or [None] * (di + 1))[di]
        sunset = (daily.get("sunset") or [None] * (di + 1))[di]

    # Rain lookahead from the start of the irrigation day.
    start_i = idx[0] + feeder.day_start_hour
    end_i = min(len(times), start_i + int(policy.rain_lookahead_h))
    look = _clean([hourly["precipitation"][i] for i in range(start_i, end_i)])
    look_mm = float(look.sum())
    look_cloud = _clean([hourly["cloud_cover"][i] for i in range(start_i, end_i)])
    if "precipitation_probability" in hourly:
        look_prob = float(np.max(_clean([hourly["precipitation_probability"][i] for i in range(start_i, end_i)])))
    else:
        look_prob = 100.0 if look_mm > 0.5 else 0.0

    hourly_rows = [
        {
            "hour": int(hh), "temp": round(float(h["temperature_2m"][hh]), 1),
            "rh": round(float(h["relative_humidity_2m"][hh])), "wind10": round(float(h["wind_speed_10m"][hh]), 2),
            "ghi": round(float(h["shortwave_radiation"][hh])), "cloud": round(float(h["cloud_cover"][hh])),
            "precip": round(float(h["precipitation"][hh]), 2),
            "prob": round(float(h["precipitation_probability"][hh])) if "precipitation_probability" in h else None,
        }
        for hh in range(24)
    ]

    return DayWeather(
        date=day, source=source, source_detail=source_detail, fetched_at=fetched_at,
        ghi=np.maximum(ghi, 0), dni=np.maximum(dni, 0), dhi=np.maximum(dhi, 0), temp=temp, wind10=wind,
        cloud=cloud, precip=precip, precip_prob=prob, tmax=tmax, tmin=tmin, rh_max=rh_max, rh_min=rh_min,
        rh_mean=rh_mean, u2=u2, rs=rs, rain_mm=rain, rain_prob=rain_prob, et0=et.et0, et0_reference=et0_ref,
        et0_parts=et.as_dict(), lookahead_rain_mm=look_mm, lookahead_rain_prob=look_prob,
        sunrise=sunrise, sunset=sunset, hourly=hourly_rows,
        lookahead_precip=[float(v) for v in look], lookahead_cloud=[float(v) for v in look_cloud],
    )


def climatological_et0(month: int, loc: Location) -> float:
    """FAO-56 ET0 for the monthly normals: what a farmer's seasonal experience suggests."""
    tmax, tmin, rh_mean, u2, rs, _, _ = CLIMATOLOGY[month]
    doy = Date(2025, month, 15).timetuple().tm_yday
    return et0_penman_monteith(
        tmax=tmax, tmin=tmin, rs=rs, u2=u2, lat=loc.lat, elevation=loc.elevation_m, doy=doy, rh_mean=rh_mean,
    ).et0


def climatology_day(day: str, loc: Location, feeder: Feeder) -> DayWeather:
    """Synthesise a day from monthly normals: clear-sky shape scaled to normal radiation."""
    d = Date.fromisoformat(day)
    tmax, tmin, rh_mean, u2, rs_norm, rain_month, rain_days = CLIMATOLOGY[d.month]
    hours_idx = pd.Timestamp(f"{day} 00:30").tz_localize(TZ) + pd.to_timedelta(np.arange(24), unit="h")
    cs_h = clear_sky(loc, hours_idx)
    rs_clear = float(cs_h["ghi"].sum() * 3600 / 1e6)
    kt = min(1.0, rs_norm / rs_clear) if rs_clear > 0 else 0.7
    times = slot_times(day, feeder)
    cs = clear_sky(loc, times)
    zen = pvlib.solarposition.get_solarposition(times, loc.lat, loc.lon, altitude=loc.elevation_m)["zenith"]
    ghi = cs["ghi"].to_numpy() * kt
    split = pvlib.irradiance.erbs(ghi, zen.to_numpy(), times)
    mids = slot_mid_hours(feeder)
    temp = tmin + (tmax - tmin) * np.clip(np.sin(np.pi * (mids - 6) / 18), 0, 1) ** 1.2
    rh_hourly = np.clip(rh_mean + 18 * np.cos(np.pi * (np.arange(24) - 5) / 12), 15, 100)
    days_in_month = calendar.monthrange(d.year, d.month)[1]
    prob = min(95.0, 100 * rain_days / days_in_month)
    doy = d.timetuple().tm_yday
    et = et0_penman_monteith(
        tmax=tmax, tmin=tmin, rs=rs_norm, u2=u2, lat=loc.lat, elevation=loc.elevation_m, doy=doy, rh_mean=rh_mean,
    )
    n = feeder.slots
    return DayWeather(
        date=day, source="climatology",
        source_detail="Approximate monthly normals (Deccan plateau); no specific rain events can be forecast",
        fetched_at=None, ghi=ghi, dni=np.asarray(split["dni"]), dhi=np.asarray(split["dhi"]), temp=temp,
        wind10=np.full(n, u2 / 0.748), cloud=np.full(n, 100 * (1 - kt)), precip=np.zeros(n),
        precip_prob=np.full(n, prob), tmax=tmax, tmin=tmin, rh_max=float(rh_hourly.max()),
        rh_min=float(rh_hourly.min()), rh_mean=rh_mean, u2=u2, rs=rs_norm, rain_mm=0.0, rain_prob=prob,
        et0=et.et0, et0_reference=None, et0_parts=et.as_dict(), lookahead_rain_mm=0.0, lookahead_rain_prob=prob,
        hourly=[],
    )


def forecast_day(
    day: str, loc: Location, feeder: Feeder, policy: Policy, *, simulate_outage: bool = False
) -> DayWeather:
    try:
        payload, source, fetched = fetch_forecast(loc, simulate_outage=simulate_outage)
        if source == "live":
            detail = "Open-Meteo forecast (15-minute radiation, hourly meteorology)"
        else:
            detail = "Open-Meteo forecast unavailable; using the last cached forecast (persistence fallback)"
        return _assemble_day(
            payload=payload, day=day, loc=loc, feeder=feeder, policy=policy,
            source=source, source_detail=detail, fetched_at=fetched,
        )
    except WeatherUnavailable as exc:
        log.warning("falling back to climatology for %s: %s", day, exc)
        dw = climatology_day(day, loc, feeder)
        if simulate_outage:
            dw.source_detail = "Weather API outage simulated; " + dw.source_detail
        return dw


def replay_days(loc: Location, start: str, n_days: int, feeder: Feeder, policy: Policy) -> list[DayWeather]:
    """Historical days from the ERA5 archive (plus one extra day for rain lookahead)."""
    d0 = Date.fromisoformat(start)
    end = d0 + timedelta(days=n_days)
    payload = fetch_archive(loc, d0.isoformat(), end.isoformat())
    out = []
    for k in range(n_days):
        day = (d0 + timedelta(days=k)).isoformat()
        try:
            out.append(_assemble_day(
                payload=payload, day=day, loc=loc, feeder=feeder, policy=policy, source="replay",
                source_detail="Open-Meteo historical archive (ERA5/ERA5T reanalysis)", fetched_at=None,
            ))
        except WeatherUnavailable:
            dw = climatology_day(day, loc, feeder)
            dw.source_detail = "Archive gap filled with climatology"
            out.append(dw)
    return out


# ----------------------------------------------------------- scenario modes


def _recompute_et0(dw: DayWeather, loc: Location) -> None:
    doy = Date.fromisoformat(dw.date).timetuple().tm_yday
    et = et0_penman_monteith(
        tmax=dw.tmax, tmin=dw.tmin, rs=dw.rs, u2=dw.u2, lat=loc.lat, elevation=loc.elevation_m, doy=doy,
        rh_max=dw.rh_max, rh_min=dw.rh_min,
    )
    dw.et0 = et.et0
    dw.et0_parts = et.as_dict()


def _scale_rs_by_slots(dw: DayWeather, old_ghi: np.ndarray) -> None:
    before = float(old_ghi.sum())
    if before > 0:
        dw.rs = dw.rs * float(dw.ghi.sum()) / before


def apply_mode(
    dw: DayWeather,
    *,
    mode: str,
    loc: Location,
    feeder: Feeder,
    rain_mm: float = 18.0,
    rain_prob: float = 85.0,
    rain_start_hour: float = 13.0,
    solar_event: dict[str, float] | None = None,
) -> DayWeather:
    """Apply a scenario on top of the base weather. Never mutates the input."""
    dw = replace(
        dw, ghi=dw.ghi.copy(), dni=dw.dni.copy(), dhi=dw.dhi.copy(), temp=dw.temp.copy(),
        cloud=dw.cloud.copy(), precip=dw.precip.copy(), precip_prob=dw.precip_prob.copy(),
        modifications=list(dw.modifications), et0_parts=dict(dw.et0_parts),
    )
    times = slot_times(dw.date, feeder)
    mids = slot_mid_hours(feeder)

    if mode == "clear":
        cs = clear_sky(loc, times)
        old = dw.ghi.copy()
        dw.ghi, dw.dni, dw.dhi = cs["ghi"].to_numpy(), cs["dni"].to_numpy(), cs["dhi"].to_numpy()
        _scale_rs_by_slots(dw, old)
        dw.cloud[:] = 0
        dw.precip[:] = 0
        dw.precip_prob[:] = 0
        dw.rain_mm = dw.rain_prob = dw.lookahead_rain_mm = dw.lookahead_rain_prob = 0.0
        _recompute_et0(dw, loc)
        dw.modifications.append("Clear-sky irradiance (pvlib Ineichen); forecast rain removed")
    elif mode == "cloudy":
        cs = clear_sky(loc, times)
        zen = pvlib.solarposition.get_solarposition(times, loc.lat, loc.lon, altitude=loc.elevation_m)["zenith"].to_numpy()
        old = dw.ghi.copy()
        ripple = 1 + 0.18 * np.sin(mids * 2.1) * np.cos(mids * 0.7)
        dw.ghi = cs["ghi"].to_numpy() * 0.38 * ripple
        dw.dni = cs["dni"].to_numpy() * 0.05
        dw.dhi = np.maximum(0, dw.ghi - dw.dni * np.cos(np.radians(zen)))
        _scale_rs_by_slots(dw, old)
        dw.cloud[:] = 92
        dw.rh_max = min(100.0, dw.rh_max + 8)
        dw.rh_min = min(100.0, dw.rh_min + 12)
        _recompute_et0(dw, loc)
        dw.modifications.append("Overcast day: irradiance ~38% of clear-sky")
    elif mode == "heatwave":
        dw.tmax += 4.0
        dw.tmin += 2.5
        dw.temp = dw.temp + 3.5
        dw.rh_max = max(20.0, dw.rh_max - 15)
        dw.rh_min = max(8.0, dw.rh_min - 15)
        dw.u2 *= 1.3
        _recompute_et0(dw, loc)
        dw.modifications.append("Heatwave: +4 °C, −15% RH, +30% wind")
    elif mode == "rain":
        old = dw.ghi.copy()
        onset = rain_start_hour
        shares = (0.4, 0.35, 0.25)
        for k, mid in enumerate(mids):
            if onset - 1.0 <= mid < onset:
                dw.ghi[k] *= 0.55
                dw.dni[k] *= 0.3
            elif onset <= mid < onset + 3:
                dw.ghi[k] *= 0.18
                dw.dni[k] *= 0.02
                hour_share = shares[min(2, int(mid - onset))]
                dw.precip[k] += rain_mm * hour_share * feeder.slot_minutes / 60
                dw.precip_prob[k] = max(dw.precip_prob[k], rain_prob)
                dw.cloud[k] = 100
            elif mid >= onset + 3:
                dw.ghi[k] *= 0.5
                dw.dni[k] *= 0.35
        dw.dhi = np.minimum(dw.dhi, dw.ghi)
        _scale_rs_by_slots(dw, old)
        dw.rain_mm += rain_mm
        dw.rain_prob = max(dw.rain_prob, rain_prob)
        dw.lookahead_rain_mm += rain_mm
        dw.lookahead_rain_prob = max(dw.lookahead_rain_prob, rain_prob)
        dw.rh_min = min(100.0, dw.rh_min + 20)
        _recompute_et0(dw, loc)
        dw.modifications.append(
            f"Rain event injected: {rain_mm:.0f} mm from {int(onset):02d}:{int(round((onset % 1) * 60)):02d} ({rain_prob:.0f}% probability)"
        )

    if solar_event:
        k0 = int(solar_event.get("from_slot", 0))
        factor = float(solar_event.get("factor", 1.0))
        dw.ghi[k0:] *= factor
        dw.dni[k0:] *= factor
        dw.dhi[k0:] *= factor
        dw.modifications.append(
            f"Cloud bank from slot {k0}: irradiance × {factor:.2f} (solar forecast revised)"
        )
    return dw
