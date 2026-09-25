"""Builds a C or C++ bot to wasm32 with the judge's own clang, in the sandbox.

The flags, the source order and the link line are `judge/build.cc`'s, so a bot
built here is the bot the judge builds. One flag is ours: wasm-ld runs with
`--threads=1`, because a worker waiting on a futex never wakes in this host.
"""

from __future__ import annotations

import hashlib
import os
import pathlib
import shutil
import tempfile

from . import progress, update, webc
from .errors import UserError

C_SUFFIX = ".c"
CXX_SUFFIXES = (".cc", ".cpp", ".cxx", ".c++")
BUILD_PAGES = 32768
COMPILE_RATE = 5e6

DRIVER_FLAGS = [
    "--sysroot=/sysroot", "--target=wasm32-wasi", "-resource-dir=/lib/clang/20", "-B/bin",
    "-fintegrated-cc1", "-fwasm-exceptions", "-mllvm", "-wasm-enable-eh", "-mllvm",
    "-wasm-enable-sjlj", "-mllvm", "-wasm-use-legacy-eh=false", "-matomics", "-mbulk-memory",
    "-msimd128", "-mmutable-globals", "-pthread", "-ftls-model=local-exec",
    "-D_WASI_EMULATED_MMAN", "-D_WASI_EMULATED_SIGNAL", "-D_WASI_EMULATED_PROCESS_CLOCKS",
    "-DUSE_TIMEGM", "-Werror=date-time", "-O2", "-I.",
]
LINK_FLAGS = [
    "-m", "wasm32", "--strip-all", "--threads=1", "-L/lib/clang/20/lib/wasm32-unknown-wasi",
    "-L/sysroot/lib/wasm32-wasi", "/sysroot/lib/wasm32-wasi/crt1-command.o", "--shared-memory",
    "--max-memory=4294967296", "--import-memory", "-lunwind",
]
LINK_TAIL = [
    "-lpthread", "-lc", "/lib/clang/20/lib/wasm32-unknown-wasi/libclang_rt.builtins.a",
    "-o", "/out/bot.wasm",
]


class BuildError(UserError):
    pass


def shipped() -> pathlib.Path | None:
    """The toolchain the wheel carries, unpacked beside this module by
    build-sandbox.py: no checkout, no git-lfs, nothing to install."""
    home = pathlib.Path(__file__).resolve().parent / "clang"
    return home if (home / "clang.wasm").is_file() else None


def package() -> pathlib.Path:
    override = os.environ.get("UNSWBC_CLANG_WEBC")
    if override:
        return pathlib.Path(override)
    return pathlib.Path(__file__).resolve().parents[2] / "judge" / "sandbox" / "pkg" / "clang.webc"


def sources(directory: pathlib.Path) -> list[pathlib.Path]:
    """`judge/build.cc ListFiles`: every C and C++ source under the bot, dotfiles apart."""
    found = []
    for path in directory.rglob("*"):
        relative = path.relative_to(directory)
        if (path.is_file() and not path.is_symlink()
                and not any(part.startswith(".") for part in relative.parts)
                and (relative.suffix == C_SUFFIX or relative.suffix in CXX_SUFFIXES)):
            found.append(relative)
    return sorted(found, key=lambda path: path.as_posix())


def toolchain() -> pathlib.Path:
    from .sandbox import _cache_dir, _write_once

    path = package()
    if not os.environ.get("UNSWBC_CLANG_WEBC"):
        home = shipped()
        if home is not None:
            return home
    if not path.is_file():
        raise BuildError(
            "--sandbox builds C and C++ with the judge's clang, and this build ships no "
            f"copy of it. A released wheel carries one, so install that:\n"
            f"        {update.upgrade_command()}\n"
            "    A checkout of the private repo carries it too: run `git lfs pull`, then set\n"
            "    UNSWBC_CLANG_WEBC to judge/sandbox/pkg/clang.webc.\n"
            f"    Looked for it at {path}"
        )
    stat = path.stat()
    home = _cache_dir() / f"clang-{stat.st_size}-{int(stat.st_mtime)}"
    if (home / "clang.wasm").is_file():
        return home
    try:
        blob = path.read_bytes()
        index = webc.index(blob)
    except ValueError as error:
        raise BuildError(f"{path}: {error}") from error
    for name, volume in index["volumes"].items():
        if name.startswith("/"):
            webc.unpack(blob, volume["span"]["start"], home / "root" / name.lstrip("/"))
    _write_once(home / "clang.wasm", webc.module(blob, index["atoms"]["span"]))
    if not (home / "clang.wasm").is_file():
        raise BuildError(f"cannot write the toolchain to {home}")
    return home


def warm() -> bool:
    from .sandbox import compile_once, compiled_path

    try:
        home = toolchain()
    except BuildError:
        return False
    todo = [wasm for wasm in (home / "clang.wasm", home / "root" / "bin" / "wasm-ld")
            if not compiled_path(wasm).is_file()]
    if not todo:
        return False
    print("preparing judge clang for this machine", flush=True)
    for step, wasm in enumerate(todo, 1):
        with progress.waiting(f"  {wasm.stem} ({step} of {len(todo)})",
                              wasm.stat().st_size / COMPILE_RATE):
            compile_once(wasm)
    return True


def _step(wasm: pathlib.Path, home: pathlib.Path, argv: list[str],
          mounts: dict[str, pathlib.Path], what: str) -> None:
    from .sandbox import Sandbox

    box = Sandbox(wasm_path=wasm, root=home / "root", mounts=mounts, cwd="/src", argv=argv,
                  environ=["TERM=dumb", "PATH=/bin", "TMPDIR=/tmp"], writable=("/out", "/tmp"),
                  needs_zygote=False, needs_meter=False, max_pages=BUILD_PAGES)
    if box.run() != 0:
        said = (bytes(box.stdout) + bytes(box.stderr)).decode("utf-8", "replace").strip()
        raise BuildError(f"{what}\n{said}" if said else what)


def build(directory: pathlib.Path) -> pathlib.Path:
    from .sandbox import _cache_dir, _write_once

    found = sources(directory)
    if not found:
        raise BuildError(f"{directory}: no .c, .cc or .cpp sources in the submission")
    stamp = hashlib.sha256(
        repr([DRIVER_FLAGS, LINK_FLAGS, LINK_TAIL, [path.as_posix() for path in found]]).encode()
        + b"".join((directory / path).read_bytes() for path in found)).hexdigest()[:32]
    built = _cache_dir() / "wasmbots" / f"{directory.resolve().name}-{stamp}.wasm"
    if built.is_file():
        return built

    warm()
    home = toolchain()
    print(f"building {directory} to wasm with judge clang")
    work = pathlib.Path(tempfile.mkdtemp(prefix="unswbc-cxx-"))
    try:
        (work / "out").mkdir()
        (work / "tmp").mkdir()
        mounts = {"/src": directory, "/out": work / "out", "/tmp": work / "tmp"}
        objects = []
        for index, source in enumerate(found):
            language = (["-xc", "-std=c17"] if source.suffix == C_SUFFIX
                        else ["-xc++", "-std=c++20", "-stdlib=libc++"])
            objects.append(f"/tmp/{index}.o")
            _step(home / "clang.wasm", home,
                  ["/bin/clang-20", *DRIVER_FLAGS, "-c", "-o", objects[-1], *language,
                   source.as_posix()],
                  mounts, f"compiling {source.as_posix()}")
        any_cxx = any(source.suffix in CXX_SUFFIXES for source in found)
        _step(home / "root" / "bin" / "wasm-ld", home,
              ["/bin/wasm-ld", *LINK_FLAGS, *(["-lc++", "-lc++abi"] if any_cxx else []),
               *objects, *LINK_TAIL],
              mounts, "linking")
        blob = (work / "out" / "bot.wasm").read_bytes()
    finally:
        shutil.rmtree(work, ignore_errors=True)

    _write_once(built, blob)
    if not built.is_file():
        built = pathlib.Path(tempfile.mkdtemp()) / built.name
        built.write_bytes(blob)
    return built
