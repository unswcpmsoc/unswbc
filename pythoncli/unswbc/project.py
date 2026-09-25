"""A bot project: bot.toml, the sources it names, and how to build them."""

from __future__ import annotations

import fnmatch
import hashlib
import pathlib
import shutil
import tomllib
from dataclasses import dataclass, field

from . import toolchain
from .errors import UserError

BUILD_DIR_NAME = ".unswbc-build"
BUILD_STAMP = ".built-from"
LANGUAGES = {
    "py": "python", "python": "python",
    "cpp": "cpp", "c++": "cpp", "cxx": "cpp",
    "c": "c",
}


class ProjectError(UserError):
    pass


class NoBotfile(ProjectError):
    pass


@dataclass
class Project:
    path: pathlib.Path
    language: str
    output_dir: pathlib.Path
    includes: list[str]
    sources: list[str] = field(default_factory=list)

    @staticmethod
    def from_dir(botdir: str | pathlib.Path) -> "Project":
        path = pathlib.Path(botdir)
        botfile = path / "bot.toml"
        if not botfile.exists():
            raise NoBotfile("no bot.toml here (try `unswbc init`)")

        try:
            table = tomllib.loads(botfile.read_text())
        except (tomllib.TOMLDecodeError, UnicodeDecodeError) as error:
            raise ProjectError(f"bot.toml is not valid TOML: {error}") from error
        project = table.get("project")
        if not isinstance(project, dict):
            raise NoBotfile("no bot.toml here (try `unswbc init`)")

        name = project.get("language")
        if name is None:
            raise ProjectError("bot.toml is missing project.language")
        language = LANGUAGES.get(str(name).lower())
        if language is None:
            raise ProjectError("bot.toml names a language the toolkit cannot build")

        includes = project.get("include")
        if not isinstance(includes, list):
            raise ProjectError("bot.toml is missing project.include")

        return Project(
            path=path,
            language=language,
            output_dir=path / project.get("output", BUILD_DIR_NAME),
            includes=[str(p) for p in includes],
        )

    def _matches(self, relative: pathlib.PurePath) -> bool:
        whole = relative.as_posix()
        return any(
            fnmatch.fnmatchcase(whole, p) or fnmatch.fnmatchcase(relative.name, p)
            for p in self.includes
        )

    def collect_sources(self) -> None:
        output = self.output_dir.resolve()
        self.sources = sorted(
            str(entry.relative_to(self.path))
            for entry in self.path.rglob("*")
            if entry.is_file()
            and output not in entry.resolve().parents
            and self._matches(entry.relative_to(self.path))
        )

    def compile(self) -> pathlib.Path:
        self.collect_sources()
        if not self.sources:
            raise ProjectError("no files matched project.include")
        tool = (toolchain.find_python() if self.language == "python"
                else toolchain.find_compiler(self.language == "c"))
        stamp = self.output_dir.resolve() / BUILD_STAMP
        built_from = self._fingerprint(tool)
        if self._holds(built_from, stamp):
            return self.output_dir
        if self.language == "python":
            self._compile_python()
        else:
            self._compile_cxx(self.language == "c")
        stamp.write_text(built_from)
        return self.output_dir

    def _fingerprint(self, tool: list[str]) -> str:
        """The sources and the tool that built them: the same answer means the
        same artifact, so the build is skipped rather than repeated."""
        digest = hashlib.sha256("\0".join([self.language, *tool]).encode())
        try:
            digest.update(str(pathlib.Path(tool[0]).stat().st_mtime_ns).encode())
        except OSError:
            pass
        for source in self.sources:
            digest.update(source.encode())
            digest.update(hashlib.sha256((self.path / source).read_bytes()).digest())
        return digest.hexdigest()

    def _holds(self, built_from: str, stamp: pathlib.Path) -> bool:
        if not stamp.is_file() or stamp.read_text() != built_from:
            return False
        if self.language == "python":
            return (self.output_dir / "main.py").is_file()
        return any((self.output_dir / name).is_file()
                   for name in (toolchain.BOT_NAME, toolchain.BOT_NAME + ".exe"))

    def _stage(self) -> pathlib.Path:
        output = self.output_dir.resolve()
        for source in self.sources:
            target = output / source
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self.path / source, target)
        return output

    def _compile_python(self) -> None:
        output = self._stage()
        modules = [str(output / s) for s in self.sources if s.endswith(".py")]
        if not modules:
            raise ProjectError("no python sources matched project.include")

        argv = toolchain.find_python() + ["-m", "compileall", "-q", *modules]
        code, text = toolchain.run_capture(argv)
        if code != 0:
            shutil.rmtree(output, ignore_errors=True)
            raise ProjectError(text or "python reported a syntax error")

    def _compile_cxx(self, c_only: bool) -> None:
        root = self.path.resolve()
        units = [root / s for s in self.sources if toolchain.is_compilable(pathlib.Path(s))]
        if not units:
            raise ProjectError("no c/c++ sources matched project.include")
        try:
            toolchain.compile_sources(units, self.output_dir.resolve(), c_only)
        except Exception:
            shutil.rmtree(self.output_dir, ignore_errors=True)
            raise
