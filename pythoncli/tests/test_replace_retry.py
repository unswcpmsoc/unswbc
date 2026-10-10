"""Run with python -m unittest discover -s pythoncli/tests from the repo root."""

import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from unswbc.sandbox import _replace_past_windows_locks


class ReplaceRetryTests(unittest.TestCase):
    def setUp(self):
        self.home = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.src = self.home / "0.o.tmp"
        self.dst = self.home / "0.o"
        self.src.write_bytes(b"object")

    def test_a_rename_nothing_holds_open_succeeds(self):
        with patch("time.sleep") as slept:
            _replace_past_windows_locks(self.src, self.dst)
        self.assertEqual(self.dst.read_bytes(), b"object")
        slept.assert_not_called()

    def test_a_scanner_holding_the_file_briefly_is_waited_out(self):
        real = pathlib.Path.replace
        calls = []

        def flaky(self_path, target):
            calls.append(target)
            if len(calls) < 3:
                raise PermissionError(32, "The process cannot access the file")
            return real(self_path, target)

        with patch.object(pathlib.Path, "replace", flaky), patch("time.sleep") as slept:
            _replace_past_windows_locks(self.src, self.dst)
        self.assertEqual(self.dst.read_bytes(), b"object")
        self.assertEqual(len(calls), 3)
        self.assertEqual(slept.call_count, 2)

    def test_a_file_held_open_forever_still_raises(self):
        def blocked(self_path, target):
            raise PermissionError(32, "The process cannot access the file")

        with patch.object(pathlib.Path, "replace", blocked), patch("time.sleep") as slept:
            with self.assertRaises(PermissionError):
                _replace_past_windows_locks(self.src, self.dst)
        self.assertEqual(slept.call_count, 6)


if __name__ == "__main__":
    unittest.main()
