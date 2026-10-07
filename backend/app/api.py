"""HTTP API. Request bodies use camelCase to match the TypeScript client."""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Literal

import ortools
import pvlib
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from . import db
from .engine import planner, season
from .engine.scenario import load_scenario
from .engine.weather import apply_mode

log = logging.getLogger("sunshift.api")
router = APIRouter()

CropKey = Literal["cotton", "maize", "groundnut", "chilli"]
WeatherMode = Literal["live", "clear", "cloudy", "rain", "heatwave"]
Failure = Literal["weather_api", "solar_forecast", "internet", "pump_feedback", "capacity"]


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class SolarEvent(_Model):
    from_slot: int = Field(ge=0, le=47)
    factor: float = Field(ge=0.0, le=1.5)


class PlanRequest(_Model):
    date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    location: str | None = None
    pv_kwp: float | None = Field(default=None, ge=10, le=600)
    feeder_limit_kw: float | None = Field(default=None, ge=10, le=400)
    grid_backup_kw: float | None = Field(default=None, ge=0, le=200)
    weather_mode: WeatherMode = "live"
    rain_mm: float = Field(default=18.0, ge=0, le=200)
    rain_prob: float = Field(default=85.0, ge=0, le=100)
    rain_start_hour: float = Field(default=13.0, ge=6, le=17.5)
    solar_event: SolarEvent | None = None
    demand_scale: float = Field(default=1.0, ge=0.3, le=2.0)
    crop_overrides: dict[int, CropKey] = Field(default_factory=dict)
    served_yesterday: dict[int, float] = Field(default_factory=dict)
    fairness_weight: float | None = Field(default=None, ge=0, le=5)
    mode: Literal["sunshift", "throughput"] = "sunshift"
    fixed_until: int = Field(default=0, ge=0, le=48)
    executed: dict[int, list[int]] = Field(default_factory=dict)
    failure: Failure | None = None
    time_limit_s: float = Field(default=3.0, ge=0.2, le=10)
    persist: bool = True

    def to_params(self) -> planner.PlanParams:
        return planner.PlanParams(
            date=self.date, location=self.location, pv_kwp=self.pv_kwp, feeder_limit_kw=self.feeder_limit_kw,
            grid_backup_kw=self.grid_backup_kw, weather_mode=self.weather_mode, rain_mm=self.rain_mm,
            rain_prob=self.rain_prob, rain_start_hour=self.rain_start_hour,
            solar_event=self.solar_event.model_dump() if self.solar_event else None,
            demand_scale=self.demand_scale, crop_overrides=dict(self.crop_overrides),
            served_yesterday={k: max(0.0, min(1.0, v)) for k, v in self.served_yesterday.items()},
            fairness_weight=self.fairness_weight, mode=self.mode, fixed_until=self.fixed_until,
            executed={k: [s for s in v if 0 <= s < 48] for k, v in self.executed.items()},
            failure=self.failure, time_limit_s=self.time_limit_s, persist=self.persist,
        )


class RainEventRequest(PlanRequest):
    forecast_slot: int = Field(default=20, ge=1, le=40)


class SeasonRequest(_Model):
    season: str = "rabi-2025"
    start: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    days: int = Field(default=30, ge=1, le=120)
    location: str | None = None
    pv_kwp: float | None = Field(default=None, ge=10, le=600)
    feeder_limit_kw: float | None = Field(default=None, ge=10, le=400)
    grid_backup_kw: float | None = Field(default=None, ge=0, le=200)
    demand_scale: float = Field(default=1.0, ge=0.3, le=2.0)
    crop_overrides: dict[int, CropKey] = Field(default_factory=dict)
    seed: int = 2026
    bau_factor: float | None = Field(default=None, ge=0.6, le=2.0)


_study_cache: dict[str, tuple[float, dict]] = {}
STUDY_TTL_S = 600


def _cached(kind: str, req: BaseModel, compute) -> dict:
    """Studies with identical inputs on the same plan date are identical for every visitor:
    keep them for 10 minutes so the story sections load instantly after the first view."""
    key = f"{kind}:{planner.default_plan_date()}:{req.model_dump_json()}"
    now = time.time()
    hit = _study_cache.get(key)
    if hit and now - hit[0] < STUDY_TTL_S:
        return hit[1]
    result = compute()
    if len(_study_cache) > 64:
        _study_cache.clear()
    _study_cache[key] = (now, result)
    return result


def _fail(exc: Exception) -> HTTPException:
    log.exception("request failed")
    return HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


@router.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "engine": "cp-sat",
        "ortools": ortools.__version__,
        "pvlib": pvlib.__version__,
        "db": db.status(),
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "defaultPlanDate": planner.default_plan_date(),
    }


@router.get("/scenario")
def scenario() -> dict:
    sc = load_scenario()
    raw = dict(sc.raw)
    raw["farms"] = [
        {**f, "pumpKw": round(sc.farm(f["id"]).pump_kw, 3), "flowM3h": round(sc.farm(f["id"]).flow_m3h, 3)}
        for f in sc.raw["farms"]
    ]
    return raw


@router.post("/plan")
def plan(req: PlanRequest) -> dict:
    try:
        return planner.plan_day(req.to_params())
    except Exception as exc:
        raise _fail(exc) from exc


@router.post("/sensitivity")
def sensitivity(req: PlanRequest) -> dict:
    try:
        return planner.sensitivity(req.to_params())
    except Exception as exc:
        raise _fail(exc) from exc


@router.post("/fairness")
def fairness(req: PlanRequest) -> dict:
    try:
        return _cached("fairness", req, lambda: planner.fairness_study(req.to_params()))
    except Exception as exc:
        raise _fail(exc) from exc


@router.post("/rain-event")
def rain_event(req: RainEventRequest) -> dict:
    try:
        return _cached("rain", req, lambda: planner.rain_event_study(req.to_params(), forecast_slot=req.forecast_slot))
    except Exception as exc:
        raise _fail(exc) from exc


@router.get("/weather")
def weather(
    location: str | None = None,
    date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    mode: WeatherMode = "live",
) -> dict:
    try:
        sc = load_scenario()
        loc_id = location if location in sc.locations else sc.default_location
        day = date or planner.default_plan_date()
        dw, notes = planner._weather_for(day, sc, loc_id, planner.PlanParams())
        dw = apply_mode(dw, mode=mode, loc=sc.locations[loc_id], feeder=sc.feeder)
        out = dw.to_dict()
        out["notes"] = notes
        return out
    except Exception as exc:
        raise _fail(exc) from exc


@router.post("/season")
def season_run(req: SeasonRequest) -> StreamingResponse:
    params = season.SeasonParams(
        season=req.season, start=req.start, days=req.days, location=req.location, pv_kwp=req.pv_kwp,
        feeder_limit_kw=req.feeder_limit_kw, grid_backup_kw=req.grid_backup_kw, demand_scale=req.demand_scale,
        crop_overrides=dict(req.crop_overrides), seed=req.seed,
        bau_factor=req.bau_factor,
    )

    def stream():
        summary = None
        try:
            for event in season.simulate(params):
                if event.get("type") == "summary":
                    summary = event
                yield f"data: {json.dumps(event, separators=(',', ':'))}\n\n"
        except Exception as exc:  # stream the failure instead of cutting the connection
            log.exception("season simulation failed")
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
        if summary:
            db.save_run(
                kind="season", plan_date=params.start or params.season, location=params.location or "default",
                engine="cp-sat", solve_seconds=summary.get("elapsedS", 0.0),
                params=req.model_dump(by_alias=True), summary={"sunshift": summary["sunshift"], "bau": summary["bau"]},
            )

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/runs")
def runs(limit: int = Query(default=20, ge=1, le=100)) -> list[dict]:
    return db.list_runs(limit)


@router.get("/runs/{run_id}")
def run(run_id: str) -> dict:
    r = db.get_run(run_id)
    if r is None:
        raise HTTPException(status_code=404, detail="run not found")
    return r
