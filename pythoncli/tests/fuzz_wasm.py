"""Random wasm bots, priced against a hand-summed expectation.

Run with python pythoncli/tests/fuzz_wasm.py --cases 2000 --seed 1 from the repo root.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import random
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from wasmtime import wat2wasm

from unswbc import metering

I32_CONST, I64_CONST, DROP, END, CALL, BR_IF, LOOP = 0x41, 0x42, 0x1A, 0x0B, 0x10, 0x0D, 0x03
I32_ADD, I32_SUB, I32_DIV_S, I64_MUL, I32_LOAD, I32_STORE = 0x6A, 0x6B, 0x6D, 0x7E, 0x28, 0x36
BLOCK, BR = 0x02, 0x0C
LOCAL_GET, LOCAL_SET, MEMORY_GROW, MEMORY_SIZE, BR_TABLE = 0x20, 0x21, 0x40, 0x3F, 0x0E
MEMORY_COPY, MEMORY_FILL = (0xFC << 16) | 10, (0xFC << 16) | 11
V128_CONST, I32X4_EXTRACT = (0xFD << 16) | 12, (0xFD << 16) | 27

HEAP = 8192
REPLY_AT = 1 << 20
BUFFER_LIMIT = 10 * 1024
WRITE_SYSCALL_COST = 2_500_000
WRITE_BYTE_COST = 4_000
TURN_TAIL_POINTS = 23


def _add(rng):
    return ("(drop (i32.add (i32.const %d) (i32.const %d)))" % (rng.randint(0, 9999), rng.randint(0, 9999)),
            [I32_CONST, I32_CONST, I32_ADD, DROP])


def _divide(rng):
    return ("(drop (i32.div_s (i32.const %d) (i32.const %d)))" % (rng.randint(0, 9999), rng.randint(1, 99)),
            [I32_CONST, I32_CONST, I32_DIV_S, DROP])


def _multiply(rng):
    return ("(drop (i64.mul (i64.const %d) (i64.const %d)))" % (rng.randint(0, 9999), rng.randint(0, 99)),
            [I64_CONST, I64_CONST, I64_MUL, DROP])


def _load(rng):
    return ("(drop (i32.load (i32.const %d)))" % rng.randrange(0, HEAP, 4), [I32_CONST, I32_LOAD, DROP])


def _store(rng):
    return ("(i32.store (i32.const %d) (i32.const %d))" % (rng.randrange(0, HEAP, 4), rng.randint(0, 9999)),
            [I32_CONST, I32_CONST, I32_STORE])


def _touch_local(rng):
    return ("(local.set $x (i32.add (local.get $x) (i32.const 1)))",
            [LOCAL_GET, I32_CONST, I32_ADD, LOCAL_SET])


def _grow(rng):
    return ("(drop (memory.grow (i32.const 0)))", [I32_CONST, MEMORY_GROW, DROP])


def _size(rng):
    return ("(drop (memory.size))", [MEMORY_SIZE, DROP])


def _fill(rng):
    length = rng.randrange(0, 4096)
    return ("(memory.fill (i32.const %d) (i32.const 0) (i32.const %d))" % (HEAP, length),
            [I32_CONST, I32_CONST, I32_CONST, MEMORY_FILL], length >> metering.BULK_BYTES_PER_POINT_SHIFT)


def _copy(rng):
    length = rng.randrange(0, 4096)
    return ("(memory.copy (i32.const %d) (i32.const %d) (i32.const %d))" % (HEAP + 8192, HEAP, length),
            [I32_CONST, I32_CONST, I32_CONST, MEMORY_COPY], length >> metering.BULK_BYTES_PER_POINT_SHIFT)


def _lanes(rng):
    return ("(drop (i32x4.extract_lane 0 (v128.const i32x4 1 2 3 4)))",
            [V128_CONST, I32X4_EXTRACT, DROP])


def _call(rng):
    return ("(call $noop)", [CALL, END])


def _branch(rng):
    return ("(block $b (br $b))", [BLOCK, BR])


def _table(rng):
    return ("(block $b (br_table $b $b $b (i32.const %d)))" % rng.randint(0, 2),
            [BLOCK, I32_CONST, BR_TABLE])


def _spin(rng, trips: int = 0):
    trips = trips or rng.randint(1, 40)
    body = ("(local.set $i (i32.const %d))" % trips
            + "(loop $spin (local.set $i (i32.sub (local.get $i) (i32.const 1)))"
              " (br_if $spin (local.get $i)))")
    ops = [I32_CONST, LOCAL_SET, LOOP]
    ops += trips * [LOCAL_GET, I32_CONST, I32_SUB, LOCAL_SET, LOCAL_GET, BR_IF]
    ops += [END]
    return (body, ops)


SNIPPETS = [_add, _divide, _multiply, _load, _store, _touch_local, _grow, _size,
            _fill, _copy, _lanes, _call, _branch, _table, _spin]


def module(rng: random.Random, count: int = 24, tail_trips: int = 0) -> tuple[bytes, int]:
    lines, opcodes, extra = [], [], 0
    made_all = [rng.choice(SNIPPETS)(rng) for _ in range(count)]
    if tail_trips:
        made_all.append(_spin(rng, tail_trips))
    for made in made_all:
        lines.append(made[0])
        opcodes += made[1]
        extra += made[2] if len(made) > 2 else 0
    opcodes.append(END)
    text = ('(module (import "env" "memory" (memory 2 100 shared))'
            ' (func $noop) (func (export "_start") (local $x i32) (local $i i32) '
            + "\n".join(lines) + "))")
    return wat2wasm(text), sum(metering.cost(code) for code in opcodes) + extra


TALKER = '''(module
  (import "env" "memory" (memory 48 100 shared))
  (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (data (i32.const REPLY_AT) "REPLY")
  (func (export "_start") (local $n i32)
    (loop $turn
      (i32.store (i32.const 0) (i32.const 4096))
      (i32.store (i32.const 4) (i32.const 60000))
      (drop (call $read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 32)))
      (if (i32.eqz (i32.load (i32.const 32))) (then (return)))
      QUIT
      (i32.store (i32.const 16) (i32.const REPLY_AT))
      (i32.store (i32.const 20) (i32.const REPLY_LEN))
      (drop (call $write (i32.const 1) (i32.const 16) (i32.const 1) (i32.const 36)))
      (br $turn))))'''

QUIT_AFTER = ('(local.set $n (i32.add (local.get $n) (i32.const 1)))'
              '(if (i32.eq (local.get $n) (i32.const %d)) (then (return)))')


def talker(reply: bytes, quit_after: int = 0) -> bytes:
    escaped = "".join("\\%02x" % byte for byte in reply)
    text = (TALKER.replace("REPLY_AT", str(REPLY_AT)).replace('"REPLY"', '"%s"' % escaped)
            .replace("REPLY_LEN", str(len(reply)))
            .replace("QUIT", QUIT_AFTER % quit_after if quit_after else ""))
    return wat2wasm(text)


def framed_reply(lines: list[bytes]) -> bytes:
    out = bytearray()
    for line in lines:
        if line == b"ENDTURN":
            break
        room = BUFFER_LIMIT - len(out)
        if room > 0:
            out += line[:room]
            if len(out) < BUFFER_LIMIT:
                out += b"\n"
    return bytes(out)


def reply_lines(rng: random.Random) -> list[bytes]:
    lines = []
    for _ in range(rng.randint(0, 5)):
        alphabet = b"MOVENSEW 0123456789abc"
        size = (rng.randint(BUFFER_LIMIT, BUFFER_LIMIT * 2) if rng.random() < 0.1
                else rng.randint(0, 40))
        lines.append(bytes(rng.choices(alphabet, k=size)))
    return lines


def spend(wasm: bytes, home: pathlib.Path, budget: int | None = None) -> tuple[int, int, str | None]:
    from unswbc import sandbox

    sandbox._COMPILED.clear()
    room = pathlib.Path(tempfile.mkdtemp(dir=home))
    raw = room / "main.wasm"
    raw.write_bytes(wasm)
    box = sandbox.Sandbox(wasm_path=sandbox._metered(raw), root=room, argv=["bot"],
                          environ=[], needs_zygote=False)
    box.instantiate()
    if budget is not None:
        box._meter.set_value(box.store, budget)
    box.spent()
    try:
        box.main()
    except BaseException as error:
        return -1, box.spent(), box.failure or str(error)
    return box.exit_code, box.spent(), box.failure


def one_turn(wasm: bytes, home: pathlib.Path, block: bytes = b"ROUND 1"):
    from unswbc import sandbox

    sandbox._COMPILED.clear()
    room = pathlib.Path(tempfile.mkdtemp(dir=home))
    (room / "main.wasm").write_bytes(wasm)
    pool = sandbox.WasmPool([str(room / "main.wasm")], team="a")
    bot = sandbox.SandboxBot(pool, init=b"", name="0")
    try:
        return bot.ask(block), bot.error, bot.live
    finally:
        bot.stop()
        pool.close()


def turns(wasm: bytes, home: pathlib.Path, count: int) -> list:
    from unswbc import sandbox

    sandbox._COMPILED.clear()
    room = pathlib.Path(tempfile.mkdtemp(dir=home))
    (room / "main.wasm").write_bytes(wasm)
    pool = sandbox.WasmPool([str(room / "main.wasm")], team="a")
    bot = sandbox.SandboxBot(pool, init=b"", name="0")
    try:
        return [(bot.ask(b"ROUND %d" % (turn + 1)), bot.error, bot.live) for turn in range(count)]
    finally:
        bot.stop()
        pool.close()


def priced(rng: random.Random, home: pathlib.Path) -> None:
    wasm, expected = module(rng, count=rng.randint(1, 120))
    code, points, failure = spend(wasm, home)
    if code != 0 or failure is not None:
        raise AssertionError("run failed: code=%s failure=%s" % (code, failure))
    if points != expected:
        raise AssertionError("charged %d, expected %d" % (points, expected))


def starved(rng: random.Random, home: pathlib.Path) -> None:
    wasm, expected = module(rng, count=8, tail_trips=500)
    code, _, failure = spend(wasm, home, budget=expected // 2)
    if code == 0:
        raise AssertionError("ran to the end on half of %d points" % expected)
    if failure != "exceeded CPU limit":
        raise AssertionError("died of %r, not its budget" % failure)


def framed(rng: random.Random, home: pathlib.Path) -> None:
    from unswbc import sandbox

    lines = reply_lines(rng)
    payload = b"".join(line + b"\n" for line in lines) + b"ENDTURN\n"
    expected = WRITE_SYSCALL_COST + WRITE_BYTE_COST * len(payload) + TURN_TAIL_POINTS
    if abs(expected - sandbox.MAX_TURN_POINTS) < 10_000:
        return
    reply, error, live = one_turn(talker(payload), home)
    if expected > sandbox.MAX_TURN_POINTS:
        if reply or error != "exceeded CPU limit":
            raise AssertionError("a %d point write gave %r, %r" % (expected, reply[:32], error))
        return
    want = framed_reply(lines)
    if reply != want:
        raise AssertionError("framed %d bytes, wanted %d" % (len(reply), len(want)))
    if error is not None:
        raise AssertionError("turn reported %r" % error)
    if live[0] != expected:
        raise AssertionError("charged %d, expected %d" % (live[0], expected))


def chats(rng: random.Random, home: pathlib.Path) -> None:
    lines = [bytes(rng.choices(b"MOVENSEW ", k=rng.randint(0, 20))) for _ in range(rng.randint(0, 3))]
    payload = b"".join(line + b"\n" for line in lines) + b"ENDTURN\n"
    want = framed_reply(lines)
    base = WRITE_SYSCALL_COST + WRITE_BYTE_COST * len(payload) + TURN_TAIL_POINTS
    said = turns(talker(payload), home, rng.randint(2, 6))
    for index, (reply, error, live) in enumerate(said):
        if reply != want or error is not None:
            raise AssertionError("turn %d gave %r, %r" % (index, reply[:32], error))
        if index == 0 and live[0] != base:
            raise AssertionError("first turn charged %d, expected %d" % (live[0], base))
        if index and live[0] != said[1][2][0]:
            raise AssertionError("turn %d charged %d, turn 1 charged %d"
                                 % (index, live[0], said[1][2][0]))
    if len(said) > 1 and said[1][2][0] <= base:
        raise AssertionError("a later turn was not charged for the work between turns")


def parked(rng: random.Random, home: pathlib.Path) -> None:
    lines = [bytes(rng.choices(b"MOVENSEW ", k=rng.randint(1, 20))) for _ in range(rng.randint(1, 3))]
    payload = b"".join(line + b"\n" for line in lines)
    reply, error, _ = one_turn(talker(payload), home)
    if reply != framed_reply(lines) or error is not None:
        raise AssertionError("parking gave %r, %r" % (reply[:32], error))


def quits(rng: random.Random, home: pathlib.Path) -> None:
    reply, error, _ = one_turn(talker(b"MOVE N\nENDTURN\n", quit_after=rng.randint(1, 2)), home)
    if reply and error:
        raise AssertionError("reply %r came with error %r" % (reply[:32], error))


def mangled(rng: random.Random, home: pathlib.Path) -> None:
    wasm, _ = module(rng, count=8)
    blob = bytearray(wasm)
    for _ in range(rng.randint(1, 6)):
        blob[rng.randrange(len(blob))] = rng.randrange(256)
    survives(bytes(blob))


def truncated(rng: random.Random, home: pathlib.Path) -> None:
    wasm, _ = module(rng, count=8)
    survives(wasm[:rng.randrange(1, len(wasm))])


def survives(blob: bytes) -> None:
    try:
        out = metering.instrument(blob)
    except Exception:
        return
    if metering.REMAINING not in out:
        raise AssertionError("instrumented a module without exporting the meter")


CHECKS = [priced, starved, framed, chats, parked, quits, mangled, truncated]


def sweep(cases: int, seed: int, quiet: bool = False) -> int:
    home = pathlib.Path(tempfile.mkdtemp(prefix="unswbc-fuzz-"))
    os.environ["XDG_CACHE_HOME"] = str(home / "cache")
    failures, start = 0, time.monotonic()
    for case in range(cases):
        rng = random.Random("%d:%d" % (seed, case))
        check = CHECKS[case % len(CHECKS)]
        try:
            check(rng, home)
        except Exception as error:
            failures += 1
            print("case %d (%s): %s: %s" % (case, check.__name__, type(error).__name__, error),
                  file=sys.stderr)
        if not quiet and case and case % 100 == 0:
            print("%d/%d cases, %d failures, %.0fs"
                  % (case, cases, failures, time.monotonic() - start), flush=True)
    if not quiet:
        print("%d cases, %d failures, %.0fs" % (cases, failures, time.monotonic() - start))
    return failures


class FuzzTests(unittest.TestCase):
    def test_a_short_sweep_finds_nothing(self):
        self.assertEqual(sweep(48, seed=7, quiet=True), 0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=int, default=300)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()
    sys.exit(1 if sweep(args.cases, args.seed) else 0)
