import pathlib
import shutil

from setuptools import setup

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
SOURCE = ROOT / "maps"
TARGET = HERE / "unswbc" / "templates" / "maps"
# Kept in the repo, but not boards anyone plays a contest game on, so the wheel
# doesn't carry them: small is the unit tests' and the fuzzer's fixture, help
# the judge's stress match.
UNSHIPPED = {"small.map", "queen_of_spades_but_she_ages.map", "help.map"}

if SOURCE.is_dir():
    TARGET.mkdir(parents=True, exist_ok=True)
    shipped = {
        path.name
        for path in SOURCE.glob("*.map")
        if path.name not in UNSHIPPED and not path.name.endswith(".private.map")
    }
    for stale in TARGET.glob("*.map"):
        if stale.name not in shipped:
            stale.unlink()
    for path in sorted(SOURCE.glob("*.map")):
        if path.name in shipped:
            shutil.copyfile(path, TARGET / path.name)

# Whoever installs the wheel has no checkout, so the PyPI page stops where the
# README turns to the repository.
MARKER = "<!-- pypi stops here -->"

for name, out in (("README.public.md", "README.md"), ("LICENSE", "LICENSE")):
    source = ROOT / name
    if not source.is_file():
        source = ROOT / out
    if not source.is_file():
        continue
    if out == "README.md":
        (HERE / out).write_text(source.read_text().split(MARKER)[0].rstrip() + "\n")
    else:
        shutil.copyfile(source, HERE / out)

setup()
