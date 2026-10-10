#!/bin/sh
# Regenerates unswbc/unswbc_engine.wasm from engine/. The Python CLI never
# reimplements the rules; it runs the same code the judge does.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SDK="${WASI_SDK:-/opt/wasi-sdk}"
CXX="$SDK/bin/clang++"
EH="$SDK/share/wasi-sysroot/lib/wasm32-wasip1/eh"
CAPNP="${CAPNP_SRC:-$ROOT/.build/_deps/capnproto-src/c++/src}"
GEN="${CAPNP_GEN:-$ROOT/.build/engine}"
OUT="$HERE/unswbc/unswbc_engine.wasm"
OBJ="$(mktemp -d)"
trap 'rm -rf "$OBJ"' EXIT

[ -x "$CXX" ] || { echo "no wasi-sdk at $SDK; set WASI_SDK" >&2; exit 1; }
[ -f "$CAPNP/capnp/message.h" ] || { echo "no capnp sources at $CAPNP; configure cmake first" >&2; exit 1; }
[ -f "$GEN/replay.capnp.h" ] || { echo "no generated schema at $GEN; build engine first" >&2; exit 1; }

# __EMSCRIPTEN__ is capnp's own name for a wasm32 build: it sizes MessageReader's
# inline arena for 32-bit pointers. What it does not cover is kj's POSIX crash
# handler, which needs siginfo_t, and its stack traces, which wasm cannot walk.
cp -r "$CAPNP" "$OBJ/capnp-src"
KJEX="$OBJ/capnp-src/kj/exception.c++"
sed -i 's/^#elif _WIN32$/#elif _WIN32 || defined(__wasm32__)/' "$KJEX"
sed -i 's/^#ifndef _WIN32$/#if !defined(_WIN32) \&\& !defined(__wasm32__)/' "$KJEX"
sed -i '/^void Exception::addTraceHere() {$/,/^}$/ s/^#if __GNUC__$/#if defined(__wasm32__)\n#elif __GNUC__/' "$KJEX"

# -fwasm-exceptions: the engine throws from RUNTIME_ASSERT.
# -wasm-use-legacy-eh=false: wasmtime rejects the legacy `try` encoding.
# -ffile-prefix-map: kj bakes __FILE__ into its assertions, so without this the
# scratch directory's name would land in the binary and no two builds would match.
FLAGS="-std=c++23 -O2 -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false"
FLAGS="$FLAGS -ffile-prefix-map=$OBJ/capnp-src=capnp -ffile-prefix-map=$ROOT=. -ffile-prefix-map=$GEN=gen"
CAPNP_FLAGS="-D__EMSCRIPTEN__ -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -DCAPNP_LITE=1"

KJ="array list common debug exception io memory mutex string source-location hash table arena units encoding"
CP="c++.capnp blob arena layout list any message schema.capnp stream.capnp serialize serialize-packed"

for name in $KJ; do
    # shellcheck disable=SC2086
    "$CXX" $FLAGS $CAPNP_FLAGS -I"$OBJ/capnp-src" -c "$OBJ/capnp-src/kj/$name.c++" -o "$OBJ/kj-$name.o"
done
for name in $CP; do
    # shellcheck disable=SC2086
    "$CXX" $FLAGS $CAPNP_FLAGS -I"$OBJ/capnp-src" -c "$OBJ/capnp-src/capnp/$name.c++" -o "$OBJ/capnp-$name.o"
done

for src in "$ROOT"/engine/src/*.cc "$HERE"/shim/shim.cc; do
    # shellcheck disable=SC2086
    "$CXX" $FLAGS $CAPNP_FLAGS -I"$ROOT/engine/include" -I"$GEN" -I"$OBJ/capnp-src" \
        -c "$src" -o "$OBJ/$(basename "$src").o"
done
# shellcheck disable=SC2086
"$CXX" $FLAGS $CAPNP_FLAGS -I"$OBJ/capnp-src" -c "$GEN/replay.capnp.c++" -o "$OBJ/replay.capnp.o"

# shellcheck disable=SC2086
"$CXX" $FLAGS -mexec-model=reactor -nostdlib++ -L"$EH" \
    -Wl,--no-entry,--export=ubc_run,--export=ubc_alloc,--export=ubc_free,--export=ubc_error,--export=ubc_replay,--export=ubc_replay_ptr \
    "$OBJ"/*.o -lc++ -lc++abi -lunwind -lwasi-emulated-signal -lwasi-emulated-mman -o "$OUT"

echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
