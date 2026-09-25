"""`unswbc auth`: the API key this machine submits with."""

from __future__ import annotations

import json
import os
import pathlib
import re

from . import api
from .errors import UserError, fail

STORE = ".unswbc/keys.json"
SHAPE = re.compile(r"^bc_[A-Za-z0-9_-]+$")


def _path() -> pathlib.Path:
    try:
        return pathlib.Path.home() / STORE
    except RuntimeError as error:
        raise UserError("cannot find your home directory; set HOME") from error


def _load() -> dict:
    try:
        table = json.loads(_path().read_text())
    except (OSError, ValueError):
        return {}
    return table if isinstance(table, dict) else {}


def _save(table: dict) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with open(handle, "w", encoding="utf-8") as out:
        json.dump(table, out, indent=2, sort_keys=True)


def key() -> str | None:
    return os.environ.get("UNSWBC_KEY") or _load().get(api.server())


def _masked(token: str) -> str:
    return f"{token[:6]}...{token[-4:]}" if len(token) > 14 else "set"


def _whose(token: str) -> str:
    who = api.request("me", key=token)
    team = who.get("team") or {}
    user = who.get("user") or {}
    return f"team {team.get('name', '?')} as {user.get('username', '?')}"


def set_key(token: str | None) -> int:
    token = (token or "").strip()
    if not SHAPE.match(token):
        return fail("that is not an API key; make one on your team page (it starts with bc_)")
    try:
        whose = _whose(token)
    except api.ApiError as error:
        if error.status in (401, 403):
            return fail(str(error))
        whose = f"could not check it now ({error})"
    table = _load()
    table[api.server()] = token
    _save(table)
    print(f"saved the key for {api.server()} in {_path()}")
    print(f"  {whose}")
    return 0


def status() -> int:
    print(f"server: {api.server()}")
    token = key()
    if not token:
        print("no key here; run `unswbc auth set <token>`")
        return 1
    where = "UNSWBC_KEY" if os.environ.get("UNSWBC_KEY") else str(_path())
    print(f"key:    {_masked(token)} (from {where})")
    try:
        print(f"  {_whose(token)}")
    except api.ApiError as error:
        print(f"  {error}")
        return 1
    return 0


def clear() -> int:
    table = _load()
    if table.pop(api.server(), None) is None:
        print(f"no stored key for {api.server()}")
    else:
        _save(table)
        print(f"removed the stored key for {api.server()}")
    if os.environ.get("UNSWBC_KEY"):
        print("UNSWBC_KEY is still set in this shell, and it wins")
    return 0


def command(action: str, token: str | None) -> int:
    if action == "set":
        return set_key(token)
    if action == "clear":
        return clear()
    return status()
