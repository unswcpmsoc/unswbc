"""Run with python -m unittest discover -s pythoncli/tests from the repo root."""

import contextlib
import io
import json
import pathlib
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from unswbc import update


class UpdateTests(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.stamp = pathlib.Path(temporary) / ".unswbc" / "update.json"
        self.enterContext(patch.object(update, "_path", lambda: self.stamp))
        self.enterContext(patch.object(update, "__version__", "0.3.6"))
        self.enterContext(patch.object(update, "_interactive", lambda: True))
        self.enterContext(patch.object(update.os.environ, "get", lambda name, default=None: default))
        self.real_command = update.upgrade_command
        self.enterContext(patch.object(update, "upgrade_command", lambda: "pip install --upgrade unswbc"))
        self.problem = self.enterContext(contextlib.redirect_stderr(io.StringIO()))

    def _seen(self, **fields):
        self.stamp.parent.mkdir(parents=True, exist_ok=True)
        self.stamp.write_text(json.dumps(fields))

    def test_a_newer_release_is_offered_and_installed(self):
        self._seen(latest="0.4.0", when=time.time())
        with patch.object(update, "input", lambda prompt: "", create=True), \
                patch.object(update.subprocess, "call", return_value=0) as pip:
            update.nag()
        self.assertEqual(pip.call_args.args[0], "pip install --upgrade unswbc")
        self.assertIn("0.4.0", self.problem.getvalue())

    def test_declining_leaves_the_toolkit_alone(self):
        self._seen(latest="0.4.0", when=time.time())
        with patch.object(update, "input", lambda prompt: "n", create=True), \
                patch.object(update.subprocess, "call") as pip:
            update.nag()
        pip.assert_not_called()
        self.assertIn("pip install --upgrade unswbc", self.problem.getvalue())

    def test_the_current_version_says_nothing(self):
        self._seen(latest="0.3.6", when=time.time())
        update.nag()
        self.assertEqual(self.problem.getvalue(), "")

    def test_an_unreachable_index_is_silent(self):
        with patch.object(update.urllib.request, "urlopen", side_effect=OSError):
            update.refresh()
        update.nag()
        self.assertEqual(self.problem.getvalue(), "")

    def test_it_asks_the_index_once_a_day(self):
        self._seen(latest="0.4.0", when=time.time())
        with patch.object(update.urllib.request, "urlopen") as feed:
            update.refresh()
        feed.assert_not_called()

    def test_a_pipe_is_never_prompted(self):
        self._seen(latest="0.4.0", when=time.time())
        with patch.object(update, "_interactive", lambda: False), \
                patch.object(update, "input", create=True) as ask:
            update.nag()
        ask.assert_not_called()
        self.assertIn("pip install --upgrade unswbc", self.problem.getvalue())

    def test_the_offer_comes_once_a_day(self):
        self._seen(latest="0.4.0", when=time.time(), asked=time.time())
        with patch.object(update, "input", create=True) as ask:
            update.nag()
        ask.assert_not_called()

    def test_a_failed_install_points_at_the_command(self):
        self._seen(latest="0.4.0", when=time.time())
        with patch.object(update, "input", lambda prompt: "y", create=True), \
                patch.object(update.subprocess, "call", return_value=1):
            update.nag()
        self.assertIn("run `pip install --upgrade unswbc` yourself", self.problem.getvalue())

    def test_the_line_suits_the_installer(self):
        for prefix, line in [("/home/a/.local/share/uv/tools/unswbc", "uv tool install unswbc@latest"),
                             ("/home/a/.local/pipx/venvs/unswbc", "pipx upgrade unswbc")]:
            with patch.object(update.sys, "prefix", prefix):
                self.assertEqual(self.real_command(), line)


if __name__ == "__main__":
    unittest.main()
