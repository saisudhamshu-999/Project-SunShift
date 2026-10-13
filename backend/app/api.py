"""HTTP API. Request bodies use camelCase to match the TypeScript client.

Every CP-SAT solve runs as a job on the bounded solver pool (see jobs.py):
  POST /api/jobs      {kind, params} -> 202 + job; poll GET /api/jobs/{id}
  POST /api/plan etc. the same work, waited for in one request (kept for simple clients)
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

import ortools
import pvlib
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel
from starlette.concurrency import iterate_in_threadpool

from . import db, registry
from .engine import planner, season
from .engine.scenario import load_scenario
from .engine.weather import apply_mode
from .jobs import JobManager, Kind, QueueFull
from .ml import models as ml_models
from .security import require_api_key
from .settings import Settings

log = logging.getLogger("sunshift.api")
router = APIRouter()

CropKey = Literal["cotton", "maize", "groundnut", "chilli"]
MethodKey = Literal["drip", "sprinkler", "furrow"]
WeatherMode = Literal["live", "clear", "cloudy", "rain", "heatwave"]
Failure = Literal["weather_api", "solar_forecast", "internet", "pump_feedback", "capacity"]
DATE = r"^\d{4}-\d{2}-\d{2}$"


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class SolarEvent(_Model):
    from_slot: int = Field(ge=0, le=47)
    factor: float = Field(ge=0.0, le=1.5)


class PlanRequest(_Model):
    date: str | None = Field(default=None, pattern=DATE)
    feeder: str | None = Field(default=None, max_length=32)
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
    # Skip result reuse (an explicit "re-optimise"); identical in-flight requests still share a solve.
    fresh: bool = False

    def to_params(self, max_time_limit_s: float) -> planner.PlanParams:
        return planner.PlanParams(
            date=self.date, feeder=self.feeder, location=self.location, pv_kwp=self.pv_kwp,
            feeder_limit_kw=self.feeder_limit_kw, grid_backup_kw=self.grid_backup_kw, weather_mode=self.weather_mode,
            rain_mm=self.rain_mm, rain_prob=self.rain_prob, rain_start_hour=self.rain_start_hour,
            solar_event=self.solar_event.model_dump() if self.solar_event else None,
            demand_scale=self.demand_scale, crop_overrides=dict(self.crop_overrides),
            served_yesterday={k: max(0.0, min(1.0, v)) for k, v in self.served_yesterday.items()},
            fairness_weight=self.fairness_weight, mode=self.mode, fixed_until=self.fixed_until,
            executed={k: [s for s in v if 0 <= s < 48] for k, v in self.executed.items()},
            failure=self.failure, time_limit_s=min(self.time_limit_s, max_time_limit_s), persist=self.persist,
        )


class RainEventRequest(PlanRequest):
    forecast_slot: int = Field(default=20, ge=1, le=40)


class SeasonRequest(_Model):
    season: str = "rabi-2025"
    start: str | None = Field(default=None, pattern=DATE)
    days: int = Field(default=30, ge=1, le=120)
    location: str | None = None
    pv_kwp: float | None = Field(default=None, ge=10, le=600)
    feeder_limit_kw: float | None = Field(default=None, ge=10, le=400)
    grid_backup_kw: float | None = Field(default=None, ge=0, le=200)
    demand_scale: float = Field(default=1.0, ge=0.3, le=2.0)
    crop_overrides: dict[int, CropKey] = Field(default_factory=dict)
    seed: int = 2026
    bau_factor: float | None = Field(default=None, ge=0.6, le=2.0)


JobKind = Literal["plan", "sensitivity", "fairness", "rain-event"]
REQUEST_MODELS: dict[str, type[PlanRequest]] = {
    "plan": PlanRequest, "sensitivity": PlanRequest, "fairness": PlanRequest, "rain-event": RainEventRequest,
}


class JobRequest(_Model):
    kind: JobKind
    params: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------- registry models


def _check_soil(v: str | None) -> str | None:
    if v is not None and v not in load_scenario().soils:
        raise ValueError(f"unknown soil; choose one of {sorted(load_scenario().soils)}")
    return v


def _check_windows(v: list[tuple[float, float]] | None) -> list[tuple[float, float]] | None:
    if v is None:
        return v
    for a, b in v:
        if not (0 <= a < b <= 24):
            raise ValueError("availability windows are [start_hour, end_hour] with 0 <= start < end <= 24")
    return v


class PumpIn(_Model):
    hp: float | None = Field(default=None, gt=0, le=50)
    head_m: float | None = Field(default=None, ge=2, le=300)
    controller: Literal["advisory", "automatic"] | None = None
    measured_kw: float | None = Field(default=None, gt=0, le=60)
    measured_flow_m3h: float | None = Field(default=None, gt=0, le=500)


class FarmPatch(_Model):
    label: str | None = Field(default=None, max_length=60)
    crop: CropKey | None = None
    area_ha: float | None = Field(default=None, gt=0, le=50)
    soil: str | None = None
    method: MethodKey | None = None
    das: int | None = Field(default=None, ge=0, le=400)
    sowing_date: str | None = Field(default=None, pattern=DATE)
    available: list[tuple[float, float]] | None = Field(default=None, min_length=1, max_length=4)
    habit_start: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    dr0_frac: float | None = Field(default=None, ge=0, le=1)
    served_yesterday: float | None = Field(default=None, ge=0, le=1)
    last_irrigated_days: int | None = Field(default=None, ge=0, le=60)
    map_x: float | None = None
    map_y: float | None = None
    pump: PumpIn | None = None

    @field_validator("soil")
    @classmethod
    def check_soil(cls, v: str | None) -> str | None:
        return _check_soil(v)

    @field_validator("available")
    @classmethod
    def check_windows(cls, v: list[tuple[float, float]] | None) -> list[tuple[float, float]] | None:
        return _check_windows(v)


class FarmCreate(FarmPatch):
    crop: CropKey
    area_ha: float = Field(gt=0, le=50)
    soil: str
    method: MethodKey
    available: list[tuple[float, float]] = Field(min_length=1, max_length=4)
    habit_start: str = Field(default="07:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    dr0_frac: float = Field(default=0.5, ge=0, le=1)
    served_yesterday: float = Field(default=1.0, ge=0, le=1)
    last_irrigated_days: int = Field(default=2, ge=0, le=60)
    pump: PumpIn

    @model_validator(mode="after")
    def _complete(self) -> FarmCreate:
        if self.das is None and self.sowing_date is None:
            raise ValueError("give either das (days after sowing) or sowing_date")
        if self.pump.hp is None or self.pump.head_m is None:
            raise ValueError("a new farm's pump needs hp and headM")
        return self


class FeederPatch(_Model):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    location_id: str | None = None
    pv_kwp: float | None = Field(default=None, ge=1, le=5000)
    inverter_kw: float | None = Field(default=None, ge=1, le=5000)
    feeder_limit_kw: float | None = Field(default=None, ge=1, le=5000)
    grid_backup_kw: float | None = Field(default=None, ge=0, le=5000)

    @field_validator("location_id")
    @classmethod
    def _location(cls, v: str | None) -> str | None:
        if v is not None and v not in load_scenario().locations:
            raise ValueError(f"unknown location; choose one of {sorted(load_scenario().locations)}")
        return v


# ------------------------------------------------------------------- job wiring


class LeaseGate:
    """At most ``n`` holders at once. Leases expire, so a stream that is never started
    or never closed cannot block the gate for good."""

    def __init__(self, n: int, lease_s: float = 600.0):
        self.n, self.lease_s = n, lease_s
        self._leases: dict[str, float] = {}
        self._lock = threading.Lock()

    def acquire(self) -> str | None:
        now = time.monotonic()
        with self._lock:
            for token, t in list(self._leases.items()):
                if now - t > self.lease_s:
                    del self._leases[token]
            if len(self._leases) >= self.n:
                return None
            token = uuid.uuid4().hex
            self._leases[token] = now
            return token

    def release(self, token: str) -> None:
        with self._lock:
            self._leases.pop(token, None)



def make_job_manager(settings: Settings) -> JobManager:
    cap = settings.max_time_limit_s

    def runner(kind: str):
        model = REQUEST_MODELS[kind]

        def run(payload: dict[str, Any]) -> dict[str, Any]:
            req = model.model_validate(payload)
            params = req.to_params(cap)
            if kind == "plan":
                return planner.plan_day(params)
            if kind == "sensitivity":
                return planner.sensitivity(params)
            if kind == "fairness":
                return planner.fairness_study(params)
            return planner.rain_event_study(params, forecast_slot=req.forecast_slot)  # type: ignore[attr-defined]

        return run

    kinds = {
        "plan": Kind(runner("plan"), settings.plan_cache_s),
        "sensitivity": Kind(runner("sensitivity"), settings.study_cache_s),
        "fairness": Kind(runner("fairness"), settings.study_cache_s),
        "rain-event": Kind(runner("rain-event"), settings.study_cache_s),
    }
    return JobManager(
        kinds, settings.solver_workers, settings.max_queued_jobs,
        prune=lambda: db.prune(settings.runs_retention, settings.jobs_retention_h),
    )


def _jobs(request: Request) -> JobManager:
    return request.app.state.jobs


def _submit(request: Request, kind: str, req: PlanRequest) -> dict[str, Any]:
    if kind != "plan":
        req = req.model_copy(update={"persist": False})
    payload = req.model_dump(mode="json")
    # persist and fresh change side effects, not the answer; the plan date and the
    # registry version are part of the answer even when the request leaves them implicit.
    key_payload = {k: v for k, v in payload.items() if k not in ("persist", "fresh")}
    key_payload["time_limit_s"] = min(req.time_limit_s, request.app.state.settings.max_time_limit_s)
    if req.feeder:
        registry.scenario(req.feeder)  # 404 for an unknown feeder before anything is queued
    context = f"{req.date or planner.default_plan_date()}|{registry.version(req.feeder)}"
    try:
        return _jobs(request).submit(kind, payload, key_payload=key_payload, context=context, fresh=req.fresh)
    except QueueFull as full:
        raise HTTPException(
            status_code=429, detail="The solver is busy. Please retry shortly.",
            headers={"Retry-After": str(full.retry_after_s)},
        ) from None


async def _solve_and_wait(request: Request, kind: str, req: PlanRequest) -> dict[str, Any]:
    job = _submit(request, kind, req)
    if job["status"] not in ("done", "failed"):
        job = await _jobs(request).wait(job["id"], timeout_s=90) or job
    if job["status"] == "done":
        return job["result"]
    if job["status"] == "failed":
        raise HTTPException(status_code=500, detail=job["error"] or "The solver failed on this request")
    raise HTTPException(status_code=504, detail=f"Still solving; poll /api/jobs/{job['id']}")


# -------------------------------------------------------------------- endpoints


@router.get("/health")
def health(request: Request) -> dict:
    sc = registry.scenario()
    return {
        "status": "ok",
        "engine": "cp-sat",
        "ortools": ortools.__version__,
        "pvlib": pvlib.__version__,
        "db": db.status(),
        "registry": sc.registry,
        "ml": ml_models.status(),
        "jobs": _jobs(request).stats(),
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "defaultPlanDate": planner.default_plan_date(),
    }


@router.get("/ml")
def ml_card() -> dict:
    """How the ML weather corrections were trained, and how they did on the held-out year."""
    card = ml_models.card()
    if card is None:
        raise HTTPException(status_code=404, detail="no trained models on this server")
    return {**card, "loaded": ml_models.status()}


@router.get("/scenario")
def scenario(feeder: str | None = Query(default=None, max_length=32)) -> dict:
    sc = registry.scenario(feeder, planner.default_plan_date())
    raw = dict(sc.raw)
    raw["farms"] = [
        {**f, "pumpKw": round(sc.farm(f["id"]).pump_kw, 3), "flowM3h": round(sc.farm(f["id"]).flow_m3h, 3)}
        for f in sc.raw["farms"]
    ]
    return raw


@router.post("/jobs", status_code=202)
def submit_job(body: JobRequest, request: Request) -> JSONResponse:
    model = REQUEST_MODELS[body.kind]
    try:
        req = model.model_validate(body.params)
    except Exception as exc:  # pydantic.ValidationError: report the fields, as FastAPI would
        errors = getattr(exc, "errors", lambda: [])()
        raise HTTPException(status_code=422, detail=json.loads(json.dumps(errors, default=str))) from None
    job = _submit(request, body.kind, req)
    status = 200 if job["status"] in ("done", "failed") else 202
    return JSONResponse(job, status_code=status, headers={"Location": f"/api/jobs/{job['id']}"})


@router.get("/jobs/{job_id}")
def get_job(job_id: str, request: Request) -> dict:
    job = _jobs(request).get(job_id[:32])
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@router.post("/plan")
async def plan(req: PlanRequest, request: Request) -> dict:
    return await _solve_and_wait(request, "plan", req)


@router.post("/sensitivity")
async def sensitivity(req: PlanRequest, request: Request) -> dict:
    return await _solve_and_wait(request, "sensitivity", req)


@router.post("/fairness")
async def fairness(req: PlanRequest, request: Request) -> dict:
    return await _solve_and_wait(request, "fairness", req)


@router.post("/rain-event")
async def rain_event(req: RainEventRequest, request: Request) -> dict:
    return await _solve_and_wait(request, "rain-event", req)


@router.get("/weather")
def weather(
    location: str | None = None,
    date: str | None = Query(default=None, pattern=DATE),
    mode: WeatherMode = "live",
) -> dict:
    sc = registry.scenario()
    loc_id = location if location in sc.locations else sc.default_location
    day = date or planner.default_plan_date()
    dw, notes = planner._weather_for(day, sc, loc_id, planner.PlanParams())
    dw = apply_mode(dw, mode=mode, loc=sc.locations[loc_id], feeder=sc.feeder)
    out = dw.to_dict()
    out["notes"] = notes
    return out


@router.post("/season")
async def season_run(req: SeasonRequest, request: Request) -> StreamingResponse:
    gate: LeaseGate = request.app.state.season_gate
    lease = gate.acquire()
    if lease is None:
        raise HTTPException(status_code=429, detail="A season simulation is already running. Please retry shortly.",
                            headers={"Retry-After": "20"})
    params = season.SeasonParams(
        season=req.season, start=req.start, days=req.days, location=req.location, pv_kwp=req.pv_kwp,
        feeder_limit_kw=req.feeder_limit_kw, grid_backup_kw=req.grid_backup_kw, demand_scale=req.demand_scale,
        crop_overrides=dict(req.crop_overrides), seed=req.seed, bau_factor=req.bau_factor,
    )

    async def stream():
        summary = None
        try:
            async for event in iterate_in_threadpool(season.simulate(params)):
                if event.get("type") == "summary":
                    summary = event
                yield f"data: {json.dumps(event, separators=(',', ':'))}\n\n"
        except asyncio.CancelledError:  # the client went away
            raise
        except Exception:  # stream the failure instead of cutting the connection
            ref = uuid.uuid4().hex[:8]
            log.exception("season simulation failed (ref %s)", ref)
            yield f"data: {json.dumps({'type': 'error', 'message': f'The season simulation failed (ref {ref})'})}\n\n"
        finally:
            gate.release(lease)
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
    r = db.get_run(run_id[:32])
    if r is None:
        raise HTTPException(status_code=404, detail="run not found")
    return r


# --------------------------------------------------------------------- registry


@router.get("/feeders")
def feeders() -> list[dict]:
    return registry.list_feeders()


@router.get("/feeders/{feeder_id}")
def feeder(feeder_id: str, include_inactive: bool = Query(default=False, alias="includeInactive")) -> dict:
    return registry.get_feeder(feeder_id[:32], include_inactive=include_inactive)


@router.patch("/feeders/{feeder_id}", dependencies=[Depends(require_api_key)])
def update_feeder(feeder_id: str, body: FeederPatch) -> dict:
    return registry.update_feeder(feeder_id[:32], body.model_dump(exclude_unset=True))


@router.post("/feeders/{feeder_id}/farms", status_code=201, dependencies=[Depends(require_api_key)])
def create_farm(feeder_id: str, body: FarmCreate) -> dict:
    fields = body.model_dump(exclude={"pump"})
    fields["available"] = [list(w) for w in body.available]
    return registry.create_farm(feeder_id[:32], fields, body.pump.model_dump(exclude_none=True))


@router.get("/farms/{farm_id}")
def farm(farm_id: int) -> dict:
    return registry.get_farm(farm_id)


@router.patch("/farms/{farm_id}", dependencies=[Depends(require_api_key)])
def update_farm(farm_id: int, body: FarmPatch) -> dict:
    fields = body.model_dump(exclude_unset=True, exclude={"pump"})
    if "available" in fields and fields["available"] is not None:
        fields["available"] = [list(w) for w in fields["available"]]
    pump = body.pump.model_dump(exclude_unset=True) if body.pump is not None else {}
    return registry.update_farm(farm_id, fields, pump)


@router.delete("/farms/{farm_id}", dependencies=[Depends(require_api_key)])
def deactivate_farm(farm_id: int) -> dict:
    return registry.deactivate_farm(farm_id)
