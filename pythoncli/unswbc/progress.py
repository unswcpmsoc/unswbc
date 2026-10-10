"""A line that keeps moving while a one-time job runs, so a wait looks like work.

Compiling the judge's toolchains to native code takes seconds to a minute on
first use and says nothing while it runs. The bar approaches full without ever
reaching it, because how long it takes is the machine's business, not ours.
"""

from __future__ import annotations

import contextlib
import math
import sys
import threading
import time

WIDTH = 24
TICK = 0.2


def _bar(spent: float, estimate: float) -> str:
    filled = round(WIDTH * (1 - math.exp(-spent / max(estimate, 1.0))))
    return "#" * filled + "-" * (WIDTH - filled)


@contextlib.contextmanager
def waiting(label: str, estimate: float):
    started = time.monotonic()
    if not sys.stdout.isatty():
        print(f"{label}...", flush=True)
        yield
        print(f"{label}: {time.monotonic() - started:.0f}s", flush=True)
        return

    done = threading.Event()

    def draw() -> None:
        while not done.is_set():
            spent = time.monotonic() - started
            print(f"\r{label} [{_bar(spent, estimate)}] {spent:3.0f}s", end="", flush=True)
            done.wait(TICK)

    ticker = threading.Thread(target=draw, daemon=True)
    ticker.start()
    try:
        yield
    finally:
        done.set()
        ticker.join(timeout=1.0)
        spent = time.monotonic() - started
        print(f"\r{label} [{'#' * WIDTH}] {spent:3.0f}s", flush=True)
