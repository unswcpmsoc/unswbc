"""`unswbc`: the contest toolkit."""

from __future__ import annotations

import argparse
import platform
import re
import sys
import traceback

from . import (__version__, api, auth, init as init_command, maps, run as run_command,
               submit as submit_command, toolchain, update as update_command, vscode)
from .engine import DEBUG_ALL, DEBUG_DRAW, DEBUG_INDICATOR, DEBUG_LIMITS, DEBUG_LOGS
from .errors import UserError, fail, log_path, record

PLATFORM = {"Windows": "windows", "Darwin": "macos"}.get(platform.system(), "linux")

NEEDS = {"run": ("map",), "init": ("language", "directory"),
         "auth": ("action",), "submit": ("directory",)}

C_PROBE = "int main(void) { return 0; }\n"
CXX_PROBE = (
    "#include <ranges>\n#include <vector>\n"
    "int main() { std::vector<int> v{1, 2, 3}; for (int x : v | std::views::reverse) (void)x; return 0; }\n"
)


class _Help(argparse.HelpFormatter):
    def _format_action(self, action):
        one = super()._format_action
        if action.nargs != argparse.PARSER:
            return one(action)
        return "".join(one(sub) for sub in action._get_subactions())


def _python_line() -> str:
    argv = toolchain.find_python()
    line = " ".join(argv)
    code, output = toolchain.run_capture(argv + ["--version"])
    if code == 0 and output.strip():
        line += f" ({output.strip()})"
    return line


def _version_of(argv: list[str]) -> str:
    _, output = toolchain.run_capture(argv + ["--version"])
    line = next((text.strip() for text in output.splitlines() if text.strip()), "")
    found = re.search(r"\d+(?:\.\d+)+", line)
    if not found:
        return ""
    low = line.lower()
    name = "clang" if "clang" in low else "msvc" if "microsoft" in low else "gcc"
    return f"{name} {found.group()}"


def _compiler_line(c_only: bool, build: bool) -> str:
    argv = toolchain.find_compiler(c_only)
    notes = [note for note in (_version_of(argv),) if note]
    if build:
        import pathlib
        import shutil
        import tempfile

        directory = pathlib.Path(tempfile.mkdtemp(prefix="unswbc-doctor"))
        try:
            source = directory / ("probe.c" if c_only else "probe.cpp")
            source.write_text(C_PROBE if c_only else CXX_PROBE)
            toolchain.compile_sources([source], directory, c_only)
        finally:
            shutil.rmtree(directory, ignore_errors=True)
        notes.append("builds -std=c17" if c_only else "builds -std=c++20")
    return " ".join(argv) + (f" ({', '.join(notes)})" if notes else "")


def _row(found: bool, label: str, detail: str) -> None:
    print(f"  {'found' if found else 'not found':<10}{label:<8}{detail}")


def machine(build: bool) -> None:
    print(f"this machine ({PLATFORM}):")

    ok = True
    for label, probe in (
        ("python", lambda: _python_line()),
        ("c", lambda: _compiler_line(True, build)),
        ("c++", lambda: _compiler_line(False, build)),
    ):
        try:
            _row(True, label, probe())
        except Exception as error:
            _row(False, label, str(error))
            ok = False

    editor = vscode.find_editor()
    _row(bool(editor), "editor", editor or "no VS Code, Cursor or VSCodium on PATH (optional)")
    version = vscode.installed_version(editor) if editor else None
    _row(bool(version), "viewer", f"replay viewer {version}" if version else "run `unswbc vscode` to install it (optional)")

    print()
    print(f"server: {api.server()}")
    if ok:
        print("ready: `unswbc init` and `unswbc run` will work here")
    else:
        print("not ready: install what is marked `not found` above, then run `unswbc` again")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="unswbc",
        description=f"UNSW Battlecode toolkit {__version__}",
        usage="unswbc <command> [options]",
        formatter_class=_Help,
        add_help=False,
    )
    parser.add_argument("-h", "--help", action="store_true", help="Show this message")
    parser.add_argument("-V", "--version", action="version", version=f"unswbc {__version__}", help="Show the version")
    parser.add_argument("-b", "--build", action="store_true", help="Also compile a test program")
    parser._positionals.title = "commands"
    sub = parser.add_subparsers(prog="unswbc", dest="command", metavar="command")

    new = sub.add_parser("init", help="Create a new C, C++, or Python bot project")
    new.add_argument("language", nargs="?", help="c, cpp, or python; asks if left out")
    new.add_argument("directory", nargs="?", help="where to create it, the current one by default")
    new.add_argument("-f", "--force", action="store_true", help="Overwrite existing project files")

    refresh = sub.add_parser("update", help="Replace a bot's helper files and the shared maps with the ones this toolkit ships")
    refresh.add_argument("directory", nargs="?", default=".", help="the bot project, the current one by default")

    map_command = sub.add_parser("maps", help="Add missing bundled maps without overwriting existing files")
    map_command.add_argument("directory", nargs="?", default="maps", help="map folder, defaults to maps")

    play = sub.add_parser("run", help="Build two bots and battle them on a map")
    play.add_argument("map", nargs="?", help="a .map file")
    play.add_argument("bots", nargs="*", default=[])
    play.add_argument("-v", "--verbose", action="store_true",
                      help="Log every round, map warning and dragon output, one line at a time")
    play.add_argument("-o", "--output", "--replay", dest="output", help="Write the replay to this path, or into this folder (default replays/)")
    play.add_argument("--no-replay", action="store_true", help="Do not write a replay")
    play.add_argument("--no-logs", action="store_true", help="Keep LOG lines out of the replay")
    play.add_argument("--no-indicator", action="store_true", help="Keep INDICATOR text out of the replay")
    play.add_argument("--no-draw", action="store_true", help="Keep DOT and LINE drawings out of the replay")
    play.add_argument("--no-debug", action="store_true",
                      help="Keep all of it out, warnings about unreadable lines included")
    play.add_argument("--sandbox", action="store_true",
                      help="Run python, C, C++ and wasm bots in the judge's sandbox, price them in CPU points"
                           " and cap their logs, indicators and drawings as the judge does")

    key = sub.add_parser("auth", help="Hold the API key this machine submits with")
    key.add_argument("action", nargs="?", choices=("set", "status", "clear"))
    key.add_argument("token", nargs="?", help="the key, for `set`")

    send = sub.add_parser("submit", help="Upload a bot to the contest server")
    send.add_argument("directory", nargs="?", help="the project to upload")
    send.add_argument("-n", "--name", help="version name, dated by default")
    send.add_argument("-d", "--description", help="what changed")

    sub.add_parser("vscode", help="Install the replay viewer into VS Code")

    sub.add_parser("log", help="Show the errors this machine has hit")

    topic = sub.add_parser("help", help="Show help for a command")
    topic.add_argument("topic", nargs="?")
    topic.add_argument("-b", "--build", action="store_true", dest="build_topic", help="Also compile a test program")
    return parser


def show_log() -> int:
    try:
        text = log_path().read_text(errors="replace").strip()
    except OSError:
        text = ""
    print(text or f"nothing logged yet ({log_path()})")
    if text:
        print(f"\nlog file: {log_path()}")
    return 0


def _run(argv: list[str] | None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command in (None, "help", "auth", "submit"):
        update_command.refresh()
    if args.command == "vscode":
        return vscode.command()
    if args.command == "log":
        return show_log()
    if args.command == "maps":
        return maps.command(args.directory)
    if args.command == "update":
        return init_command.update_helpers(args.directory)

    needed = NEEDS.get(args.command)
    if needed and all(getattr(args, name) is None for name in needed):
        parser.parse_args([args.command, "--help"])

    topic = getattr(args, "topic", None)
    if args.command is None or args.command == "help":
        if topic:
            parser.parse_args([topic, "--help"])
            return 0
        parser.print_help()
        print()
        machine(args.build or getattr(args, "build_topic", False))
        return 0
    if args.command == "auth":
        return auth.command(args.action, args.token)
    if args.command == "submit":
        return submit_command.execute(args.directory, args.name, args.description)
    if args.command == "init":
        code = init_command.create(args.language, args.directory or ".", args.force)
        if code == 0:
            vscode.ensure()
        return code

    if args.output and args.no_replay:
        return fail("--no-replay cannot be used with -o")

    keep = 0 if args.no_debug else DEBUG_ALL
    if args.no_logs:
        keep &= ~DEBUG_LOGS
    if args.no_indicator:
        keep &= ~DEBUG_INDICATOR
    if args.no_draw:
        keep &= ~DEBUG_DRAW
    if args.sandbox:
        keep |= DEBUG_LIMITS
    return run_command.execute(args.map, args.bots, args.verbose, args.output, args.no_replay,
                               args.sandbox, keep)


def main(argv: list[str] | None = None) -> int:
    try:
        return _run(argv)
    except KeyboardInterrupt:
        print()
        return 130
    except (UserError, OSError) as error:
        return fail(str(error))
    except Exception:
        where = record(traceback.format_exc())
        traceback.print_exc()
        print(f"\nunswbc hit a bug of its own. The trace above is in {where};"
              " send it to us with `unswbc log`.", file=sys.stderr)
        return 1
    finally:
        vscode.ensure(quiet=True)
        update_command.nag()


if __name__ == "__main__":
    sys.exit(main())
