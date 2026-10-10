"""Where `unswbc` talks to the contest server."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from . import __version__
from .errors import UserError

DEFAULT_SERVER = "https://game.battlecode.au"
TIMEOUT = 120


class ApiError(UserError):
    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


def server() -> str:
    return (os.environ.get("UNSWBC_SERVER") or DEFAULT_SERVER).rstrip("/")


def url(path: str) -> str:
    return f"{server()}/api/v1/{path.lstrip('/')}"


def _reason(error: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(error.read() or b"{}")
    except ValueError:
        body = {}
    if isinstance(body, dict) and body.get("error"):
        return str(body["error"])
    if error.code == 404:
        return f"{server()} serves no toolkit API; the contest may not be open yet"
    return f"{error.code} {error.reason}"


def request(path: str, key: str | None = None, method: str = "GET",
            body: bytes | None = None, content_type: str | None = None) -> dict:
    ask = urllib.request.Request(url(path), data=body, method=method)
    ask.add_header("User-Agent", f"unswbc/{__version__}")
    ask.add_header("Origin", server())
    if key:
        ask.add_header("Authorization", f"Bearer {key}")
    if content_type:
        ask.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(ask, timeout=TIMEOUT) as reply:
            raw = reply.read()
    except urllib.error.HTTPError as error:
        raise ApiError(_reason(error), error.code) from error
    except (urllib.error.URLError, OSError) as error:
        raise ApiError(f"cannot reach {server()}: {error}") from error
    try:
        return json.loads(raw) if raw else {}
    except ValueError as error:
        raise ApiError(f"{server()} replied with something that is not JSON") from error
