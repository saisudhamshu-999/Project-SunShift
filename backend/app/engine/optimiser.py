"""Feeder-level irrigation scheduling with Google OR-Tools CP-SAT.

Decision: x[j,t] = 1 if farm j's pump runs in 15-minute slot t.

Hard constraints
  - pumps run only inside the farmer's availability windows
  - every run block lasts at least ``min_run`` slots; at most ``max_starts`` blocks per day
  - no farm receives more than its agronomic requirement (no over-irrigation)
  - feeder load never exceeds the feeder limit
  - load never exceeds solar AC output plus the permitted grid backup

Objective, solved lexicographically
  Phase 1  maximise the fairness floor: the smallest share of its requirement any farm
           receives (averaged with yesterday's share, so shortfalls are repaid).
  Phase 2  keep that floor, then maximise
             priority-weighted served fraction        (agronomy: who needs water most)
           - grid import                              (run on the sun)
           - load above the cautious solar curve      (when an ML P10 curve is given)
           - peak load, pump starts                   (feeder health, motor wear)
           + small bonus for high-solar slots         (robustness to forecast error)

``mode="throughput"`` instead maximises total water pumped with no fairness, which is the
comparison used to show why fairness matters under scarcity.

Both phases start from a complete, feasible warm start produced by the greedy heuristic,
so the solver can only improve on it. Re-optimisation: slots before ``fixed_until`` are
taken as already executed.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

from ortools.sat.python import cp_model

POWER_UNIT_KW = 0.1  # CP-SAT works on integers: powers are expressed in 100 W units
FRACTION_SCALE = 1000

W_GRID = 4
W_PEAK = 1
W_START = 30
W_SOLAR_BONUS = 3
W_RISK = 2  # per 100 W of load above the cautious (P10) solar curve: half the weight of firm grid import
PHASE1_SHARE = 0.35  # share of the time budget spent on the fairness floor


@dataclass
class Job:
    farm_id: int
    power_kw: float
    flow_m3h: float
    required_slots: int
    allowed: list[int]
    weight: int
    min_run: int
    max_starts: int
    executed: list[int] = field(default_factory=list)  # slots already run (< fixed_until)
    carry: float = 1.0  # share of yesterday's requirement that was served (fairness over time)


@dataclass
class Problem:
    jobs: list[Job]
    solar_kw: list[float]
    feeder_limit_kw: float
    grid_cap_kw: float
    slots: int
    fairness_weight: float = 1.0  # 1 = keep the best fairness floor; 0.5 = guarantee half of it; 0 = off
    mode: str = "sunshift"  # sunshift | throughput
    fixed_until: int = 0
    time_limit_s: float = 3.0
    workers: int = 8
    seed: int = 7
    # Cautious (P10) solar curve from the ML forecast correction; None plans on solar_kw alone.
    solar_low_kw: list[float] | None = None
    # Stop once the incumbent is provably within this relative gap of the best bound.
    # CP-SAT then reports OPTIMAL; the UI always shows the actual gap alongside it.
    gap_limit: float = 5e-4


@dataclass
class Solution:
    status: str
    on: dict[int, list[int]]
    objective: float
    best_bound: float
    gap: float
    wall_time: float
    num_booleans: int
    num_constraints: int
    num_conflicts: int
    num_branches: int
    convergence: list[dict[str, float]]
    load_kw: list[float]
    grid_kw: list[float]
    time_limit_s: float
    workers: int
    mode: str
    gap_limit: float
    fairness_floor: float | None = None  # guaranteed two-day share (0..1), phase 1
    phase1: dict | None = None
    warm_start_objective: float | None = None  # greedy heuristic's objective, for comparison

    def stats(self) -> dict:
        improvement = None
        if self.warm_start_objective:
            improvement = round(
                (self.objective - self.warm_start_objective) / max(1.0, abs(self.warm_start_objective)), 5
            )
        return {
            "status": self.status,
            "objective": round(self.objective, 1),
            "bestBound": round(self.best_bound, 1),
            "gap": round(self.gap, 5),
            "wallTimeS": round(self.wall_time, 3),
            "numBooleans": self.num_booleans,
            "numConstraints": self.num_constraints,
            "numConflicts": self.num_conflicts,
            "numBranches": self.num_branches,
            "convergence": self.convergence,
            "timeLimitS": self.time_limit_s,
            "gapLimit": self.gap_limit,
            "workers": self.workers,
            "mode": self.mode,
            "fairnessFloor": None if self.fairness_floor is None else round(self.fairness_floor, 4),
            "phase1": self.phase1,
            "warmStartObjective": self.warm_start_objective,
            "improvementOverWarmStart": improvement,
            "solver": "OR-Tools CP-SAT",
        }


class _Progress(cp_model.CpSolverSolutionCallback):
    def __init__(self, offset: float = 0.0, phase: int = 2) -> None:
        super().__init__()
        self.offset = offset
        self.phase = phase
        self.points: list[dict[str, float]] = []

    def on_solution_callback(self) -> None:
        self.points.append({
            "t": round(self.offset + self.wall_time, 4),
            "objective": round(self.objective_value, 1),
            "bound": round(self.best_objective_bound, 1),
            "phase": self.phase,
        })


def units(kw: float) -> int:
    return int(round(kw / POWER_UNIT_KW))


def solar_units(kw: float) -> int:
    return max(0, int(math.floor(kw / POWER_UNIT_KW)))


@dataclass
class _Built:
    model: cp_model.CpModel
    x: dict  # (j, t) -> BoolVar, or the constant 0/1 for slots that are fixed or impossible
    starts: dict  # (j, t) -> BoolVar
    fracs: dict  # j -> IntVar, served share x1000
    floor: cp_model.IntVar | None
    floors: list  # (j or None, fixed share or None, carried share)
    grid: dict  # t -> IntVar
    risk: dict  # t -> IntVar, load above the cautious solar curve
    peak: cp_model.IntVar
    service: list  # (weight, fraction var)
    secondary: object  # linear expression: bonus - grid - peak - starts
    water: object  # linear expression: total water (x10 m3/h units)
    grid_sum: object
    n_bool: int
    S: list[int]
    G: int
    s_max: float
    SL: list[int] | None


def _build(p: Problem) -> _Built:
    m = cp_model.CpModel()
    T = p.slots
    F = units(p.feeder_limit_kw)
    G = units(p.grid_cap_kw)
    S = [solar_units(s) for s in p.solar_kw]
    s_max = max(max(p.solar_kw), 1e-6)
    t0 = p.fixed_until
    n_bool = 0

    x: dict[tuple[int, int], cp_model.IntVar | int] = {}
    starts: dict = {}
    fracs: dict = {}
    service: list = []
    floors: list = []
    bonus_terms: list = []
    water_terms: list = []

    for j, job in enumerate(p.jobs):
        executed = sorted(s for s in job.executed if s < t0)
        remaining = max(0, job.required_slots - len(executed))
        allowed = set(job.allowed)
        carried = int(round(FRACTION_SCALE * max(0.0, min(1.0, job.carry))))
        for t in range(T):
            if t < t0:
                x[j, t] = 1 if t in executed else 0
            elif remaining > 0 and t in allowed:
                x[j, t] = m.new_bool_var(f"x_{job.farm_id}_{t}")
                n_bool += 1
            else:
                x[j, t] = 0

        future = [x[j, t] for t in range(t0, T) if not isinstance(x[j, t], int)]
        if job.required_slots > 0 and not future:
            # Nothing left to decide; its share still counts towards the fairness floor.
            share = min(FRACTION_SCALE, FRACTION_SCALE * len(executed) // job.required_slots)
            floors.append((None, share, carried))
            continue
        if not future:
            continue

        past_blocks = sum(1 for k, s in enumerate(executed) if k == 0 or executed[k - 1] != s - 1)
        job_starts = []
        for t in range(t0, T):
            xt = x[j, t]
            if isinstance(xt, int):
                continue
            prev = x[j, t - 1] if t > 0 else 0
            st = m.new_bool_var(f"s_{job.farm_id}_{t}")
            n_bool += 1
            if isinstance(prev, int):
                if prev == 1:
                    m.add(st == 0)
                else:
                    m.add(st == xt)
            else:
                m.add(st >= xt - prev)
                m.add(st <= xt)
                m.add(st <= 1 - prev)
            for k in range(1, job.min_run):  # minimum run length for blocks starting now
                nxt = x[j, t + k] if t + k < T else 0
                if isinstance(nxt, int):
                    if nxt == 0:
                        m.add(st == 0)
                else:
                    m.add_implication(st, nxt)
            starts[j, t] = st
            job_starts.append(st)
        m.add(sum(job_starts) + past_blocks <= job.max_starts)

        n_future = sum(future)
        m.add(n_future <= remaining)
        f = m.new_int_var(0, FRACTION_SCALE, f"f_{job.farm_id}")
        m.add(FRACTION_SCALE * (n_future + len(executed)) >= job.required_slots * f)
        fracs[j] = f
        service.append((job.weight, f))
        floors.append((j, None, carried))
        for t in range(t0, T):
            xt = x[j, t]
            if not isinstance(xt, int):
                bonus_terms.append(int(round(W_SOLAR_BONUS * p.solar_kw[t] / s_max)) * xt)
                water_terms.append(int(round(job.flow_m3h * 10)) * xt)

    grid: dict = {}
    risk: dict = {}
    SL = [solar_units(s) for s in p.solar_low_kw] if p.solar_low_kw is not None else None
    peak = m.new_int_var(0, max(F, 0), "peak")
    for t in range(t0, T):
        active = [(j, job) for j, job in enumerate(p.jobs) if not isinstance(x[j, t], int)]
        if not active:
            continue
        load = sum(units(job.power_kw) * x[j, t] for j, job in active)
        m.add(load <= F)
        m.add(peak >= load)
        if sum(units(job.power_kw) for _, job in active) > S[t]:
            g = m.new_int_var(0, G, f"g_{t}")
            m.add(g >= load - S[t])
            grid[t] = g
        if SL is not None and sum(units(job.power_kw) for _, job in active) > SL[t]:
            r = m.new_int_var(0, max(F, 0), f"r_{t}")
            m.add(r >= load - SL[t])
            risk[t] = r

    floor = None
    if fracs:
        # Fairness floor over the two-day average share.
        floor = m.new_int_var(0, FRACTION_SCALE, "fairness_floor")
        for j, share, carried in floors:
            m.add(2 * floor <= (fracs[j] if j is not None else share) + carried)

    grid_sum = sum(grid.values())
    secondary = (sum(bonus_terms) - W_GRID * grid_sum - W_RISK * sum(risk.values()) - W_PEAK * peak
                 - W_START * sum(starts.values()))
    return _Built(m, x, starts, fracs, floor, floors, grid, risk, peak, service, secondary, sum(water_terms), grid_sum,
                  n_bool, S, G, s_max, SL)


def _configure(solver: cp_model.CpSolver, p: Problem, time_limit: float, gap: float) -> None:
    solver.parameters.max_time_in_seconds = max(0.05, time_limit)
    solver.parameters.num_workers = p.workers
    solver.parameters.random_seed = p.seed
    solver.parameters.relative_gap_limit = gap


def _complete_hint(built: _Built, p: Problem, on: dict[int, list[int]]) -> tuple[list, dict]:
    """Values for *every* model variable implied by a schedule, plus its objective values.

    A complete feasible hint becomes CP-SAT's first incumbent immediately, so the solver
    can only improve on it."""
    T = p.slots
    on_sets = {job.farm_id: set(on.get(job.farm_id, [])) for job in p.jobs}
    vals: list = []
    xv: dict[tuple[int, int], int] = {}
    bonus = water = 0
    for (j, t), v in built.x.items():
        if isinstance(v, int):
            xv[j, t] = v
            continue
        val = 1 if t in on_sets[p.jobs[j].farm_id] else 0
        xv[j, t] = val
        vals.append((v, val))
        bonus += int(round(W_SOLAR_BONUS * p.solar_kw[t] / built.s_max)) * val
        water += int(round(p.jobs[j].flow_m3h * 10)) * val
    n_starts = 0
    for (j, t), v in built.starts.items():
        val = 1 if xv[j, t] == 1 and (xv[j, t - 1] if t > 0 else 0) == 0 else 0
        vals.append((v, val))
        n_starts += val
    fvals = {}
    for j, v in built.fracs.items():
        n = sum(xv[j, t] for t in range(T))
        fvals[j] = min(FRACTION_SCALE, FRACTION_SCALE * n // p.jobs[j].required_slots)
        vals.append((v, fvals[j]))
    floor_val = None
    if built.floor is not None:
        floor_val = min(((fvals[j] if j is not None else share) + carried) // 2 for j, share, carried in built.floors)
        vals.append((built.floor, floor_val))
    loads = [sum(units(job.power_kw) * xv[j, t] for j, job in enumerate(p.jobs)) for t in range(T)]
    grid_total = 0
    for t, g in built.grid.items():
        val = min(built.G, max(0, loads[t] - built.S[t]))
        vals.append((g, val))
        grid_total += val
    risk_total = 0
    for t, r in built.risk.items():
        val = max(0, loads[t] - built.SL[t])
        vals.append((r, val))
        risk_total += val
    peak_val = max((loads[t] for t in range(p.fixed_until, T)), default=0)
    vals.append((built.peak, peak_val))
    service = sum(p.jobs[j].weight * fvals[j] for j in fvals)
    objective = service + bonus - W_GRID * grid_total - W_RISK * risk_total - W_PEAK * peak_val - W_START * n_starts
    return vals, {"floor": floor_val, "objective": objective, "throughput": water - W_GRID * grid_total}


def _apply_hint(m: cp_model.CpModel, vals: list) -> None:
    m.clear_hints()
    for var, val in vals:
        m.add_hint(var, val)


def _extract(built: _Built, p: Problem, solver: cp_model.CpSolver) -> dict[int, list[int]]:
    return {
        job.farm_id: [
            t for t in range(p.slots)
            if (isinstance(built.x[j, t], int) and built.x[j, t] == 1)
            or (not isinstance(built.x[j, t], int) and solver.value(built.x[j, t]))
        ]
        for j, job in enumerate(p.jobs)
    }


def solve(p: Problem) -> Solution:
    from .heuristic import greedy  # local import: heuristic depends on this module's types

    wall0 = time.perf_counter()
    T = p.slots
    built = _build(p)
    m = built.model
    phase1 = None
    floor_value = None
    convergence: list[dict[str, float]] = []

    warm = greedy(p)  # always-feasible incumbent: the solver never starts from nothing
    warm_vals, warm_info = _complete_hint(built, p, warm)
    hint_vals, best_on, best_src = warm_vals, warm, "greedy"

    if p.mode == "sunshift" and p.fairness_weight > 0 and built.floor is not None:
        # ---------------- Phase 1: the best fairness floor
        m.maximize(built.floor)
        _apply_hint(m, warm_vals)
        s1 = cp_model.CpSolver()
        _configure(s1, p, p.time_limit_s * PHASE1_SHARE, 0.01)
        cb1 = _Progress(0.0, phase=1)
        st1 = s1.solve(m, cb1)
        if st1 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            best = s1.value(built.floor)
            floor_value = int(math.floor(min(1.0, p.fairness_weight) * best))
            p1_on = _extract(built, p, s1)
            p1_vals, p1_info = _complete_hint(built, p, p1_on)
            candidates = [(p1_info["objective"], p1_vals, p1_on, "phase1")]
            if warm_info["floor"] is not None and warm_info["floor"] >= floor_value:
                candidates.append((warm_info["objective"], warm_vals, warm, "greedy"))
            _, hint_vals, best_on, best_src = max(candidates, key=lambda c: c[0])
            phase1 = {
                "status": s1.status_name(st1), "wallTimeS": round(s1.wall_time, 3),
                "floor": round(best / FRACTION_SCALE, 4), "bound": round(s1.best_objective_bound / FRACTION_SCALE, 4),
                "guaranteed": round(floor_value / FRACTION_SCALE, 4),
                "greedyFloor": None if warm_info["floor"] is None else round(warm_info["floor"] / FRACTION_SCALE, 4),
            }
            convergence.extend(cb1.points)
            m.clear_objective()
            m.add(built.floor >= floor_value)

    if p.mode == "throughput":
        m.maximize(built.water - W_GRID * built.grid_sum)
    else:
        m.maximize(sum(w * f for w, f in built.service) + built.secondary)
    _apply_hint(m, hint_vals)

    solver = cp_model.CpSolver()
    elapsed = time.perf_counter() - wall0
    _configure(solver, p, p.time_limit_s - elapsed, p.gap_limit)
    cb = _Progress(elapsed, phase=2)
    status = solver.solve(m, cb)
    status_name = solver.status_name(status)
    convergence.extend(cb.points)

    ok = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    if ok:
        on = _extract(built, p, solver)
    else:
        # No phase-2 solution in time: use the best feasible schedule we have and say so.
        on = best_on
        status_name = f"FALLBACK_{best_src.upper()}"

    load_kw = [0.0] * T
    for job in p.jobs:
        for t in on[job.farm_id]:
            load_kw[t] += job.power_kw
    grid_kw = [max(0.0, load_kw[t] - p.solar_kw[t]) for t in range(T)]

    obj = solver.objective_value if ok else 0.0
    bound = solver.best_objective_bound if ok else 0.0
    gap = abs(bound - obj) / max(1.0, abs(obj)) if ok else 1.0
    warm_obj = warm_info["throughput"] if p.mode == "throughput" else warm_info["objective"]
    if floor_value is not None and (warm_info["floor"] is None or warm_info["floor"] < floor_value):
        warm_obj = None  # the warm start misses the fairness floor: objectives are not comparable
    return Solution(
        status=status_name,
        on=on,
        objective=obj,
        best_bound=bound,
        gap=gap,
        wall_time=time.perf_counter() - wall0,
        num_booleans=built.n_bool,
        num_constraints=len(m.proto.constraints),
        num_conflicts=solver.num_conflicts,
        num_branches=solver.num_branches,
        convergence=convergence[-80:],
        load_kw=[round(v, 3) for v in load_kw],
        grid_kw=[round(v, 3) for v in grid_kw],
        time_limit_s=p.time_limit_s,
        workers=p.workers,
        mode=p.mode,
        gap_limit=p.gap_limit,
        fairness_floor=None if floor_value is None else floor_value / FRACTION_SCALE,
        phase1=phase1,
        warm_start_objective=warm_obj,
    )
