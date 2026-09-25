"""A bot is an ordinary process: a round block goes in, a reply comes back."""

from __future__ import annotations

import os
import pathlib
import socket
import subprocess
import sys
import threading

if sys.platform != "win32":
    import array
    import fcntl
    import select
    import termios

from .turn import TurnBot

WARM_SPARES = 8
CHUNK = 1 << 20
STDERR_CAP = 10 * 1024
ZYGOTE = str(pathlib.Path(__file__).with_name("zygote_host.py"))
GUEST_ENV = {"TERM": "dumb", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONHASHSEED": "0",
             "PYTHONUNBUFFERED": "1"}
KEEP_ENV = ("SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "LOCALAPPDATA", "LocalAppData")


def guest_env() -> dict:
    env = {k: v for k, v in os.environ.items() if k in KEEP_ENV}
    env.update(GUEST_ENV)
    return env


class _PollReader:
    def __init__(self, stream) -> None:
        self._stream = stream
        self._fd = stream.fileno()
        self._poll = select.poll()
        self._poll.register(stream, select.POLLIN)

    def read(self, timeout: float | None = None) -> bytes | None:
        if not self._poll.poll(None if timeout is None else timeout * 1000.0):
            return None
        return os.read(self._fd, CHUNK)


class _ThreadReader:
    """Windows has no poll() on pipes, so a thread blocks on the read instead
    and the turn waits on it -- the same shape as the native runner's Drain."""

    def __init__(self, stream) -> None:
        self._stream = stream
        self._chunks: list[bytes] = []
        self._eof = False
        self._ready = threading.Condition()
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self) -> None:
        while True:
            try:
                chunk = self._stream.read(CHUNK)
            except (OSError, ValueError):
                chunk = b""
            with self._ready:
                if chunk:
                    self._chunks.append(chunk)
                else:
                    self._eof = True
                self._ready.notify()
            if not chunk:
                return

    def read(self, timeout: float | None = None) -> bytes | None:
        with self._ready:
            while not self._chunks and not self._eof:
                if self._ready.wait(1.0 if timeout is None else timeout) or timeout is not None:
                    break
            if self._chunks:
                out = b"".join(self._chunks)
                self._chunks.clear()
                return out
            return b"" if self._eof else None


_Reader = _ThreadReader if sys.platform == "win32" else _PollReader


def _record_pair():
    """The judge sees each guest `fd_write` whole and drops what follows
    ENDTURN in it; a pipe loses those edges, a SOCK_SEQPACKET pair keeps them."""
    if not hasattr(socket, "SOCK_SEQPACKET"):
        return None
    try:
        return socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    except (AttributeError, OSError):
        return None


class Pool:
    def __init__(self, argv: list[str], cwd: str | None = None, size: int = WARM_SPARES,
                 team: str = "a") -> None:
        self._argv = argv
        self._cwd = cwd
        self._size = size
        self.zygote = ZYGOTE in argv
        self._env = guest_env() if self.zygote else None
        self._spares: list[tuple] = []
        self._fill()

    def _launch(self) -> tuple:
        pair = _record_pair()
        process = subprocess.Popen(
            self._argv,
            cwd=self._cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE if pair is None else pair[1],
            stderr=subprocess.PIPE,
            bufsize=0,
            env=self._env,
        )
        if pair is None:
            return (process, _Reader(process.stdout), _Reader(process.stderr))
        pair[1].close()
        return (process, _Reader(pair[0]), _Reader(process.stderr))

    def _fill(self) -> None:
        while len(self._spares) < self._size:
            self._spares.append(self._launch())

    def take(self) -> tuple:
        spare = self._spares.pop() if self._spares else self._launch()
        self._fill()
        return spare

    def close(self) -> None:
        self._size = 0
        for spare in self._spares:
            spare[0].kill()
            spare[0].wait()
        self._spares.clear()


class Bot(TurnBot):
    def __init__(self, pool: Pool, init: bytes = b"", name: str = "0") -> None:
        super().__init__(init, name)
        self._pool = pool
        self._process: subprocess.Popen | None = None
        self._parks = 0
        self._stderr = bytearray()

    def _running(self) -> bool:
        return self._process is not None

    def start(self) -> None:
        self.stop()
        self._process, self._reader, self._err = self._pool.take()
        self._activate = self._pool.zygote
        while self._reader.read(0.0):
            pass

    def stop(self) -> None:
        if self._process is None:
            return
        self._process.kill()
        self._process.wait()
        self._process = None

    _kill = stop

    def _write(self, data: bytes) -> bool:
        try:
            # An unbuffered pipe write can be short; the bot would then wait
            # forever for the rest of its block.
            view = memoryview(data)
            while view:
                view = view[self._process.stdin.write(view) or 0 :]
        except (BrokenPipeError, OSError, ValueError):
            return False
        return True

    def take_stderr(self) -> bytes:
        out, self._stderr = bytes(self._stderr), bytearray()
        return out

    def _poll(self, timeout: float) -> str:
        noise = self._err.read(0.0)
        if noise and len(self._stderr) < STDERR_CAP:
            self._stderr += noise[: STDERR_CAP - len(self._stderr)]
        chunk = self._reader.read(min(timeout, 0.005))
        if chunk:
            self._parks = 0
            self._framer.feed(chunk)
            return "data"
        if chunk == b"":
            return "exit"
        self._parks = self._parks + 1 if _parked_on_stdin(self._process) else 0
        return "park" if self._parks > 1 else "wait"

    def _reason(self) -> str:
        try:
            code = self._process.wait(0.05)
        except (AttributeError, subprocess.TimeoutExpired):
            return "exited"
        return f"exited with code {code}"


def _parked_on_stdin(process: subprocess.Popen) -> bool:
    """The judge ends a turn when the bot blocks on empty stdin: on Linux that
    is `read(0)` in /proc with nothing left in the pipe. Without the pipe test a
    bot that has not yet woken from the previous turn's read looks parked."""
    if sys.platform != "linux":
        return False
    try:
        pending = array.array("i", [0])
        fcntl.ioctl(process.stdin.fileno(), termios.FIONREAD, pending, True)
        if pending[0]:
            return False
        with open(f"/proc/{process.pid}/syscall") as handle:
            fields = handle.read().split()
    except (OSError, ValueError):
        return False
    return len(fields) > 2 and fields[0] in ("0", "63") and fields[1] == "0x0"
