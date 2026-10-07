"""SunShift API server. Also serves the built frontend when ``frontend/dist`` exists,
so the whole product deploys as a single service."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .api import router
from .engine.scenario import REPO_ROOT

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(levelname)s %(name)s: %(message)s")

STATIC_DIR = Path(os.environ.get("SUNSHIFT_STATIC", REPO_ROOT / "frontend" / "dist")).resolve()


@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.getLogger("sunshift").info("database: %s", db.init_db())
    yield


app = FastAPI(
    title="SunShift API",
    version="0.1.0",
    description="Feeder-level irrigation scheduling for solarised agricultural feeders: "
    "Open-Meteo weather, pvlib PV model, FAO-56 agronomy and OR-Tools CP-SAT optimisation.",
    lifespan=lifespan,
)
app.add_middleware(GZipMiddleware, minimum_size=2048)
origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"])
app.include_router(router, prefix="/api")

if (STATIC_DIR / "index.html").is_file():
    if (STATIC_DIR / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = (STATIC_DIR / full_path).resolve()
        if full_path and candidate.is_file() and STATIC_DIR in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")
