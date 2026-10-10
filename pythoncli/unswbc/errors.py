"""Errors `unswbc` understands: one line to the user, never a traceback."""

from __future__ import annotations

import pathlib
import re
import sys
import time

LOG_CAP = 1 << 20
SECRET = re.compile(r"bc_[A-Za-z0-9_-]{4,}")


class UserError(Exception):
    pass


def log_path() -> pathlib.Path:
    return pathlib.Path.home() / ".unswbc" / "log"


def redact(text: str) -> str:
    return SECRET.sub(lambda found: f"{found.group()[:6]}...", text)


def record(text: str) -> str:
    try:
        path = log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_file() and path.stat().st_size > LOG_CAP:
            path.write_text(path.read_text(errors="replace")[-(LOG_CAP // 2):])
        with path.open("a", encoding="utf-8") as out:
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            said = redact(" ".join(sys.argv[1:]))
            out.write(f"\n=== {stamp}  unswbc {said}\n{redact(text)}")
        return str(path)
    except Exception:
        return "no log file"


def fail(message: str) -> int:
    record(f"{message}\n")
    print(f"error: {message}", file=sys.stderr)
    return 1
