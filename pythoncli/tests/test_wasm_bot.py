"""Run with python -m unittest discover -s pythoncli/tests from the repo root."""

import contextlib
import io
import pathlib
import sys
import tempfile
import unittest
import unittest.mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from wasmtime import wat2wasm

import fuzz_wasm
from unswbc import clangtool, metering, run, sandbox

REPO = pathlib.Path(__file__).resolve().parents[2]

SPINNER = '''(module
  (import "env" "memory" (memory 2 100 shared))
  (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 4096))
    (i32.store (i32.const 4) (i32.const 60000))
    (drop (call $read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 32)))
    BODY))'''


class WasmBotTests(unittest.TestCase):
    def setUp(self):
        self.home = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(unittest.mock.patch.dict("os.environ", {"XDG_CACHE_HOME": str(self.home / "cache")}))

    def test_a_wasm_bot_answers_a_turn(self):
        payload = b"MOVE N\nENDTURN\n"
        reply, error, live = fuzz_wasm.one_turn(fuzz_wasm.talker(payload), self.home)
        self.assertEqual(reply, b"MOVE N\n")
        self.assertIsNone(error)
        # The write, plus 6 points a byte for the turn read from stdin.
        read = len(b"ROUND 1\n")
        self.assertEqual(live[0], 2_500_000 + 4_000 * len(payload) + 6 * read + fuzz_wasm.TURN_TAIL_POINTS)

    def test_a_module_with_no_meter_is_refused(self):
        room = pathlib.Path(tempfile.mkdtemp(dir=self.home))
        raw = room / "main.wasm"
        raw.write_bytes(fuzz_wasm.module(fuzz_wasm.random.Random(1), count=2)[0])
        box = sandbox.Sandbox(wasm_path=raw, root=room, argv=["bot"], environ=[], needs_zygote=False)
        with self.assertRaises(sandbox.SandboxError) as refused:
            box.instantiate()
        self.assertIn("carries no meter", str(refused.exception))

    def test_a_priced_module_is_priced_once(self):
        room = pathlib.Path(tempfile.mkdtemp(dir=self.home))
        raw = room / "main.wasm"
        raw.write_bytes(fuzz_wasm.module(fuzz_wasm.random.Random(2), count=4)[0])
        priced = sandbox._metered(raw)
        self.assertNotEqual(priced, raw)
        self.assertEqual(sandbox._metered(priced), priced)
        stamp = priced.stat().st_mtime_ns
        self.assertEqual(sandbox._metered(raw), priced)
        self.assertEqual(priced.stat().st_mtime_ns, stamp)

    def test_a_runaway_bot_dies_on_its_budget(self):
        reply, error, _ = fuzz_wasm.one_turn(wat2wasm(SPINNER.replace("BODY", "(loop $l (br $l))")), self.home)
        self.assertEqual(reply, b"")
        self.assertEqual(error, "exceeded CPU limit")

    def test_a_trap_ends_the_turn(self):
        reply, error, _ = fuzz_wasm.one_turn(wat2wasm(SPINNER.replace("BODY", "(unreachable)")), self.home)
        self.assertEqual(reply, b"")
        self.assertIsNotNone(error)

    def test_a_bot_that_exits_ends_the_turn(self):
        reply, error, _ = fuzz_wasm.one_turn(wat2wasm(SPINNER.replace("BODY", "(return)")), self.home)
        self.assertEqual(reply, b"")
        self.assertIsNotNone(error)

    def test_output_past_the_buffer_limit_is_cut(self):
        line = b"N" * (fuzz_wasm.BUFFER_LIMIT + 500)
        reply, error, _ = fuzz_wasm.one_turn(fuzz_wasm.talker(line + b"\nENDTURN\n"), self.home)
        self.assertEqual(reply, line[:fuzz_wasm.BUFFER_LIMIT])
        self.assertIsNone(error)

    def test_a_bot_that_stops_reading_ends_its_turn(self):
        reply, error, _ = fuzz_wasm.one_turn(fuzz_wasm.talker(b"MOVE N\n"), self.home)
        self.assertEqual(reply, b"MOVE N\n")
        self.assertIsNone(error)

    def test_a_directory_and_a_file_both_name_a_wasm_bot(self):
        room = pathlib.Path(tempfile.mkdtemp(dir=self.home))
        module = room / "main.wasm"
        module.write_bytes(fuzz_wasm.talker(b"ENDTURN\n"))
        self.assertEqual(run._inspect(room)[2], "wasm")
        self.assertEqual(run._inspect(module)[2], "wasm")

    def test_a_wasm_bot_needs_the_sandbox(self):
        room = pathlib.Path(tempfile.mkdtemp(dir=self.home))
        (room / "main.wasm").write_bytes(fuzz_wasm.talker(b"ENDTURN\n"))
        with contextlib.redirect_stderr(io.StringIO()) as complaint:
            code = run.execute(str(REPO / "maps/small.map"), [str(room), str(room)],
                               False, None, True, sandbox=False)
        self.assertEqual(code, 1)
        self.assertIn("--sandbox", complaint.getvalue())

    def test_the_sandbox_still_refuses_a_native_bot(self):
        room = pathlib.Path(tempfile.mkdtemp(dir=self.home))
        binary = room / "bot"
        binary.write_bytes(b"\x7fELF")
        binary.chmod(0o755)
        with contextlib.redirect_stderr(io.StringIO()) as complaint:
            code = run.execute(str(REPO / "maps/small.map"), [str(room), str(room)],
                               False, None, True, sandbox=True)
        self.assertEqual(code, 1)
        self.assertIn("wasm bots only", complaint.getvalue())


class CxxBotTests(unittest.TestCase):
    CPPBOT = REPO / "examples" / "cppbot"

    def test_the_sources_are_the_ones_the_judge_compiles(self):
        room = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name in ("b.cpp", "a.c", "deep/c.cc", ".git/d.c", "notes.txt", "bot.h"):
            path = room / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("")
        self.assertEqual([path.as_posix() for path in clangtool.sources(room)],
                         ["a.c", "b.cpp", "deep/c.cc"])

    def test_the_wheel_carries_the_toolchain(self):
        home = pathlib.Path(clangtool.__file__).resolve().parent / "clang"
        found = clangtool.shipped()
        if (home / "clang.wasm").is_file():
            self.assertEqual(found, home)
            self.assertTrue((home / "root" / "bin" / "wasm-ld").is_file())
        else:
            self.assertIsNone(found)

    def test_a_missing_toolchain_names_the_way_back(self):
        room = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(unittest.mock.patch.dict(
            "os.environ", {"UNSWBC_CLANG_WEBC": str(room / "absent.webc")}))
        with unittest.mock.patch.object(sys, "prefix", "/home/a/.local/share/uv/tools/unswbc"):
            with self.assertRaises(clangtool.BuildError) as raised:
                clangtool.toolchain()
        self.assertIn("uv tool install unswbc@latest", str(raised.exception))

    @unittest.skipUnless(clangtool.package().is_file(), "this checkout has no clang.webc")
    def test_a_cxx_bot_builds_to_wasm_and_is_priced(self):
        argv, botdir, kind = run._resolve(str(self.CPPBOT), sandbox=True)
        self.assertEqual((botdir, kind), (self.CPPBOT, "wasm"))
        module = pathlib.Path(argv[0])
        self.assertEqual(module.read_bytes()[:4], b"\0asm")
        self.assertNotIn(metering.REMAINING, module.read_bytes())
        self.assertIn(metering.REMAINING, sandbox._metered(module).read_bytes())

    @unittest.skipUnless(clangtool.package().is_file(), "this checkout has no clang.webc")
    def test_a_cxx_bot_plays_a_game_in_the_sandbox(self):
        with contextlib.redirect_stdout(io.StringIO()) as said:
            code = run.execute(str(REPO / "maps/small.map"), [str(self.CPPBOT)] * 2,
                               False, None, True, sandbox=True)
        self.assertEqual(code, 0)
        self.assertIn("loaded wasm vs wasm", said.getvalue())
        self.assertIn("wins after", said.getvalue())


if __name__ == "__main__":
    unittest.main()
