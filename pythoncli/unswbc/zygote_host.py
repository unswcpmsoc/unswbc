"""The judge's zygote, on the host interpreter.

A port of `judge/sandbox/guest-bin/zygote.py`: the same stdout buffering, the
same flush before every stdin read, the same READY and activation handshake,
the same exit codes and traceback trimming. Host-only: the bot's own source
instead of `/bot/main.pyc`, and a park line so the runner can end a turn when
the bot blocks on empty stdin.
"""

import builtins
import io
import os
import sys

PARK = b"\x00UNSWBC PARK"
_read_total = 0

try:
    import select as _select
except ImportError:
    _select = None


def raw_read(n):
    global _read_total
    if _select is not None:
        try:
            ready = _select.select([0], [], [], 0)[0]
        except OSError:
            ready = [0]
        if not ready:
            try:
                sys.stdout.flush()
            except (ValueError, OSError):
                pass
            os.write(1, b"%s %d\n" % (PARK, _read_total))
    chunk = os.read(0, n)
    _read_total += len(chunk)
    return chunk


class CountingStdin(io.RawIOBase):
    def readable(self):
        return True

    def readinto(self, buf):
        chunk = raw_read(len(buf))
        buf[: len(chunk)] = chunk
        return len(chunk)


_stdin_buf = bytearray()


def guest_input(prompt=""):
    if prompt:
        sys.stdout.write(prompt)
        sys.stdout.flush()

    while True:
        nl = _stdin_buf.find(b"\n")

        if nl >= 0:
            line = _stdin_buf[:nl]
            del _stdin_buf[: nl + 1]
            if line.endswith(b"\r"):
                line = line[:-1]
            return line.decode("utf-8", "surrogateescape")

        sys.stdout.flush()
        chunk = raw_read(4096)

        if not chunk:
            if not _stdin_buf:
                raise EOFError

            line = bytes(_stdin_buf)
            _stdin_buf.clear()

            if line.endswith(b"\r"):
                line = line[:-1]

            return line.decode("utf-8", "surrogateescape")

        _stdin_buf.extend(chunk)


class FlushingStdin(io.TextIOWrapper):
    """Reading the next turn sends whatever the bot has printed first, so a
    bot that never flushes still gets its reply out."""

    def read(self, *args):
        sys.stdout.flush()
        return super().read(*args)

    def readline(self, *args):
        sys.stdout.flush()
        return super().readline(*args)

    def __next__(self):
        sys.stdout.flush()
        return super().__next__()


def attach_stdio():
    sys.stdout = io.TextIOWrapper(open(1, "wb", buffering=1 << 16, closefd=False), encoding="UTF-8")
    sys.stdin = FlushingStdin(io.BufferedReader(CountingStdin(), 1 << 13),
                              encoding="UTF-8", errors="surrogateescape")
    sys.stderr = io.TextIOWrapper(os.fdopen(2, "wb", closefd=False), encoding="UTF-8",
                                  line_buffering=True)


def match_environ():
    """What the guest sees: the judge's six variables and nothing else. Read
    after startup, so none of it changes this interpreter."""
    os.environ.pop("LC_CTYPE", None)
    os.environ["PYTHONHOME"] = sys.base_prefix
    os.environ["PYTHONPYCACHEPREFIX"] = "/pycache"


def deny_threads():
    import _thread

    def start_new_thread(*args, **kwargs):
        raise RuntimeError("can't start new thread")

    _thread.start_new_thread = start_new_thread
    threading = sys.modules.get("threading")
    if threading is not None:
        threading._start_new_thread = start_new_thread


def write_stderr(text):
    try:
        sys.stderr.write(text)
        sys.stderr.flush()
    except BaseException:
        try:
            os.write(2, text.encode("utf-8", "replace"))
        except BaseException:
            pass


def exit_now(code):
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except BaseException:
        pass

    try:
        os._exit(code)
    except BaseException:
        raise SystemExit(code)


def print_exception(exc):
    try:
        frames = []
        tb = exc.__traceback__

        while tb is not None:
            frames.append(tb)
            tb = tb.tb_next

        if (
            len(frames) > 1
            and getattr(frames[-1].tb_frame.f_code, "co_filename", "").endswith("zygote_host.py")
        ):
            frames = frames[:-1]

        parts = ["Traceback (most recent call last):\n"]
        for tb in frames:
            code = tb.tb_frame.f_code
            parts.append(
                f'  File "{code.co_filename}", line {tb.tb_lineno}, in {code.co_name}\n'
            )

        parts.append(f"{type(exc).__name__}: {exc}\n")
        write_stderr("".join(parts))
    except BaseException:
        write_stderr(f"{type(exc).__name__}: {exc}\n")


def run(path):
    import random

    sys.path.insert(0, os.path.dirname(path) or ".")
    with open(path, "rb") as handle:
        code = compile(handle.read(), path, "exec")
    attach_stdio()
    deny_threads()
    match_environ()
    print("READY", flush=True)

    if not raw_read(1):
        raise SystemExit(0)

    random.seed()
    builtins.input = guest_input

    try:
        exec(code, {"__name__": "__main__", "__file__": path})

    except SystemExit as e:
        if e.code is None:
            exit_now(0)

        if isinstance(e.code, int):
            exit_now(e.code)

        write_stderr(f"{e.code}\n")
        exit_now(1)

    except BaseException as exc:
        print_exception(exc)
        exit_now(1)

    exit_now(0)


if __name__ == "__main__":
    run(sys.argv[1])
