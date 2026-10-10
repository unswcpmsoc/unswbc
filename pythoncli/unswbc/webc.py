"""Reads a Wasmer `.webc` package: its index, its wasm atoms and its volumes."""

from __future__ import annotations

import os
import pathlib
import struct

from . import metering

TAG_VOLUME, TAG_DIR, TAG_FILE, TAG_SYMLINK = 4, 30, 31, 32
LAST_SECTION_ID = 13


def cbor(blob: bytes, at: int):
    head = blob[at]
    major, arg = head >> 5, head & 0x1F
    at += 1
    if arg < 24:
        value = arg
    elif arg == 24:
        value = blob[at]; at += 1
    elif arg == 25:
        value = int.from_bytes(blob[at:at + 2], "big"); at += 2
    elif arg == 26:
        value = int.from_bytes(blob[at:at + 4], "big"); at += 4
    elif arg == 27:
        value = int.from_bytes(blob[at:at + 8], "big"); at += 8
    else:
        value = None
    if major == 0:
        return value, at
    if major == 2:
        return blob[at:at + value], at + value
    if major == 3:
        return blob[at:at + value].decode(), at + value
    if major == 4:
        items = []
        for _ in range(value):
            item, at = cbor(blob, at)
            items.append(item)
        return items, at
    if major == 5:
        table = {}
        for _ in range(value):
            key, at = cbor(blob, at)
            table[key], at = cbor(blob, at)
        return table, at
    if major == 6:
        return cbor(blob, at)
    return None, at


def index(blob: bytes):
    if blob[:8] != b"\0webc003":
        if blob[:7] == b"version":
            raise ValueError("git-lfs pointer, not the package; run `git lfs pull`")
        raise ValueError("not a webc003 package")
    return cbor(blob, 17)[0]


def module(blob: bytes, span: dict) -> bytes:
    """The atoms run holds whole wasm modules; take the first, tag sections and all."""
    start, end = span["start"], span["start"] + span["len"]
    head = blob.index(b"\0asm\x01\0\0\0", start, end)
    at = head + 8
    while at < end and blob[at] <= LAST_SECTION_ID:
        size, after = metering.uleb(blob, at + 1)
        if after + size > end:
            break
        at = after + size
    return blob[head:at]


def unpack(blob: bytes, start: int, dest: pathlib.Path) -> tuple[int, int, int]:
    if blob[start] != TAG_VOLUME:
        raise ValueError(f"not a volume at {start}")
    at = start + 41

    def slab(at):
        size = struct.unpack_from("<Q", blob, at)[0]
        return blob[at + 8:at + 8 + size], at + 8 + size

    _name, at = slab(at)
    header, at = slab(at)
    data, at = slab(at)
    u64 = lambda off: struct.unpack_from("<Q", header, off)[0]
    counts = [0, 0, 0]

    def walk(off, path):
        tag = header[off]
        at = off + 1
        if tag == TAG_DIR:
            end = at + 8 + u64(at)
            at += 8 + 24 + 32
            path.mkdir(parents=True, exist_ok=True)
            counts[0] += 1
            while at < end:
                child = u64(at)
                at += 8 + 32
                size = u64(at)
                at += 8
                name = header[at:at + size].decode()
                at += size
                walk(child, path / name)
        elif tag == TAG_FILE:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data[u64(at):u64(at + 8)])
            counts[1] += 1
        elif tag == TAG_SYMLINK:
            size = u64(at)
            target = header[at + 8:at + 8 + size].decode()
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.is_symlink() or path.exists():
                path.unlink()
            os.symlink(target, path)
            counts[2] += 1
        else:
            raise ValueError(f"unknown volume tag {tag}")

    walk(0, dest)
    return tuple(counts)
