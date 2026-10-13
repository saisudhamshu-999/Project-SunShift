"""Train, evaluate and backtest the ML weather corrections.

    python -m app.ml.train                 # fetch data (cached), train, evaluate, write artifacts
    python -m app.ml.train --backtest-every 9

Method
- Data: Open-Meteo day-ahead forecasts (``*_previous_day1``) and ERA5 reanalysis for the
  four scenario locations, from 2024-01-20 (start of the forecast archive) to END.
- Split by time: everything before TEST_START trains; the final 12 months are held out
  and used only for the reported numbers.
- Solar: gradient-boosted quantile regression of the clear-sky index (P10, P50). The
  cautious P10 is widened by a one-sided conformal offset estimated out-of-fold on
  contiguous three-month blocks, so the calibration reflects out-of-sample error.
- Rain: logistic regression for P(rain over the 30-hour look-ahead >= policy minimum).
- Backtest: on held-out days, plan with the raw forecast and with the ML curves, then
  replay both schedules against the solar that actually arrived (ERA5).
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import replace
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LogisticRegression

from ..engine import planner
from ..engine.optimiser import solve
from ..engine.scenario import load_scenario
from ..engine.solar import ac_from_ghi
from ..engine.weather import climatology_day, slot_mid_hours
from . import data
from . import features as F
from . import models as ml_models

START, TEST_START, END = "2024-01-20", "2025-10-01", "2026-09-30"
VERSION = "2026.10"
SOLAR_PARAMS = dict(max_iter=300, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=50, l2_regularization=1.0, random_state=0)


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ------------------------------------------------------------------- datasets


def build_datasets(sc) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, pd.DataFrame]]:
    solar_rows, rain_rows, hourly = [], [], {}
    for loc in sc.locations.values():
        df = data.complete_days(data.hourly_frame(loc, START, END))
        hourly[loc.id] = df
        mid = df.index - pd.Timedelta(minutes=30)  # hour-ending means, centred on the half hour
        cs0 = F.clear_sky(loc, mid)["ghi"].to_numpy()
        day = pd.Series(df.index.date.astype(str))
        cloud_day = pd.Series(np.where(cs0 >= F.DAYLIGHT_CS, df.fc_cloud.to_numpy(), np.nan)).groupby(day).transform("mean").to_numpy()
        X, cs = F.solar_features(mid, df.fc_ghi, df.fc_cloud, df.fc_precip, cloud_day, loc)
        X = X.assign(obs_ghi=df.obs_ghi.to_numpy(), cs=cs, date=day.to_numpy(), loc=loc.id)
        solar_rows.append(X[cs >= F.DAYLIGHT_CS])
        for _, w in data.rain_windows(df, int(sc.policy.rain_lookahead_h), sc.feeder.day_start_hour).iterrows():
            f = F.rain_features(w.fc_precip, w.fc_cloud, w.day, loc.lat)
            rain_rows.append({**f, "day": w.day, "loc": loc.id, "obs_sum": w.obs_sum})
    solar = pd.concat(solar_rows, ignore_index=True)
    solar["k_obs"] = np.clip(solar.obs_ghi / np.maximum(solar.cs, 1.0), 0, F.K_MAX)
    rain = pd.DataFrame(rain_rows)
    rain["y"] = (rain.obs_sum >= sc.policy.rain_min_mm).astype(int)
    return solar, rain, hourly


def three_month_folds(dates: pd.Series) -> np.ndarray:
    months = dates.str[:7]
    order = {m: i // 3 for i, m in enumerate(sorted(months.unique()))}
    return months.map(order).to_numpy()


# ---------------------------------------------------------------------- solar


def _fit_quantile(X, y, q):
    return HistGradientBoostingRegressor(loss="quantile", quantile=q, **SOLAR_PARAMS).fit(X, y)


def train_solar(D: pd.DataFrame) -> tuple[dict, dict]:
    cols = F.SOLAR_FEATURES
    train = (D.date < TEST_START).to_numpy()
    test = ~train
    T = D[train].reset_index(drop=True)
    folds = three_month_folds(T.date)
    oof10 = np.zeros(len(T))
    for f in np.unique(folds):
        m = folds != f
        oof10[~m] = _fit_quantile(T.loc[m, cols], T.loc[m, "k_obs"], 0.1).predict(T.loc[~m, cols])
    q_lo = float(np.quantile(oof10 - T.k_obs.to_numpy(), 0.9))  # one-sided: P(y < P10 - q_lo) = 10%
    p10 = _fit_quantile(T[cols], T.k_obs, 0.1)
    p50 = _fit_quantile(T[cols], T.k_obs, 0.5)
    art = {"version": f"solar-{VERSION}", "sklearn": sklearn.__version__, "features": cols, "p10": p10, "p50": p50, "q_lo": q_lo}

    E = D[test]
    cs, y, raw = E.cs.to_numpy(), E.obs_ghi.to_numpy(), E.fc_ghi.to_numpy()
    k50 = np.clip(p50.predict(E[cols]), 0, F.K_MAX)
    k10 = np.minimum(np.clip(p10.predict(E[cols]) - q_lo, 0, None), k50)
    g50, g10 = k50 * cs, k10 * cs
    mae = lambda a: float(np.mean(np.abs(a - y)))  # noqa: E731
    rmse = lambda a: float(np.sqrt(np.mean((a - y) ** 2)))  # noqa: E731
    daily = pd.DataFrame({"k": E["loc"].to_numpy() + E.date.to_numpy(), "raw": raw, "p50": g50, "y": y}).groupby("k").sum() / 1000
    per_loc = {}
    for loc in sorted(E["loc"].unique()):
        m = (E["loc"] == loc).to_numpy()
        per_loc[loc] = {"rmseRaw": round(float(np.sqrt(np.mean((raw[m] - y[m]) ** 2))), 1),
                        "rmseLikely": round(float(np.sqrt(np.mean((g50[m] - y[m]) ** 2))), 1)}
    metrics = {
        "hours": int(len(E)),
        "hourlyMaeRaw": round(mae(raw), 1), "hourlyMaeLikely": round(mae(g50), 1),
        "hourlyRmseRaw": round(rmse(raw), 1), "hourlyRmseLikely": round(rmse(g50), 1),
        "biasRaw": round(float(np.mean(raw - y)), 1), "biasLikely": round(float(np.mean(g50 - y)), 1),
        "dailyEnergyMaeRaw": round(float(np.mean(np.abs(daily.raw - daily.y))), 3),
        "dailyEnergyMaeLikely": round(float(np.mean(np.abs(daily.p50 - daily.y))), 3),
        "belowCautious": round(float(np.mean(y < g10)), 3),
        "belowCautiousBy25": round(float(np.mean(y < g10 - 25)), 3),
        "cautiousTarget": 0.10,
        "conformalOffset": round(q_lo, 4),
        "perLocation": per_loc,
        "units": "W/m2 (hourly, daylight hours); daily energy in kWh/m2",
    }
    return art, metrics


# ----------------------------------------------------------------------- rain


def train_rain(R: pd.DataFrame, sc) -> tuple[dict, dict]:
    train = (R.day < TEST_START).to_numpy()
    test = ~train
    model = LogisticRegression(C=1.0, max_iter=2000).fit(F.rain_matrix(R[train]), R.y[train])
    art = {"version": f"rain-{VERSION}", "sklearn": sklearn.__version__, "features": F.RAIN_FEATURES, "model": model,
           "target": f"rain >= {sc.policy.rain_min_mm} mm in the next {sc.policy.rain_lookahead_h:.0f} h"}

    E = R[test]
    y = E.y.to_numpy().astype(float)
    p_ml = model.predict_proba(F.rain_matrix(E))[:, 1]
    p_det = (E.fc_sum >= sc.policy.rain_min_mm).astype(float).to_numpy()
    clim = R[train].assign(mm=R.day.str[5:7]).groupby(["loc", "mm"]).y.mean()
    p_clim = np.array([clim.get((loc, d[5:7]), R.y[train].mean()) for loc, d in zip(E["loc"], E.day)])
    thr = sc.policy.rain_defer_prob / 100

    def scores(p):
        pc = np.clip(p, 1e-4, 1 - 1e-4)
        bins = np.minimum((p * 10).astype(int), 9)
        ece = sum(abs(p[bins == b].mean() - y[bins == b].mean()) * (bins == b).mean() for b in range(10) if (bins == b).any())
        d = p >= thr
        return {"brier": round(float(np.mean((p - y) ** 2)), 4),
                "logLoss": round(float(-np.mean(y * np.log(pc) + (1 - y) * np.log(1 - pc))), 3),
                "calibrationError": round(float(ece), 3),
                "deferrals": int(d.sum()), "wrongDeferrals": int(np.sum(d & (y == 0))), "missedRain": int(np.sum(~d & (y == 1)))}

    metrics = {
        "days": int(len(E)), "rainDayRate": round(float(y.mean()), 3),
        "trainRainDayRate": round(float(R.y[train].mean()), 3), "threshold": thr,
        "calibrated": scores(p_ml), "forecastYesNo": scores(p_det), "climatology": scores(p_clim),
        "reliability": [
            {"predicted": round(float(p_ml[(p_ml >= lo) & (p_ml < lo + 0.2)].mean()), 3),
             "observed": round(float(y[(p_ml >= lo) & (p_ml < lo + 0.2)].mean()), 3),
             "days": int(((p_ml >= lo) & (p_ml < lo + 0.2)).sum())}
            for lo in (0.0, 0.2, 0.4, 0.6, 0.8) if ((p_ml >= lo) & (p_ml < lo + 0.2)).any()
        ],
    }
    return art, metrics


# -------------------------------------------------------------------- backtest


def _slots(values: np.ndarray, mids: np.ndarray, kind: str) -> np.ndarray:
    hours = np.arange(24, dtype=float)
    if kind == "mean":  # hour-ending means, as the weather module treats them
        return np.interp(mids, hours - 0.5, values)
    return np.interp(mids, hours, values)


def backtest(sc, hourly: dict[str, pd.DataFrame], every: int, time_limit: float) -> dict:
    """Plan held-out days with the raw forecast and with the ML curves; replay both against ERA5."""
    feeder = sc.feeder
    h = feeder.slot_hours
    mids = slot_mid_hours(feeder)
    totals = {k: {"gridKwh": 0.0, "shortfallKwh": 0.0, "waterM3": 0.0, "plannedWaterM3": 0.0, "loadAboveActualKwh": 0.0}
              for k in ("raw", "ml")}
    n_days = 0
    for loc in sc.locations.values():
        df = hourly[loc.id]
        days = sorted(d for d in set(df.index.date.astype(str)) if d >= TEST_START)[::every]
        for day in days:
            hd = df[df.index.date.astype(str) == day]
            if len(hd) != 24:
                continue
            clim = climatology_day(day, loc, feeder)  # typical demand for the date; solar is replaced below
            fc = replace(
                clim, source="live", ghi=np.clip(_slots(hd.fc_ghi.to_numpy(), mids, "mean"), 0, None),
                cloud=_slots(hd.fc_cloud.to_numpy(), mids, "point"),
                precip=hd.fc_precip.to_numpy()[np.clip(np.ceil(mids).astype(int), 0, 23)] * h,
            )
            curves = ml_models.solar_curves(fc, loc, feeder)
            if curves is None:
                raise RuntimeError("solar model not loaded")
            obs = np.clip(_slots(hd.obs_ghi.to_numpy(), mids, "mean"), 0, None)
            ac = {k: ac_from_ghi(day, loc, feeder, g, clim.temp, clim.wind10)
                  for k, g in (("raw", fc.ghi), ("p50", curves[0]), ("p10", curves[1]), ("obs", obs))}
            params = planner.PlanParams(date=day, location=loc.id, persist=False, time_limit_s=time_limit)
            ctx = planner.build_context(params, weather=clim)
            base = planner._problem(ctx)
            base.workers = 8
            plans = {
                "raw": solve(replace(base, solar_kw=list(ac["raw"]), solar_low_kw=None)),
                "ml": solve(replace(base, solar_kw=list(ac["p50"]), solar_low_kw=list(ac["p10"]))),
            }
            power = {j.farm_id: j.power_kw for j in base.jobs}
            flow = {j.farm_id: j.flow_m3h for j in base.jobs}
            for k, sol in plans.items():
                load = np.zeros(feeder.slots)
                for fid, slots in sol.on.items():
                    load[slots] += power[fid]
                supply = ac["obs"] + feeder.grid_backup_kw
                frac = np.where(load > supply, supply / np.maximum(load, 1e-9), 1.0)  # protection curtails pumps
                t = totals[k]
                t["gridKwh"] += float(np.minimum(feeder.grid_backup_kw, np.clip(load - ac["obs"], 0, None)).sum() * h)
                t["shortfallKwh"] += float(np.clip(load - supply, 0, None).sum() * h)
                t["loadAboveActualKwh"] += float(np.clip(load - ac["obs"], 0, None).sum() * h)
                t["plannedWaterM3"] += sum(flow[f] * h * len(s) for f, s in sol.on.items())
                t["waterM3"] += sum(flow[f] * h * float(frac[s].sum()) for f, s in sol.on.items())
            n_days += 1
        log(f"backtest: {loc.id} done ({n_days} days so far)")
    per_day = {k: {m: round(v / max(1, n_days), 2) for m, v in t.items()} for k, t in totals.items()}
    for k in per_day:
        per_day[k]["gridKwhPer100M3"] = round(100 * totals[k]["gridKwh"] / max(1e-9, totals[k]["waterM3"]), 2)
    return {"days": n_days, "timeLimitS": time_limit, "perDay": per_day,
            "note": "Demand from climatology for each date; solar from the archived day-ahead forecast (raw) or the "
                    "ML curves (ml); both schedules replayed against ERA5 solar with the feeder's grid backup."}


# ------------------------------------------------------------------------ main


def main() -> None:
    ap = argparse.ArgumentParser(description="Train the SunShift ML weather corrections")
    ap.add_argument("--backtest-every", type=int, default=9, help="backtest every Nth held-out day (0 = skip)")
    ap.add_argument("--time-limit", type=float, default=1.0, help="solver seconds per backtest plan")
    args = ap.parse_args()
    sc = load_scenario()
    log("loading data")
    solar, rain, hourly = build_datasets(sc)
    log(f"solar rows {len(solar)}, rain days {len(rain)}")
    solar_art, solar_metrics = train_solar(solar)
    log(f"solar: {json.dumps({k: v for k, v in solar_metrics.items() if k != 'perLocation'})}")
    rain_art, rain_metrics = train_rain(rain, sc)
    log(f"rain: calibrated {rain_metrics['calibrated']} | yes/no {rain_metrics['forecastYesNo']}")

    ml_models.ARTIFACTS.mkdir(parents=True, exist_ok=True)
    joblib.dump(solar_art, ml_models.ARTIFACTS / "solar.joblib", compress=3)
    joblib.dump(rain_art, ml_models.ARTIFACTS / "rain.joblib", compress=3)
    ml_models._load.cache_clear()

    # A sample of the held-out year, so tests can re-check the shipped models offline.
    rng = np.random.default_rng(0)
    st = solar[solar.date >= TEST_START]
    st = st.iloc[np.sort(rng.choice(len(st), size=min(4000, len(st)), replace=False))]
    rt = rain[rain.day >= TEST_START]
    np.savez_compressed(
        ml_models.ARTIFACTS / "holdout.npz",
        solar_X=st[F.SOLAR_FEATURES].to_numpy(np.float32), solar_cs=st.cs.to_numpy(np.float32),
        solar_obs=st.obs_ghi.to_numpy(np.float32), solar_raw=st.fc_ghi.to_numpy(np.float32),
        rain_X=rt[F.RAIN_FEATURES].to_numpy(np.float32), rain_y=rt.y.to_numpy(np.int8),
    )

    bt = None
    if args.backtest_every > 0:
        log("backtest")
        bt = backtest(sc, hourly, args.backtest_every, args.time_limit)
        log(f"backtest: {json.dumps(bt['perDay'])}")
    card = {
        "version": VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data": {
            "forecast": "Open-Meteo Previous Runs API, day-ahead (previous_day1) best-match forecast",
            "observed": "ERA5 reanalysis (Open-Meteo Historical Weather API): a model reconstruction, not station measurements",
            "locations": sorted(sc.locations), "train": [START, TEST_START], "test": [TEST_START, END],
        },
        "solar": solar_metrics, "rain": rain_metrics, "backtest": bt,
        "limitations": [
            "Trained on 20 months; forecast errors differ between years, so the cautious curve is somewhat optimistic "
            "on the held-out year (see belowCautious against its 10% target).",
            "An upper (P90) band was tested and is not shipped: it was badly under-calibrated on the held-out year.",
            f"Rain fell on {rain_metrics['rainDayRate']:.0%} of held-out days against {rain_metrics['trainRainDayRate']:.0%} in "
            "training; in that drier year the rain model's mid-range probabilities were too high (see the "
            "reliability table), although it still beat the forecast's yes/no on every score.",
            "Day-ahead forecasts (24 h+ lead) are used for training; same-day plans use fresher forecasts, so the "
            "corrections are, if anything, conservative for them.",
            "ERA5 is the reference for 'what happened'; it has its own errors against ground stations.",
        ],
    }
    (ml_models.ARTIFACTS / "model_card.json").write_text(json.dumps(card, indent=1) + "\n", encoding="utf-8", newline="\n")
    log("wrote artifacts")


if __name__ == "__main__":
    main()
