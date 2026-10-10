"""`unswbc vscode`: the replay viewer, installed into VS Code."""

from __future__ import annotations

import hashlib
import os
import pathlib
import shutil
import subprocess
import sys

from .errors import fail

EXTENSION = "unswbc.battledragon-replay-viewer"
VSIX = pathlib.Path(__file__).with_name("replay-viewer.vsix")
try:
    MARKER = pathlib.Path.home() / ".unswbc" / "viewer"
except RuntimeError:
    MARKER = None

ON_PATH = ("code", "cursor", "codium", "windsurf", "code-insiders")
# Insiders puts `code`, not `code-insiders`, in its own bundle; the branded name
# is only what it installs on PATH.
MAC_APPS = (
    ("Visual Studio Code", "code"),
    ("Visual Studio Code - Insiders", "code"),
    ("Cursor", "cursor"),
    ("VSCodium", "codium"),
    ("Windsurf", "windsurf"),
)
BUNDLED = tuple(
    f"{root}/{app}.app/Contents/Resources/app/bin/{binary}"
    for root in ("/Applications", os.path.expanduser("~/Applications"))
    for app, binary in MAC_APPS
) + (
    "/usr/share/code/bin/code",
    "/snap/bin/code",
    "/var/lib/flatpak/exports/bin/com.visualstudio.code",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"),
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\cursor\resources\app\bin\cursor.cmd"),
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\VSCodium\bin\codium.cmd"),
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Windsurf\bin\windsurf.cmd"),
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd"),
    os.path.expandvars(r"%ProgramFiles%\Microsoft VS Code\bin\code.cmd"),
    os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft VS Code\bin\code.cmd"),
    os.path.expandvars(r"%ProgramFiles%\VSCodium\bin\codium.cmd"),
)


def find_editor() -> str | None:
    for name in ON_PATH:
        found = shutil.which(name)
        if found:
            return found
    for path in BUNDLED:
        if pathlib.Path(path).is_file():
            return path
    return None


def _argv(editor: str, *args: str) -> list[str] | str:
    # CreateProcess cannot run a .cmd shim, which is what VS Code puts on PATH
    # for Windows, so that one goes through the interpreter instead. `/s` plus
    # the outer quotes keep a path with spaces in it in one piece.
    if sys.platform == "win32" and editor.lower().endswith((".cmd", ".bat")):
        return 'cmd /s /c "' + subprocess.list2cmdline([editor, *args]) + '"'
    return [editor, *args]


def installed_version(editor: str) -> str | None:
    try:
        done = subprocess.run(
            _argv(editor, "--list-extensions", "--show-versions"),
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in done.stdout.splitlines():
        name, _, version = line.strip().partition("@")
        if name == EXTENSION:
            return version or "installed"
    return None


def _remove_installed(editor: str) -> None:
    """VS Code keeps a directory per version and loads the highest it finds, so
    an older viewer left behind can outrank the one the toolkit ships."""
    if installed_version(editor) is None:
        return
    try:
        subprocess.run(_argv(editor, "--uninstall-extension", EXTENSION),
                       capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.SubprocessError):
        pass


def install(editor: str | None = None) -> tuple[bool, str]:
    editor = editor or find_editor()
    if editor is None:
        return False, "no VS Code on this machine"
    if not VSIX.is_file():
        return False, "this build ships no replay viewer"
    _remove_installed(editor)
    try:
        done = subprocess.run(
            _argv(editor, "--install-extension", str(VSIX), "--force"),
            capture_output=True, text=True, timeout=180,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return False, str(error)
    if done.returncode != 0:
        detail = (done.stderr or done.stdout).strip().splitlines()
        return False, detail[-1] if detail else f"{editor} exited {done.returncode}"
    _remember()
    return True, editor


def _stamp() -> str:
    return hashlib.sha256(VSIX.read_bytes()).hexdigest()


def _remember(value: str | None = None) -> None:
    if MARKER is None:
        return
    try:
        MARKER.parent.mkdir(parents=True, exist_ok=True)
        MARKER.write_text(value or _stamp())
    except OSError:
        pass


def ensure(quiet: bool = False) -> None:
    """Install the viewer the toolkit ships, and only when that one is not the
    one installed: every command asks, an upgrade is what answers."""
    if os.environ.get("UNSWBC_NO_VSCODE"):
        return
    try:
        if not VSIX.is_file():
            return
        if MARKER is not None and MARKER.is_file() and MARKER.read_text().strip() == _stamp():
            return
        if find_editor() is None:
            if not quiet:
                print("no VS Code, Cursor or VSCodium found. Install one, then run `unswbc vscode` "
                      "to set up the replay viewer.", file=sys.stderr)
            return
        ok, detail = install()
        print(f"installed the replay viewer into {detail}" if ok
              else f"replay viewer: {detail} -- run `unswbc vscode` to retry", file=sys.stderr)
    except Exception:
        pass


def command() -> int:
    ok, detail = install()
    if ok:
        print(f"installed the replay viewer into {detail}")
        print("open any .replay file in VS Code to watch the match")
        print("if VS Code is already open, run Developer: Reload Window first")
        print("if a replay shows a binary/encoding warning, right-click its tab and choose "
              "Reopen Editor With... > Battledragon Replay")
        return 0
    return fail(detail)
