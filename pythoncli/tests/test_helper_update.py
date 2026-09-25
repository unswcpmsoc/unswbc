"""Run with python -m unittest discover -s pythoncli/tests from the repo root."""

import contextlib
import io
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from unswbc import init, maps
from unswbc.errors import UserError


class HelperUpdateTests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        bundle = self.root / "bundle"
        bundle.mkdir()
        (bundle / "arena.map").write_bytes(b"arena")
        self.enterContext(patch.object(maps, "BUNDLED", bundle))
        self.output = self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def test_old_helpers_are_replaced_and_kept_as_backups(self):
        for language, helpers in (("python", ["helper.py"]), ("cpp", ["helper.hpp"]), ("c", ["helper.h", "helper.c"])):
            bot = self.root / language
            init.create(language, str(bot), False)
            main_file = next(bot.glob("main.*"))
            main_file.write_bytes(b"my bot")
            for name in helpers:
                (bot / name).write_bytes(b"old helper")

            self.assertEqual(init.update_helpers(str(bot)), 0)

            template_dir = init.TEMPLATES / init.DIRS[init.SPECS[language][0]]
            for name in helpers:
                self.assertEqual((bot / name).read_bytes(), (template_dir / name).read_bytes())
                self.assertEqual((bot / (name + ".bak")).read_bytes(), b"old helper")
            self.assertEqual(main_file.read_bytes(), b"my bot")

    def test_current_helpers_are_left_alone(self):
        bot = self.root / "bot"
        init.create("python", str(bot), False)
        self.assertEqual(init.update_helpers(str(bot)), 0)
        self.assertIn("already current", self.output.getvalue())
        self.assertFalse((bot / "helper.py.bak").exists())

    def test_changed_and_missing_maps_are_replaced(self):
        bot = self.root / "bot"
        init.create("python", str(bot), False)
        (self.root / "maps" / "arena.map").write_bytes(b"old arena")
        (maps.BUNDLED / "new.map").write_bytes(b"new")
        init.update_helpers(str(bot))
        self.assertEqual((self.root / "maps" / "arena.map").read_bytes(), b"arena")
        self.assertEqual((self.root / "maps" / "new.map").read_bytes(), b"new")

    def test_a_folder_without_bot_toml_is_refused(self):
        with self.assertRaises(UserError):
            init.update_helpers(str(self.root))


if __name__ == "__main__":
    unittest.main()
