"""Run with python -m unittest discover -s pythoncli/tests from the repo root."""

import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from unswbc import engine, sandbox, toolchain

MISSING = FileNotFoundError(r"Could not find module 'wasmtime\win32-aarch64\wasmtime.dll'")


class WasmRuntimeTests(unittest.TestCase):
    """wasmtime picks its binary by the machine, not by the interpreter, so an
    x86-64 Python on a Windows ARM machine loads nothing and says little."""

    def test_the_message_names_both_sides_of_the_mismatch(self):
        said = str(toolchain.wasm_runtime(MISSING))
        self.assertIn("win32-aarch64", said)
        self.assertIn("Python on a machine reporting", said)
        self.assertIn("uv tool install unswbc --force --python 3.13", said)

    def test_the_engine_says_it_rather_than_failing_to_import(self):
        with patch.object(engine, "WASM_RUNTIME_ERROR", MISSING):
            with self.assertRaises(toolchain.ToolError) as raised:
                engine.EngineModule()
        self.assertIn("cannot load wasmtime", str(raised.exception))

    def test_the_sandbox_says_it_too(self):
        with patch.object(sandbox, "WASM_RUNTIME_ERROR", MISSING):
            with self.assertRaises(toolchain.ToolError):
                sandbox.compile_once(pathlib.Path("does-not-matter.wasm"))
            with self.assertRaises(toolchain.ToolError):
                sandbox._patch_wasmtime()

    def test_a_working_install_carries_no_error(self):
        self.assertIsNone(engine.WASM_RUNTIME_ERROR)
        self.assertIsNone(sandbox.WASM_RUNTIME_ERROR)


if __name__ == "__main__":
    unittest.main()
