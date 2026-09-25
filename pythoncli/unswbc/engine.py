"""Drives the Battlecode engine, compiled from engine/ to WebAssembly."""

from __future__ import annotations

import pathlib
import sys
from dataclasses import dataclass
from typing import Callable

try:
    from wasmtime import Engine, FuncType, Linker, Module, Store, ValType, WasiConfig
except (ImportError, OSError) as error:
    WASM_RUNTIME_ERROR: Exception | None = error
else:
    WASM_RUNTIME_ERROR = None

from . import toolchain
from .errors import UserError

WASM_PATH = pathlib.Path(__file__).with_name("unswbc_engine.wasm")

REPLY_CAP = 1 << 16

# Bot output to keep, matching the bits ubc_run reads in shim/shim.cc.
DEBUG_LOGS = 1
DEBUG_INDICATOR = 2
DEBUG_DRAW = 4
DEBUG_PARSE = 8
DEBUG_ALL = DEBUG_LOGS | DEBUG_INDICATOR | DEBUG_DRAW | DEBUG_PARSE
# Holds bot output to the judge's limits; without it a local run keeps all of it.
DEBUG_LIMITS = 16


@dataclass
class MatchResult:
    rounds: int
    winner: str | None
    end_reason: int
    a_dragons: int
    b_dragons: int
    a_length: int
    b_length: int
    events: int


class EngineModule:
    def __init__(self, wasm_path: pathlib.Path = WASM_PATH) -> None:
        if WASM_RUNTIME_ERROR is not None:
            raise toolchain.wasm_runtime(WASM_RUNTIME_ERROR)
        if not pathlib.Path(wasm_path).is_file():
            raise UserError(f"this build ships no engine, so no match can run ({wasm_path})")
        self._engine = Engine()
        self._module = Module.from_file(self._engine, str(wasm_path))
        self._live: tuple | None = None

    def run(
        self,
        map_bytes: bytes,
        bot_reply: Callable[[int, bytes], bytes],
        on_death: Callable[[int, int, str], None] | None = None,
        bot_spawn: Callable[[int, bytes], None] | None = None,
        on_notice: Callable[[str], None] | None = None,
        debug: int = DEBUG_ALL,
    ) -> MatchResult:
        store = Store(self._engine)
        wasi = WasiConfig()
        notice = on_notice or (lambda line: print(line, file=sys.stderr, flush=True))
        pending = bytearray()

        def _stderr(chunk: bytes) -> int:
            pending.extend(chunk)
            while b"\n" in pending:
                line, _, rest = bytes(pending).partition(b"\n")
                pending[:] = rest
                notice(line.decode(errors="replace"))
            return len(chunk)

        wasi.stderr_custom = _stderr
        store.set_wasi(wasi)

        linker = Linker(self._engine)
        linker.define_wasi()
        state: dict = {}

        def _bot_reply(dragon_id: int, ptr: int, length: int, out: int, cap: int) -> int:
            memory = state["memory"]
            reply = state.pop("long", None)
            if reply is None:
                reply = bot_reply(dragon_id, bytes(memory.read(store, ptr, ptr + length)))
            # Too long for the buffer: the engine grows it and asks again.
            if len(reply) > cap:
                state["long"] = reply
                return len(reply)
            memory.write(store, reply, out)
            return len(reply)

        def _log(dragon_id: int, round_num: int, reason: int) -> None:
            if on_death is not None:
                on_death(dragon_id, round_num, chr(reason))

        def _bot_spawn(dragon_id: int, ptr: int, length: int) -> None:
            if bot_spawn is None:
                return
            memory = state["memory"]
            bot_spawn(dragon_id, bytes(memory.read(store, ptr, ptr + length)))

        i32 = ValType.i32()
        linker.define_func("unswbc", "bot_reply", FuncType([i32] * 5, [i32]), _bot_reply)
        linker.define_func("unswbc", "log", FuncType([i32] * 3, []), _log)
        linker.define_func("unswbc", "bot_spawn", FuncType([i32] * 3, []), _bot_spawn)

        instance = linker.instantiate(store, self._module)
        exports = instance.exports(store)
        state["memory"] = exports["memory"]
        initialize = exports.get("_initialize")
        if initialize is not None:
            initialize(store)

        encoded = map_bytes
        map_ptr = exports["ubc_alloc"](store, len(encoded))
        state["memory"].write(store, encoded, map_ptr)
        out_ptr = exports["ubc_alloc"](store, 8 * 4)

        code = exports["ubc_run"](store, map_ptr, len(encoded), debug, out_ptr)
        if pending:
            notice(bytes(pending).decode(errors="replace"))
        if code != 0:
            raise RuntimeError(self._read_error(store, exports, state["memory"]))

        self._live = (store, exports, state["memory"])
        raw = bytes(state["memory"].read(store, out_ptr, out_ptr + 32))
        values = [int.from_bytes(raw[i * 4 : i * 4 + 4], "little", signed=True) for i in range(8)]
        return MatchResult(
            rounds=values[0],
            winner={0: None, 1: "A", 2: "B"}[values[1]],
            end_reason=values[2],
            a_dragons=values[3],
            b_dragons=values[4],
            a_length=values[5],
            b_length=values[6],
            events=values[7],
        )

    def replay(self, team_a: str, team_b: str) -> bytes:
        if self._live is None:
            raise RuntimeError("no match has been run")
        store, exports, memory = self._live

        names = []
        for name in (team_a, team_b):
            encoded = name.encode()
            ptr = exports["ubc_alloc"](store, len(encoded))
            memory.write(store, encoded, ptr)
            names += [ptr, len(encoded)]

        size = exports["ubc_replay"](store, *names)
        for ptr in (names[0], names[2]):
            exports["ubc_free"](store, ptr)
        if size < 0:
            raise RuntimeError(self._read_error(store, exports, memory))

        base = exports["ubc_replay_ptr"](store)
        return bytes(memory.read(store, base, base + size))

    @staticmethod
    def _read_error(store, exports, memory) -> str:
        ptr = exports["ubc_error"](store)
        out = bytearray()
        while True:
            byte = bytes(memory.read(store, ptr, ptr + 1))
            if not byte or byte == b"\0":
                break
            out += byte
            ptr += 1
        # A complaint about a map quotes the line it choked on, which in a
        # corrupt file is not text at all.
        return out.decode(errors="replace") or "engine failed"
