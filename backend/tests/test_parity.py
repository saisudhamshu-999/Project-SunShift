"""The shared parity fixture must describe the Python engine as it is now."""

import json

import pytest

from .parity import FIXTURE, build


def test_parity_fixture_is_current():
    assert FIXTURE.is_file(), "missing fixture: run python -m tests.parity"
    stored = json.loads(FIXTURE.read_text(encoding="utf-8"))
    fresh = json.loads(json.dumps(build()))
    assert stored["greedy"] == fresh["greedy"], "greedy changed: run python -m tests.parity"
    for kind in ("et0", "assess"):
        assert len(stored[kind]) == len(fresh[kind])
        for a, b in zip(stored[kind], fresh[kind]):
            assert a["input"] == b["input"]
            for k, v in b["output"].items():
                if isinstance(v, float):
                    assert a["output"][k] == pytest.approx(v, rel=1e-9, abs=1e-12), (kind, a["input"], k)
                else:
                    assert a["output"][k] == v, (kind, a["input"], k)
