"""Greedy list-scheduling heuristic.

Used three ways:
  1. warm start (solution hint) for CP-SAT, so the solver always has an incumbent;
  2. fallback if CP-SAT returns no solution within its time budget;
  3. reference for the browser fallback engine (frontend/src/engine/heuristic.ts),
     which runs the same algorithm when the API is unreachable.

Algorithm: farms in priority order. Pass A gives every farm one block of up to half
its requirement (fair share first); pass B extends blocks and, if starts allow, adds a
second block. Windows are chosen to maximise solar margin, never breaking the feeder
limit, the solar + grid-backup supply limit, availability, minimum run time or the
minimum off time between blocks.
"""

from __future__ import annotations

import math

from .optimiser import Job, Problem, solar_units, units


def _feasible_runs(ok: list[bool]) -> list[int]:
    """runs[t] = number of consecutive feasible slots starting at t."""
    runs = [0] * (len(ok) + 1)
    for t in range(len(ok) - 1, -1, -1):
        runs[t] = runs[t + 1] + 1 if ok[t] else 0
    return runs[:-1]


def gap_ok(mine: set[int], t: int, min_off: int) -> bool:
    """Adding slot ``t`` leaves no off gap shorter than ``min_off`` next to it."""
    for d in range(2, min_off + 1):
        # the nearest scheduled slot on either side, d slots away, would leave d - 1 off slots
        if t - d in mine and not any(t - e in mine for e in range(1, d)):
            return False
        if t + d in mine and not any(t + e in mine for e in range(1, d)):
            return False
    return True


def greedy(p: Problem) -> dict[int, list[int]]:
    # Integer power units, exactly as in the CP-SAT model, so the result is a valid hint.
    T, t0 = p.slots, p.fixed_until
    F, G = units(p.feeder_limit_kw), units(p.grid_cap_kw)
    S = [solar_units(v) for v in p.solar_kw]
    P = {job.farm_id: units(job.power_kw) for job in p.jobs}
    load = [0] * T
    assigned: dict[int, set[int]] = {}
    for job in p.jobs:
        done = {s for s in job.executed if s < t0}
        assigned[job.farm_id] = set(done)
        for s in done:
            load[s] += P[job.farm_id]

    def fits(t: int, job: Job) -> bool:
        return load[t] + P[job.farm_id] <= F and load[t] + P[job.farm_id] <= S[t] + G

    def blocks(slots: set[int]) -> int:
        return sum(1 for s in slots if s - 1 not in slots)

    def ok_slots(job: Job) -> list[bool]:
        allowed = set(job.allowed)
        mine = assigned[job.farm_id]
        return [t >= t0 and t in allowed and t not in mine and fits(t, job) and gap_ok(mine, t, job.min_off)
                for t in range(T)]

    def place(job: Job, length: int) -> bool:
        ok = ok_slots(job)
        runs = _feasible_runs(ok)
        best_len = min(length, max(runs) if runs else 0)
        if best_len < job.min_run:
            return False
        margin = [S[t] - load[t] - P[job.farm_id] for t in range(T)]
        best_s, best_score = None, -math.inf
        for s in range(T):
            if runs[s] >= best_len:
                score = sum(margin[s:s + best_len])
                if score > best_score:
                    best_s, best_score = s, score
        if best_s is None:
            return False
        for t in range(best_s, best_s + best_len):
            assigned[job.farm_id].add(t)
            load[t] += P[job.farm_id]
        return True

    def extend(job: Job, extra: int) -> int:
        """Grow existing blocks one slot at a time towards the better side."""
        mine = assigned[job.farm_id]
        allowed = set(job.allowed)
        added = 0
        while added < extra:
            options = []
            for s in mine:
                for nb in (s - 1, s + 1):
                    if t0 <= nb < T and nb in allowed and nb not in mine and fits(nb, job) and gap_ok(mine, nb, job.min_off):
                        options.append((S[nb] - load[nb], nb))
            if not options:
                break
            _, nb = max(options)
            mine.add(nb)
            load[nb] += P[job.farm_id]
            added += 1
        return added

    order = sorted(
        (j for j in p.jobs if j.required_slots > 0),
        key=lambda j: (-j.weight, j.required_slots),
    )
    remaining = {j.farm_id: max(0, j.required_slots - len(assigned[j.farm_id])) for j in order}

    # Pass A: a fair first share for everyone, in priority order.
    for job in order:
        need = remaining[job.farm_id]
        if need <= 0 or blocks(assigned[job.farm_id] - set(range(t0, T))) >= job.max_starts:
            continue
        share = max(job.min_run, math.ceil(need * 0.5))
        if place(job, min(share, need)):
            remaining[job.farm_id] = job.required_slots - len(assigned[job.farm_id])

    # Pass B: fill the rest, extending first, then a second block if starts allow.
    for job in order:
        need = remaining[job.farm_id]
        if need <= 0:
            continue
        if any(s >= t0 for s in assigned[job.farm_id]):
            need -= extend(job, need)
        if need >= job.min_run and blocks(assigned[job.farm_id]) < job.max_starts:
            if place(job, need):
                need = job.required_slots - len(assigned[job.farm_id])
        remaining[job.farm_id] = max(0, need)

    return {j.farm_id: sorted(assigned[j.farm_id]) for j in p.jobs}
