#!/usr/bin/env python3
"""Regenerates the --sandbox assets from the judge's python.webc.

Pulls out the interpreter the judge runs and the stdlib it runs against, prices
the interpreter in CPU points, and drops both beside the package. The judge's
package is the only source, so the sandbox cannot drift from it.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from unswbc import metering, webc

HERE = pathlib.Path(__file__).parent
WEBC = pathlib.Path(os.environ.get("PYTHON_WEBC", HERE / ".." / "judge" / "sandbox" / "pkg" / "python.webc"))
CLANG_WEBC = pathlib.Path(os.environ.get("CLANG_WEBC", HERE / ".." / "judge" / "sandbox" / "pkg" / "clang.webc"))
WASM_OUT = HERE / "unswbc" / "python-metered.wasm"
ROOT_OUT = HERE / "unswbc" / "sandbox-root"
CLANG_OUT = HERE / "unswbc" / "clang"


def main() -> None:
    if not WEBC.is_file():
        raise SystemExit(f"no python.webc at {WEBC}; set PYTHON_WEBC")
    blob = WEBC.read_bytes()
    try:
        index = webc.index(blob)
    except ValueError as error:
        raise SystemExit(f"{WEBC}: {error}")

    plain = webc.module(blob, index["atoms"]["span"])
    print(f"interpreter {len(plain) / 1e6:.1f} MB")
    metered = metering.instrument(plain)
    WASM_OUT.write_bytes(metered)
    print(f"priced      {len(metered) / 1e6:.1f} MB -> {WASM_OUT.name}")

    (ROOT_OUT / "sbin").mkdir(parents=True, exist_ok=True)
    for name, volume in index["volumes"].items():
        if not name.startswith("/"):
            continue
        dest = ROOT_OUT / name.lstrip("/").replace(".", "/")
        dirs, files, links = webc.unpack(blob, volume["span"]["start"], dest)
        print(f"volume {name}: {dirs} dirs, {files} files, {links} symlinks -> {dest}")

    zygote(WEBC.parent.parent / "guest-bin" / "zygote.py")
    zygote_drift(WEBC.parent.parent / "guest-bin" / "zygote.py")
    pycache()
    clang()


def clang() -> None:
    """`judge/build.cc` compiles C and C++ with this package, and so does
    `unswbc run --sandbox`, which is why the toolkit carries it."""
    if not CLANG_WEBC.is_file():
        raise SystemExit(f"no clang.webc at {CLANG_WEBC}; set CLANG_WEBC, or run `git lfs pull`")
    blob = CLANG_WEBC.read_bytes()
    try:
        index = webc.index(blob)
    except ValueError as error:
        raise SystemExit(f"{CLANG_WEBC}: {error}")
    shutil.rmtree(CLANG_OUT, ignore_errors=True)
    CLANG_OUT.mkdir(parents=True)
    module = webc.module(blob, index["atoms"]["span"])
    (CLANG_OUT / "clang.wasm").write_bytes(module)
    print(f"clang       {len(module) / 1e6:.1f} MB -> {CLANG_OUT.name}/clang.wasm")
    for name, volume in index["volumes"].items():
        if not name.startswith("/"):
            continue
        dirs, files, links = webc.unpack(blob, volume["span"]["start"],
                                         CLANG_OUT / "root" / name.lstrip("/"))
        print(f"volume {name}: {dirs} dirs, {files} files, {links} symlinks")


def zygote(src: pathlib.Path) -> None:
    """`judge/sandbox/compile_zygote.cc`: the guest interpreter compiles its own
    zygote, so a stale checked-in .pyc can never reach the sandbox."""
    from unswbc.sandbox import Sandbox

    work = ROOT_OUT / "zygote-compile"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    shutil.copy(src, work / "zygote.py")
    box = Sandbox(root=ROOT_OUT, writable=("/zygote-compile",), cwd="/zygote-compile",
                  needs_zygote=False,
                  environ=["TERM=dumb", "PYTHONHOME=/usr/local", "PYTHONHASHSEED=0",
                           "PYTHONUNBUFFERED=1"],
                  argv=["python", "-m", "compileall", "-b", "-q", "zygote.py"])
    if box.run() != 0:
        raise SystemExit(bytes(box.stderr).decode("utf-8", "replace") or "zygote compile failed")
    shutil.move(work / "zygote.pyc", ROOT_OUT / "sbin" / "zygote.pyc")
    shutil.rmtree(work, ignore_errors=True)


SHARED_ZYGOTE = ("FlushingStdin", "write_stderr", "exit_now", "guest_input", "attach_stdio", "run")


def zygote_drift(guest: pathlib.Path) -> None:
    """unswbc/zygote_host.py is the judge's zygote on the host interpreter. The
    parts that need no host change must stay identical to it."""
    import ast

    def parts(path):
        tree = ast.parse(path.read_text())
        return {n.name: ast.unparse(n) for n in tree.body
                if isinstance(n, (ast.FunctionDef, ast.ClassDef))}

    theirs, ours = parts(guest), parts(HERE / "unswbc" / "zygote_host.py")
    drift = [n for n in SHARED_ZYGOTE if theirs.get(n) != ours.get(n)]
    expected = ["guest_input", "attach_stdio", "run"]
    if drift != expected:
        print(f"zygote drift: {drift}, expected only {expected}; "
              "re-port unswbc/zygote_host.py from the judge's zygote.py")
    else:
        print(f"zygote: {len(SHARED_ZYGOTE) - len(drift)} of {len(SHARED_ZYGOTE)} parts identical")


def pycache() -> None:
    from unswbc.sandbox import Sandbox

    out = ROOT_OUT / "pycache"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    box = Sandbox(root=ROOT_OUT, writable=("/pycache",),
                  environ=["TERM=dumb", "PYTHONHOME=/usr/local", "PYTHONHASHSEED=0",
                           "PYTHONPYCACHEPREFIX=/pycache"],
                  argv=["python", "-m", "compileall", "-q", "--invalidation-mode",
                        "unchecked-hash", "/usr/local/lib/python3.13"])
    if box.run() != 0:
        raise SystemExit(bytes(box.stderr).decode("utf-8", "replace") or "compileall failed")
    print(f"pycache: {sum(1 for _ in out.rglob('*.pyc'))} files, {box.spent() / 1e9:.1f}G points")


if __name__ == "__main__":
    main()
