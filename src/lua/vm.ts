import { bytes, text } from "../resp/reply";
import luaWasm from "./lua.wasm";

export const SCRIPT_TIMEOUT_MS = 5000;
export const FUNCTION_LOAD_TIMEOUT_MS = 500;

export interface RegisteredFn {
  name: string;
  desc: string | null;
  flags: number;
  ref: number;
}

export interface RunResult {
  timedOut: boolean;
  out: Uint8Array;
}

export interface HostCallbacks {
  callRedis: (args: Array<Uint8Array>, respVer: number) => Uint8Array;
  aclCheck: (args: Array<Uint8Array>) => number;
  registerFn: (fn: RegisteredFn) => number;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  _initialize: () => void;
  lua_vm_init: () => number;
  lua_eval_reset: () => void;
  lua_func_reset: () => void;
  lua_alloc: (size: number) => number;
  lua_free: (ptr: number) => void;
  lua_out_ptr: () => number;
  lua_out_len: () => number;
  lua_sha1hex: (dataPtr: number, len: number, outPtr: number) => void;
  lua_eval_compile: (shaPtr: number, bodyPtr: number, bodyLen: number, shebangLen: number) => number;
  lua_eval_has: (shaPtr: number) => number;
  lua_eval_remove: (shaPtr: number) => void;
  lua_eval_run: (
    shaPtr: number,
    keysPtr: number,
    keysLen: number,
    argsPtr: number,
    argsLen: number,
    clientResp: number,
    timeoutMs: number,
  ) => number;
  lua_func_load: (codePtr: number, codeLen: number, timeoutMs: number) => number;
  lua_func_call: (
    luaRef: number,
    namePtr: number,
    nameLen: number,
    keysPtr: number,
    keysLen: number,
    argsPtr: number,
    argsLen: number,
    clientResp: number,
    timeoutMs: number,
  ) => number;
  lua_func_unref: (luaRef: number) => void;
}

function isWasmFn<T extends (...args: Array<never>) => number | void>(x: WebAssembly.ExportValue): x is T {
  return typeof x === "function";
}

function getFn<T extends (...args: Array<never>) => number | void>(exports: WebAssembly.Exports, name: string): T {
  const v = exports[name];
  if (!isWasmFn<T>(v)) throw new Error(`Missing wasm export: ${name}`);
  return v;
}

function extractExports(exports: WebAssembly.Exports): WasmExports {
  const memory = exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Missing wasm memory export");
  return {
    memory,
    _initialize: getFn(exports, "_initialize"),
    lua_vm_init: getFn(exports, "lua_vm_init"),
    lua_eval_reset: getFn(exports, "lua_eval_reset"),
    lua_func_reset: getFn(exports, "lua_func_reset"),
    lua_alloc: getFn(exports, "lua_alloc"),
    lua_free: getFn(exports, "lua_free"),
    lua_out_ptr: getFn(exports, "lua_out_ptr"),
    lua_out_len: getFn(exports, "lua_out_len"),
    lua_sha1hex: getFn(exports, "lua_sha1hex"),
    lua_eval_compile: getFn(exports, "lua_eval_compile"),
    lua_eval_has: getFn(exports, "lua_eval_has"),
    lua_eval_remove: getFn(exports, "lua_eval_remove"),
    lua_eval_run: getFn(exports, "lua_eval_run"),
    lua_func_load: getFn(exports, "lua_func_load"),
    lua_func_call: getFn(exports, "lua_func_call"),
    lua_func_unref: getFn(exports, "lua_func_unref"),
  };
}

function packArgs(items: Array<Uint8Array>): Uint8Array {
  let total = 4;
  for (const item of items) total += 4 + item.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, items.length, true);
  let pos = 4;
  for (const item of items) {
    view.setUint32(pos, item.length, true);
    pos += 4;
    out.set(item, pos);
    pos += item.length;
  }
  return out;
}

function unpackArgs(buf: Uint8Array): Array<Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint32(0, true);
  const args: Array<Uint8Array> = [];
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const len = view.getUint32(pos, true);
    pos += 4;
    args.push(buf.slice(pos, pos + len));
    pos += len;
  }
  return args;
}

export class LuaVm {
  private readonly w: WasmExports;
  private host: HostCallbacks | null = null;

  constructor() {
    const imports: WebAssembly.Imports = {
      env: {
        host_now_ms: () => Date.now(),
        host_redis_call: (reqPtr: number, reqLen: number, respVer: number, outPtrPtr: number, outLenPtr: number) =>
          this.onRedisCall(reqPtr, reqLen, respVer, outPtrPtr, outLenPtr),
        host_acl_check_cmd: (reqPtr: number, reqLen: number) => this.onAclCheck(reqPtr, reqLen),
        host_register_function: (
          namePtr: number,
          nameLen: number,
          descPtr: number,
          descLen: number,
          hasDesc: number,
          flags: number,
          luaRef: number,
        ) => this.onRegisterFunction(namePtr, nameLen, descPtr, descLen, hasDesc, flags, luaRef),
        emscripten_notify_memory_growth: () => {},
        __syscall_dup3: () => 0,
      },
      wasi_snapshot_preview1: {
        proc_exit: (code: number) => {
          throw new Error(`lua.wasm exited with code ${code}`);
        },
        fd_write: () => 0,
        fd_read: () => 0,
        fd_close: () => 0,
        fd_seek: () => 0,
      },
    };
    const instance = new WebAssembly.Instance(luaWasm, imports);
    this.w = extractExports(instance.exports);
    this.w._initialize();
    if (this.w.lua_vm_init() !== 0) throw new Error("Failed to initialize Lua VM");
  }

  private memU8(): Uint8Array {
    return new Uint8Array(this.w.memory.buffer);
  }

  private writeBytes(data: Uint8Array, nulTerminate = false): number {
    const ptr = this.w.lua_alloc(data.length + (nulTerminate ? 1 : 0));
    const mem = this.memU8();
    mem.set(data, ptr);
    if (nulTerminate) mem[ptr + data.length] = 0;
    return ptr;
  }

  private readOut(): Uint8Array {
    const ptr = this.w.lua_out_ptr();
    const len = this.w.lua_out_len();
    return this.memU8().slice(ptr, ptr + len);
  }

  private onRedisCall(reqPtr: number, reqLen: number, respVer: number, outPtrPtr: number, outLenPtr: number): number {
    if (!this.host) return 1;
    const req = this.memU8().slice(reqPtr, reqPtr + reqLen);
    const args = unpackArgs(req);
    const replyBytes = this.host.callRedis(args, respVer);
    const outPtr = this.writeBytes(replyBytes, true);
    const view = new DataView(this.w.memory.buffer);
    view.setUint32(outPtrPtr, outPtr, true);
    view.setUint32(outLenPtr, replyBytes.length, true);
    return 0;
  }

  private onAclCheck(reqPtr: number, reqLen: number): number {
    if (!this.host) return -1;
    const req = this.memU8().slice(reqPtr, reqPtr + reqLen);
    return this.host.aclCheck(unpackArgs(req));
  }

  private onRegisterFunction(
    namePtr: number,
    nameLen: number,
    descPtr: number,
    descLen: number,
    hasDesc: number,
    flags: number,
    luaRef: number,
  ): number {
    if (!this.host) return 1;
    const mem = this.memU8();
    const name = text(mem.subarray(namePtr, namePtr + nameLen));
    const desc = hasDesc ? text(mem.subarray(descPtr, descPtr + descLen)) : null;
    return this.host.registerFn({ name, desc, flags, ref: luaRef });
  }

  sha1Hex(data: Uint8Array): string {
    const dataPtr = this.writeBytes(data);
    const outPtr = this.w.lua_alloc(41);
    try {
      this.w.lua_sha1hex(dataPtr, data.length, outPtr);
      return text(this.memU8().subarray(outPtr, outPtr + 40));
    } finally {
      this.w.lua_free(dataPtr);
      this.w.lua_free(outPtr);
    }
  }

  compileEval(sha: string, body: Uint8Array, shebangLen: number): string | null {
    const shaPtr = this.writeBytes(bytes(sha), true);
    const bodyPtr = this.writeBytes(body);
    try {
      const rc = this.w.lua_eval_compile(shaPtr, bodyPtr, body.length, shebangLen);
      return rc === 0 ? null : text(this.readOut());
    } finally {
      this.w.lua_free(shaPtr);
      this.w.lua_free(bodyPtr);
    }
  }

  hasEval(sha: string): boolean {
    const shaPtr = this.writeBytes(bytes(sha), true);
    try {
      return this.w.lua_eval_has(shaPtr) !== 0;
    } finally {
      this.w.lua_free(shaPtr);
    }
  }

  removeEval(sha: string) {
    const shaPtr = this.writeBytes(bytes(sha), true);
    try {
      this.w.lua_eval_remove(shaPtr);
    } finally {
      this.w.lua_free(shaPtr);
    }
  }

  runEval(
    sha: string,
    keys: Array<Uint8Array>,
    args: Array<Uint8Array>,
    clientResp: number,
    timeoutMs: number,
    host: HostCallbacks,
  ): RunResult {
    const shaPtr = this.writeBytes(bytes(sha), true);
    const packedKeys = packArgs(keys);
    const packedArgs = packArgs(args);
    const keysPtr = this.writeBytes(packedKeys);
    const argsPtr = this.writeBytes(packedArgs);
    this.host = host;
    try {
      const rc = this.w.lua_eval_run(shaPtr, keysPtr, packedKeys.length, argsPtr, packedArgs.length, clientResp, timeoutMs);
      return { timedOut: rc !== 0, out: this.readOut() };
    } finally {
      this.host = null;
      this.w.lua_free(shaPtr);
      this.w.lua_free(keysPtr);
      this.w.lua_free(argsPtr);
    }
  }

  resetEval() {
    this.w.lua_eval_reset();
  }

  loadFunctionLibrary(code: Uint8Array, timeoutMs: number, host: HostCallbacks): string | null {
    const codePtr = this.writeBytes(code);
    this.host = host;
    try {
      const rc = this.w.lua_func_load(codePtr, code.length, timeoutMs);
      return rc === 0 ? null : text(this.readOut());
    } finally {
      this.host = null;
      this.w.lua_free(codePtr);
    }
  }

  callFunction(
    luaRef: number,
    fnName: string,
    keys: Array<Uint8Array>,
    args: Array<Uint8Array>,
    clientResp: number,
    timeoutMs: number,
    host: HostCallbacks,
  ): RunResult {
    const nameBytes = bytes(fnName);
    const namePtr = this.writeBytes(nameBytes, true);
    const packedKeys = packArgs(keys);
    const packedArgs = packArgs(args);
    const keysPtr = this.writeBytes(packedKeys);
    const argsPtr = this.writeBytes(packedArgs);
    this.host = host;
    try {
      const rc = this.w.lua_func_call(
        luaRef,
        namePtr,
        nameBytes.length,
        keysPtr,
        packedKeys.length,
        argsPtr,
        packedArgs.length,
        clientResp,
        timeoutMs,
      );
      return { timedOut: rc !== 0, out: this.readOut() };
    } finally {
      this.host = null;
      this.w.lua_free(namePtr);
      this.w.lua_free(keysPtr);
      this.w.lua_free(argsPtr);
    }
  }

  unrefFunction(luaRef: number) {
    this.w.lua_func_unref(luaRef);
  }

  resetFunctions() {
    this.w.lua_func_reset();
  }
}
