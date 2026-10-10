"""Run with python -m unittest discover -s pythoncli/tests from the repo root."""

import contextlib
import io
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from unswbc import progress


class BarTests(unittest.TestCase):
    def test_it_starts_empty_and_never_fills(self):
        self.assertEqual(progress._bar(0, 10).count("#"), 0)
        self.assertLess(progress._bar(10, 10).count("#"), progress.WIDTH)
        self.assertLess(progress._bar(1000, 10).count("#"), progress.WIDTH + 1)

    def test_it_grows_with_the_wait(self):
        filled = [progress._bar(spent, 10).count("#") for spent in (1, 5, 20, 60)]
        self.assertEqual(filled, sorted(filled))
        self.assertLess(filled[0], filled[-1])

    def test_a_bar_is_always_its_full_width(self):
        for spent in (0, 3, 17, 900):
            self.assertEqual(len(progress._bar(spent, 10)), progress.WIDTH)


class WaitingTests(unittest.TestCase):
    def _run(self, tty: bool, body=lambda: None) -> str:
        said = io.StringIO()
        said.isatty = lambda: tty
        with contextlib.redirect_stdout(said):
            with progress.waiting("preparing something", 10):
                body()
        return said.getvalue()

    def test_a_pipe_gets_one_line_in_and_one_line_out(self):
        lines = self._run(tty=False).strip().splitlines()
        self.assertEqual(lines[0], "preparing something...")
        self.assertRegex(lines[-1], r"^preparing something: \d+s$")
        self.assertNotIn("\r", self._run(tty=False))

    def test_a_terminal_ends_on_a_full_bar(self):
        said = self._run(tty=True)
        self.assertIn("#" * progress.WIDTH, said)
        self.assertTrue(said.endswith("\n"))
        self.assertTrue(said.startswith("\r"))

    def test_the_line_is_closed_even_when_the_work_fails(self):
        said = io.StringIO()
        said.isatty = lambda: True
        with contextlib.redirect_stdout(said):
            with self.assertRaises(ValueError):
                with progress.waiting("preparing something", 10):
                    raise ValueError("the compile died")
        self.assertIn("#" * progress.WIDTH, said.getvalue())


if __name__ == "__main__":
    unittest.main()
