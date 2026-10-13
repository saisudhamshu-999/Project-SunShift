"""PV plant model (pvlib): GHI/DNI/DHI -> plane-of-array -> cell temperature -> DC -> AC.

The feeder-level plant is modelled as a fixed-tilt array with a PVWatts DC model and a
PVWatts inverter, which is the right level of fidelity for 15-minute scheduling.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import pvlib

from .scenario import Feeder, Location
from .weather import DayWeather, clear_sky, slot_times


@dataclass
class SolarProfile:
    times: pd.DatetimeIndex
    zenith: np.ndarray
    azimuth: np.ndarray
    elevation: np.ndarray
    ghi: np.ndarray
    poa: np.ndarray
    tcell: np.ndarray
    dc_kw: np.ndarray
    ac_kw: np.ndarray
    clear_ac_kw: np.ndarray

    def energy_kwh(self, slot_hours: float) -> float:
        return float(self.ac_kw.sum() * slot_hours)

    def to_dict(self, slot_hours: float) -> dict:
        r = lambda a, n=2: [round(float(x), n) for x in a]  # noqa: E731
        return {
            "zenith": r(self.zenith, 2),
            "azimuth": r(self.azimuth, 2),
            "elevation": r(self.elevation, 2),
            "ghi": r(self.ghi, 1),
            "poa": r(self.poa, 1),
            "tcell": r(self.tcell, 1),
            "dcKw": r(self.dc_kw),
            "acKw": r(self.ac_kw),
            "clearSkyAcKw": r(self.clear_ac_kw),
            "energyKwh": round(self.energy_kwh(slot_hours), 1),
            "clearSkyEnergyKwh": round(float(self.clear_ac_kw.sum() * slot_hours), 1),
            "peakKw": round(float(self.ac_kw.max()), 2),
        }


def _ac_power(
    *, feeder: Feeder, times: pd.DatetimeIndex, solpos: pd.DataFrame, ghi, dni, dhi, temp_air, wind
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    dni_extra = pvlib.irradiance.get_extra_radiation(times)
    poa = pvlib.irradiance.get_total_irradiance(
        surface_tilt=feeder.tilt_deg,
        surface_azimuth=feeder.azimuth_deg,
        solar_zenith=solpos["apparent_zenith"],
        solar_azimuth=solpos["azimuth"],
        dni=pd.Series(dni, index=times),
        ghi=pd.Series(ghi, index=times),
        dhi=pd.Series(dhi, index=times),
        dni_extra=dni_extra,
        model="haydavies",
    )
    poa_global = poa["poa_global"].fillna(0).clip(lower=0)
    tcell = pvlib.temperature.faiman(poa_global, pd.Series(temp_air, index=times), pd.Series(wind, index=times))
    pdc = pvlib.pvsystem.pvwatts_dc(poa_global, tcell, pdc0=feeder.pv_kwp * 1000, gamma_pdc=feeder.gamma_pdc)
    pdc = pdc * (1 - feeder.system_losses)
    inv_pdc0 = feeder.inverter_kw * 1000 / 0.96
    pac = pvlib.inverter.pvwatts(pdc, pdc0=inv_pdc0, eta_inv_nom=0.96)
    pac = np.clip(np.nan_to_num(np.asarray(pac, dtype=float)), 0, feeder.inverter_kw * 1000)
    return (
        poa_global.to_numpy(),
        np.asarray(tcell, dtype=float),
        np.clip(np.asarray(pdc, dtype=float), 0, None) / 1000,
        pac / 1000,
    )


def ac_from_ghi(day: str, loc: Location, feeder: Feeder, ghi, temp_air, wind10) -> np.ndarray:
    """AC output per slot for a GHI series alone: DNI and DHI are split off with Erbs.
    Used for ML solar curves and backtests, where only GHI is known."""
    times = slot_times(day, feeder)
    solpos = pvlib.solarposition.get_solarposition(times, loc.lat, loc.lon, altitude=loc.elevation_m)
    ghi = np.clip(np.asarray(ghi, dtype=float), 0, None)
    split = pvlib.irradiance.erbs(ghi, solpos["zenith"].to_numpy(), times)
    _, _, _, ac = _ac_power(feeder=feeder, times=times, solpos=solpos, ghi=ghi, dni=np.nan_to_num(np.asarray(split["dni"])),
                            dhi=np.nan_to_num(np.asarray(split["dhi"])), temp_air=temp_air, wind=wind10)
    return ac


def pv_profile(dw: DayWeather, loc: Location, feeder: Feeder) -> SolarProfile:
    times = slot_times(dw.date, feeder)
    solpos = pvlib.solarposition.get_solarposition(
        times, loc.lat, loc.lon, altitude=loc.elevation_m, temperature=float(np.mean(dw.temp))
    )
    poa, tcell, dc_kw, ac_kw = _ac_power(
        feeder=feeder, times=times, solpos=solpos, ghi=dw.ghi, dni=dw.dni, dhi=dw.dhi,
        temp_air=dw.temp, wind=dw.wind10,
    )
    cs = clear_sky(loc, times)
    _, _, _, clear_ac = _ac_power(
        feeder=feeder, times=times, solpos=solpos, ghi=cs["ghi"].to_numpy(), dni=cs["dni"].to_numpy(),
        dhi=cs["dhi"].to_numpy(), temp_air=dw.temp, wind=dw.wind10,
    )
    return SolarProfile(
        times=times,
        zenith=solpos["apparent_zenith"].to_numpy(),
        azimuth=solpos["azimuth"].to_numpy(),
        elevation=solpos["apparent_elevation"].to_numpy(),
        ghi=np.asarray(dw.ghi, dtype=float),
        poa=poa,
        tcell=tcell,
        dc_kw=dc_kw,
        ac_kw=ac_kw,
        clear_ac_kw=clear_ac,
    )
