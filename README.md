# UNSW Battlecode

`unswbc` is the toolkit for UNSW CPMSoc's Battlecode competition. It creates a
bot project, builds it, and plays two bots against each other on a map, writing
a replay you can watch.

## Install

Install [uv](https://docs.astral.sh/uv/) first.

**macOS and Linux**

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Windows**, in PowerShell

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Open a new shell so `uv` is on your PATH, then install the toolkit:

```sh
uv tool install unswbc
```

Upgrade with `uv tool upgrade unswbc`, and pin a version with
`uv tool install unswbc==0.3.9`.

One wheel covers macOS, Linux and Windows. It carries the game engine, every
contest map, the VS Code replay viewer and the judge's own clang, so there is
nothing else to download. Without uv you need Python 3.11 or newer and you
manage the environment yourself:

```sh
python3 -m venv ~/.unswbc && ~/.unswbc/bin/pip install unswbc
```

## Your first bot

```sh
unswbc init python mybot
unswbc run maps/arena.map mybot mybot
```

`init` writes a working bot and a helper library into `mybot/`, and adds contest
maps to a shared `maps/` folder beside it, never overwriting one you have. `run`
takes a map and exactly two bots, builds both and plays them, then writes a
`.replay` file into `replays/`. Name the same project twice to play it against
itself.

```sh
unswbc                  # the commands, and what this machine is missing
unswbc --build          # the same, but compile a test program too
unswbc run <map> a b --sandbox    # play them the way the judge does
unswbc init python      # writes into the current directory
unswbc maps             # add the maps a newer toolkit brought
unswbc log              # the errors this machine has hit
unswbc help <command>
```

### Submitting

Make an API key on your team page, give it to `unswbc` once, then upload from
the command line:

```sh
unswbc auth set bc_...            # kept in ~/.unswbc/keys.json, one key per server
unswbc auth status                # which server, which key, which team
unswbc submit mybot               # upload the project in mybot/
unswbc submit mybot -n v12 -d "wider search"
```

The version is named after the folder and the date unless `-n` says otherwise.

### When something breaks

Every error `unswbc` prints is also appended to `~/.unswbc/log`. `unswbc log`
shows it. Quote it when you ask for help.

| variable | effect |
| -------- | ------ |
| `UNSWBC_PYTHON` | the interpreter to run `.py` bots with |
| `CC`, `CXX` | the compilers to build `.c` and `.cpp` bots with |
| `UNSWBC_SERVER` | the contest server, default `https://game.battlecode.au` |
| `UNSWBC_KEY` | the API key to submit with; beats the stored one |
| `UNSWBC_NO_VSCODE` | do not set up the replay viewer |
| `NO_COLOR` | plain output; colour is off anyway when the output is piped |

## In the judge

The judge runs bots inside a WebAssembly sandbox, so the same code behaves the
same on every machine, and it measures work in **CPU points** rather than
seconds. `unswbc run --sandbox` runs that same sandbox on your machine.

| limit | value |
| ----- | ----- |
| points per dragon per turn | 100 million |
| memory per dragon | 48 MB |
| time per turn | 1 s of CPU, 10 s wall, a backstop for a bot that beats the meter |

A turn over its budget gives no reply, and a dragon that gives no reply dies
that turn, so leave yourself a margin. The first turn is no exception: the
interpreter and NumPy are already loaded, but your own imports and setup count.

Prices, in points: most instructions 1, loads and stores 2, division 3, calls 4
to 6, memory growth 50, bulk copies and fills 10 plus 1 per 8 bytes, and 2 for
everything else, which includes 128-bit SIMD. A write costs 2.5 million plus
4,000 per byte, so keep logging light, and a read 6 per byte. The helpers flush once, at the end of the
turn; leave it that way. In C++ that means no `std::unitbuf`, and `std::clog`
rather than `std::cerr`. To C and C++ the judge's stdout looks like a terminal,
so with `sync_with_stdio(false)` every line that ends in `\n` is its own write.

To plan around: parsing a round in the Python helper costs ~10 million points, a
full-map flood fill on 32x32 ~19 million in Python and ~0.3 million in C++.

C and C++ are compiled with `-O2 -msimd128` against the C standard library and
libc++, with the zip's own directory on the include path. `__DATE__`, `__TIME__`
and `__TIMESTAMP__` are errors, so a bot is the same whenever it is built.
Python is CPython 3.13
with the standard library and NumPy 2.5. There is nothing else, so vendor any
library you need as source. Vector code is priced like scalar code and runs as
real SIMD, so it is worth writing.

Matches are reproducible: randomness comes from a generator seeded per dragon
and match, and the clock advances with the points you spend, so `time.sleep`
costs no real time and timing your own search measures points.

## Watching replays

The VS Code extension opens any `.replay` file as an interactive board with a
game log, per-team statistics and charts. `unswbc` ships it and installs it when
`unswbc init` creates a project. To redo that at any point, run `unswbc vscode`.
Replays also open at [game.battlecode.au](https://game.battlecode.au), which
uses the same renderer.

<!-- pypi stops here -->

## Building from source

Only needed to change the toolkit itself. It is pure Python, so nothing
compiles:

```sh
pip install -e pythoncli
```

`pythoncli/unswbc/unswbc_engine.wasm` and `replay-viewer.vsix` are committed
prebuilt. Rebuild them with `pythoncli/build-wasm.sh`
(needs [wasi-sdk](https://github.com/WebAssembly/wasi-sdk)) and
`pythoncli/build-vsix.sh` (needs node and pnpm). `unswbc run --sandbox` is the
exception: it needs the judge's toolchains, which ship in the released wheel
rather than this repository.

## Layout

| directory | what it is |
| --------- | ---------- |
| `pythoncli/` | the `unswbc` command, and the `init` project templates |
| `engine/` | the game rules, the replay format and the bot protocol |
| `packages/visualiser/` | the board renderer, shared by the web app and VS Code |
| `vscode-extension/` | the replay viewer |
| `examples/` | bots to play against |
| `maps/` | boards |
