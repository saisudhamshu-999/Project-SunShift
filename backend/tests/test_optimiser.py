"""The optimiser's hard constraints must hold for every schedule it returns."""

import random

import pytest

from app.engine.heuristic import greedy
from app.engine.optimiser import Job, Problem, solve


def _solar(peak: float, slots: int = 48) -> list[float]:
    import math

    return [max(0.0, peak * math.sin(math.pi * (t + 0.5) / slots)) for t in range(slots)]


def _random_problem(seed: int, scarce: bool = False) -> Problem:
    rng = random.Random(seed)
    jobs = []
    for i in range(1, 17):
        a = rng.choice([0, 0, 8, 12])
        b = rng.choice([48, 48, 32, 28])
        jobs.append(Job(
            farm_id=i, power_kw=rng.choice([2.9, 4.8, 4.8, 7.2]), flow_m3h=rng.uniform(9, 17),
            required_slots=rng.randint(0, 28), allowed=list(range(a, b)), weight=rng.randint(5, 50),
            min_run=2, max_starts=2, min_off=2, carry=rng.choice([1.0, 1.0, 0.6]),
        ))
    return Problem(jobs=jobs, solar_kw=_solar(35 if scarce else 75), feeder_limit_kw=60, grid_cap_kw=0 if scarce else 15,
                   slots=48, time_limit_s=1.5)


def _check(p: Problem, on: dict[int, list[int]]) -> None:
    load = [0.0] * p.slots
    for job in p.jobs:
        slots = sorted(on[job.farm_id])
        assert len(slots) <= job.required_slots, "over-irrigation"
        assert set(slots) <= set(job.allowed) | set(job.executed), "outside availability"
        blocks = []
        for s in slots:
            if blocks and s == blocks[-1][-1] + 1:
                blocks[-1].append(s)
            else:
                blocks.append([s])
        assert len(blocks) <= job.max_starts, "too many starts"
        for b in blocks:
            if b[0] >= p.fixed_until:
                assert len(b) >= job.min_run, "block shorter than minimum run"
        for prev, nxt in zip(blocks, blocks[1:]):
            if nxt[0] >= p.fixed_until:
                assert nxt[0] - prev[-1] - 1 >= job.min_off, "pump restarted before its minimum off time"
        for s in slots:
            load[s] += job.power_kw
    for t in range(p.fixed_until, p.slots):
        assert load[t] <= p.feeder_limit_kw + 1e-6, f"feeder limit broken at slot {t}"
        assert load[t] <= p.solar_kw[t] + p.grid_cap_kw + 0.1 + 1e-6, f"supply limit broken at slot {t}"


@pytest.mark.parametrize("seed", range(6))
@pytest.mark.parametrize("scarce", [False, True])
def test_cp_sat_schedule_is_feasible(seed, scarce):
    p = _random_problem(seed, scarce)
    sol = solve(p)
    assert sol.status in ("OPTIMAL", "FEASIBLE") or sol.status.startswith("FALLBACK")
    _check(p, sol.on)


@pytest.mark.parametrize("seed", range(6))
def test_greedy_schedule_is_feasible(seed):
    p = _random_problem(seed, scarce=seed % 2 == 0)
    _check(p, greedy(p))


def test_solver_never_worse_than_warm_start():
    p = _random_problem(3)
    sol = solve(p)
    stats = sol.stats()
    if stats["improvementOverWarmStart"] is not None:
        assert stats["improvementOverWarmStart"] >= -1e-6


def test_fairness_floor_beats_throughput_under_scarcity():
    p = _random_problem(11, scarce=True)
    for j in p.jobs:
        j.carry = 1.0
    fair = solve(p)
    thr = solve(Problem(**{**p.__dict__, "mode": "throughput"}))
    share = lambda sol: min(  # noqa: E731
        len(sol.on[j.farm_id]) / j.required_slots for j in p.jobs if j.required_slots > 0
    )
    assert share(fair) >= share(thr) - 1e-9


def test_reoptimisation_keeps_the_past():
    p = _random_problem(5)
    first = solve(p)
    executed = {fid: [s for s in slots if s < 20] for fid, slots in first.on.items()}
    for job in p.jobs:
        job.executed = executed[job.farm_id]
    p.fixed_until = 20
    p.solar_kw = [v * (0.5 if t >= 20 else 1.0) for t, v in enumerate(p.solar_kw)]
    second = solve(p)
    for fid, slots in executed.items():
        assert [s for s in second.on[fid] if s < 20] == slots
    _check(p, second.on)


def test_real_feeder_pumps_start_at_most_twice_with_rest_between():
    """On the 20-farm feeder: <= 2 starts a day, runs >= 30 min, >= 30 min off between runs,
    and on an ordinary January day the schedule is proven within 1% of the best possible."""
    from app.engine import planner

    plan = planner.plan_day(planner.PlanParams(date="2030-01-15", persist=False, time_limit_s=5.0))
    solver = plan["sunshift"]["solver"]
    assert solver["status"] == "OPTIMAL" and solver["gap"] <= 0.01 and solver["wallTimeS"] < 5.0  # stops once proven
    feeder = plan["feeder"]
    assert feeder["maxStarts"] == 2 and feeder["minRunSlots"] == 2 and feeder["minOffSlots"] == 2
    for farm in plan["farms"]:
        blocks = farm["schedule"]["blocks"]  # [first, last] slot of each run
        assert len(blocks) <= 2, farm["code"]
        assert all(b - a + 1 >= 2 for a, b in blocks), farm["code"]
        assert all(nxt[0] - prev[1] - 1 >= 2 for prev, nxt in zip(blocks, blocks[1:])), farm["code"]
