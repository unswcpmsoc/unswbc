"""Run with python -m unittest discover -s pythoncli/tests from the repo root."""

import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from unswbc import clangtool, metering, webc

REPO = pathlib.Path(__file__).resolve().parents[2]
PACKAGES = [REPO / "judge" / "sandbox" / "pkg" / name
            for name in ("python.webc", "clang.webc", "zygote.webc")]


def module(*sections: tuple[int, bytes]) -> bytes:
    out = bytearray(b"\0asm\x01\0\0\0")
    for sid, body in sections:
        out += bytes([sid]) + bytes([len(body)]) + body
    return bytes(out)


class CborTests(unittest.TestCase):
    def test_it_reads_every_width_of_integer(self):
        for blob, want in [(b"\x0a", 10), (b"\x18\x2a", 42), (b"\x19\x01\x00", 256),
                           (b"\x1a\x00\x01\x00\x00", 65536),
                           (b"\x1b\x00\x00\x00\x01\x00\x00\x00\x00", 1 << 32)]:
            self.assertEqual(webc.cbor(blob, 0), (want, len(blob)))

    def test_it_reads_the_shapes_a_manifest_uses(self):
        self.assertEqual(webc.cbor(b"\x63abc", 0)[0], "abc")
        self.assertEqual(webc.cbor(b"\x43\x01\x02\x03", 0)[0], b"\x01\x02\x03")
        self.assertEqual(webc.cbor(b"\x82\x01\x02", 0)[0], [1, 2])
        self.assertEqual(webc.cbor(b"\xa1\x61a\x01", 0)[0], {"a": 1})
        self.assertEqual(webc.cbor(b"\xc1\x05", 0)[0], 5)

    def test_a_nested_map_keeps_its_offsets(self):
        blob = b"\xa2\x61a\xa1\x61b\x02\x61c\x63end"
        self.assertEqual(webc.cbor(blob, 0), ({"a": {"b": 2}, "c": "end"}, len(blob)))


class IndexTests(unittest.TestCase):
    def test_it_refuses_what_is_not_a_package(self):
        with self.assertRaisesRegex(ValueError, "not a webc003 package"):
            webc.index(b"PK\x03\x04" + b"\0" * 32)

    def test_it_names_an_lfs_pointer_for_what_it_is(self):
        pointer = b"version https://git-lfs.github.com/spec/v1\noid sha256:00\n"
        with self.assertRaisesRegex(ValueError, "git-lfs pointer"):
            webc.index(pointer)


class ModuleTests(unittest.TestCase):
    def test_it_takes_the_whole_module_and_stops_at_its_end(self):
        wasm = module((1, b"\x00"), (3, b"\x00"), (10, b"\x00"))
        blob = b"junk" + wasm + b"\xff\xff\xff"
        span = {"start": 0, "len": len(blob)}
        self.assertEqual(webc.module(blob, span), wasm)

    def test_it_keeps_the_tag_section_a_c_bot_carries(self):
        """Section 13 is the exception-handling tag section; clang emits it last
        of the ones before code, and a parser that ranks sections drops it."""
        wasm = module((1, b"\x00"), (13, b"\x00"), (10, b"\x00"))
        self.assertEqual(webc.module(wasm, {"start": 0, "len": len(wasm)}), wasm)

    def test_a_section_running_past_the_span_ends_it(self):
        wasm = module((1, b"\x00")) + bytes([3, 200]) + b"\x00" * 4
        cut = webc.module(wasm, {"start": 0, "len": len(wasm)})
        self.assertEqual(cut, module((1, b"\x00")))


class PackageTests(unittest.TestCase):
    """The parser against the judge's own packages, when the checkout has them."""

    @unittest.skipUnless(all(path.is_file() for path in PACKAGES), "this checkout has no packages")
    def test_every_package_gives_one_whole_module(self):
        for path in PACKAGES:
            blob = path.read_bytes()
            index = webc.index(blob)
            found = webc.module(blob, index["atoms"]["span"])
            self.assertEqual(found[:8], b"\0asm\x01\0\0\0", path.name)
            ends = [end for _, _, end, _ in metering.sections(found)]
            self.assertIn(10, [sid for sid, *_ in metering.sections(found)], path.name)
            self.assertEqual(ends[-1], len(found), path.name)

    @unittest.skipUnless(PACKAGES[1].is_file(), "this checkout has no clang.webc")
    def test_the_clang_volumes_carry_the_files_a_build_needs(self):
        blob = PACKAGES[1].read_bytes()
        index = webc.index(blob)
        room = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name, volume in index["volumes"].items():
            if name.startswith("/"):
                webc.unpack(blob, volume["span"]["start"], room / name.lstrip("/"))
        for name in ("bin/wasm-ld", "lib/clang/20/lib/wasm32-unknown-wasi/libclang_rt.builtins.a",
                     "sysroot/lib/wasm32-wasi/crt1-command.o", "sysroot/include/stdio.h"):
            self.assertTrue((room / name).is_file(), name)
        self.assertEqual((room / "bin" / "wasm-ld").read_bytes()[:4], b"\0asm")

    @unittest.skipUnless(PACKAGES[1].is_file(), "this checkout has no clang.webc")
    def test_the_link_line_names_files_the_package_holds(self):
        blob = PACKAGES[1].read_bytes()
        index = webc.index(blob)
        room = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name, volume in index["volumes"].items():
            if name.startswith("/"):
                webc.unpack(blob, volume["span"]["start"], room / name.lstrip("/"))
        for flag in clangtool.LINK_FLAGS + clangtool.LINK_TAIL:
            if flag.startswith("-L"):
                self.assertTrue((room / flag[2:].lstrip("/")).is_dir(), flag)
            elif flag.startswith(("/lib", "/sysroot")):
                self.assertTrue((room / flag.lstrip("/")).is_file(), flag)

    def test_it_refuses_a_volume_that_is_not_one(self):
        with self.assertRaisesRegex(ValueError, "not a volume"):
            webc.unpack(b"\x00" * 64, 0, pathlib.Path(tempfile.mkdtemp()))


if __name__ == "__main__":
    unittest.main()
