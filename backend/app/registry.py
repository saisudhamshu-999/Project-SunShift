"""Farm registry: feeders, farms and pumps stored in the database.

The planner reads its feeder from here. On first start the registry is seeded from
``shared/scenario.json`` (the simulated demo feeder); after that the database is the
source of truth and farms can be added or changed through the API. If the database is
unavailable, planning falls back to the scenario file.

Run ``python -m app.registry seed [--reset]`` to (re)seed by hand.
"""

from __future__ import annotations

import argparse
import logging
import threading
from dataclasses import replace
from datetime import date as Date
from typing import Any

from sqlalchemy import func, select

from . import db
from .engine.scenario import Farm, Scenario, load_scenario, pump_electrical_kw, pump_flow_m3h

log = logging.getLogger("sunshift.registry")

FARM_FIELDS = (
    "label", "crop", "area_ha", "soil", "method", "das", "sowing_date", "available", "habit_start",
    "dr0_frac", "served_yesterday", "last_irrigated_days", "map_x", "map_y",
)
PUMP_FIELDS = ("hp", "head_m", "controller", "measured_kw", "measured_flow_m3h")
FEEDER_FIELDS = ("name", "location_id", "pv_kwp", "inverter_kw", "feeder_limit_kw", "grid_backup_kw")

_cache: dict[tuple, Scenario] = {}
_cache_lock = threading.Lock()


class NotFound(LookupError):
    pass


class Unavailable(RuntimeError):
    """The registry needs the database and it is not reachable."""


def default_feeder_id() -> str:
    return load_scenario().feeder.id


# ------------------------------------------------------------------ seeding


def seed(reset: bool = False) -> bool:
    """Load the demo feeder from the scenario file. Returns True if anything was written."""
    sc = load_scenario()
    now = db.utcnow()
    with db.session() as s:
        if s is None:
            return False
        if reset:
            farm_ids = select(db.FarmRow.id).where(db.FarmRow.feeder_id == sc.feeder.id)
            s.query(db.PumpRow).filter(db.PumpRow.farm_id.in_(farm_ids)).delete(synchronize_session=False)
            s.query(db.FarmRow).filter(db.FarmRow.feeder_id == sc.feeder.id).delete(synchronize_session=False)
            s.query(db.FeederRow).filter(db.FeederRow.id == sc.feeder.id).delete(synchronize_session=False)
            s.flush()
        elif s.get(db.FeederRow, sc.feeder.id) is not None:
            return False
        f = sc.feeder
        s.add(db.FeederRow(
            id=f.id, name=f.name, location_id=sc.default_location, pv_kwp=f.pv_kwp, inverter_kw=f.inverter_kw,
            feeder_limit_kw=f.feeder_limit_kw, grid_backup_kw=f.grid_backup_kw, simulated=True,
            created_at=now, updated_at=now,
        ))
        s.flush()
        for raw in sc.raw["farms"]:
            s.add(db.FarmRow(
                id=raw["id"], feeder_id=f.id, label=None, crop=raw["crop"], area_ha=raw["area_ha"], soil=raw["soil"],
                method=raw["method"], das=raw["das"], sowing_date=None, available=[list(w) for w in raw["available"]],
                habit_start=raw["habit_start"], dr0_frac=raw["dr0_frac"], served_yesterday=raw["served_yesterday"],
                last_irrigated_days=raw["last_irrigated_days"], map_x=raw["pos"][0], map_y=raw["pos"][1],
                simulated=True, active=True, created_at=now, updated_at=now,
            ))
        s.flush()
        for raw in sc.raw["farms"]:
            s.add(db.PumpRow(farm_id=raw["id"], hp=raw["pump_hp"], head_m=raw["head_m"], controller="advisory", updated_at=now))
    log.info("registry seeded with feeder %s (%d farms)", sc.feeder.id, len(sc.raw["farms"]))
    clear_cache()
    return True


def seed_if_empty() -> None:
    try:
        seed(reset=False)
    except Exception:
        log.exception("could not seed the registry")


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


# --------------------------------------------------------- scenario building


def version(feeder_id: str | None = None) -> str:
    """Changes whenever the feeder or any of its farms or pumps changes."""
    fid = feeder_id or default_feeder_id()
    try:
        with db.session() as s:
            if s is None:
                return "file"
            row = s.get(db.FeederRow, fid)
            return db.aware(row.updated_at).isoformat() if row else "file"
    except Exception:
        return "file"


def _days_after_sowing(row: db.FarmRow, day: str | None) -> int:
    if row.sowing_date and day:
        return (Date.fromisoformat(day) - Date.fromisoformat(row.sowing_date)).days
    return int(row.das or 0)


def _farm(row: db.FarmRow, pump: db.PumpRow | None, base: Scenario, day: str | None) -> Farm:
    pm = base.pump_model
    hp = pump.hp if pump else 5.0
    head = pump.head_m if pump else 40.0
    kw = pump.measured_kw if pump and pump.measured_kw else pump_electrical_kw(hp, pm["motor_efficiency"])
    flow = (
        pump.measured_flow_m3h
        if pump and pump.measured_flow_m3h
        else pump_flow_m3h(kw, head, pm["wire_to_water_efficiency"])
    )
    return Farm(
        id=row.id, crop=row.crop, area_ha=row.area_ha, soil=row.soil, pump_hp=hp, head_m=head, method=row.method,
        das=_days_after_sowing(row, day), dr0_frac=row.dr0_frac,
        available=tuple((float(a), float(b)) for a, b in row.available), habit_start=row.habit_start,
        last_irrigated_days=row.last_irrigated_days, served_yesterday=row.served_yesterday,
        pos=(float(row.map_x or 0.0), float(row.map_y or 0.0)), pump_kw=round(kw, 3), flow_m3h=round(flow, 3),
    )


def _farm_raw(farm: Farm) -> dict[str, Any]:
    """The scenario-file shape of a farm, so /api/scenario keeps its format."""
    return {
        "id": farm.id, "crop": farm.crop, "area_ha": farm.area_ha, "soil": farm.soil, "pump_hp": farm.pump_hp,
        "head_m": farm.head_m, "method": farm.method, "das": farm.das, "dr0_frac": farm.dr0_frac,
        "available": [list(w) for w in farm.available], "habit_start": farm.habit_start,
        "last_irrigated_days": farm.last_irrigated_days, "served_yesterday": farm.served_yesterday,
        "pos": list(farm.pos),
    }


def scenario(feeder_id: str | None = None, day: str | None = None) -> Scenario:
    """The scenario to plan with: the registry's feeder, or the scenario file as a fallback."""
    base = load_scenario()
    fid = feeder_id or base.feeder.id
    try:
        with db.session() as s:
            if s is None:
                return base
            feeder = s.get(db.FeederRow, fid)
            if feeder is None:
                if feeder_id and feeder_id != base.feeder.id:
                    raise NotFound(f"feeder {feeder_id} not found")
                return base
            uses_dates = bool(s.scalar(
                select(func.count()).select_from(db.FarmRow)
                .where(db.FarmRow.feeder_id == fid, db.FarmRow.sowing_date.is_not(None))
            ))
            key = (fid, db.aware(feeder.updated_at).isoformat(), day if uses_dates else None)
            with _cache_lock:
                hit = _cache.get(key)
            if hit is not None:
                return hit
            rows = s.scalars(
                select(db.FarmRow).where(db.FarmRow.feeder_id == fid, db.FarmRow.active.is_(True)).order_by(db.FarmRow.id)
            ).all()
            pumps = {p.farm_id: p for p in s.scalars(select(db.PumpRow).where(db.PumpRow.farm_id.in_([r.id for r in rows]))).all()}
            farms = tuple(_farm(r, pumps.get(r.id), base, day) for r in rows)
            sc = replace(
                base,
                feeder=replace(
                    base.feeder, id=feeder.id, name=feeder.name, pv_kwp=feeder.pv_kwp, inverter_kw=feeder.inverter_kw,
                    feeder_limit_kw=feeder.feeder_limit_kw, grid_backup_kw=feeder.grid_backup_kw,
                ),
                farms=farms,
                default_location=feeder.location_id if feeder.location_id in base.locations else base.default_location,
                raw={**base.raw, "farms": [_farm_raw(f) for f in farms],
                     "feeder": {**base.raw["feeder"], "id": feeder.id, "name": feeder.name, "pv_kwp": feeder.pv_kwp,
                                "inverter_kw": feeder.inverter_kw, "feeder_limit_kw": feeder.feeder_limit_kw,
                                "grid_backup_kw": feeder.grid_backup_kw}},
                registry="database",
                all_simulated=feeder.simulated and all(r.simulated for r in rows),
            )
            with _cache_lock:
                if len(_cache) > 32:
                    _cache.clear()
                _cache[key] = sc
            return sc
    except NotFound:
        raise
    except Exception as exc:
        log.warning("registry unavailable, planning from the scenario file: %s", exc)
        return base


# ------------------------------------------------------------------ reading


def _feeder_dict(f: db.FeederRow, farm_count: int) -> dict[str, Any]:
    return {
        "id": f.id, "name": f.name, "locationId": f.location_id, "pvKwp": f.pv_kwp, "inverterKw": f.inverter_kw,
        "feederLimitKw": f.feeder_limit_kw, "gridBackupKw": f.grid_backup_kw, "simulated": f.simulated,
        "farmCount": farm_count, "updatedAt": db.aware(f.updated_at).isoformat(),
    }


def _farm_dict(r: db.FarmRow, p: db.PumpRow | None) -> dict[str, Any]:
    return {
        "id": r.id, "code": f"F{r.id:02d}", "feederId": r.feeder_id, "label": r.label, "crop": r.crop,
        "areaHa": r.area_ha, "soil": r.soil, "method": r.method, "das": r.das, "sowingDate": r.sowing_date,
        "available": r.available, "habitStart": r.habit_start, "dr0Frac": r.dr0_frac,
        "servedYesterday": r.served_yesterday, "lastIrrigatedDays": r.last_irrigated_days,
        "mapX": r.map_x, "mapY": r.map_y, "simulated": r.simulated, "active": r.active,
        "pump": None if p is None else {
            "hp": p.hp, "headM": p.head_m, "controller": p.controller,
            "measuredKw": p.measured_kw, "measuredFlowM3h": p.measured_flow_m3h,
        },
        "updatedAt": db.aware(r.updated_at).isoformat(),
    }


def _require_session(s):
    if s is None:
        raise Unavailable("database unavailable")
    return s


def list_feeders() -> list[dict[str, Any]]:
    with db.session() as s:
        s = _require_session(s)
        counts = dict(s.execute(
            select(db.FarmRow.feeder_id, func.count()).where(db.FarmRow.active.is_(True)).group_by(db.FarmRow.feeder_id)
        ).all())
        return [_feeder_dict(f, counts.get(f.id, 0)) for f in s.scalars(select(db.FeederRow).order_by(db.FeederRow.id)).all()]


def get_feeder(feeder_id: str, include_inactive: bool = False) -> dict[str, Any]:
    with db.session() as s:
        s = _require_session(s)
        f = s.get(db.FeederRow, feeder_id)
        if f is None:
            raise NotFound(f"feeder {feeder_id} not found")
        q = select(db.FarmRow).where(db.FarmRow.feeder_id == feeder_id).order_by(db.FarmRow.id)
        if not include_inactive:
            q = q.where(db.FarmRow.active.is_(True))
        rows = s.scalars(q).all()
        pumps = {p.farm_id: p for p in s.scalars(select(db.PumpRow).where(db.PumpRow.farm_id.in_([r.id for r in rows]))).all()}
        return {**_feeder_dict(f, sum(1 for r in rows if r.active)), "farms": [_farm_dict(r, pumps.get(r.id)) for r in rows]}


# ------------------------------------------------------------------ writing


def _touch(s, feeder_id: str) -> None:
    feeder = s.get(db.FeederRow, feeder_id)
    if feeder is not None:
        feeder.updated_at = db.utcnow()


def update_feeder(feeder_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    with db.session() as s:
        s = _require_session(s)
        f = s.get(db.FeederRow, feeder_id)
        if f is None:
            raise NotFound(f"feeder {feeder_id} not found")
        for k in FEEDER_FIELDS:
            if k in changes:
                setattr(f, k, changes[k])
        f.updated_at = db.utcnow()
    clear_cache()
    return get_feeder(feeder_id)


def create_farm(feeder_id: str, fields: dict[str, Any], pump: dict[str, Any]) -> dict[str, Any]:
    now = db.utcnow()
    with db.session() as s:
        s = _require_session(s)
        if s.get(db.FeederRow, feeder_id) is None:
            raise NotFound(f"feeder {feeder_id} not found")
        new_id = (s.scalar(select(func.max(db.FarmRow.id))) or 0) + 1
        row = db.FarmRow(
            id=new_id, feeder_id=feeder_id, simulated=False, active=True, created_at=now, updated_at=now,
            **{k: fields.get(k) for k in FARM_FIELDS},
        )
        s.add(row)
        s.flush()
        s.add(db.PumpRow(farm_id=new_id, updated_at=now, **{k: pump.get(k) for k in PUMP_FIELDS if pump.get(k) is not None}))
        _touch(s, feeder_id)
    clear_cache()
    return get_farm(new_id)


def get_farm(farm_id: int) -> dict[str, Any]:
    with db.session() as s:
        s = _require_session(s)
        r = s.get(db.FarmRow, farm_id)
        if r is None:
            raise NotFound(f"farm {farm_id} not found")
        p = s.scalars(select(db.PumpRow).where(db.PumpRow.farm_id == farm_id)).first()
        return _farm_dict(r, p)


def update_farm(farm_id: int, fields: dict[str, Any], pump: dict[str, Any]) -> dict[str, Any]:
    with db.session() as s:
        s = _require_session(s)
        r = s.get(db.FarmRow, farm_id)
        if r is None:
            raise NotFound(f"farm {farm_id} not found")
        for k, v in fields.items():
            if k in FARM_FIELDS or k == "active":
                setattr(r, k, v)
        r.updated_at = db.utcnow()
        if pump:
            p = s.scalars(select(db.PumpRow).where(db.PumpRow.farm_id == farm_id)).first()
            if p is None:
                p = db.PumpRow(farm_id=farm_id, hp=5.0, head_m=40.0, controller="advisory", updated_at=db.utcnow())
                s.add(p)
            for k, v in pump.items():
                if k in PUMP_FIELDS:
                    setattr(p, k, v)
            p.updated_at = db.utcnow()
        _touch(s, r.feeder_id)
    clear_cache()
    return get_farm(farm_id)


def deactivate_farm(farm_id: int) -> dict[str, Any]:
    """Farms are deactivated, not deleted, so past runs stay explainable."""
    return update_farm(farm_id, {"active": False}, {})


def main() -> None:  # pragma: no cover - CLI
    parser = argparse.ArgumentParser(description="SunShift farm registry")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_seed = sub.add_parser("seed", help="load the demo feeder from shared/scenario.json")
    p_seed.add_argument("--reset", action="store_true", help="replace the demo feeder's farms with the file's")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    print("database:", db.init_db())
    if args.cmd == "seed":
        print("seeded" if seed(reset=args.reset) else "already seeded (use --reset to replace)")


if __name__ == "__main__":  # pragma: no cover
    main()
