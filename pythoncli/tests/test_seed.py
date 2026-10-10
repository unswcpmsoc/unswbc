"""Run with python -m unittest discover -s pythoncli/tests from the repo root."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from unswbc.engine import EngineModule
from unswbc.sandbox import Rng

MAP = pathlib.Path(__file__).resolve().parents[2] / "maps/default.map"


def replay(seed: int) -> bytes:
    engine = EngineModule()
    engine.run(MAP.read_bytes(), lambda dragon, block: b"", seed=seed)
    return engine.replay("a", "b")


class SeedTests(unittest.TestCase):
    def test_the_same_seed_plays_the_same_game(self):
        self.assertEqual(replay(7), replay(7))

    def test_another_seed_moves_the_pearls(self):
        self.assertNotEqual(replay(7), replay(8))

    def test_a_seed_with_the_top_bit_set_goes_in(self):
        top = (1 << 64) - 1
        self.assertEqual(replay(top), replay(top))
        self.assertNotEqual(replay(top), replay(top >> 1))

    def test_bots_draw_what_the_judge_draws(self):
        # Also checked in judge/sandbox/src/limits/rng.rs.
        self.assertEqual(Rng("000000000000002a-a", "3").fill(16).hex(), "08fc7618131d497a63f1580c7863d5e9")


if __name__ == "__main__":
    unittest.main()
