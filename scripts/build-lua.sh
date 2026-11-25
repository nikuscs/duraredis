#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

docker run --rm -v "$ROOT:/src" -w /src emscripten/emsdk \
  emcc -O2 -Wall -Wextra -Wno-unused-parameter -DLUA_ANSI -DENABLE_CJSON_GLOBAL "-DSTRUCT_INT=long long" \
  -Ivendor/lua/deps/lua/src \
  -Ivendor/lua/deps/fpconv \
  -Ivendor/lua/src \
  -fwasm-exceptions \
  -sSUPPORT_LONGJMP=wasm \
  -sSTANDALONE_WASM=1 \
  --no-entry \
  -sINITIAL_MEMORY=4194304 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sMAXIMUM_MEMORY=67108864 \
  -sSTACK_SIZE=1048576 \
  -sEXPORTED_FUNCTIONS=_lua_vm_init,_lua_eval_reset,_lua_func_reset,_lua_alloc,_lua_free,_lua_out_ptr,_lua_out_len,_lua_sha1hex,_lua_eval_compile,_lua_eval_has,_lua_eval_remove,_lua_eval_run,_lua_func_load,_lua_func_call,_lua_func_unref \
  vendor/lua/deps/lua/src/lapi.c \
  vendor/lua/deps/lua/src/lcode.c \
  vendor/lua/deps/lua/src/ldebug.c \
  vendor/lua/deps/lua/src/ldo.c \
  vendor/lua/deps/lua/src/ldump.c \
  vendor/lua/deps/lua/src/lfunc.c \
  vendor/lua/deps/lua/src/lgc.c \
  vendor/lua/deps/lua/src/llex.c \
  vendor/lua/deps/lua/src/lmem.c \
  vendor/lua/deps/lua/src/lobject.c \
  vendor/lua/deps/lua/src/lopcodes.c \
  vendor/lua/deps/lua/src/lparser.c \
  vendor/lua/deps/lua/src/lstate.c \
  vendor/lua/deps/lua/src/lstring.c \
  vendor/lua/deps/lua/src/ltable.c \
  vendor/lua/deps/lua/src/ltm.c \
  vendor/lua/deps/lua/src/lundump.c \
  vendor/lua/deps/lua/src/lvm.c \
  vendor/lua/deps/lua/src/lzio.c \
  vendor/lua/deps/lua/src/strbuf.c \
  vendor/lua/deps/lua/src/fpconv.c \
  vendor/lua/deps/lua/src/lauxlib.c \
  vendor/lua/deps/lua/src/lbaselib.c \
  vendor/lua/deps/lua/src/ldblib.c \
  vendor/lua/deps/lua/src/lmathlib.c \
  vendor/lua/deps/lua/src/ltablib.c \
  vendor/lua/deps/lua/src/lstrlib.c \
  vendor/lua/deps/lua/src/lua_cjson.c \
  vendor/lua/deps/lua/src/lua_struct.c \
  vendor/lua/deps/lua/src/lua_cmsgpack.c \
  vendor/lua/deps/lua/src/lua_bit.c \
  vendor/lua/deps/fpconv/fpconv_dtoa.c \
  vendor/lua/src/rand.c \
  src/lua/bridge.c \
  -o src/lua/lua.wasm -lm
