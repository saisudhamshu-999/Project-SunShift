import math

import pytest

from app.engine import agronomy as ag
from app.engine.scenario import load_scenario


def test_et0_matches_fao56_example_18():
    """FAO-56 Example 18: Uccle (Brussels), 6 July, ET0 = 3.9 mm/day."""
    lat, elev, doy = 50.80, 100.0, 187
    n_hours = 9.25
    ra = ag.extraterrestrial_radiation(lat, doy)
    big_n = ag.daylight_hours(lat, doy)
    rs = (0.25 + 0.50 * n_hours / big_n) * ra  # Angstrom (Eq. 35)
    assert ra == pytest.approx(41.09, abs=0.1)
    assert big_n == pytest.approx(16.1, abs=0.1)
    assert rs == pytest.approx(22.07, abs=0.1)
    u2 = ag.wind_at_2m(10 / 3.6, 10.0)
    assert u2 == pytest.approx(2.078, abs=0.01)
    r = ag.et0_penman_monteith(tmax=21.5, tmin=12.3, rs=rs, u2=u2, lat=lat, elevation=elev, doy=doy, rh_max=84, rh_min=63)
    assert r.es == pytest.approx(1.997, abs=0.01)
    assert r.ea == pytest.approx(1.409, abs=0.01)
    assert r.rnl == pytest.approx(3.71, abs=0.05)
    assert r.rn == pytest.approx(13.28, abs=0.1)
    assert r.et0 == pytest.approx(3.9, abs=0.05)


def test_atmospheric_constants():
    assert ag.atmospheric_pressure(1800) == pytest.approx(81.8, abs=0.1)  # FAO-56 Example 2
    assert ag.psychrometric_constant(81.8) == pytest.approx(0.054, abs=0.001)
    assert ag.sat_vapour_pressure(25) == pytest.approx(3.168, abs=0.002)


def test_kc_curve_shape():
    crop = load_scenario().crops["cotton"]
    ini, dev, mid, late = crop.stages
    assert ag.kc_at(crop, 0) == crop.kc[0]
    assert ag.kc_at(crop, ini + dev / 2) == pytest.approx((crop.kc[0] + crop.kc[1]) / 2)
    assert ag.kc_at(crop, ini + dev + mid / 2) == crop.kc[1]
    assert ag.kc_at(crop, crop.season_days) == pytest.approx(crop.kc[2])
    assert ag.kc_at(crop, crop.season_days + 5) == 0.0
    assert ag.crop_stage(crop, crop.season_days + 1) == 4


def test_water_balance_conserves_and_drains():
    day = ag.water_balance_day(dr=40, taw=100, raw=50, etc=5, rain=0, et0=5, irrigation_net=0)
    assert day.dr_end == pytest.approx(45)
    assert day.ks == 1.0
    # heavy rain refills to field capacity and the rest drains
    day = ag.water_balance_day(dr=10, taw=100, raw=50, etc=4, rain=30, et0=4, irrigation_net=0)
    assert day.dr_end == 0
    # 30 mm rain, 1.75 mm runoff above the 25 mm threshold, 10 mm refills the root zone, 4 mm ET
    assert day.runoff == pytest.approx(1.75)
    assert day.deep_percolation == pytest.approx(30 - 1.75 - 10 - 4)
    # stress reduces actual ET
    day = ag.water_balance_day(dr=80, taw=100, raw=50, etc=6, rain=0, et0=6, irrigation_net=0)
    assert day.ks == pytest.approx(0.4)
    assert day.eta == pytest.approx(2.4)


def test_light_rain_is_not_effective():
    eff, ro = ag.effective_rain(0.5, 5.0)
    assert eff == 0 and ro == 0
    eff, ro = ag.effective_rain(40, 5.0)
    assert ro > 0 and math.isclose(eff + ro, 40)


def test_assess_farm_respects_rain_and_pump_capacity():
    sc = load_scenario()
    farm = sc.farm(7)
    crop, soil = sc.crops[farm.crop], sc.soils[farm.soil]
    taw = ag.total_available_water(soil, ag.root_depth(crop, farm.das))
    dry = ag.assess_farm(sc=sc, farm=farm, das=farm.das, dr_start=0.7 * taw, et0=5.0, rain_forecast_mm=0,
                         rain_prob=0, available_slot_count=48)
    assert dry.required_slots > 0
    assert dry.pump_hours <= 12 + 1e-9
    wet = ag.assess_farm(sc=sc, farm=farm, das=farm.das, dr_start=0.3 * taw, et0=5.0, rain_forecast_mm=40,
                         rain_prob=90, available_slot_count=48)
    assert wet.required_slots == 0


def test_hot_cells_derate_solar_output():
    """Same sun, hotter air: Faiman cell temperature and PVWatts derating cut the output."""
    from app.engine.solar import panel_output

    feeder = load_scenario().feeder
    poa, wind = 600.0, 1.0  # below the inverter limit, so the derating is not hidden by clipping
    tc25, dc25, ac25 = (float(v[0]) for v in panel_output([poa], [25.0], [wind], feeder))
    tc42, dc42, ac42 = (float(v[0]) for v in panel_output([poa], [42.0], [wind], feeder))
    assert tc42 - tc25 == pytest.approx(17.0)  # cell heating follows the air
    assert tc42 > 55  # Indian midday: cells far above the 25 C rating
    # DC falls by |gamma_pdc| per degree of cell temperature: 17 C x 0.37% = 6.3%
    assert dc42 / dc25 == pytest.approx((1 + feeder.gamma_pdc * (tc42 - 25)) / (1 + feeder.gamma_pdc * (tc25 - 25)), rel=1e-9)
    assert 0.92 < ac42 / ac25 < 0.95
    # At full sun on a hot day the cells run near 70 C and the array still stays within the inverter limit.
    tc, dc, ac = (float(v[0]) for v in panel_output([1000.0], [42.0], [1.0], feeder))
    assert 70 < tc < 76 and ac <= feeder.inverter_kw + 1e-9 and ac < feeder.pv_kwp * 0.86
