"""SunShift API server. Also serves the built frontend when ``frontend/dist`` exists,
so the whole product deploys as a single service."""

from __future__ import annotations

import logging
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import db, registry
from .api import LeaseGate, make_job_manager, router
from .engine.scenario import REPO_ROOT
from .ratelimit import RateLimiter, RateLimitMiddleware
from .settings import Settings

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sunshift")


def create_app(settings: Settings | None = None, static_dir: Path | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    static = (static_dir or Path(os.environ.get("SUNSHIFT_STATIC", REPO_ROOT / "frontend" / "dist"))).resolve()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db.on_ready(registry.seed_if_empty)
        log.info("database: %s", db.init_db())
        app.state.jobs = make_job_manager(settings)
        try:
            yield
        finally:
            app.state.jobs.shutdown()

    app = FastAPI(
        title="SunShift API",
        version="0.2.0",
        description="Feeder-level irrigation scheduling for solarised agricultural feeders: "
        "Open-Meteo weather, pvlib PV model, FAO-56 agronomy and OR-Tools CP-SAT optimisation.",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.season_gate = LeaseGate(settings.max_concurrent_seasons)

    app.add_middleware(GZipMiddleware, minimum_size=2048)
    if settings.allowed_origins:
        # Only needed when the site is hosted on another origin; same-origin needs no CORS.
        app.add_middleware(
            CORSMiddleware, allow_origins=settings.allowed_origins,
            allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["content-type", "x-api-key"],
        )
    app.add_middleware(
        RateLimitMiddleware,
        limiter=RateLimiter(settings.rate_compute, settings.rate_season, settings.rate_admin, settings.rate_read),
        enabled=settings.rate_limits_enabled,
    )

    @app.exception_handler(registry.NotFound)
    async def not_found(_: Request, exc: registry.NotFound) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(registry.Unavailable)
    async def unavailable(_: Request, exc: registry.Unavailable) -> JSONResponse:
        return JSONResponse({"detail": "The database is unavailable; registry changes cannot be made right now"},
                            status_code=503, headers={"Retry-After": "30"})

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception) -> JSONResponse:
        # Never send internals to the client; log them with a reference instead.
        ref = uuid.uuid4().hex[:8]
        log.exception("unhandled error on %s %s (ref %s)", request.method, request.url.path, ref)
        return JSONResponse({"detail": "Internal server error", "ref": ref}, status_code=500)

    app.include_router(router, prefix="/api")

    if (static / "index.html").is_file():
        from fastapi.staticfiles import StaticFiles

        if (static / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=static / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str) -> FileResponse:
            if full_path.startswith("api/"):
                raise HTTPException(status_code=404)
            candidate = (static / full_path).resolve()
            if full_path and candidate.is_file() and static in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(static / "index.html")

    return app


app = create_app()
