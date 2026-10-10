"""Guest file operations must work with open handles, including on Windows."""

import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from unswbc.sandbox import DIR, OK, Node, Sandbox, _open_writable


class WritableFileTests(unittest.TestCase):
    def setUp(self):
        self.home = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()

    def test_open_file_can_be_renamed_and_written_afterwards(self):
        # Exercise the same path_open2/path_rename pair clang calls, without
        # instantiating an interpreter just to call the host filesystem.
        box = object.__new__(Sandbox)
        box.root, box.mounts, box.writable = self.home, [], ("/",)
        box._fds = {3: Node("/", self.home, DIR)}
        names = {0: "object.tmp", 1: "object.o"}
        box.text = lambda ptr, n: names[ptr]
        result = {}
        box.u32 = lambda ptr, value: result.update(fd=value)
        calls = box._build_impl()
        self.assertEqual(calls["wasix_32v1.path_open2"](3, 0, 0, 10, 1, 0, 0, 0, 0, 0), OK)
        fd = result["fd"]
        handle = box._fds[fd].handle
        self.addCleanup(handle.close)
        handle.write(b"object")
        self.assertEqual(calls["wasi_snapshot_preview1.path_rename"](3, 0, 10, 3, 1, 8), OK)
        self.assertFalse((self.home / "object.tmp").exists())
        handle.write(b" tail")
        self.assertEqual((self.home / "object.o").read_bytes(), b"object tail")
        self.assertEqual(calls["wasi_snapshot_preview1.fd_close"](fd), OK)
        self.assertTrue(handle.closed)

    def test_open_preserves_or_truncates_existing_contents(self):
        path = self.home / "object.o"
        path.write_bytes(b"object")
        with _open_writable(path, truncate=False) as handle:
            self.assertEqual(handle.read(), b"object")
        with _open_writable(path, truncate=True) as handle:
            self.assertEqual(handle.read(), b"")
            handle.write(b"new")
        self.assertEqual(path.read_bytes(), b"new")

    def test_missing_file_without_create_is_not_created(self):
        path = self.home / "missing.o"
        with self.assertRaises(OSError):
            _open_writable(path, truncate=False)
        self.assertFalse(path.exists())

    def test_open_file_can_be_unlinked(self):
        path = self.home / "object.o"
        with _open_writable(path, truncate=True) as handle:
            handle.write(b"object")
            path.unlink()
            handle.seek(0)
            self.assertEqual(handle.read(), b"object")
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
