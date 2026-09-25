"""`unswbc init`: a new bot project, ready to run."""

from __future__ import annotations

import os
import pathlib
import sys

from . import maps
from .errors import fail
from .project import BUILD_DIR_NAME, NoBotfile, Project

TEMPLATES = pathlib.Path(__file__).with_name("templates")

SPECS = {
    "python": ("python", "py", '[ "*.py" ]', ["main.py", "helper.py"]),
    "py": ("python", "py", '[ "*.py" ]', ["main.py", "helper.py"]),
    "cpp": ("c++", "c++", '[ "*.cpp", "*.hpp", "*.cc", "*.hh", "*.c", "*.h" ]', ["main.cpp", "helper.hpp"]),
    "c++": ("c++", "c++", '[ "*.cpp", "*.hpp", "*.cc", "*.hh", "*.c", "*.h" ]', ["main.cpp", "helper.hpp"]),
    "c": ("c", "c", '[ "*.c" ]', ["main.c", "helper.h", "helper.c"]),
}

DIRS = {"python": "python", "c++": "cpp", "c": "c"}
HELPERS = {"python": ["helper.py"], "cpp": ["helper.hpp"], "c": ["helper.h", "helper.c"]}
CHOICES = ("python", "c++", "c")


def _ask() -> str | None:
    if not sys.stdin.isatty():
        return None
    print("language?")
    for index, name in enumerate(CHOICES, 1):
        print(f"  {index}  {name}")
    while True:
        try:
            reply = input(f"choose [{CHOICES[0]}]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        if not reply:
            return CHOICES[0]
        if reply.isdigit() and 1 <= int(reply) <= len(CHOICES):
            return CHOICES[int(reply) - 1]
        if reply in SPECS:
            return reply
        print(f"  not a language: {reply}")


def _botfile(label: str, token: str, include: str) -> str:
    head = "# created by `unswbc init`\n"
    if label == "c":
        head += "# only translation units belong in include; headers are pulled in by #include\n"
    return f'{head}[project]\nlanguage = "{token}"\ninclude = {include}\n'


def _ensure_gitignore(path: pathlib.Path) -> bool:
    if not path.exists():
        path.write_bytes(f"{BUILD_DIR_NAME}\n".encode())
        return True
    text = path.read_bytes().decode()
    if any(line in (BUILD_DIR_NAME, "/" + BUILD_DIR_NAME) for line in text.splitlines()):
        return False
    with path.open("ab") as out:
        if text and not text.endswith("\n"):
            out.write(b"\n")
        out.write(f"{BUILD_DIR_NAME}\n".encode())
    return True


def _quote(text: str) -> str:
    return f'"{text}"' if any(c in text for c in " \t") else text


def create(language: str | None, directory: str, force: bool) -> int:
    # `unswbc init mybot` reads as a directory, not as a language nobody has.
    if language and language.lower() not in SPECS and directory == ".":
        language, directory = None, language
    if language is None:
        language = _ask()
        if language is None:
            return fail("no language given; pass c, cpp, or python")

    spec = SPECS.get(language.lower())
    if spec is None:
        return fail(f"unknown language: {language} (expected c, cpp, or python)")
    label, token, include, sources = spec

    directory = directory or "."
    dir_path = pathlib.Path(directory)
    if dir_path.exists() and not dir_path.is_dir():
        return fail(f"{directory} exists and is not a directory")

    source_dir = TEMPLATES / DIRS[label]
    files = {"bot.toml": _botfile(label, token, include).encode()}
    for name in sources:
        files[name] = (source_dir / name).read_bytes()

    if not force:
        clashes = [name for name in files if (dir_path / name).exists()]
        if clashes:
            listed = "".join(f"\n  {name}" for name in clashes)
            return fail(f"{directory} already has project files:{listed}\nuse --force to overwrite")

    map_dir = dir_path.resolve().parent / "maps"
    if not dir_path.is_absolute():
        map_dir = pathlib.Path(os.path.relpath(map_dir))
    if map_dir.resolve() == dir_path.resolve():
        return fail("the bot directory cannot be named maps; that directory is reserved for shared maps")
    arena_path = maps.add_missing(map_dir)

    dir_path.mkdir(parents=True, exist_ok=True)
    for name, contents in files.items():
        target = dir_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)

    written = list(files)
    if _ensure_gitignore(dir_path / ".gitignore"):
        written.append(".gitignore")

    print(f"created {label} project in {directory}")
    print()
    for name in written:
        print(f"  {name}")
    print()

    if label != "python" and not os.environ.get("UNSWBC_NO_WARM"):
        from . import clangtool
        clangtool.warm()

    arena = _quote(str(arena_path))
    where = _quote(directory)
    print(f"play it with: unswbc run {arena} {where} {where}")
    return 0


def _helper_language(dir_path: pathlib.Path) -> str:
    try:
        return Project.from_dir(dir_path).language
    except NoBotfile:
        for language, names in HELPERS.items():
            if (dir_path / names[0]).is_file():
                return language
        raise


def update_helpers(directory: str) -> int:
    dir_path = pathlib.Path(directory)
    language = _helper_language(dir_path)
    changed = []
    for name in HELPERS[language]:
        shipped = (TEMPLATES / language / name).read_bytes()
        target = dir_path / name
        if target.is_file() and target.read_bytes() == shipped:
            continue
        backup = target.with_name(name + ".bak")
        had_old_copy = target.is_file()
        if had_old_copy:
            target.replace(backup)
        target.write_bytes(shipped)
        changed.append(f"{name}  (old copy in {backup.name})" if had_old_copy else name)

    maps.replace_changed(dir_path.resolve().parent / "maps")
    if not changed:
        print(f"helpers in {directory} are already current")
        return 0
    print(f"updated helpers in {directory}")
    print()
    for line in changed:
        print(f"  {line}")
    return 0
