"""Run with python -m unittest discover -s pythoncli/tests from the repo root."""

import contextlib
import io
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from unswbc import init, maps
from unswbc.errors import UserError


class MapsTests(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.root = pathlib.Path(temporary)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        (self.bundle / "arena.map").write_bytes(b"arena")
        self.enterContext(patch.object(maps, "BUNDLED", self.bundle))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def test_init_all_languages_share_maps(self):
        for language in ("python", "cpp", "c"):
            bot = self.root / language
            self.assertEqual(init.create(language, str(bot), False), 0)
            self.assertTrue((bot / "bot.toml").is_file())
            self.assertFalse((bot / "maps").exists())
        self.assertEqual((self.root / "maps" / "arena.map").read_bytes(), b"arena")

    def test_updates_and_force_init_preserve_existing_maps(self):
        bot = self.root / "bot"
        init.create("python", str(bot), False)
        destination = self.root / "maps"
        (destination / "arena.map").write_bytes(b"edited arena")
        (destination / "custom.map").write_bytes(b"custom")
        (self.bundle / "new.map").write_bytes(b"new")
        init.create("python", str(bot), True)
        self.assertEqual((destination / "arena.map").read_bytes(), b"edited arena")
        self.assertEqual((destination / "custom.map").read_bytes(), b"custom")
        self.assertEqual((destination / "new.map").read_bytes(), b"new")
        self.assertEqual(maps.command(str(destination)), 0)
        self.assertEqual((destination / "arena.map").read_bytes(), b"edited arena")

    def test_current_directory_uses_sibling_maps(self):
        bot = self.root / "bot with spaces"
        bot.mkdir()
        previous = pathlib.Path.cwd()
        try:
            os.chdir(bot)
            self.assertEqual(init.create("python", ".", False), 0)
        finally:
            os.chdir(previous)
        self.assertTrue((self.root / "maps" / "arena.map").is_file())
        self.assertFalse((bot / "maps").exists())

    def test_separate_command_creates_custom_folder(self):
        destination = self.root / "custom maps"
        self.assertEqual(maps.command(str(destination)), 0)
        self.assertEqual((destination / "arena.map").read_bytes(), b"arena")

    def test_missing_bundle_does_not_create_bot(self):
        with patch.object(maps, "BUNDLED", self.root / "absent"):
            with self.assertRaises(UserError):
                init.create("python", str(self.root / "bot"), False)
        self.assertFalse((self.root / "bot").exists())

    def test_map_folder_collision_does_not_create_bot(self):
        (self.root / "maps").write_bytes(b"keep")
        with self.assertRaises(UserError):
            init.create("python", str(self.root / "bot"), False)
        self.assertFalse((self.root / "bot").exists())
        self.assertEqual((self.root / "maps").read_bytes(), b"keep")


if __name__ == "__main__":
    unittest.main()
