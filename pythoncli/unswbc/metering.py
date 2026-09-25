"""Prices a wasm module in CPU points, as the judge does.

The judge counts with a Wasmer compile-time middleware
(judge/sandbox/src/limits/cpu.rs). That middleware only emits ordinary wasm, so
the same thing works as a module-to-module pass, which is how `unswbc --sandbox`
gets the judge's numbers out of wasmtime.
"""

from __future__ import annotations

REMAINING = b"wasmer_metering_remaining_points"
EXHAUSTED = b"wasmer_metering_points_exhausted"
INITIAL_POINTS = (1 << 63) - 1
BULK_BYTES_PER_POINT_SHIFT = 3
SECTION_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 10, 11]

_MEMARG_SIMD = set(range(0, 12)) | {92, 93}
_LANE_SIMD = set(range(21, 35))
_MEMARG_LANE_SIMD = set(range(84, 92))
_MEMARG_ATOMIC = {0, 1, 2} | set(range(0x10, 0x4F))

LOOP = 0x03
ENDS_BLOCK = {0x03, 0x04, 0x05, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E,
              0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x18}
BULK_LENGTH = {(0xFC << 16) | sub for sub in (8, 10, 11)}

_ONE = ({0x00, 0x01, 0x02, 0x03, 0x05, 0x0B, 0x1A, 0x1B, 0x1C}
        | {0x20, 0x21, 0x22, 0x23, 0x24, 0x41, 0x42, 0x43, 0x44}
        | set(range(0x45, 0xC5)) | {0xD0, 0xD1, 0xD2})
_THREE = {0x6D, 0x6E, 0x6F, 0x70, 0x7F, 0x80, 0x81, 0x82, 0x95, 0xA3}
_TWO = set(range(0x28, 0x3F)) | {0x04, 0x0C, 0x0D, 0x0F, 0x3F}
_TEN = {0x25, 0x26} | {(0xFC << 16) | s for s in (8, 9, 10, 11, 12, 13, 14, 16, 17)}
_FIFTY = {0x40, (0xFC << 16) | 15}


def cost(code: int) -> int:
    if code in _THREE:
        return 3
    if code in _TWO:
        return 2
    if code in _ONE:
        return 1
    if code in _TEN:
        return 10
    if code in _FIFTY:
        return 50
    if code == 0x0E:
        return 3
    if code == 0x10:
        return 4
    if code in (0x11, 0x12, 0x13, 0x14, 0x15):
        return 6
    return 2


def uleb(b: bytes, i: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = b[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, i
        shift += 7


def sleb(b: bytes, i: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = b[i]
        i += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            if byte & 0x40 and shift < 64:
                value -= 1 << shift
            return value, i


def put_uleb(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def put_sleb(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        done = (value == 0 and not byte & 0x40) or (value == -1 and byte & 0x40)
        out.append(byte if done else byte | 0x80)
        if done:
            return bytes(out)


def _blocktype(b: bytes, i: int) -> int:
    if b[i] == 0x40 or b[i] in (0x7F, 0x7E, 0x7D, 0x7C, 0x7B, 0x70, 0x6F):
        return i + 1
    return sleb(b, i)[1]


def _memarg(b: bytes, i: int) -> int:
    align, i = uleb(b, i)
    if align & 0x40:
        _, i = uleb(b, i)
    return uleb(b, i)[1]


def next_op(b: bytes, i: int) -> tuple[int, int]:
    """Returns (code, end). `code` is the opcode, or prefix << 16 | subopcode."""
    op = b[i]
    j = i + 1
    if op in (0x02, 0x03, 0x04, 0x06, 0x1F):
        j = _blocktype(b, j)
        if op == 0x1F:
            n, j = uleb(b, j)
            for _ in range(n):
                kind = b[j]
                j += 1
                if kind in (0x00, 0x01):
                    _, j = uleb(b, j)
                _, j = uleb(b, j)
    elif op in (0x07, 0x08, 0x09, 0x0C, 0x0D, 0x10, 0x12, 0x14, 0x15, 0x18,
                0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x3F, 0x40, 0xD2):
        _, j = uleb(b, j)
    elif op in (0x11, 0x13):
        _, j = uleb(b, j)
        _, j = uleb(b, j)
    elif op == 0x0E:
        n, j = uleb(b, j)
        for _ in range(n + 1):
            _, j = uleb(b, j)
    elif op == 0x1C:
        n, j = uleb(b, j)
        j += n
    elif 0x28 <= op <= 0x3E:
        j = _memarg(b, j)
    elif op in (0x41, 0x42):
        _, j = sleb(b, j)
    elif op == 0x43:
        j += 4
    elif op == 0x44:
        j += 8
    elif op == 0xD0:
        j = _blocktype(b, j)
    elif op == 0xFC:
        sub, j = uleb(b, j)
        if sub in (8, 10, 12, 14):
            _, j = uleb(b, j)
            _, j = uleb(b, j)
        elif sub in (9, 11, 13, 15, 16, 17):
            _, j = uleb(b, j)
        return (0xFC << 16) | sub, j
    elif op == 0xFD:
        sub, j = uleb(b, j)
        if sub in _MEMARG_SIMD:
            j = _memarg(b, j)
        elif sub in (12, 13):
            j += 16
        elif sub in _LANE_SIMD:
            j += 1
        elif sub in _MEMARG_LANE_SIMD:
            j = _memarg(b, j) + 1
        return (0xFD << 16) | sub, j
    elif op == 0xFE:
        sub, j = uleb(b, j)
        if sub in _MEMARG_ATOMIC:
            j = _memarg(b, j)
        elif sub == 3:
            j += 1
        return (0xFE << 16) | sub, j
    return op, j


def sections(b: bytes):
    i = 8
    while i < len(b):
        sid = b[i]
        size, j = uleb(b, i + 1)
        end = j + size
        yield sid, j, end, i
        i = end


def _check(rem: int, exh: int) -> bytes:
    return (b"\x23" + put_uleb(rem) + b"\x42\x00\x53\x04\x40\x41\x01\x24"
            + put_uleb(exh) + b"\x00\x0b")


def _charge(rem: int, points: int) -> bytes:
    return b"\x23" + put_uleb(rem) + b"\x42" + put_sleb(points) + b"\x7d\x24" + put_uleb(rem)


def _charge_length(rem: int, scratch: int) -> bytes:
    return (b"\x24" + put_uleb(scratch) + b"\x23" + put_uleb(scratch)
            + b"\x23" + put_uleb(rem) + b"\x23" + put_uleb(scratch) + b"\xad\x42"
            + put_sleb(BULK_BYTES_PER_POINT_SHIFT) + b"\x88\x7d\x24" + put_uleb(rem))


def _instrument_body(b: bytes, start: int, end: int, rem: int, exh: int, scratch: int) -> bytes:
    k = start
    count, k = uleb(b, k)
    for _ in range(count):
        _, k = uleb(b, k)
        k += 1
    out = bytearray(b[start:k])
    out += _check(rem, exh)
    acc = 0
    while k < end:
        op = k
        code, k = next_op(b, k)
        acc += cost(code)
        if code in ENDS_BLOCK and acc > 0:
            out += _charge(rem, acc)
            acc = 0
        if code in BULK_LENGTH:
            out += _charge_length(rem, scratch)
        out += b[op:k]
        if code == LOOP:
            out += _check(rem, exh)
    return bytes(out)


def _imported_globals(b: bytes, start: int) -> int:
    total = 0
    n, j = uleb(b, start)
    for _ in range(n):
        length, j = uleb(b, j)
        j += length
        length, j = uleb(b, j)
        j += length
        kind = b[j]
        j += 1
        if kind == 0:
            _, j = uleb(b, j)
        elif kind == 1:
            j += 1
            limits = b[j]
            j += 1
            _, j = uleb(b, j)
            if limits:
                _, j = uleb(b, j)
        elif kind == 2:
            limits = b[j]
            j += 1
            _, j = uleb(b, j)
            if limits & 1:
                _, j = uleb(b, j)
        else:
            total += 1
            j += 2
    return total


def instrument(blob: bytes, initial: int = INITIAL_POINTS) -> bytes:
    found: dict[int, tuple[int, int]] = {}
    for sid, j, end, _ in sections(blob):
        found.setdefault(sid, (j, end))

    imported = _imported_globals(blob, found[2][0]) if 2 in found else 0
    defined, gbody = 0, b""
    if 6 in found:
        j, end = found[6]
        defined, after = uleb(blob, j)
        gbody = blob[after:end]
    rem = imported + defined
    exh, scratch = rem + 1, rem + 2

    globals_section = (put_uleb(defined + 3) + gbody
                       + b"\x7e\x01\x42" + put_sleb(initial) + b"\x0b"
                       + b"\x7f\x01\x41\x00\x0b\x7f\x01\x41\x00\x0b")

    exported, ebody = 0, b""
    if 7 in found:
        j, end = found[7]
        exported, after = uleb(blob, j)
        ebody = blob[after:end]
    exports_section = (put_uleb(exported + 2) + ebody
                       + put_uleb(len(REMAINING)) + REMAINING + b"\x03" + put_uleb(rem)
                       + put_uleb(len(EXHAUSTED)) + EXHAUSTED + b"\x03" + put_uleb(exh))

    j, end = found[10]
    n, j = uleb(blob, j)
    bodies = []
    for _ in range(n):
        size, j = uleb(blob, j)
        bodies.append(_instrument_body(blob, j, j + size, rem, exh, scratch))
        j += size
    code_section = put_uleb(n) + b"".join(put_uleb(len(x)) + x for x in bodies)

    replaced = {6: globals_section, 7: exports_section, 10: code_section}
    out = bytearray(blob[:8])
    written: set[int] = set()
    for sid, j, end, head in sections(blob):
        for missing in (6, 7):
            if missing in found or missing in written:
                continue
            if SECTION_ORDER.index(sid) > SECTION_ORDER.index(missing):
                body = replaced[missing]
                out += bytes([missing]) + put_uleb(len(body)) + body
                written.add(missing)
        if sid == 0:
            out += blob[head:end]
        else:
            body = replaced.get(sid, blob[j:end])
            out += bytes([sid]) + put_uleb(len(body)) + body
        written.add(sid)
    return bytes(out)
