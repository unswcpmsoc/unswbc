"""Runs a Python bot the way the judge does: the judge's own CPython, inside
wasmtime, on a virtual clock denominated in CPU points.

The judge's interpreter is a WASIX build, and WASIX is Wasmer's. Only a handful
of those calls are ever reached, so this defines them here: a read-only
filesystem over the bundled stdlib, signature reflection over the module's own
function table, and the judge's own clock, entropy and syscall policy.
"""

from __future__ import annotations

import collections
import ctypes
import hashlib
import os
import pathlib
import queue
import shutil
import struct
import sys
import tempfile
import threading
import time

try:
    from wasmtime import (Config, Engine, FuncType, Limits, Linker, MemoryType,
                          Module, SharedMemory, Store, ValType)
except (ImportError, OSError) as error:
    WASM_RUNTIME_ERROR: Exception | None = error
else:
    WASM_RUNTIME_ERROR = None

from . import metering, progress, toolchain
from .errors import UserError
from .project import BUILD_DIR_NAME
from .turn import TurnBot

WASM_PATH = pathlib.Path(__file__).with_name("python-metered.wasm")
ROOT_PATH = pathlib.Path(__file__).with_name("sandbox-root")
MAX_TURN_POINTS = 100_000_000
MAX_MEMORY_PAGES = 768
INTERPRETER_RATE = 12e6
GUEST_ENV = ["TERM=dumb", "PYTHONDONTWRITEBYTECODE=1", "PYTHONHASHSEED=0",
             "PYTHONHOME=/usr/local", "PYTHONUNBUFFERED=1", "PYTHONPYCACHEPREFIX=/pycache"]
VIRTUAL_EPOCH_NS = 1_767_225_600_000_000_000
WRITE_SYSCALL_COST = 2_500_000
WRITE_BYTE_COST = 4_000
READ_BYTE_COST = 6
U64 = 0xFFFFFFFFFFFFFFFF

OK, E2BIG, EACCES, EBADF, EINVAL, EISDIR = 0, 1, 2, 8, 28, 31
ENOENT, ENOSYS, ENOTDIR, ENOTSUP, ENOTTY = 44, 52, 54, 58, 59
EOVERFLOW, ERANGE, EROFS, EEXIST = 61, 68, 69, 20
DIR, REGULAR, CHARACTER = 3, 4, 2
ALL_RIGHTS = U64

DENIED = frozenset("""callback_signal dl_invalid_handle dlopen dlsym epoll_create epoll_ctl
epoll_wait fd_event fd_pipe proc_exec4 proc_fork proc_join proc_raise proc_signal proc_spawn3
sock_connect sock_open sock_send sock_send_file sock_send_to thread-spawn thread_join
thread_signal thread_sleep tty_set""".split())
EXITS = frozenset(("proc_exit", "proc_exit2", "thread_exit"))

_VALTYPE = {"i32": ValType.i32, "i64": ValType.i64, "f32": ValType.f32, "f64": ValType.f64}


class Unsupported(Exception):
    pass


class SandboxError(UserError, RuntimeError):
    pass


class Exit(Exception):
    def __init__(self, code: int) -> None:
        self.code = code


class Rng:
    """xoshiro256**, seeded as judge/sandbox/src/limits/rng.rs seeds it."""

    def __init__(self, template: str, process: str) -> None:
        h = 0xCBF29CE484222325
        for byte in template.encode() + b"\0" + process.encode():
            h = ((h ^ byte) * 0x00000100000001B3) & U64
        self.state = []
        for _ in range(4):
            h = (h + 0x9E3779B97F4A7C15) & U64
            z = h
            z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & U64
            z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & U64
            self.state.append(z ^ (z >> 31))
        self.used = 0

    def _next(self) -> int:
        self.used += 1
        s = self.state
        rotl = lambda v, k: ((v << k) | (v >> (64 - k))) & U64
        out = (rotl((s[1] * 5) & U64, 7) * 9) & U64
        t = (s[1] << 17) & U64
        s[2] ^= s[0]
        s[3] ^= s[1]
        s[1] ^= s[2]
        s[0] ^= s[3]
        s[2] ^= t
        s[3] = rotl(s[3], 45)
        return out

    def fill(self, n: int) -> bytes:
        out = bytearray()
        while len(out) < n:
            out += struct.pack("<Q", self._next())
        return bytes(out[:n])


class Node:
    def __init__(self, vpath: str, host: pathlib.Path, kind: int, preopen: str | None = None):
        self.vpath, self.host, self.kind, self.preopen = vpath, host, kind, preopen
        self.pos = 0
        self.data: bytes | None = None
        self.handle = None


def parse_imports(b: bytes, memory: list | None = None):
    """Function imports, and the shape of any imported memory into `memory`."""
    memory = [] if memory is None else memory
    names = {0x7F: "i32", 0x7E: "i64", 0x7D: "f32", 0x7C: "f64", 0x7B: "v128",
             0x70: "funcref", 0x6F: "externref", 0x69: "exnref"}
    types: list[tuple[list[str], list[str]]] = []
    out = []
    for sid, j, end, _ in metering.sections(b):
        if sid == 1:
            n, j = metering.uleb(b, j)
            for _ in range(n):
                j += 1
                count, j = metering.uleb(b, j)
                params = [names[b[j + k]] for k in range(count)]
                j += count
                count, j = metering.uleb(b, j)
                results = [names[b[j + k]] for k in range(count)]
                j += count
                types.append((params, results))
        elif sid == 2:
            n, j = metering.uleb(b, j)
            for _ in range(n):
                length, j = metering.uleb(b, j)
                module = b[j:j + length].decode()
                j += length
                length, j = metering.uleb(b, j)
                name = b[j:j + length].decode()
                j += length
                kind = b[j]
                j += 1
                if kind == 0:
                    index, j = metering.uleb(b, j)
                    out.append((module, name, types[index]))
                elif kind == 1:
                    j += 1
                    limits = b[j]
                    j += 1
                    _, j = metering.uleb(b, j)
                    if limits:
                        _, j = metering.uleb(b, j)
                elif kind == 2:
                    limits = b[j]
                    j += 1
                    minimum, j = metering.uleb(b, j)
                    maximum = None
                    if limits & 1:
                        maximum, j = metering.uleb(b, j)
                    memory.append((minimum, maximum or 65536))
                else:
                    j += 2
    return out


_SLAB_LOCK = threading.RLock()
_FILES: dict = {}
_STATS: dict = {}


def _contents(host: pathlib.Path) -> bytes:
    info = host.stat()
    key = (str(host), info.st_size, info.st_mtime_ns)
    data = _FILES.get(key)
    if data is None:
        data = host.read_bytes()
        if len(_FILES) < 4096:
            _FILES[key] = data
    return data


def _patch_wasmtime() -> None:
    """wasmtime-py 48 wraps an already-made pointer when a SharedMemory is
    passed to a Linker, and the slab its host functions live in is not safe to
    share between threads: two sandboxes built at once get the same slot."""
    if WASM_RUNTIME_ERROR is not None:
        raise toolchain.wasm_runtime(WASM_RUNTIME_ERROR)
    from wasmtime import _ffi as ffi
    from wasmtime._slab import Slab

    def as_extern(self):
        return ffi.wasmtime_extern_t(ffi.WASMTIME_EXTERN_SHAREDMEMORY,
                                     ffi.wasmtime_extern_union(sharedmemory=self.ptr()))

    SharedMemory._as_extern = as_extern
    with _SLAB_LOCK:
        if getattr(Slab, "guarded", False):
            return
        for name in ("allocate", "deallocate"):
            def guard(self, *args, _inner=getattr(Slab, name)):
                if sys.is_finalizing():
                    return _inner(self, *args)
                with _SLAB_LOCK:
                    return _inner(self, *args)
            setattr(Slab, name, guard)
        Slab.guarded = True


_COMPILED: dict = {}
_COMPILE_LOCK = threading.Lock()


def _cache_dir() -> pathlib.Path:
    home = os.environ.get("XDG_CACHE_HOME") or os.environ.get("LOCALAPPDATA")
    return (pathlib.Path(home) if home else pathlib.Path.home() / ".cache") / "unswbc"


def _open_writable(path: pathlib.Path, *, truncate: bool):
    """WASI permits renaming an open file; Windows needs delete sharing.

    Clang renames its temporary object before closing the output descriptor.
    Python's ordinary open() denies that rename on Windows, even in this same
    process, so retrying cannot release the lock we ourselves still hold.
    """
    mode = "w+b" if truncate else "r+b"
    if os.name != "nt":
        return open(path, mode, buffering=0)

    import msvcrt
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                       ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = (wintypes.HANDLE,)
    close.restype = wintypes.BOOL
    # GENERIC_READ | GENERIC_WRITE; FILE_SHARE_READ | WRITE | DELETE;
    # CREATE_ALWAYS or OPEN_EXISTING; FILE_ATTRIBUTE_NORMAL.
    handle = create(str(path), 0x80000000 | 0x40000000, 1 | 2 | 4,
                    None, 2 if truncate else 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
    except BaseException:
        close(handle)
        raise
    # open_osfhandle transfers ownership to the CRT descriptor.
    try:
        return os.fdopen(fd, mode, buffering=0)
    except BaseException:
        os.close(fd)
        raise


def _replace_past_windows_locks(src: pathlib.Path, dst: pathlib.Path) -> None:
    for delay in (0.01, 0.02, 0.05, 0.1, 0.2, 0.5, None):
        try:
            src.replace(dst)
            return
        except PermissionError:
            if delay is None:
                raise
            time.sleep(delay)


def compile_once(wasm_path: pathlib.Path):
    if WASM_RUNTIME_ERROR is not None:
        raise toolchain.wasm_runtime(WASM_RUNTIME_ERROR)
    with _COMPILE_LOCK:
        if wasm_path not in _COMPILED:
            config = Config()
            for flag in ("wasm_threads", "wasm_bulk_memory", "wasm_simd", "wasm_exceptions",
                         "wasm_wide_arithmetic", "wasm_multi_memory", "wasm_multi_value",
                         "wasm_reference_types", "wasm_tail_call", "shared_memory"):
                setattr(config, flag, True)
            engine = Engine(config)
            blob = wasm_path.read_bytes()
            shape: list[tuple[int, int]] = []
            imports = parse_imports(blob, shape)
            _COMPILED[wasm_path] = (engine, _module(engine, wasm_path, blob), imports,
                                    shape[0] if shape else (1, 65536))
    return _COMPILED[wasm_path]


def _write_once(path: pathlib.Path, blob: bytes) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(f".{os.getpid()}")
        temp.write_bytes(blob)
        _replace_past_windows_locks(temp, path)
    except OSError:
        pass


def _metered(path: pathlib.Path, spare: pathlib.Path | None = None) -> pathlib.Path:
    blob = path.read_bytes()
    if metering.REMAINING in blob:
        return path
    priced = _cache_dir() / f"{path.stem}-{hashlib.sha256(blob).hexdigest()[:32]}-metered.wasm"
    if not priced.is_file():
        _write_once(priced, metering.instrument(blob))
    if priced.is_file():
        return priced
    beside = (spare or pathlib.Path(tempfile.mkdtemp())) / priced.name
    beside.write_bytes(metering.instrument(blob))
    return beside


def warm_interpreter() -> bool:
    """The judge's python, compiled to native code once per machine."""
    if not WASM_PATH.is_file() or compiled_path(WASM_PATH).is_file():
        return False
    with progress.waiting("preparing the judge's python, once",
                          WASM_PATH.stat().st_size / INTERPRETER_RATE):
        compile_once(WASM_PATH)
    return True


def compiled_path(wasm_path: pathlib.Path) -> pathlib.Path:
    stat = wasm_path.stat()
    return _cache_dir() / f"{wasm_path.stem}-{stat.st_size}-{int(stat.st_mtime)}.cwasm"


def _module(engine: "Engine", wasm_path: pathlib.Path, blob: bytes) -> "Module":
    cached = compiled_path(wasm_path)
    try:
        return Module.deserialize_file(engine, str(cached))
    except Exception:
        pass
    module = Module(engine, blob)
    _write_once(cached, module.serialize())
    return module


class Sandbox:
    def __init__(self, wasm_path: pathlib.Path = WASM_PATH, root: pathlib.Path = ROOT_PATH,
                 argv: list[str] | None = None, environ: list[str] | None = None,
                 template: str = "", process: str = "", writable: tuple[str, ...] = (), cwd: str = "/",
                 mounts: dict[str, pathlib.Path] | None = None,
                 stdin=None, stdout=None, stderr=None, needs_zygote: bool = True,
                 needs_meter: bool = True, max_pages: int = MAX_MEMORY_PAGES) -> None:
        _patch_wasmtime()
        # Always the packaged root: a pool runs from a temp tree whose usr and
        # sbin are mounts back to it, so only that copy holds the assets.
        _check_sandbox_assets(wasm_path, need_zygote=needs_zygote)
        self.wasm = wasm_path
        self.needs_meter = needs_meter
        self.root = root.resolve()
        self.mounts = sorted(
            (([p for p in at.split("/") if p], pathlib.Path(host).resolve())
             for at, host in (mounts or {}).items()),
            key=lambda entry: -len(entry[0]))
        self.argv = [a.encode() for a in (argv or ["python"])]
        self.environ = [e.encode() for e in (GUEST_ENV if environ is None else environ)]
        self.rng = Rng(template, process)
        self.writable = writable
        self.cwd = cwd.encode()
        self.stdin = stdin
        self.stdout = stdout if stdout is not None else bytearray()
        self.stderr = stderr if stderr is not None else bytearray()
        self.calls: collections.Counter = collections.Counter()
        self.unsupported: list[str] = []
        self.slept_ns = 0
        self._spent = 0
        self._last = metering.INITIAL_POINTS
        self.budget: int | None = None
        self.exit_code: int | None = None
        self._exports = None
        self.pending: BaseException | None = None
        self.live = (0, 0)
        self._turn, self._reported, self._first = 0, 0, True
        self.ended = False
        self.frozen = threading.Event()
        self.frozen.set()
        self.failure: str | None = None

        self.engine, self.module, self.imports, (pages, limit) = compile_once(wasm_path)
        self.store = Store(self.engine)
        self.memory = SharedMemory(self.engine,
                                   MemoryType(Limits(pages, min(limit, max_pages)), shared=True))
        self._base = ctypes.addressof(self.memory.data_ptr().contents)
        self._view: tuple[int, object] = (0, None)
        self._meter = None
        self._table = None
        self._fds = {fd: Node("/", self.root, DIR, preopen="/") for fd in (3, 4)}
        self._impl = self._build_impl()

    def mem(self):
        size = self.memory.data_len()
        if self._view[0] != size:
            self._view = (size, (ctypes.c_ubyte * size).from_address(self._base))
        return self._view[1]

    def bound(self, ptr: int, n: int) -> None:
        if ptr < 0 or n < 0 or ptr + n > self.memory.data_len():
            raise SandboxError(f"guest pointer {ptr}+{n} outside {self.memory.data_len()} bytes")

    def rd(self, ptr: int, n: int) -> bytes:
        self.bound(ptr, n)
        return ctypes.string_at(self._base + ptr, n)

    def wr(self, ptr: int, data: bytes) -> None:
        self.bound(ptr, len(data))
        ctypes.memmove(self._base + ptr, data, len(data))

    def u8(self, ptr, v): self.wr(ptr, struct.pack("<B", v & 0xFF))
    def u32(self, ptr, v): self.wr(ptr, struct.pack("<I", v & 0xFFFFFFFF))
    def u64(self, ptr, v): self.wr(ptr, struct.pack("<Q", v & U64))
    def text(self, ptr, n): return self.rd(ptr, n).decode("utf-8", "replace")

    def spent(self) -> int:
        if self._meter is not None:
            now = self._meter.value(self.store)
            if self._first:
                self._first = False
            else:
                self._spent += self._last - now
            self._last = now
        return self._spent

    def end_turn(self) -> None:
        """`ENDTURN` is framed: the turn's figures are final and the guest runs
        on until it blocks at its next syscall."""
        self.ended = True
        self.frozen.clear()

    def mark(self) -> None:
        """Take the turn's figures, until `ENDTURN` settles them."""
        if self.ended:
            return
        self._reported = self.spent()
        self.live = (self._reported - self._turn, self.memory.data_len())

    def refill(self, points: int) -> None:
        if self._meter is None:
            return
        # A bot goes on running between `ENDTURN` and this read, and that work
        # belongs to the turn starting here: charging it to the one already
        # reported is not possible, and dropping it would hand every bot a
        # second budget the report never shows.
        gap = self.spent() - self._reported
        self._turn = self._reported
        self.ended = False
        left = max(0, points - gap)
        self._meter.set_value(self.store, left)
        self._last = left

    def now(self) -> int:
        return self.spent() + self.slept_ns

    def charge(self, points: int) -> None:
        if self._meter is None:
            return
        left = self._meter.value(self.store)
        self._meter.set_value(self.store, max(0, left - points))

    def charge_write(self, total: int) -> None:
        if self._meter is None:
            return
        cost = WRITE_SYSCALL_COST + total * WRITE_BYTE_COST
        left = self._meter.value(self.store)
        self._meter.set_value(self.store, left - cost)
        if not self._first:
            self.mark()
        if left < cost:
            burnt = self._exports.get(metering.EXHAUSTED.decode())
            if burnt is not None:
                burnt.set_value(self.store, 1)
            self.failure = "exceeded CPU limit"
            raise Exit(137)

    def _free_fd(self) -> int:
        fd = 3
        while fd in self._fds:
            fd += 1
        return fd

    def _resolve(self, vpath: str) -> tuple[pathlib.Path, str]:
        parts: list[str] = []
        for part in vpath.split("/"):
            if part in ("", "."):
                continue
            if part == "..":
                if parts:
                    parts.pop()
            else:
                parts.append(part)
        for at, host in self.mounts:
            if parts[:len(at)] == at:
                return host.joinpath(*parts[len(at):]), "/" + "/".join(parts)
        return self.root.joinpath(*parts), "/" + "/".join(parts)

    def _filestat(self, path: pathlib.Path, out: int) -> int:
        packed = _STATS.get(path)
        if packed is None:
            try:
                st = path.lstat()
            except OSError:
                return ENOENT
            kind = DIR if path.is_dir() else REGULAR
            mount = self.root != path and self.root not in path.parents
            # Times are 0, as in the judge: a real one is a host clock reading.
            packed = struct.pack("<QQBxxxxxxxQQQQQ", 1, st.st_ino & U64, kind, 1,
                                 0 if mount and kind == DIR else st.st_size, 0, 0, 0)
            _STATS[path] = packed
        self.wr(out, packed)
        return OK

    def _build_impl(self) -> dict:
        impl = {}

        def at(name):
            def deco(fn):
                impl[name] = fn
                return fn
            return deco

        wasi = "wasi_snapshot_preview1."
        wasix = "wasix_32v1."

        @at(wasi + "args_sizes_get")
        def _(a, b):
            self.u32(a, len(self.argv))
            self.u32(b, sum(len(x) + 1 for x in self.argv))
            return OK

        @at(wasi + "args_get")
        def _(vec, buf):
            for k, arg in enumerate(self.argv):
                self.u32(vec + 4 * k, buf)
                self.wr(buf, arg + b"\0")
                buf += len(arg) + 1
            return OK

        @at(wasi + "environ_sizes_get")
        def _(a, b):
            self.u32(a, len(self.environ))
            self.u32(b, sum(len(x) + 1 for x in self.environ))
            return OK

        @at(wasi + "environ_get")
        def _(vec, buf):
            for k, env in enumerate(self.environ):
                self.u32(vec + 4 * k, buf)
                self.wr(buf, env + b"\0")
                buf += len(env) + 1
            return OK

        @at(wasi + "clock_time_get")
        def _(clock_id, precision, out):
            self.u64(out, (VIRTUAL_EPOCH_NS if clock_id == 0 else 0) + self.now())
            return OK

        @at(wasi + "clock_res_get")
        def _(clock_id, out):
            self.u64(out, 1)
            return OK

        @at(wasi + "random_get")
        def _(ptr, n):
            self.wr(ptr, self.rng.fill(n))
            return OK

        @at(wasi + "sched_yield")
        def _():
            return OK

        @at(wasi + "poll_oneoff")
        def _(subs, events, n, out):
            # `validate_poll_fd_count`: the judge allows clock waits and no fds.
            if n == 0:
                return EINVAL
            if any(self.rd(subs + 48 * k + 8, 1)[0] != 0 for k in range(n)):
                return E2BIG
            wait, fired = None, []
            for k in range(n):
                base = subs + 48 * k
                userdata = struct.unpack("<Q", self.rd(base, 8))[0]
                tag = self.rd(base + 8, 1)[0]
                if tag == 0:
                    _cid, timeout, _prec, flags = struct.unpack("<IxxxxQQH", self.rd(base + 16, 26))
                    nanos = max(0, timeout - self.now()) if flags & 1 else timeout
                    wait = nanos if wait is None else min(wait, nanos)
                    fired.append((userdata, 0))
                else:
                    fired.append((userdata, 1 if tag == 1 else 2))
            if wait:
                self.slept_ns += wait
            for k, (userdata, kind) in enumerate(fired):
                self.wr(events + 32 * k, struct.pack("<QHBxQH6x", userdata, 0, kind, 0, 0))
            self.u32(out, len(fired))
            return OK

        @at(wasi + "fd_prestat_get")
        def _(fd, out):
            node = self._fds.get(fd)
            if node is None or node.preopen is None:
                return EBADF
            self.wr(out, struct.pack("<BxxxI", 0, len(node.preopen)))
            return OK

        @at(wasi + "fd_prestat_dir_name")
        def _(fd, ptr, n):
            node = self._fds.get(fd)
            if node is None or node.preopen is None:
                return EBADF
            self.wr(ptr, node.preopen.encode()[:n])
            return OK

        @at(wasi + "fd_fdstat_get")
        def _(fd, out):
            kind = CHARACTER if fd in (0, 1, 2) else None
            if kind is None:
                node = self._fds.get(fd)
                if node is None:
                    return EBADF
                kind = node.kind
            self.wr(out, struct.pack("<BxHxxxxQQ", kind, 0, ALL_RIGHTS, ALL_RIGHTS))
            return OK

        @at(wasi + "fd_fdstat_set_flags")
        def _(fd, flags):
            return OK

        @at(wasix + "fd_fdflags_get")
        def _(fd, out):
            self.u32(out, 0)
            return OK

        @at(wasix + "fd_fdflags_set")
        def _(fd, flags):
            return OK

        @at(wasi + "fd_filestat_get")
        def _(fd, out):
            if fd in (0, 1, 2):
                self.wr(out, struct.pack("<QQBxxxxxxxQQQQQ", 1, fd, CHARACTER, 1, 0, 0, 0, 0))
                return OK
            node = self._fds.get(fd)
            return self._filestat(node.host, out) if node else EBADF

        @at(wasi + "path_filestat_get")
        def _(fd, flags, ptr, n, out):
            node = self._fds.get(fd)
            if node is None:
                return EBADF
            host, _ = self._resolve(self._join(node.vpath, self.text(ptr, n)))
            return self._filestat(host, out)

        @at(wasi + "path_readlink")
        def _(fd, ptr, n, buf, buflen, out):
            node = self._fds.get(fd)
            if node is None:
                return EBADF
            host, _ = self._resolve(self._join(node.vpath, self.text(ptr, n)))
            if not host.is_symlink():
                return EINVAL if host.exists() else ENOENT
            target = os.readlink(host).encode()[:buflen]
            self.wr(buf, target)
            self.u32(out, len(target))
            return OK

        @at(wasix + "path_open2")
        def _(dirfd, dirflags, ptr, n, oflags, rights, inherit, fdflags, extra, out):
            node = self._fds.get(dirfd)
            if node is None:
                return EBADF
            host, vpath = self._resolve(self._join(node.vpath, self.text(ptr, n)))
            writable = any(vpath.startswith(w) for w in self.writable)
            if (oflags & 1 or oflags & 8) and not writable:
                return EACCES
            if oflags & 1 and oflags & 4 and host.exists():
                return EEXIST
            if not host.exists() and not oflags & 1:
                return ENOENT
            is_dir = host.is_dir()
            if oflags & 2 and not is_dir:
                return ENOTDIR
            fd = self._free_fd()
            opened = Node(vpath, host, DIR if is_dir else REGULAR)
            if is_dir:
                pass
            elif writable:
                _STATS.clear()
                host.parent.mkdir(parents=True, exist_ok=True)
                opened.handle = _open_writable(host, truncate=not host.exists() or bool(oflags & 8))
            else:
                opened.data = _contents(host)
            self._fds[fd] = opened
            self.u32(out, fd)
            return OK

        @at(wasi + "fd_close")
        def _(fd):
            node = self._fds.pop(fd, None)
            if node is not None and node.handle is not None:
                node.handle.close()
            return OK

        @at(wasi + "path_create_directory")
        def _(fd, ptr, n):
            node = self._fds.get(fd)
            if node is None:
                return EBADF
            host, vpath = self._resolve(self._join(node.vpath, self.text(ptr, n)))
            if not any(vpath.startswith(w) for w in self.writable):
                return EACCES
            host.mkdir(parents=True, exist_ok=True)
            return OK

        @at(wasi + "path_unlink_file")
        def _(fd, ptr, n):
            node = self._fds.get(fd)
            if node is None:
                return EBADF
            host, vpath = self._resolve(self._join(node.vpath, self.text(ptr, n)))
            if not any(vpath.startswith(w) for w in self.writable):
                return EACCES
            host.unlink(missing_ok=True)
            return OK

        @at(wasi + "path_rename")
        def _(fd, ptr, n, newfd, newptr, newn):
            node, target = self._fds.get(fd), self._fds.get(newfd)
            if node is None or target is None:
                return EBADF
            src, srcv = self._resolve(self._join(node.vpath, self.text(ptr, n)))
            dst, dstv = self._resolve(self._join(target.vpath, self.text(newptr, newn)))
            if not all(any(v.startswith(w) for w in self.writable) for v in (srcv, dstv)):
                return EACCES
            dst.parent.mkdir(parents=True, exist_ok=True)
            _replace_past_windows_locks(src, dst)
            return OK

        @at(wasi + "path_remove_directory")
        def _(fd, ptr, n):
            host, err = self._mutable(fd, ptr, n)
            if err != OK:
                return err
            host.rmdir()
            return OK

        @at(wasi + "path_symlink")
        def _(ptr, n, fd, newptr, newn):
            host, err = self._mutable(fd, newptr, newn, exists=False)
            if err != OK:
                return err
            host.symlink_to(self.text(ptr, n))
            return OK

        @at(wasi + "path_link")
        def _(fd, flags, ptr, n, newfd, newptr, newn):
            host, err = self._mutable(newfd, newptr, newn, exists=False)
            if err != OK:
                return err
            src, _ = self._resolve(self._join(self._fds[fd].vpath, self.text(ptr, n)))
            if not src.exists():
                return ENOENT
            host.hardlink_to(src)
            return OK

        @at(wasi + "path_filestat_set_times")
        def _(fd, flags, ptr, n, atim, mtim, fst):
            return self._mutable(fd, ptr, n)[1]

        @at(wasi + "fd_filestat_set_times")
        def _(fd, atim, mtim, fst):
            return self._writable_fd(fd)

        @at(wasi + "fd_filestat_set_size")
        def _(fd, size):
            err = self._writable_fd(fd)
            if err == OK:
                self._fds[fd].handle.truncate(size)
            return err

        @at(wasi + "fd_pwrite")
        def _(fd, iovs, n, offset, out):
            node = self._fds.get(fd)
            if node is None or node.handle is None:
                return self._impl[wasi + "fd_write"](fd, iovs, n, out)
            chunks = [struct.unpack("<II", self.rd(iovs + 8 * k, 8)) for k in range(n)]
            self.charge_write(sum(length for _, length in chunks))
            total = 0
            for ptr, length in chunks:
                node.handle.seek(offset + total)
                node.handle.write(self.rd(ptr, length))
                total += length
            self.u32(out, total)
            return OK

        @at(wasi + "fd_advise")
        def _(fd, offset, length, advice):
            return OK if fd in self._fds else EBADF

        @at(wasi + "fd_datasync")
        def _(fd):
            return OK if fd in self._fds else EBADF

        @at(wasi + "fd_sync")
        def _(fd):
            return OK if fd in self._fds else EBADF

        @at(wasix + "fd_dup")
        def _(fd, out):
            if fd not in self._fds:
                return EBADF
            new = self._free_fd()
            self._fds[new] = self._fds[fd]
            self.u32(out, new)
            return OK

        @at(wasix + "clock_time_set")
        def _(clock_id, timestamp):
            return ENOSYS

        @at(wasix + "proc_parent")
        def _(pid, out):
            return ENOSYS

        @at(wasix + "proc_raise_interval")
        def _(signal, interval, repeat):
            return ENOSYS

        @at(wasi + "fd_renumber")
        def _(a, b):
            if a in self._fds:
                self._fds[b] = self._fds.pop(a)
            return OK

        @at(wasix + "fd_dup2")
        def _(fd, flags, newfd, out):
            if fd in self._fds:
                self._fds[newfd] = self._fds[fd]
            self.u32(out, newfd)
            return OK

        @at(wasi + "fd_read")
        def _(fd, iovs, n, out):
            if fd == 0:
                return self._read_stdin(iovs, n, out)
            node = self._fds.get(fd)
            if node is None:
                return EBADF
            if node.kind == DIR:
                return EISDIR
            return self._read_node(node, iovs, n, out)

        @at(wasi + "fd_pread")
        def _(fd, iovs, n, offset, out):
            node = self._fds.get(fd)
            return self._read_node(node, iovs, n, out, at=offset) if node else EBADF

        @at(wasi + "fd_seek")
        def _(fd, offset, whence, out):
            node = self._fds.get(fd)
            if node is None:
                return EBADF
            size = node.handle.seek(0, 2) if node.handle is not None else len(node.data or b"")
            base = (0, node.pos, size)[whence]
            node.pos = max(0, base + offset)
            self.u64(out, node.pos)
            return OK

        @at(wasi + "fd_tell")
        def _(fd, out):
            node = self._fds.get(fd)
            if node is None:
                return EBADF
            self.u64(out, node.pos)
            return OK

        @at(wasi + "fd_readdir")
        def _(fd, buf, buflen, cookie, out):
            node = self._fds.get(fd)
            if node is None:
                return EBADF
            if node.kind != DIR:
                return ENOTDIR
            entries = [(".", node.host), ("..", node.host.parent)]
            entries += sorted((e.name, e) for e in node.host.iterdir())
            blob = b""
            for index, (name, path) in enumerate(entries):
                if index < cookie:
                    continue
                kind = DIR if pathlib.Path(path).is_dir() else REGULAR
                blob += struct.pack("<QQIBxxx", index + 1, index + 7, len(name), kind)
                blob += name.encode()
                if len(blob) >= buflen:
                    break
            self.wr(buf, blob[:buflen])
            self.u32(out, min(len(blob), buflen))
            return OK

        @at(wasi + "fd_write")
        def _(fd, iovs, n, out):
            # `cpu.rs charge_write`: charged before the bytes go out, so the
            # turn's report includes its final flush and an unaffordable
            # write never reaches stdout.
            chunks = [struct.unpack("<II", self.rd(iovs + 8 * k, 8)) for k in range(n)]
            total = sum(length for _, length in chunks)
            self.charge_write(total)
            node = self._fds.get(fd)
            if node is not None and node.handle is not None:
                for ptr, length in chunks:
                    node.handle.seek(node.pos)
                    node.handle.write(self.rd(ptr, length))
                    node.pos += length
                self.u32(out, total)
                return OK
            sink = self.stderr if fd == 2 else self.stdout
            for ptr, length in chunks:
                sink.extend(self.rd(ptr, length))
            self.u32(out, total)
            return OK

        @at(wasix + "getcwd")
        def _(ptr, lenptr):
            cwd = self.cwd
            maxlen = struct.unpack("<I", self.rd(lenptr, 4))[0]
            self.u32(lenptr, len(cwd))
            if len(cwd) > maxlen:
                return ERANGE
            if ptr == 0 or maxlen == 0:
                return EINVAL
            self.wr(ptr, cwd)
            if len(cwd) < maxlen:
                self.wr(ptr + len(cwd), b"\0")
            return OK

        @at(wasix + "chdir")
        def _(ptr, n):
            return OK

        @at(wasix + "tty_get")
        def _(ptr):
            return ENOTTY

        @at(wasix + "thread_id")
        def _(out):
            self.u32(out, 1)
            return OK

        @at(wasix + "thread_parallelism")
        def _(out):
            # `metrics/slot.rs`: a bot has one thread on every node.
            self.u32(out, 1)
            return OK

        @at(wasix + "thread_exit")
        def _(code):
            raise Exit(code)

        @at(wasix + "proc_id")
        def _(out):
            self.u32(out, 1)
            return OK

        @at(wasix + "proc_signals_sizes_get")
        def _(out):
            self.u32(out, 0)
            return OK

        @at(wasix + "proc_signals_get")
        def _(out):
            return OK

        @at(wasi + "proc_exit")
        def _(code):
            raise Exit(code)

        @at(wasix + "proc_exit2")
        def _(code):
            raise Exit(code)

        @at(wasix + "futex_wait")
        def _(ptr, expected, timeout_ptr, woken):
            if struct.unpack("<I", self.rd(ptr, 4))[0] != expected:
                self.u8(woken, 1)
                return OK
            if timeout_ptr and self.rd(timeout_ptr, 1)[0]:
                self.u8(woken, 0)
                return OK
            raise Unsupported("futex_wait would block forever (the judge runs one thread)")

        @at(wasix + "futex_wake")
        def _(ptr, woken):
            self.u8(woken, 0)
            return OK

        @at(wasix + "futex_wake_all")
        def _(ptr, woken):
            self.u8(woken, 0)
            return OK

        @at(wasix + "reflect_signature")
        def _(fid, aptr, alen, rptr, rlen, out):
            fn = self._lookup(fid)
            if fn is None:
                self.wr(out, struct.pack("<BxHH", 1, 0, 0))
                return EINVAL
            ty = fn.type(self.store)
            params, results = list(ty.params), list(ty.results)
            self.wr(out, struct.pack("<BxHH", 1, len(params), len(results)))
            if len(params) > alen or len(results) > rlen:
                return EOVERFLOW
            if params:
                self.wr(aptr, bytes(_TYPE_CODE[str(v)] for v in params))
            if results:
                self.wr(rptr, bytes(_TYPE_CODE[str(v)] for v in results))
            return OK

        @at(wasix + "call_dynamic")
        def _(fid, vals, vlen, res, rlen, strict):
            fn = self._lookup(fid)
            if fn is None:
                return EINVAL
            ty = fn.type(self.store)
            offset, args = vals, []
            for v in ty.params:
                name = str(v)
                width = _TYPE_WIDTH[name]
                args.append(_UNPACK[name](self.rd(offset, width)))
                offset += width
            got = fn(self.store, *args)
            outs = [] if got is None else (list(got) if isinstance(got, (list, tuple)) else [got])
            offset = res
            for v, value in zip(ty.results, outs):
                name = str(v)
                self.wr(offset, _PACK[name](value))
                offset += _TYPE_WIDTH[name]
            return OK

        return impl

    def _writable_fd(self, fd: int) -> int:
        node = self._fds.get(fd)
        if node is None:
            return EBADF
        return OK if any(node.vpath.startswith(w) for w in self.writable) else EACCES

    def _mutable(self, fd: int, ptr: int, n: int, exists: bool = True):
        """`fs/readonly.rs`: resolve, then ENOENT before EACCES."""
        node = self._fds.get(fd)
        if node is None:
            return None, EBADF
        host, vpath = self._resolve(self._join(node.vpath, self.text(ptr, n)))
        if exists and not host.exists():
            return host, ENOENT
        if not any(vpath.startswith(w) for w in self.writable):
            return host, EACCES
        return host, OK

    @staticmethod
    def _join(base: str, rel: str) -> str:
        return rel if rel.startswith("/") else base.rstrip("/") + "/" + rel

    def _read_node(self, node: Node, iovs: int, n: int, out: int, at: int | None = None) -> int:
        pos = node.pos if at is None else at
        total = 0
        for k in range(n):
            ptr, length = struct.unpack("<II", self.rd(iovs + 8 * k, 8))
            if node.handle is not None:
                node.handle.seek(pos)
                chunk = node.handle.read(length)
            else:
                chunk = (node.data or b"")[pos:pos + length]
            if chunk:
                self.wr(ptr, chunk)
            pos += len(chunk)
            total += len(chunk)
            if len(chunk) < length:
                break
        if at is None:
            node.pos = pos
        self.charge(total * READ_BYTE_COST)
        self.u32(out, total)
        return OK

    def _read_stdin(self, iovs: int, n: int, out: int) -> int:
        total = 0
        for k in range(n):
            ptr, length = struct.unpack("<II", self.rd(iovs + 8 * k, 8))
            chunk = self.stdin.read(length) if self.stdin is not None else b""
            if self.budget is not None:
                self.refill(self.budget)
                self.budget = None
            if chunk:
                self.wr(ptr, chunk)
            total += len(chunk)
            if len(chunk) < length:
                break
        self.charge(total * READ_BYTE_COST)
        self.u32(out, total)
        return OK

    def _lookup(self, fid: int):
        if self._table is None:
            return None
        try:
            return self._table.get(self.store, fid)
        except Exception:
            return None

    def _host(self, key: str, results: list[str]):
        impl = self._impl.get(key)
        denied = key.split(".", 1)[1] in DENIED
        waits = key.split(".", 1)[1] not in EXITS

        def call(*args):
            if waits and not self.frozen.is_set():
                self.frozen.wait()
            self.calls[key] += 1
            if not self._first:
                self.mark()
            try:
                if impl is not None:
                    return impl(*args)
                if denied:
                    return ENOTSUP if results else None
                self.unsupported.append(key)
                raise Unsupported(key)
            except BaseException as error:
                # wasmtime-py hands a host function's exception back through one
                # module global, so a second store running at the same time can
                # take it. Keep our own.
                self.pending = error
                raise

        return call

    def instantiate(self) -> None:
        linker = Linker(self.engine)
        linker.define(self.store, "env", "memory", self.memory)
        for module, name, (params, results) in self.imports:
            ty = FuncType([_VALTYPE[p]() for p in params], [_VALTYPE[r]() for r in results])
            linker.define_func(module, name, ty, self._host(f"{module}.{name}", results))
        instance = linker.instantiate(self.store, self.module)
        self._exports = instance.exports(self.store)
        self._table = self._exports.get("__indirect_function_table")
        self._meter = self._exports.get(metering.REMAINING.decode())
        if self._meter is None and self.needs_meter:
            raise SandboxError(f"{self.wasm.name} carries no meter")
        self._sp = self._exports.get("__stack_pointer")
        self._sp0 = self._sp.value(self.store) if self._sp is not None else None

    def _enter(self, call) -> int:
        self.pending = None
        try:
            call()
            self.exit_code = 0
        except BaseException as trapped:
            error = self._cause(trapped)
            if isinstance(error, Exit):
                self.exit_code = error.code
            elif self.unsupported:
                raise Unsupported(self.unsupported[0]) from error
            else:
                burnt = self._exports.get(metering.EXHAUSTED.decode())
                self.failure = ("exceeded CPU limit" if burnt is not None and burnt.value(self.store)
                                else f"sandbox error: {error}")
                raise error
        finally:
            self.spent(); self._meter = None
            self.store.close()
        return self.exit_code

    def _cause(self, trapped: BaseException) -> BaseException:
        error, self.pending = self.pending or trapped, None
        return error

    def main(self) -> int:
        return self._enter(lambda: self._exports["_start"](self.store))

    def run(self) -> int:
        self.instantiate()
        return self.main()

    def preinit(self) -> int:
        """`manager.rs build_image`: run the zygote to `--preinit`, which loads
        the interpreter and prints the address of `run`. proc_exit unwinds the
        frames and leaves memory as it is, so the clock and the meter restart
        where a worker booted from the judge's image does."""
        self.instantiate()
        self.pending = None
        try:
            self._exports["_start"](self.store)
        except BaseException as trapped:
            error = self._cause(trapped)
            if self.unsupported:
                raise Unsupported(self.unsupported[0]) from error
            if not isinstance(error, Exit):
                raise error
            if error.code:
                raise SandboxError(f"preinit exited with code {error.code}") from error
        else:
            raise SandboxError("preinit did not exit")
        head = bytes(self.stdout).split(b"\n", 1)[0].split()
        if len(head) != 2 or head[0] != b"PREINIT":
            raise SandboxError("preinit printed no address")
        del self.stdout[:]
        # `manager.rs build_image` boots a worker from a copy of memory in a
        # fresh instance, so its stack starts at the top. Ours is the instance
        # that ran preinit: the unwind left the pointer deep in a dead stack.
        if self._sp is not None:
            self._sp.set_value(self.store, self._sp0)
        self._meter.set_value(self.store, metering.INITIAL_POINTS)
        self._last, self._spent, self._turn, self.slept_ns = metering.INITIAL_POINTS, 0, 0, 0
        self._reported, self.ended = 0, False
        self._first = True
        return int(head[1])

    def resume(self, addr: int) -> int:
        return self._enter(lambda: self._exports["PyObject_CallNoArgs"](self.store, addr))


_TYPE_CODE = {"i32": 0, "i64": 1, "f32": 2, "f64": 3, "v128": 4}
_TYPE_WIDTH = {"i32": 4, "f32": 4, "i64": 8, "f64": 8, "v128": 16}
_UNPACK = {"i32": lambda r: struct.unpack("<i", r)[0], "i64": lambda r: struct.unpack("<q", r)[0],
           "f32": lambda r: struct.unpack("<f", r)[0], "f64": lambda r: struct.unpack("<d", r)[0]}
_PACK = {"i32": lambda v: struct.pack("<i", v), "i64": lambda v: struct.pack("<q", v),
         "f32": lambda v: struct.pack("<f", v), "f64": lambda v: struct.pack("<d", v)}


class _Pipe:
    """Bytes between the driver thread and the guest, which blocks in fd_read."""

    def __init__(self, cv: threading.Condition | None = None) -> None:
        self.buf = bytearray()
        self.cv = cv or threading.Condition()
        self.closed = False
        self.parks = 0
        self.framer = None
        self.box = None

    def feed(self, data: bytes) -> None:
        with self.cv:
            if self.framer is None:
                self.buf += data
            elif self.framer.feed(data) and self.box is not None:
                self.box.end_turn()
            self.cv.notify_all()

    extend = feed

    def read(self, n: int) -> bytes:
        with self.cv:
            parked = False
            while not self.buf and not self.closed:
                if not parked:
                    parked = True
                    self.parks += 1
                    self.cv.notify_all()
                self.cv.wait()
            out = bytes(self.buf[:n])
            del self.buf[:n]
            return out

    def take(self, want: bytes, timeout: float) -> bytes | None:
        with self.cv:
            while True:
                start = 0
                while True:
                    end = self.buf.find(b"\n", start)
                    if end < 0:
                        break
                    if bytes(self.buf[start:end]).rstrip(b"\r") == want:
                        out = bytes(self.buf[: end + 1])
                        del self.buf[: end + 1]
                        return out
                    start = end + 1
                if self.closed or not self.cv.wait(timeout):
                    return None

    def close(self) -> None:
        with self.cv:
            self.closed = True
            self.cv.notify_all()

def _check_sandbox_assets(wasm_path: pathlib.Path = WASM_PATH,
                          root: pathlib.Path = ROOT_PATH,
                          need_zygote: bool = True) -> None:
    """The interpreter and its filesystem are generated, not committed.

    `need_zygote` is off for the one sandbox that compiles the zygote, which
    cannot demand the file it is about to write."""
    zygote = root / "sbin" / "zygote.pyc"
    checks = [(wasm_path, wasm_path.is_file())]
    if need_zygote:
        checks.append((zygote, zygote.is_file()))
    checks.append((root / "usr", (root / "usr").is_dir()))
    missing = [str(path) for path, ok in checks if not ok]
    if not missing:
        return
    raise SandboxError(
        "this build ships no sandbox, so --sandbox cannot run. Missing:\n        "
        + "\n        ".join(missing)
        + "\n    They are built, not downloaded. In a checkout of the private repo:\n"
        "        git lfs pull\n"
        "        python pythoncli/build-sandbox.py\n"
        "    Or install a wheel built there, which carries them."
    )



def _drive(box: "Sandbox", stdout: "_Pipe", addr: int | None) -> None:
    try:
        box.main() if addr is None else box.resume(addr)
    except Unsupported as error:
        box.failure = f"sandbox error: {error}"
    except BaseException:
        pass
    finally:
        stdout.close()


class SandboxPool:
    """One compiled copy of a bot, shared by every dragon on its team."""

    def __init__(self, argv: list[str], cwd: str | None = None, size: int = 0,
                 team: str = "a") -> None:
        _check_sandbox_assets()
        self.team = team.lower()
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="unswbc-sandbox-"))
        self.mounts = {f"/{name}": ROOT_PATH / name for name in ("usr", "pycache", "sbin")}
        for at in self.mounts:
            (self.root / at.lstrip("/")).mkdir()
        # Only the bot's own sources: a build tree from an earlier run is not the
        # bot, and host bytecode is the wrong magic for the guest's interpreter.
        shutil.copytree(cwd or ".", self.root / "bot",
                        ignore=shutil.ignore_patterns(BUILD_DIR_NAME, "__pycache__"))
        sources = sorted(p.relative_to(self.root / "bot").as_posix()
                         for p in (self.root / "bot").rglob("*.py"))
        box = Sandbox(root=self.root, mounts=self.mounts, writable=("/bot",), cwd="/bot",
                      argv=["python", "-m", "compileall", "-b", "-q", "--invalidation-mode",
                            "unchecked-hash", *sources])
        if sources and box.run() != 0:
            detail = bytes(box.stderr).decode("utf-8", "replace").strip()
            raise SandboxError(detail or "compiling the bot failed")
        if not (self.root / "bot" / "main.pyc").is_file():
            raise SandboxError("compiling the bot did not produce main.pyc")
        for source in (self.root / "bot").rglob("*.py"):
            if source.with_suffix(".pyc").is_file():
                source.unlink()
        self._open_queue()
        for _ in range(int(os.environ.get("UNSWBC_WARM", 0)) or max(1, min(4, (os.cpu_count() or 4) // 2))):
            self.warm()

    def _open_queue(self) -> None:
        self.closed, self.gate, self.ready = False, threading.Lock(), queue.Queue()

    def _offer(self, spare) -> None:
        with self.gate:
            if not self.closed:
                self.ready.put(spare)
                return
        if spare is not None:
            spare[1].close()

    def warm(self) -> None:
        if self.closed:
            return
        threading.Thread(target=self._boot, daemon=True).start()

    def _boot(self) -> None:
        cv = threading.Condition()
        stdin, stdout = _Pipe(cv), _Pipe(cv)
        try:
            box = Sandbox(root=self.root, mounts=self.mounts, cwd="/bot",
                          template="preinit", stderr=bytearray(),
                          argv=["python", "/sbin/zygote.pyc", "--preinit"])
            addr = box.preinit()
            box.rng = Rng(self.team, "")
            box.stdin, box.stdout = stdin, stdout
        except BaseException:
            self._offer(None)
            return
        threading.Thread(target=_drive, args=(box, stdout, addr), daemon=True).start()
        self._offer((box, stdin, stdout, stdout.take(b"READY", 300) is not None))

    def close(self) -> None:
        with self.gate:
            self.closed = True
        while not self.ready.empty():
            spare = self.ready.get()
            if spare is not None:
                spare[1].close()
        shutil.rmtree(self.root, ignore_errors=True)


class WasmPool(SandboxPool):
    """A compiled bot, priced in CPU points before it ever runs."""

    def __init__(self, argv: list[str], cwd: str | None = None, size: int = 0,
                 team: str = "a") -> None:
        self.team = team.lower()
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="unswbc-sandbox-"))
        self.wasm = _metered(pathlib.Path(argv[0]), self.root)
        self._open_queue()
        for _ in range(int(os.environ.get("UNSWBC_WARM", 0)) or 2):
            self.warm()

    def _boot(self) -> None:
        cv = threading.Condition()
        stdin, stdout = _Pipe(cv), _Pipe(cv)
        try:
            box = Sandbox(wasm_path=self.wasm, root=self.root, argv=["bot"], environ=["TERM=dumb"],
                          stderr=bytearray(), stdin=stdin, stdout=stdout, needs_zygote=False)
            box.rng = Rng(self.team, "")
            box.instantiate()
        except BaseException:
            self._offer(None)
            return
        threading.Thread(target=_drive, args=(box, stdout, None), daemon=True).start()
        self._offer((box, stdin, stdout, False))


class SandboxBot(TurnBot):
    """A dragon in the judge's sandbox, behind the same interface as `bot.Bot`."""

    def __init__(self, pool: SandboxPool, init: bytes = b"", name: str = "0") -> None:
        super().__init__(init, name)
        self._pool = pool
        self._box: Sandbox | None = None
        self._stdin = self._stdout = None
        self._parks = 0
        self._stderr = bytearray()

    def _running(self) -> bool:
        return self._box is not None

    def start(self) -> None:
        self.stop()
        spare = self._pool.ready.get()
        self._pool.warm()
        if spare is None:
            raise SandboxError("the sandbox failed to start")
        box, self._stdin, self._stdout, self._activate = spare
        self._box = box
        box.rng = Rng(self._pool.team, self._name)
        self._stdout.framer, self._stdout.box = self._framer, box

    def stop(self) -> None:
        if self._box is not None:
            self._stderr += self._box.stderr
        if self._stdin is not None:
            self._stdout.framer = None
            self._box.frozen.set()
            self._stdin.close()
        self._box = self._stdin = self._stdout = None

    _kill = stop

    def _write(self, data: bytes) -> bool:
        if self._stdout.closed:
            return False
        self._box.budget = MAX_TURN_POINTS
        self._parks = self._stdin.parks
        self._stdin.feed(data)
        self._box.frozen.set()
        return True

    def _poll(self, timeout: float) -> str:
        with self._stdout.cv:
            if self._framer.done:
                return "data"
            if self._stdout.closed:
                return "exit"
            if self._stdin.parks > self._parks:
                return "park"
            self._stdout.cv.wait(timeout)
            return "wait"

    @property
    def live(self) -> tuple:
        return self._box.live if self._box is not None else (0, 0)

    def take_stderr(self) -> bytes:
        if self._box is not None:
            self._stderr += self._box.stderr
            self._box.stderr[:] = b""
        out, self._stderr = bytes(self._stderr), bytearray()
        return out

    def _reason(self) -> str:
        if self._box is None:
            return "exited"
        return self._box.failure or f"exited with code {self._box.exit_code or 0}"
