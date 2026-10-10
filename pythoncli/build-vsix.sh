#!/bin/sh
# Regenerates unswbc/replay-viewer.vsix from vscode-extension/ and
# packages/visualiser/. The wheel ships it so `unswbc` can install the replay
# viewer without the contestant having node.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
EXT="$ROOT/vscode-extension"
OUT="$HERE/unswbc/replay-viewer.vsix"
OBJ="$(mktemp -d)"
trap 'rm -rf "$OBJ"' EXIT

command -v pnpm >/dev/null 2>&1 || { echo "no pnpm; install node and pnpm" >&2; exit 1; }

cd "$EXT"
rm -rf dist
pnpm install --frozen-lockfile
pnpm build
pnpm exec vsce package --no-dependencies --allow-missing-repository --out "$OBJ/raw.vsix"

# vsce stamps every zip entry with the current time and writes them in whatever
# order the filesystem walked them, so no two packages match byte for byte and a
# freshness check could never pass. Rewrite with a fixed timestamp and a sorted
# order. Entries are stored, not deflated, so the bytes depend on the content
# alone and not on whichever zlib happens to be installed.
python3 - "$OBJ/raw.vsix" "$OUT" <<'PY'
import sys, zipfile

# OPC readers look these up by name, but every tool in the wild writes them
# first, so they stay first here too.
HEAD = ("extension.vsixmanifest", "[Content_Types].xml")

src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as src_zip, zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED) as out_zip:
    order = sorted(src_zip.infolist(),
                   key=lambda e: (HEAD.index(e.filename) if e.filename in HEAD else len(HEAD), e.filename))
    for entry in order:
        fixed = zipfile.ZipInfo(entry.filename, (1980, 1, 1, 0, 0, 0))
        # entry.external_attr carries the build machine's umask, so it is 0644
        # on one box and 0664 on the next. A vsix holds no executables.
        fixed.external_attr = 0o644 << 16
        fixed.create_system = 0
        data = src_zip.read(entry.filename)
        if entry.filename.endswith((".json", ".md")):
            data = data.replace(b"\r\n", b"\n")
        out_zip.writestr(fixed, data)
PY

echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
