"""HTTP-level tests: jobs, limits, the registry, security and error handling.

Every test runs twice, on SQLite and on PostgreSQL (see conftest.py). Plans use a date
beyond the forecast horizon, so weather comes from climatology and no network is used.
"""

from __future__ import annotations

import threading
from datetime import timedelta

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text

from app import db
from app.engine import planner
from app.jobs import Kind

from .conftest import wait_for_job

DAY = (planner.ist_now().date() + timedelta(days=10)).isoformat()


def plan_params(**extra):
    return {"date": DAY, "timeLimitS": 1.0, "persist": False, **extra}


def solve(client, kind="plan", **extra) -> dict:
    r = client.post("/api/jobs", json={"kind": kind, "params": plan_params(**extra)})
    assert r.status_code in (200, 202), r.text
    return wait_for_job(client, r.json())


def blocking_kind():
    """A job kind that holds its worker until released, for queue and limit tests."""
    release = threading.Event()

    def run(payload):
        release.wait(30)
        return {"ok": True}

    return Kind(run=run, cache_s=0), release


# ---------------------------------------------------------------- basics


def test_health_reports_database_registry_and_queue(make_client, database):
    with make_client() as c:
        h = c.get("/api/health").json()
    assert h["db"] == database
    assert h["registry"] == "database"
    assert h["jobs"]["workers"] == 2 and h["jobs"]["running"] == 0


def test_registry_is_seeded_from_the_scenario_file(make_client):
    with make_client() as c:
        feeders = c.get("/api/feeders").json()
        detail = c.get(f"/api/feeders/{feeders[0]['id']}").json()
    assert len(feeders) == 1 and feeders[0]["simulated"] is True
    assert len(detail["farms"]) == 20
    assert {f["pump"]["controller"] for f in detail["farms"]} == {"advisory"}


def test_job_lifecycle_and_result_reuse(make_client):
    with make_client() as c:
        first = solve(c)
        assert first["status"] == "done" and first["cached"] is False
        plan = first["result"]
        assert plan["meta"]["engine"] == "cp-sat"
        assert plan["meta"]["sources"]["registry"] == "database"
        assert max(plan["sunshift"]["loadKw"]) <= plan["feeder"]["limitKw"] + 1e-6

        # The same request again is answered from the finished job, without a new solve.
        r = c.post("/api/jobs", json={"kind": "plan", "params": plan_params()})
        assert r.status_code == 200
        again = r.json()
        assert again["cached"] is True and again["id"] == first["id"]

        # "fresh" forces a new solve.
        fresh = solve(c, fresh=True)
        assert fresh["id"] != first["id"] and fresh["cached"] is False
        assert c.get("/api/health").json()["jobs"]["completed"] == 2


def test_synchronous_endpoints_still_work(make_client):
    with make_client() as c:
        r = c.post("/api/plan", json=plan_params())
        assert r.status_code == 200
        assert len(r.json()["farms"]) == 20
        r = c.post("/api/rain-event", json=plan_params(forecastSlot=20))
        assert r.status_code == 200 and "cancelled" in r.text


def test_unknown_job_and_feeder_are_404(make_client):
    with make_client() as c:
        assert c.get("/api/jobs/doesnotexist").status_code == 404
        assert c.post("/api/jobs", json={"kind": "plan", "params": plan_params(feeder="NOPE")}).status_code == 404
        assert c.get("/api/feeders/NOPE").status_code == 404


def test_invalid_job_params_are_422(make_client):
    with make_client() as c:
        r = c.post("/api/jobs", json={"kind": "plan", "params": {"timeLimitS": 99}})
        assert r.status_code == 422
        assert c.post("/api/jobs", json={"kind": "nonsense", "params": {}}).status_code == 422


def test_time_limit_is_capped_by_the_server(make_client):
    with make_client(max_time_limit_s=0.5) as c:
        plan = solve(c, timeLimitS=10)["result"]
    assert plan["sunshift"]["solver"]["timeLimitS"] <= 0.5


# ------------------------------------------------------------ protection


def test_full_queue_is_refused_with_retry_after(make_client):
    with make_client(solver_workers=1, max_queued_jobs=0) as c:
        kind, release = blocking_kind()
        c.app.state.jobs.kinds["plan"] = kind
        try:
            first = c.post("/api/jobs", json={"kind": "plan", "params": plan_params(demandScale=1.1)})
            assert first.status_code == 202
            second = c.post("/api/jobs", json={"kind": "plan", "params": plan_params(demandScale=1.2)})
            assert second.status_code == 429
            assert int(second.headers["retry-after"]) >= 1
            # An identical request joins the running job instead of being refused.
            joined = c.post("/api/jobs", json={"kind": "plan", "params": plan_params(demandScale=1.1)})
            assert joined.json()["id"] == first.json()["id"]
        finally:
            release.set()
        assert wait_for_job(c, first.json())["status"] == "done"


def test_rate_limit_returns_429(make_client):
    with make_client(rate_limits_enabled=True, rate_compute=(1.0, 2)) as c:
        kind, release = blocking_kind()
        c.app.state.jobs.kinds["plan"] = kind
        try:
            codes = [c.post("/api/jobs", json={"kind": "plan", "params": plan_params(demandScale=1 + i / 10)}).status_code
                     for i in range(3)]
            assert codes[:2] != [429, 429] and codes[2] == 429
            # Reads are limited separately, so polling keeps working.
            assert c.get("/api/health").status_code == 200
        finally:
            release.set()


def test_only_one_season_simulation_at_a_time(make_client):
    with make_client() as c:
        lease = c.app.state.season_gate.acquire()
        try:
            r = c.post("/api/season", json={"days": 1})
            assert r.status_code == 429 and r.headers["retry-after"]
        finally:
            c.app.state.season_gate.release(lease)


def test_registry_writes_need_a_configured_key(make_client):
    patch = {"crop": "maize"}
    with make_client() as c:
        r = c.patch("/api/farms/7", json=patch)
        assert r.status_code == 403  # no key configured: writes are off
    with make_client(api_key="s3cret-key") as c:
        assert c.patch("/api/farms/7", json=patch).status_code == 401
        assert c.patch("/api/farms/7", json=patch, headers={"X-API-Key": "wrong"}).status_code == 401
        r = c.patch("/api/farms/7", json=patch, headers={"X-API-Key": "s3cret-key"})
        assert r.status_code == 200 and r.json()["crop"] == "maize"


def test_errors_never_leak_internals(make_client, monkeypatch):
    def boom(params):
        raise RuntimeError("secret internal detail")

    monkeypatch.setattr(planner, "plan_day", boom)
    with make_client() as c:
        r = c.post("/api/plan", json=plan_params())
        assert r.status_code == 500
        assert "secret" not in r.text and "ref" in r.text
        job = solve(c, demandScale=1.3)
        assert job["status"] == "failed" and "secret" not in job["error"]


def test_cors_is_closed_unless_configured(make_client):
    origin = {"Origin": "https://elsewhere.example"}
    with make_client() as c:
        assert "access-control-allow-origin" not in c.get("/api/health", headers=origin).headers
    with make_client(allowed_origins=["https://elsewhere.example"]) as c:
        assert c.get("/api/health", headers=origin).headers["access-control-allow-origin"] == "https://elsewhere.example"


# --------------------------------------------------------------- registry


KEY = {"X-API-Key": "k"}


def test_registry_changes_reach_the_planner(make_client):
    with make_client(api_key="k") as c:
        before = solve(c)["result"]
        f7 = next(f for f in before["farms"] if f["id"] == 7)
        new_crop = "groundnut" if f7["crop"] != "groundnut" else "maize"
        r = c.patch("/api/farms/7", json={"crop": new_crop, "pump": {"hp": 7.5}}, headers=KEY)
        assert r.status_code == 200 and r.json()["pump"]["hp"] == 7.5
        # The registry version is part of the job key, so this is a new solve, not a cached one.
        after_job = solve(c)
        assert after_job["cached"] is False
        f7_after = next(f for f in after_job["result"]["farms"] if f["id"] == 7)
        assert f7_after["crop"] == new_crop


def test_add_and_deactivate_a_farm(make_client):
    new_farm = {
        "crop": "chilli", "areaHa": 1.2, "soil": "black_clay", "method": "drip", "sowingDate": DAY[:8] + "01",
        "available": [[6, 12], [14, 18]], "pump": {"hp": 5, "headM": 40},
    }
    with make_client(api_key="k") as c:
        r = c.post("/api/feeders/F07/farms", json=new_farm, headers=KEY)
        assert r.status_code == 201, r.text
        farm = r.json()
        assert farm["id"] == 21 and farm["simulated"] is False
        plan = solve(c)["result"]
        assert len(plan["farms"]) == 21
        assert plan["meta"]["sources"]["farms"] == "registry"  # no longer all demo data
        assert c.delete(f"/api/farms/{farm['id']}", headers=KEY).json()["active"] is False
        assert len(solve(c)["result"]["farms"]) == 20
        assert len(c.get("/api/feeders/F07?includeInactive=true").json()["farms"]) == 21


@pytest.mark.parametrize("bad", [
    {"soil": "moon_dust"},
    {"available": [[12, 8]]},
    {"das": None, "sowingDate": None},
    {"pump": {"hp": 5}},
])
def test_invalid_farms_are_rejected(make_client, bad):
    farm = {"crop": "maize", "areaHa": 1, "soil": "loam", "method": "drip", "das": 30,
            "available": [[6, 18]], "pump": {"hp": 5, "headM": 40}, **bad}
    with make_client(api_key="k") as c:
        assert c.post("/api/feeders/F07/farms", json=farm, headers=KEY).status_code == 422


# -------------------------------------------------------------- database


def test_migrations_match_the_models(make_client):
    with make_client():
        engine = create_engine(db.database_url())
        with engine.connect() as conn:
            diffs = compare_metadata(MigrationContext.configure(conn), db.Base.metadata)
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        engine.dispose()
    assert diffs == [], diffs
    assert version == "0002"


def test_database_created_before_migrations_is_upgraded(database):
    """The pre-migration schema (runs + weather_cache, no alembic_version) keeps its data."""
    engine = create_engine(db.database_url())
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE runs (id VARCHAR(32) PRIMARY KEY, created_at TIMESTAMP WITH TIME ZONE NOT NULL, "
            "kind VARCHAR(16) NOT NULL, plan_date VARCHAR(10) NOT NULL, location VARCHAR(32) NOT NULL, "
            "engine VARCHAR(16) NOT NULL, solve_seconds FLOAT NOT NULL, params JSON NOT NULL, summary JSON NOT NULL)"
        ))
        conn.execute(text("CREATE INDEX ix_runs_created_at ON runs (created_at)"))
        conn.execute(text("CREATE TABLE weather_cache (key VARCHAR(160) PRIMARY KEY, "
                          "fetched_at TIMESTAMP WITH TIME ZONE NOT NULL, payload JSON NOT NULL)"))
        conn.execute(text("INSERT INTO runs VALUES ('old1', '2026-01-01 00:00:00+00', 'plan', '2026-01-01', "
                          "'warangal', 'cp-sat', 1.0, '{}', '{}')"))
    engine.dispose()
    assert db.init_db() == database
    tables = set(inspect(create_engine(db.database_url())).get_table_names())
    assert {"jobs", "feeders", "farms", "pumps", "alembic_version"} <= tables
    assert db.get_run("old1") is not None


def test_planning_survives_an_unreachable_database(make_client, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://nobody:nothing@127.0.0.1:1/none?connect_timeout=1")
    db.dispose()
    with make_client() as c:
        h = c.get("/api/health").json()
        assert h["db"] == "unavailable" and h["registry"] == "file"
        job = solve(c)
        assert job["status"] == "done" and len(job["result"]["farms"]) == 20
        assert c.get(f"/api/jobs/{job['id']}").status_code == 200  # kept in memory
        assert c.get("/api/feeders").status_code == 503


def test_ml_card_endpoint(make_client):
    with make_client() as c:
        card = c.get("/api/ml").json()
        h = c.get("/api/health").json()
    assert card["loaded"]["solar"] and card["loaded"]["rain"]
    assert card["solar"]["hourlyRmseLikely"] < card["solar"]["hourlyRmseRaw"]
    assert h["ml"] == card["loaded"]
