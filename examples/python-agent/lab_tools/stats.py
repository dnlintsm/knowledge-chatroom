"""The agent's actual work, as plain Python with no MCP or SDK imports.

Keep tool logic here so it can be unit-tested on its own and called the same way
from the MCP server (server.py) or from an old Claude Agent SDK agent
(before/agent.py).
"""

from __future__ import annotations

import math
import statistics
from dataclasses import asdict, dataclass


@dataclass
class MetricSummary:
    n: int
    mean: float
    std: float
    median: float
    min: float
    max: float


@dataclass
class Comparison:
    baseline: MetricSummary
    candidate: MetricSummary
    difference: float
    percent_change: float | None
    welch_t: float | None
    verdict: str


def describe_metric(values: list[float]) -> MetricSummary:
    """Summary statistics for one metric's values (at least one value)."""
    if not values:
        raise ValueError("give at least one value")
    return MetricSummary(
        n=len(values),
        mean=statistics.fmean(values),
        std=statistics.stdev(values) if len(values) > 1 else 0.0,
        median=statistics.median(values),
        min=min(values),
        max=max(values),
    )


def compare_runs(baseline: list[float], candidate: list[float], higher_is_better: bool = True) -> Comparison:
    """How a candidate run's metric differs from a baseline's (Welch's t for noise)."""
    a, b = describe_metric(baseline), describe_metric(candidate)
    difference = b.mean - a.mean
    percent = difference / abs(a.mean) * 100 if a.mean else None
    spread = (a.std**2 / a.n + b.std**2 / b.n) if a.n > 1 and b.n > 1 else 0.0
    welch_t = difference / math.sqrt(spread) if spread > 0 else None

    if welch_t is None:
        verdict = "not enough repeats to tell noise from change"
    elif abs(welch_t) < 2:
        verdict = "within noise"
    elif (difference > 0) == higher_is_better:
        verdict = "better"
    else:
        verdict = "worse"
    return Comparison(a, b, difference, percent, welch_t, verdict)


def as_dict(result: MetricSummary | Comparison) -> dict:
    """Dataclasses → JSON-ready dicts for tool results."""
    return asdict(result)
