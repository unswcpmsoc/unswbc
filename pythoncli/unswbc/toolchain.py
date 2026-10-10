"""Finding and driving the tools already on this machine."""

from __future__ import annotations

import os
import pathlib
import platform
import shutil
import subprocess
import sys
import sysconfig

from .errors import UserError

BOT_NAME = "bot"

if sys.platform == "win32":
    PYTHON_HINT = 'install it from https://python.org/downloads (tick "Add python.exe to PATH")'
    COMPILER_HINT = "install Visual Studio Build Tools, then run from a Developer Command Prompt"
elif sys.platform == "darwin":
    PYTHON_HINT = "install it with `brew install python`"
    COMPILER_HINT = "run `xcode-select --install`"
else:
    PYTHON_HINT = "install it with your package manager, e.g. `sudo apt install python3`"
    COMPILER_HINT = "install it with your package manager, e.g. `sudo apt install g++`"


class ToolError(UserError):
    pass


def which(program: str) -> str | None:
    if os.sep in program or (os.altsep and os.altsep in program):
        path = pathlib.Path(program)
        return os.path.abspath(path) if path.is_file() and os.access(path, os.X_OK) else None
    return shutil.which(program)


def _first_available(override: str, candidates: list[list[str]], what: str, hint: str) -> list[str]:
    chosen = os.environ.get(override, "")
    if chosen:
        resolved = which(chosen)
        if resolved:
            return [resolved]
        raise ToolError(f'{override} is set to "{chosen}", which is not on PATH')

    for candidate in candidates:
        resolved = which(candidate[0])
        if resolved:
            return [resolved, *candidate[1:]]

    names = ", ".join(" ".join(c) for c in candidates)
    raise ToolError(
        f"cannot find {what} on PATH (tried {names}) — {hint}, or set {override} to its full path"
    )


def _python_probe(argv: list[str]) -> bool:
    """Return True if *argv* is a real Python (not a store shim or stub)."""
    try:
        code, output = run_capture(argv + ["-c", "print(1)"], timeout=3.0)
    except (FileNotFoundError, OSError):
        return False
    if code != 0:
        return False
    # Microsoft Store stubs print a store-redirect message instead of "1".
    if output.strip() != "1":
        return False
    return True


def find_python() -> list[str]:
    chosen = os.environ.get("UNSWBC_PYTHON", "")
    if chosen:
        resolved = which(chosen)
        if resolved is None:
            raise ToolError(
                f'UNSWBC_PYTHON is set to "{chosen}", which is not on PATH'
            )
        argv = [resolved]
        if not _python_probe(argv):
            raise ToolError(
                f'UNSWBC_PYTHON is set to "{resolved}", but it is not a'
                " working Python interpreter (the store stub?)"
            )
        return argv

    candidates = [["python3"], ["python"], ["py", "-3"]]
    for candidate in candidates:
        resolved = which(candidate[0])
        if resolved is None:
            continue
        argv = [resolved, *candidate[1:]]
        if _python_probe(argv):
            return argv

    names = ", ".join(" ".join(c) for c in candidates)
    raise ToolError(
        "cannot find a working Python on PATH"
        f" (tried {names}).\n"
        f"    {PYTHON_HINT}\n"
        '    On Windows, uninstall any "Python" entries from the Microsoft'
        " Store,\n"
        "    download Python from python.org, and tick\n"
        '    "Add python.exe to PATH" in the installer.\n'
        "    You can also set UNSWBC_PYTHON to the full path of your"
        " Python\n"
        "    interpreter to bypass PATH lookup entirely."
    )


def find_compiler(c_only: bool) -> list[str]:
    if c_only:
        return _first_available("CC", [["cc"], ["gcc"], ["clang"], ["cl"]], "c compiler", COMPILER_HINT)
    return _first_available(
        "CXX", [["c++"], ["g++"], ["clang++"], ["cl"]], "c++ compiler", COMPILER_HINT
    )


def run_capture(argv: list[str], timeout: float | None = None) -> tuple[int, str]:
    kwargs = {"capture_output": True, "text": True, "errors": "replace"}
    if timeout is not None:
        kwargs["timeout"] = timeout
    try:
        done = subprocess.run(argv, **kwargs)
        return done.returncode, done.stdout + done.stderr
    except subprocess.TimeoutExpired as exc:
        return 1, (exc.stdout or "") + (exc.stderr or "")


def is_compilable(path: pathlib.Path) -> bool:
    return path.suffix in (".c", ".cc", ".cpp", ".cxx")


def is_executable(path: pathlib.Path) -> bool:
    if not path.is_file():
        return False
    return True if sys.platform == "win32" else os.access(path, os.X_OK)


def compile_sources(sources: list[pathlib.Path], output_dir: pathlib.Path, c_only: bool) -> pathlib.Path:
    if not sources:
        raise ToolError("no c/c++ sources to compile")
    output_dir.mkdir(parents=True, exist_ok=True)

    argv = find_compiler(c_only)
    msvc = pathlib.Path(argv[0]).stem.lower() == "cl"
    binary = output_dir / (BOT_NAME + (".exe" if msvc else ""))

    if msvc:
        argv += ["/std:c17" if c_only else "/std:c++20", "/O2", "/nologo", "/EHsc"]
    else:
        argv += ["-std=c17" if c_only else "-std=c++20", "-O2"]

    argv += [str(s) for s in sources]
    argv += [f"/Fe:{binary}", f"/Fo:{output_dir}\\"] if msvc else ["-o", str(binary)]

    code, output = run_capture(argv)
    if code != 0:
        raise ToolError(output or "the compiler reported an error")
    return binary


def wasm_runtime(error: Exception) -> ToolError:
    """wasmtime carries one binary per machine and chooses it by what the machine
    reports, not by what this interpreter was built for, so an x86-64 Python on a
    Windows ARM machine asks for a file its own wheel does not carry."""
    return ToolError(
        f"this Python cannot load wasmtime, which runs the engine:\n        {error}\n"
        f"    It is a {sysconfig.get_platform()} Python on a machine reporting "
        f"{platform.machine()}.\n"
        "    Install a Python built for this machine, then put the toolkit on that one:\n"
        "        uv python install 3.13\n"
        "        uv tool install unswbc --force --python 3.13"
    )
