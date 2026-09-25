cmake_minimum_required(VERSION 3.18)
project(battledragon)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# PIE executables need PIC objects from the static engine/sandbox archives.
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Cap'n Proto / libzip must be .a so the CLI is not tied to sidecar .so files.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build third-party libraries as static" FORCE)

find_program(CCACHE_PROGRAM ccache)
if(CCACHE_PROGRAM)
    set(CMAKE_C_COMPILER_LAUNCHER "${CCACHE_PROGRAM}")
    set(CMAKE_CXX_COMPILER_LAUNCHER "${CCACHE_PROGRAM}")
endif()

option(DEBUG "Enable debug build" OFF)
if(DEBUG)
    set(CMAKE_BUILD_TYPE RelWithDebInfo)
else()
    set(CMAKE_BUILD_TYPE Release)
endif()

# Portable Linux release: static-link bundled deps (capnp, zip, z, ffi) and the
# C++ runtime. glibc stays dynamic — build on an older glibc (see Dockerfile.cli)
# so the binary runs on any reasonably modern distro. Prefer this over musl.
option(UNSWBC_PORTABLE "Static-link bundled libs + C++ runtime (Linux)" OFF)
option(UNSWBC_STATIC_LIBSTDCXX "With UNSWBC_PORTABLE, also -static-libstdc++ (off for libc++)" ON)
if(UNSWBC_PORTABLE)
    if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
        message(FATAL_ERROR "UNSWBC_PORTABLE is Linux-only")
    endif()
    set(CMAKE_FIND_LIBRARY_SUFFIXES ".a" ".so")
    set(ZLIB_USE_STATIC_LIBS ON)
    add_link_options(
        "$<$<STREQUAL:$<TARGET_PROPERTY:TYPE>,EXECUTABLE>:-static-libgcc>"
    )
    if(UNSWBC_STATIC_LIBSTDCXX)
        add_link_options(
            "$<$<STREQUAL:$<TARGET_PROPERTY:TYPE>,EXECUTABLE>:-static-libstdc++>"
        )
    endif()
endif()

# --strip-all is GNU/ELF ld; Apple ld and link.exe reject it.
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    add_link_options("$<$<STREQUAL:$<TARGET_PROPERTY:TYPE>,EXECUTABLE>:-Wl,--strip-all>")
endif()

# The judge carries the WASIX sandbox (judge/sandbox), which needs Rust,
# Git LFS and a long cargo build. unswbc needs none of it, so configuring the
# CLI does not drag it in. `make judge` turns this on.
option(UNSWBC_JUDGE "Build the judge and the sandbox it runs bots in" OFF)

add_subdirectory(engine)
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/cli/CMakeLists.txt")
    add_subdirectory(cli)
endif()
if(UNSWBC_JUDGE)
    add_subdirectory(judge)
endif()
