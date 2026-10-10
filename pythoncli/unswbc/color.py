"""ANSI colour, only where the terminal takes it."""

from __future__ import annotations

import os
import sys

CODES = {"yellow": "\033[33m", "green": "\033[32m"}
RESET = "\033[0m"


def _windows_vt() -> bool:
    try:
        import ctypes

        kernel = ctypes.windll.kernel32
        handle = kernel.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(kernel.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:
        return False


def _enabled() -> bool:
    if os.environ.get("NO_COLOR") is not None or os.environ.get("TERM") == "dumb":
        return False
    if os.environ.get("FORCE_COLOR"):
        return True
    if not sys.stdout.isatty():
        return False
    return _windows_vt() if sys.platform == "win32" else True


ON = _enabled()


def paint(text: str, name: str) -> str:
    return f"{CODES[name]}{text}{RESET}" if ON and text else text
