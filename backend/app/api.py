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
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool

from . import db, messaging, registry
from .engine import planner, season
from .engine.scenario import load_scenario, window_label
from .engine.weather import apply_mode
from .jobs import JobManager, Kind, QueueFull, distributed_job_lock_async
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
    time_limit_s: float = Field(default=3.0, ge=0.2, le=30)  # clients are held to MAX_TIME_LIMIT_S
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
    phone: str | None = Field(default=None, pattern=r"^\+[1-9]\d{7,14}$", description="E.164, e.g. +919876543210")
    language: Literal["te", "hi", "en"] | None = None
    sms_opt_in: bool | None = None
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
    language: Literal["te", "hi", "en"] = "te"
    sms_opt_in: bool = False
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
    # Requests are capped when they are queued (_submit); this only bounds the server's own plans.
    cap = max(settings.max_time_limit_s, settings.background_time_limit_s)

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


def _submit(request: Request, kind: str, req: PlanRequest, *, time_cap: float | None = None) -> dict[str, Any]:
    """Queue a solve. Clients get at most MAX_TIME_LIMIT_S of solver time; the server's
    own plans (dispatch, re-plans) pass a larger ``time_cap``."""
    cap = request.app.state.settings.max_time_limit_s if time_cap is None else time_cap
    update: dict[str, Any] = {"time_limit_s": min(req.time_limit_s, cap)}
    if kind != "plan":
        update["persist"] = False
    req = req.model_copy(update=update)
    payload = req.model_dump(mode="json")
    # persist and fresh change side effects, not the answer; the plan date and the
    # registry version are part of the answer even when the request leaves them implicit.
    key_payload = {k: v for k, v in payload.items() if k not in ("persist", "fresh")}
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


async def _solve_and_wait(request: Request, kind: str, req: PlanRequest, *, time_cap: float | None = None) -> dict[str, Any]:
    job = _submit(request, kind, req, time_cap=time_cap)
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


# -------------------------------------------------------------------- messaging


class DispatchRequest(_Model):
    date: str | None = Field(default=None, pattern=DATE)
    feeder: str | None = Field(default=None, max_length=32)
    farms: list[int] | None = None  # only these farms (default: everyone opted in)
    dry_run: bool = False


@router.post("/dispatch", dependencies=[Depends(require_api_key)])
async def dispatch(body: DispatchRequest, request: Request) -> dict:
    """Plan the day and send every opted-in farmer their window. Schedule it each morning.

    One dispatch per feeder and day runs at a time across all workers, and farmers who
    already have this exact schedule are not messaged again."""
    day = body.date or planner.default_plan_date()
    feeder_id = body.feeder or registry.default_feeder_id()
    async with distributed_job_lock_async(f"dispatch:{feeder_id}:{day}") as got:
        if not got:
            raise HTTPException(status_code=409, detail="A dispatch for this feeder and day is already running")
        bg = request.app.state.settings.background_time_limit_s
        plan = await _solve_and_wait(request, "plan", PlanRequest(date=day, feeder=body.feeder, persist=True, time_limit_s=bg),
                                     time_cap=bg)
        return await run_in_threadpool(messaging.send_plan, plan, request.app.state.gateway,
                                       only=set(body.farms) if body.farms else None, dry_run=body.dry_run)


@router.get("/messages")
def messages(limit: int = Query(default=30, ge=1, le=200)) -> list[dict]:
    return messaging.recent_messages(limit)


def _reply_response(gateway: messaging.Gateway, action: str, text: str) -> Response:
    if gateway.name == "twilio":  # TwiML: Twilio sends the <Message> back to the farmer
        from xml.sax.saxutils import escape

        return Response(f'<?xml version="1.0" encoding="UTF-8"?><Response><Message>{escape(text)}</Message></Response>',
                        media_type="application/xml")
    return JSONResponse({"action": action, "reply": text})


def _planning_day() -> str:
    """The day farmers are replying about: tomorrow's after the evening dispatch, else today's."""
    days = [planner.default_plan_date(), planner.ist_now().date().isoformat()]
    return next((d for d in days if messaging.latest_dispatch(d)), days[0])


async def replan_day(app, day: str, reason: str) -> dict[str, Any] | None:
    """Re-plan the rest of ``day`` from what was last sent, then tell every farmer whose
    window moved. Serialised per feeder and day across workers, so two replies arriving
    together re-plan one after the other instead of racing."""
    feeder_id = registry.default_feeder_id()
    async with distributed_job_lock_async(f"replan:{feeder_id}:{day}", wait_s=120) as got:
        if not got:
            log.warning("re-plan for %s (%s) skipped: another re-plan held the lock for 2 minutes", day, reason)
            return None
        sent = messaging.latest_dispatch(day)
        before = dict(sent.schedule) if sent else {}
        sc = registry.scenario(None, day)
        now = planner._now_slot(day, sc) or 0
        executed = {int(k): [t for t in v if t < now] for k, v in before.items()}
        req = PlanRequest(date=day, fixed_until=now, executed=executed, persist=True, fresh=True,
                          time_limit_s=app.state.settings.background_time_limit_s)
        jobs: JobManager = app.state.jobs
        payload = req.model_dump(mode="json")
        job = jobs.submit("plan", payload, key_payload={k: v for k, v in payload.items() if k not in ("persist", "fresh")},
                          context=f"{day}|{registry.version(None)}", fresh=True)
        if job["status"] not in ("done", "failed"):
            job = await jobs.wait(job["id"], timeout_s=90) or job
        if job["status"] != "done":
            log.warning("re-plan (%s) did not finish: %s", reason, job.get("error"))
            return None
        plan = job["result"]
        out = await run_in_threadpool(messaging.send_plan, plan, app.state.gateway, reason=reason,
                                      updates_from=before if sent else None)
        moved = sorted(f["code"] for f in plan["farms"] if before.get(str(f["id"]), []) != f["schedule"]["slots"])
        return {"plan": plan, "sent": out, "before": before, "moved": moved}


async def _replan_in_background(app, day: str, reason: str) -> None:
    try:
        await replan_day(app, day, reason)
    except Exception:
        log.exception("re-plan (%s) failed", reason)


@router.post("/sms/inbound")
async def sms_inbound(request: Request, background: BackgroundTasks) -> Response:
    """Farmers' replies. Twilio posts here (signed); in simulated mode the API key is required."""
    from urllib.parse import parse_qs

    gateway = request.app.state.gateway
    settings = request.app.state.settings
    params = {k: v[0] for k, v in parse_qs((await request.body()).decode("utf-8", "replace")).items()}
    if isinstance(gateway, messaging.TwilioGateway):
        url = (settings.public_base_url.rstrip("/") + request.url.path) if settings.public_base_url else str(request.url)
        if not gateway.valid_signature(url, params, request.headers.get("X-Twilio-Signature")):
            raise HTTPException(status_code=403, detail="Invalid signature")
    else:
        require_api_key(request, request.headers.get("X-API-Key"))
    phone, text = params.get("From", "").strip(), params.get("Body", "")
    farm = registry.farm_by_phone(phone) if phone else None
    lang = farm.language if farm and farm.language in messaging.LANGS else "en"
    t = messaging.T[lang]
    messaging._record(direction="in", farm_id=farm.id if farm else None, phone=phone, language=lang, body=text,
                      result=None, provider=gateway.name)
    if farm is None:
        return _reply_response(gateway, "unknown-sender", "This number is not registered with SunShift.")
    day = _planning_day()
    sent = messaging.latest_dispatch(day)
    reply = messaging.parse_reply(text)
    if reply.kind == "confirm":
        slots = (sent.schedule if sent else {}).get(str(farm.id), [])
        window = window_label(slots, registry.scenario(None, day).feeder)
        return _reply_response(gateway, "confirmed", t["confirmed"].format(w=window) if window else t["notNeeded"])
    if reply.kind == "change":
        return _reply_response(gateway, "asked-time", t["changeAsk"])
    if reply.kind in ("time", "skip"):
        registry.set_override(farm.id, day, skip=reply.kind == "skip", earliest_hour=reply.hour)
        background.add_task(_replan_in_background, request.app, day, f"reply from F{farm.id:02d}")
        return _reply_response(gateway, "replanning" if reply.kind == "time" else "skipped",
                               t["replanning"] if reply.kind == "time" else t["skipped"])
    return _reply_response(gateway, "help", t["help"])


class FarmerCommand(_Model):
    farm_id: int = Field(ge=1)
    command: Literal["CONFIRM", "SKIP", "DELAY"]
    delay_slots: int | None = Field(default=None, ge=1, le=40, description="15-minute slots to push the window back")
    date: str | None = Field(default=None, pattern=DATE)

    @model_validator(mode="after")
    def _delay_needs_slots(self) -> "FarmerCommand":
        if self.command == "DELAY" and not self.delay_slots:
            raise ValueError("DELAY needs delaySlots")
        return self


@router.post("/messaging/webhook", dependencies=[Depends(require_api_key)])
async def farmer_command(body: FarmerCommand, request: Request) -> dict:
    """Structured farmer commands, for an IVR, a WhatsApp bot or a field officer's app.

    CONFIRM returns the farmer's window. SKIP frees the farm's slots for the day; DELAY
    pushes its window back by ``delaySlots``. Either re-plans the rest of the day, hands
    the freed solar capacity to the farms that need it most, messages every farmer whose
    window moved, and returns the new schedule."""
    farm = registry.get_farm(body.farm_id)
    if not farm["active"]:
        raise HTTPException(status_code=409, detail=f"Farm {farm['code']} is not active")
    day = body.date or _planning_day()
    sc = registry.scenario(None, day)
    sent = messaging.latest_dispatch(day)
    if sent is not None:
        baseline = dict(sent.schedule)
    else:  # nothing sent yet: the current plan is the baseline
        bg = request.app.state.settings.background_time_limit_s  # the same plan a dispatch would send
        plan = await _solve_and_wait(request, "plan", PlanRequest(date=day, persist=False, time_limit_s=bg), time_cap=bg)
        baseline = {str(f["id"]): f["schedule"]["slots"] for f in plan["farms"]}
    current = baseline.get(str(body.farm_id), [])
    messaging._record(direction="in", farm_id=body.farm_id, phone="", language=farm["language"] or "te",
                      body=body.command + (f" {body.delay_slots}" if body.delay_slots else ""), result=None, provider="api")
    if body.command == "CONFIRM":
        return {"action": "confirmed", "farm": farm["code"], "date": day, "window": window_label(current, sc.feeder)}
    if body.command == "SKIP":
        registry.set_override(body.farm_id, day, skip=True, source="api")
    else:
        if not current:
            raise HTTPException(status_code=409, detail=f"{farm['code']} has no pumping on {day} to delay")
        start = min(current) + int(body.delay_slots or 0)
        if start + sc.feeder.min_run_slots > sc.feeder.slots:
            raise HTTPException(status_code=409, detail="That delay runs past the end of the solar day")
        earliest = sc.feeder.day_start_hour + start * sc.feeder.slot_hours
        registry.set_override(body.farm_id, day, skip=False, earliest_hour=earliest, source="api")
    out = await replan_day(request.app, day, reason=f"{body.command.lower()} from {farm['code']}")
    if out is None:
        raise HTTPException(status_code=503, detail="The re-plan did not finish; the change is saved and applies to the next plan",
                            headers={"Retry-After": "30"})
    new_plan = out["plan"]
    mine = next((f for f in new_plan["farms"] if f["id"] == body.farm_id), None)
    gained = {
        f["code"]: len(f["schedule"]["slots"]) - len(baseline.get(str(f["id"]), []))
        for f in new_plan["farms"]
        if f["id"] != body.farm_id and len(f["schedule"]["slots"]) > len(baseline.get(str(f["id"]), []))
    }
    return {
        "action": "skipped" if body.command == "SKIP" else "delayed",
        "farm": farm["code"], "date": day,
        "previousWindow": window_label(current, sc.feeder),
        "window": mine["schedule"]["window"] if mine else "",
        "movedFarms": [c for c in out["moved"] if c != farm["code"]],
        "slotsGainedByOthers": gained,
        "messages": out["sent"]["counts"],
        "solver": new_plan["sunshift"]["solver"]["status"],
    }
