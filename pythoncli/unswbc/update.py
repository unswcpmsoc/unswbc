"""Say when the toolkit is out of date, and run the line that updates it."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request

from . import __version__

PYPI = "https://pypi.org/pypi/unswbc/json"
TTL = 24 * 60 * 60
TIMEOUT = 2.0


def _path() -> pathlib.Path | None:
    try:
        return pathlib.Path.home() / ".unswbc" / "update.json"
    except RuntimeError:
        return None


def _load() -> dict:
    try:
        seen = json.loads(_path().read_text(encoding="utf-8"))
    except (AttributeError, OSError, ValueError):
        return {}
    return seen if isinstance(seen, dict) else {}


def _save(seen: dict) -> None:
    path = _path()
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(seen), encoding="utf-8")
    except OSError:
        pass


def _rank(text: str) -> tuple:
    return tuple(int(part) for part in text.split(".") if part.isdigit())


def refresh() -> None:
    if os.environ.get("UNSWBC_NO_UPDATE"):
        return
    when = _load().get("when")
    if isinstance(when, (int, float)) and time.time() - when < TTL:
        return
    try:
        ask = urllib.request.Request(PYPI, headers={"User-Agent": f"unswbc/{__version__}"})
        with urllib.request.urlopen(ask, timeout=TIMEOUT) as reply:
            _save({"latest": str(json.loads(reply.read())["info"]["version"]), "when": time.time()})
    except Exception:
        pass


def installer() -> str:
    where = pathlib.Path(sys.prefix).as_posix().lower()
    if "/uv/tools/" in where:
        return "uv"
    if "/pipx/venvs/" in where:
        return "pipx"
    return "pip"


def pip_command() -> str:
    python = f'"{sys.executable}"' if " " in sys.executable else sys.executable
    return f"{python} -m pip"


def upgrade_command() -> str:
    kind = installer()
    if kind == "uv":
        return "uv tool install unswbc@latest"
    if kind == "pipx":
        return "pipx upgrade unswbc"
    return f"{pip_command()} install --upgrade unswbc"


def _interactive() -> bool:
    return sys.stdin.isatty() and sys.stdout.isatty()


def nag() -> None:
    if os.environ.get("UNSWBC_NO_UPDATE"):
        return
    seen = _load()
    latest = str(seen.get("latest") or "")
    if not latest or _rank(latest) <= _rank(__version__):
        return
    try:
        sys.stdout.flush()
    except Exception:
        pass
    command = upgrade_command()
    asked = seen.get("asked")
    fresh = isinstance(asked, (int, float)) and time.time() - asked < TTL
    try:
        print(f"\nunswbc {latest} is out, you have {__version__}.", file=sys.stderr)
        if fresh or not _interactive():
            print(f"  {command}", file=sys.stderr)
            return
        _save({**seen, "asked": time.time()})
        answer = input("update now? [Y/n] ").strip().lower()
        if answer and not answer.startswith("y"):
            print(f"  {command}", file=sys.stderr)
            return
        if subprocess.call(command, shell=True) != 0:
            print(f"the update did not go through; run `{command}` yourself", file=sys.stderr)
    except Exception:
        pass
