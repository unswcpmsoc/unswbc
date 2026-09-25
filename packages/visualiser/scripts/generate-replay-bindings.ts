// Generates src/replay/generated/replay.ts from the engine's schema,
// ../../engine/replay.capnp. The engine owns that file — its CMake build
// compiles it in place — so the client reads it rather than keeping a second
// copy that could drift.
//
// Run by hand via `deno task replay:bindings` after the engine changes the
// schema; no build step does it for you.
//
// Requires the Cap'n Proto compiler (`capnp`) on PATH — a system tool, not
// an npm package; see the README for install commands. capnp-es supplies
// the TypeScript-emitting plugin half (`capnpc-ts`).
//
// The two are piped together by hand rather than letting `capnp compile
// -ots:...` spawn the plugin: on Windows capnp.exe invokes plugins through
// cmd.exe, which cannot accept the \\?\-prefixed working directory it
// passes, so the plugin crashes trying to write into C:\Windows.
//
// The output IS committed, so a clone builds without capnp installed. It is
// marked linguist-generated in .gitattributes so it stays out of review.
// Regenerate it, never hand-edit it.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const repoRoot = join(projectRoot, "..", "..");
// The engine's own copy is the source of truth; we only compile it.
const schemaDir = join(repoRoot, "engine");
const schemaFile = "replay.capnp";
// Holds the vendored /capnp/c++.capnp that the schema's $Cxx.namespace needs.
const includeDir = join(projectRoot, "schema");
const outDir = join(projectRoot, "src", "replay", "generated");
const outPath = join(outDir, "replay.ts");
const capnpcTs = join(projectRoot, "node_modules", "capnp-es", "dist", "compiler", "capnpc-ts.mjs");
const scratchDir = join(projectRoot, ".capnp-gen-tmp");

// capnp resolves builtin imports like /capnp/c++.capnp relative to its own
// install prefix; some builds don't do this reliably, so as a fallback we
// derive it ourselves from wherever the `capnp` binary actually sits on
// PATH — this works regardless of package manager (apt, brew, conda,
// winget, ...) rather than assuming any one of them.
function findCapnpIncludeDir(): string | null {
    const exeName = Deno.build.os === "windows" ? "capnp.exe" : "capnp";
    const pathDirs = (Deno.env.get("PATH") ?? "").split(Deno.build.os === "windows" ? ";" : ":");
    for (const dir of pathDirs) {
        if (!dir || !existsSync(join(dir, exeName))) continue;
        const candidate = join(dirname(dir), "include");
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function compileSchema(): Buffer {
    try {
        // -o- : write the parsed CodeGeneratorRequest to stdout instead of
        // invoking a plugin — we invoke capnpc-ts ourselves, see the header
        // comment above for why.
        const systemInclude = findCapnpIncludeDir();
        const extraIncludeArgs = systemInclude ? [`-I${systemInclude}`] : [];
        return execFileSync("capnp", ["compile", "-I", includeDir, ...extraIncludeArgs, "-o-", schemaFile], {
            cwd: schemaDir,
            // capnp warns when PWD disagrees with the cwd we hand it.
            env: { ...process.env, PWD: schemaDir },
            maxBuffer: 64 * 1024 * 1024,
        });
    } catch (cause) {
        throw new Error(
            "`capnp compile` failed — is the Cap'n Proto compiler installed and on PATH? " +
                "See the comment at the top of this script for install commands.",
            { cause },
        );
    }
}

// capnpc-ts emits unformatted source. Format it the way the rest of the
// package is formatted, so regenerating an unchanged schema is a no-op in
// git rather than a whole-file diff. The svelte plugin named in .prettierrc
// is irrelevant to a .ts file and is not installed here, so drop it.
async function formatInPlace(path: string) {
    const config = await prettier.resolveConfig(path);
    const source = await readFile(path, "utf8");
    const { plugins: _plugins, ...options } = config ?? {};
    await writeFile(path, await prettier.format(source, { ...options, parser: "typescript" }));
}

async function main() {
    const request = compileSchema();

    await rm(scratchDir, { recursive: true, force: true });
    await mkdir(scratchDir, { recursive: true });

    // capnpc-ts mirrors the schema's path as capnp reported it. We compile
    // from the engine directory with a bare `replay.capnp`, so the one file
    // we want lands at the root of wherever the plugin runs.
    execFileSync(process.execPath, [capnpcTs], {
        cwd: scratchDir,
        input: request,
        maxBuffer: 64 * 1024 * 1024,
    });

    await mkdir(outDir, { recursive: true });
    await rename(join(scratchDir, "replay.ts"), outPath);
    await rm(scratchDir, { recursive: true, force: true });
    // capnp-es omits top-level schema constants. Export the compatibility
    // version from the schema so both writers and readers share one value.
    const schema = await readFile(join(schemaDir, schemaFile), "utf8");
    const version = schema.match(/const replayFormatVersion :UInt32 = (\d+);/)?.[1];
    if (!version) throw new Error("Missing replayFormatVersion in replay.capnp");
    await writeFile(
        outPath,
        (await readFile(outPath, "utf8")) + `\nexport const REPLAY_FORMAT_VERSION = ${version};\n`,
    );
    await formatInPlace(outPath);

    console.log(`[replay:bindings] wrote ${outPath}`);
}

await main();
