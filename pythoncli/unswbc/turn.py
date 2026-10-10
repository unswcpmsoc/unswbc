"""One turn, framed and ended the way the judge does, for both backends.

`Framer` is `judge/sandbox/src/stdio/stdout.rs feed_bytes`; `TurnBot` is
`pool.rs execute` with the outcome rules of `match.cc RunTurn`.
"""

from __future__ import annotations

import threading
import time

TERMINATOR = b"ENDTURN"
PARK = b"\x00UNSWBC PARK"
BUFFER_LIMIT = 10 * 1024
WALL_LIMIT_S = 10.0


def payload(block: bytes, activate: bool) -> bytes:
    return ((b"R" if activate else b"") + block
            + (b"" if block.endswith(b"\n\n") else b"\n"))


class Framer:
    """READY is swallowed in any phase, lines count only while armed, ENDTURN
    ends the turn and the rest of that write is never seen."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.armed = False
        self.done = False
        self.park_at = None
        self.out = bytearray()
        self.line = bytearray()

    def arm(self) -> None:
        with self.lock:
            self.out.clear()
            self.line.clear()
            self.armed, self.done, self.park_at = True, False, None

    def feed(self, chunk: bytes) -> bool:
        with self.lock:
            return self._feed(chunk)

    def _feed(self, chunk: bytes) -> bool:
        for byte in chunk:
            if byte != 0x0A:
                if len(self.line) < BUFFER_LIMIT:
                    self.line.append(byte)
                continue
            line = bytes(self.line).removesuffix(b"\r")
            self.line.clear()
            if line == b"READY":
                continue
            if line.startswith(PARK):
                tail = line[len(PARK):].strip()
                self.park_at = int(tail.decode("ascii")) if tail.isdigit() else -1
                continue
            if not self.armed:
                continue
            if line == TERMINATOR:
                self.armed, self.done = False, True
                return True
            room = BUFFER_LIMIT - len(self.out)
            if room > 0:
                self.out += line[:room]
                if len(self.out) < BUFFER_LIMIT:
                    self.out += b"\n"
        return False

    def take(self) -> bytes:
        with self.lock:
            room = BUFFER_LIMIT - len(self.out)
            if room > 0 and not self.done:
                self.out += self.line[:room]
            self.line.clear()
            out = bytes(self.out).decode("utf-8", "replace").encode()
            self.out.clear()
            return out


class TurnBot:
    """A turn ends on the first of ENDTURN, a stdin park, an exit or the wall
    limit; only the first two keep the reply, the rest replace the worker. A
    worker that died between turns is replaced before the turn, not skipped."""

    def __init__(self, init: bytes = b"", name: str = "0") -> None:
        self._init, self._name = init, name
        self._framer = Framer()
        self._activate = False
        self._written = 0
        self.error: str | None = None

    def ask(self, block: bytes) -> bytes:
        self.error = None
        if not self._running():
            self._fresh()
        for attempt in (0, 1):
            self._framer.arm()
            data = payload((self._init if self._new else b"") + block, self._activate)
            if not self._write(data):
                if attempt == 0:
                    self._fresh()
                    continue
                return self._skip(self._reason())
            self._written += len(data)
            self._activate = self._new = False
            deadline = time.monotonic() + WALL_LIMIT_S
            while True:
                state = self._poll(max(0.0, deadline - time.monotonic()))
                if self._framer.done or self._framer.park_at == self._written or state == "park":
                    return self._framer.take()
                if state == "exit":
                    break
                if time.monotonic() >= deadline:
                    self._kill()
                    return self._skip("ran out of time")
            reason = self._reason()
            if attempt or self._framer.out or self._framer.line:
                return self._skip(reason)
            self._fresh()
        return b""

    def _fresh(self) -> None:
        self.start()
        self._written, self._new = 0, True

    def take_stderr(self) -> bytes:
        return b""

    def _skip(self, reason: str) -> bytes:
        self.error = reason
        self.stop()
        return b""
