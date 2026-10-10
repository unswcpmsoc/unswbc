"""Install missing maps bundled with the toolkit, preserving local files."""

from __future__ import annotations

import pathlib

from .errors import UserError

BUNDLED = pathlib.Path(__file__).with_name("templates") / "maps"


def add_missing(directory: pathlib.Path) -> pathlib.Path:
    """Add maps and return a map path suitable for the suggested run command."""
    sources = sorted(path for path in BUNDLED.glob("*.map") if path.is_file())
    if not sources:
        raise UserError("this build ships no maps; reinstall the toolkit")
    if directory.exists() and not directory.is_dir():
        raise UserError(f"{directory} exists and is not a directory")
    directory.mkdir(parents=True, exist_ok=True)
    added = 0
    for source in sources:
        target = directory / source.name
        if target.is_dir():
            raise UserError(f"{target} is a directory, expected a map file")
        contents = source.read_bytes()
        try:
            with target.open("xb") as output:
                output.write(contents)
        except FileExistsError:
            continue
        added += 1
    print(f"maps in {directory}: added {added}, kept {len(sources) - added} existing")
    first = next((path for path in sources if path.name == "arena.map"), sources[0])
    return directory / first.name


def replace_changed(directory: pathlib.Path) -> None:
    sources = sorted(path for path in BUNDLED.glob("*.map") if path.is_file())
    directory.mkdir(parents=True, exist_ok=True)
    changed = [source for source in sources
               if not (directory / source.name).is_file() or (directory / source.name).read_bytes() != source.read_bytes()]
    for source in changed:
        (directory / source.name).write_bytes(source.read_bytes())
    print(f"maps in {directory}: updated {len(changed)}, {len(sources) - len(changed)} already current")


def command(directory: str) -> int:
    add_missing(pathlib.Path(directory))
    return 0
