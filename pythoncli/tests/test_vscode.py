"""Run with python -m unittest discover -s pythoncli/tests from the repo root."""

import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from unswbc import vscode


class Ran:
    def __init__(self, stdout: str = "", code: int = 0):
        self.stdout, self.stderr, self.returncode = stdout, "", code


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.home = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(vscode, "MARKER", self.home / "viewer"))
        self.calls = []

    def _editor(self, listed: str):
        def run(argv, **kwargs):
            self.calls.append(argv[1] if isinstance(argv, list) else argv)
            return Ran(listed if "--list-extensions" in argv else "")
        return run

    def test_an_older_version_is_uninstalled_before_the_new_one_goes_in(self):
        with patch.object(subprocess, "run", side_effect=self._editor(f"{vscode.EXTENSION}@0.3.5")):
            ok, detail = vscode.install("/usr/bin/code")
        self.assertTrue(ok, detail)
        self.assertEqual(self.calls, ["--list-extensions", "--uninstall-extension",
                                      "--install-extension"])

    def test_nothing_is_uninstalled_when_nothing_is_installed(self):
        with patch.object(subprocess, "run", side_effect=self._editor("someone.else@1.0.0")):
            ok, _ = vscode.install("/usr/bin/code")
        self.assertTrue(ok)
        self.assertEqual(self.calls, ["--list-extensions", "--install-extension"])

    def test_a_failed_install_is_reported_and_not_remembered(self):
        with patch.object(subprocess, "run", return_value=Ran("nope", code=1)):
            ok, detail = vscode.install("/usr/bin/code")
        self.assertFalse(ok)
        self.assertEqual(detail, "nope")
        self.assertFalse((self.home / "viewer").is_file())


class EnsureTests(unittest.TestCase):
    def setUp(self):
        self.home = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(vscode, "MARKER", self.home / "viewer"))
        self.enterContext(patch.dict("os.environ", {}, clear=False))
        self.enterContext(patch.object(vscode.os.environ, "get", lambda key, default=None:
                                       None if key == "UNSWBC_NO_VSCODE" else default))

    def test_a_viewer_that_is_already_the_shipped_one_is_left_alone(self):
        (self.home / "viewer").write_text(vscode._stamp())
        with patch.object(vscode, "install") as installed:
            vscode.ensure()
        installed.assert_not_called()

    def test_a_new_toolkit_version_installs_its_viewer(self):
        (self.home / "viewer").write_text("the viewer of an older toolkit")
        with patch.object(vscode, "find_editor", return_value="/usr/bin/code"):
            with patch.object(vscode, "install", return_value=(True, "/usr/bin/code")) as installed:
                vscode.ensure(quiet=True)
        installed.assert_called_once()

    def test_no_editor_stays_quiet_when_asked_to(self):
        with patch.object(vscode, "find_editor", return_value=None):
            with patch("sys.stderr") as said:
                vscode.ensure(quiet=True)
        said.write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
