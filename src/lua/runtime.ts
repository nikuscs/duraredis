import { toInt64 } from "../commands/args";
import type { Ctx, Server } from "../commands/types";
import { bytes, Encoder, r, RedisError, text } from "../resp/reply";
import type { Proto, Reply } from "../resp/reply";
import { globMatch } from "../store/glob";
import { blob, fromBlob } from "../store/keyspace";
import { dumpFunctions, parseFunctionsDump } from "./rdb";
import { decodeReply } from "./reply-decoder";
import {
  extractEvalShebang,
  extractFunctionMeta,
  FLAG_EVAL_COMPAT,
  FLAG_NO_WRITES,
  flagNames,
  isValidName,
} from "./shebang";
import { FUNCTION_LOAD_TIMEOUT_MS, LuaVm, SCRIPT_TIMEOUT_MS } from "./vm";
import type { HostCallbacks, RegisteredFn } from "./vm";

interface StoredScript {
  sha: string;
  body: Uint8Array;
  flags: number;
  shebangLen: number;
}

interface StoredFn {
  name: string;
  desc: string | null;
  flags: number;
  ref: number;
  libName: string;
}

interface StoredLib {
  name: string;
  code: Uint8Array;
  functions: Array<StoredFn>;
}

const SCRIPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS lua_scripts (
  sha TEXT PRIMARY KEY,
  body BLOB NOT NULL,
  flags INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lua_libraries (
  name TEXT PRIMARY KEY,
  code BLOB NOT NULL
);
`;

const NOSCRIPT_CONNECTION_ARITY = new Map<string, number>([
  ["multi", 1],
  ["exec", 1],
  ["discard", 1],
  ["watch", -2],
  ["unwatch", 1],
  ["reset", 1],
  ["subscribe", -2],
  ["unsubscribe", -1],
  ["psubscribe", -2],
  ["punsubscribe", -1],
  ["ssubscribe", -2],
  ["sunsubscribe", -1],
]);

function encodeReply(reply: Reply, respVer: number): Uint8Array {
  const proto: Proto = respVer === 3 ? 3 : 2;
  return new Encoder(proto).write(reply).take();
}

function dispatchRedisCommand(ctx: Ctx, args: Array<Uint8Array>, readOnly: boolean, respVer: number): Uint8Array {
  if (args.length === 0) return encodeReply(r.error("ERR Unknown Redis command called from script"), respVer);
  const name = text(args[0]).toLowerCase();
  const connArity = NOSCRIPT_CONNECTION_ARITY.get(name);
  if (connArity !== undefined) {
    const ok = connArity >= 0 ? args.length === connArity : args.length >= -connArity;
    if (!ok) return encodeReply(r.error("ERR Wrong number of args calling Redis command from script"), respVer);
    return encodeReply(r.error("ERR This Redis command is not allowed from script"), respVer);
  }
  const found = ctx.lookup(args);
  if (!("run" in found)) {
    if (found.t === "error" && found.s.startsWith("ERR wrong number of arguments")) {
      return encodeReply(r.error("ERR Wrong number of args calling Redis command from script"), respVer);
    }
    return encodeReply(r.error("ERR Unknown Redis command called from script"), respVer);
  }
  if (found.flags.includes("noscript")) {
    return encodeReply(r.error("ERR This Redis command is not allowed from script"), respVer);
  }
  if (readOnly && (found.flags.includes("write") || name === "publish" || name === "spublish")) {
    return encodeReply(r.error("ERR Write commands are not allowed from read-only scripts."), respVer);
  }
  return encodeReply(ctx.invoke(found, args), respVer);
}

function aclCheckCommand(ctx: Ctx, args: Array<Uint8Array>): number {
  if (args.length === 0) return -1;
  const name = text(args[0]).toLowerCase();
  if (NOSCRIPT_CONNECTION_ARITY.has(name)) return 1;
  const found = ctx.lookup(args);
  if (!("run" in found) && found.t === "error" && found.s.startsWith("ERR unknown command")) return -1;
  return 1;
}

class LuaRuntime {
  private readonly vm = new LuaVm();
  private readonly scripts = new Map<string, StoredScript>();
  private readonly libraries = new Map<string, StoredLib>();
  private readonly functions = new Map<string, StoredFn>();
  private schemaReady = false;

  constructor(ctx: Ctx) {
    ctx.ks.sql.exec(SCRIPT_SCHEMA);
    const scriptRows = ctx.ks.sql.exec<{ sha: string; body: ArrayBuffer; flags: number }>(
      "SELECT sha, body, flags FROM lua_scripts",
    ).toArray();
    for (const row of scriptRows) {
      const body = fromBlob(row.body);
      const parsed = extractEvalShebang(body);
      const shebangLen = parsed.ok ? parsed.shebangLen : 0;
      this.scripts.set(row.sha, { sha: row.sha, body, flags: row.flags, shebangLen });
    }
    const libRows = ctx.ks.sql.exec<{ name: string; code: ArrayBuffer }>(
      "SELECT name, code FROM lua_libraries ORDER BY rowid",
    ).toArray();
    for (const row of libRows) {
      this.hydrateLibrary(ctx, fromBlob(row.code));
    }
  }

  ensureSchema(ctx: Ctx) {
    if (this.schemaReady) return;
    ctx.ks.sql.exec(SCRIPT_SCHEMA);
  }

  private hydrateLibrary(ctx: Ctx, code: Uint8Array) {
    const meta = extractFunctionMeta(code);
    if (!meta.ok || meta.engine.toLowerCase() !== "lua" || !isValidName(meta.name)) return;
    const registered: Array<RegisteredFn> = [];
    const host = this.makeLoadHost(ctx, registered);
    const err = this.vm.loadFunctionLibrary(code.subarray(meta.codeOffset), 0, host);
    if (err || registered.length === 0) {
      for (const fn of registered) this.vm.unrefFunction(fn.ref);
      return;
    }
    this.commitLibrary(meta.name, code, registered, null);
  }

  private makeCallHost(ctx: Ctx, readOnly: boolean): HostCallbacks {
    return {
      callRedis: (args, respVer) => dispatchRedisCommand(ctx, args, readOnly, respVer),
      aclCheck: (args) => aclCheckCommand(ctx, args),
      registerFn: () => 1,
    };
  }

  private makeLoadHost(ctx: Ctx, out: Array<RegisteredFn>, seen?: Set<string>): HostCallbacks {
    const localNames = seen ?? new Set<string>();
    return {
      callRedis: (_args, respVer) => encodeReply(r.error("ERR redis.call cannot be used during FUNCTION LOAD"), respVer),
      aclCheck: (args) => aclCheckCommand(ctx, args),
      registerFn: (fn) => {
        if (!isValidName(fn.name)) return 1;
        const lower = fn.name.toLowerCase();
        if (localNames.has(lower)) return 2;
        localNames.add(lower);
        out.push(fn);
        return 0;
      },
    };
  }

  private compileAndStoreScript(ctx: Ctx, body: Uint8Array): { ok: true; entry: StoredScript; wasNew: boolean } | { ok: false; reply: Reply } {
    const sha = this.vm.sha1Hex(body);
    const existing = this.scripts.get(sha);
    if (existing) {
      if (!this.vm.hasEval(sha)) {
        const compileErr = this.vm.compileEval(sha, existing.body, existing.shebangLen);
        if (compileErr) return { ok: false, reply: r.error(compileErr) };
      }
      return { ok: true, entry: existing, wasNew: false };
    }
    const shebang = extractEvalShebang(body);
    if (!shebang.ok) return { ok: false, reply: r.error(shebang.error) };
    const compileErr = this.vm.compileEval(sha, body, shebang.shebangLen);
    if (compileErr) return { ok: false, reply: r.error(compileErr) };
    const entry: StoredScript = { sha, body: body.slice(), flags: shebang.flags, shebangLen: shebang.shebangLen };
    this.scripts.set(sha, entry);
    ctx.ks.sql.exec(
      "INSERT OR REPLACE INTO lua_scripts (sha, body, flags) VALUES (?, ?, ?)",
      sha,
      blob(entry.body),
      entry.flags,
    );
    return { ok: true, entry, wasNew: true };
  }

  scriptLoad(ctx: Ctx, body: Uint8Array): Reply {
    const res = this.compileAndStoreScript(ctx, body);
    if (!res.ok) {
      this.schemaReady = true;
      return res.reply;
    }
    this.schemaReady = true;
    return r.bulk(res.entry.sha);
  }

  scriptExists(shas: Array<Uint8Array>): Reply {
    const items: Array<Reply> = [];
    for (const s of shas) {
      const key = text(s).toLowerCase();
      items.push(r.int(key.length === 40 && this.scripts.has(key) ? 1 : 0));
    }
    this.schemaReady = true;
    return r.array(items);
  }

  scriptFlush(ctx: Ctx): Reply {
    ctx.ks.sql.exec("DELETE FROM lua_scripts");
    this.scripts.clear();
    this.vm.resetEval();
    this.schemaReady = true;
    return r.ok;
  }

  evalScript(ctx: Ctx, args: Array<Uint8Array>, isSha: boolean, ro: boolean): Reply {
    const numkeys = toInt64(args[2]);
    if (numkeys === undefined) {
      this.schemaReady = true;
      return r.error("ERR value is not an integer or out of range");
    }
    const avail = BigInt(args.length - 3);
    if (numkeys > avail) {
      this.schemaReady = true;
      return r.error("ERR Number of keys can't be greater than number of args");
    }
    if (numkeys < 0n) {
      this.schemaReady = true;
      return r.error("ERR Number of keys can't be negative");
    }

    let entry: StoredScript;
    let wasNew = false;
    if (isSha) {
      if (args[1].length !== 40) {
        this.schemaReady = true;
        return r.error("NOSCRIPT No matching script. Please use EVAL.");
      }
      const sha = text(args[1]).toLowerCase();
      const found = this.scripts.get(sha);
      if (!found) {
        this.schemaReady = true;
        return r.error("NOSCRIPT No matching script. Please use EVAL.");
      }
      if (!this.vm.hasEval(sha)) {
        const compileErr = this.vm.compileEval(sha, found.body, found.shebangLen);
        if (compileErr) {
          this.schemaReady = true;
          return r.error(compileErr);
        }
      }
      entry = found;
    } else {
      const compiled = this.compileAndStoreScript(ctx, args[1]);
      if (!compiled.ok) {
        this.schemaReady = true;
        return compiled.reply;
      }
      entry = compiled.entry;
      wasNew = compiled.wasNew;
    }

    const compat = (entry.flags & FLAG_EVAL_COMPAT) !== 0;
    const noWrites = (entry.flags & FLAG_NO_WRITES) !== 0;
    if (ro && !compat && !noWrites) {
      this.schemaReady = true;
      return r.error("ERR Can not execute a script with write flag using *_ro command.");
    }

    const readOnly = ro || (!compat && noWrites);
    const nkeys = Number(numkeys);
    const keys = args.slice(3, 3 + nkeys);
    const argv = args.slice(3 + nkeys);
    const { timedOut, out } = this.vm.runEval(
      entry.sha,
      keys,
      argv,
      ctx.session.proto,
      SCRIPT_TIMEOUT_MS,
      this.makeCallHost(ctx, readOnly),
    );

    if (timedOut) {
      if (wasNew) {
        this.scripts.delete(entry.sha);
        this.vm.removeEval(entry.sha);
      }
      throw new RedisError(text(out));
    }
    this.schemaReady = true;
    return decodeReply(out);
  }

  private commitLibrary(libName: string, code: Uint8Array, fns: Array<RegisteredFn>, oldLib: StoredLib | null) {
    if (oldLib) this.unlinkLibrary(oldLib);
    const storedFns: Array<StoredFn> = [];
    for (const fn of fns) {
      const sf: StoredFn = { name: fn.name, desc: fn.desc, flags: fn.flags, ref: fn.ref, libName };
      storedFns.push(sf);
      this.functions.set(fn.name.toLowerCase(), sf);
    }
    this.libraries.set(libName, { name: libName, code: code.slice(), functions: storedFns });
  }

  private unlinkLibrary(lib: StoredLib) {
    for (const fn of lib.functions) {
      this.functions.delete(fn.name.toLowerCase());
      this.vm.unrefFunction(fn.ref);
    }
    this.libraries.delete(lib.name);
  }

  functionLoad(ctx: Ctx, code: Uint8Array, replace: boolean, timeoutMs = FUNCTION_LOAD_TIMEOUT_MS): Reply {
    const meta = extractFunctionMeta(code);
    if (!meta.ok) {
      this.schemaReady = true;
      return r.error(meta.error);
    }
    if (!isValidName(meta.name)) {
      this.schemaReady = true;
      return r.error("ERR Library names can only contain letters, numbers, or underscores(_) and must be at least one character long");
    }
    if (meta.engine.toLowerCase() !== "lua") {
      this.schemaReady = true;
      return r.error(`ERR Engine '${meta.engine}' not found`);
    }
    const oldLib = this.libraries.get(meta.name) ?? null;
    if (oldLib && !replace) {
      this.schemaReady = true;
      return r.error(`ERR Library '${meta.name}' already exists`);
    }

    const registered: Array<RegisteredFn> = [];
    const loadErr = this.vm.loadFunctionLibrary(code.subarray(meta.codeOffset), timeoutMs, this.makeLoadHost(ctx, registered));
    if (loadErr) {
      for (const fn of registered) this.vm.unrefFunction(fn.ref);
      this.schemaReady = true;
      return r.error(loadErr);
    }
    if (registered.length === 0) {
      this.schemaReady = true;
      return r.error("ERR No functions registered");
    }

    for (const fn of registered) {
      const existing = this.functions.get(fn.name.toLowerCase());
      if (existing && existing.libName !== meta.name) {
        for (const rfn of registered) this.vm.unrefFunction(rfn.ref);
        this.schemaReady = true;
        return r.error(`ERR Function ${fn.name} already exists`);
      }
    }

    this.commitLibrary(meta.name, code, registered, oldLib);
    ctx.ks.sql.exec("INSERT OR REPLACE INTO lua_libraries (name, code) VALUES (?, ?)", meta.name, blob(code));
    this.schemaReady = true;
    return r.bulk(meta.name);
  }

  functionDelete(ctx: Ctx, libName: string): Reply {
    const lib = this.libraries.get(libName);
    if (!lib) {
      this.schemaReady = true;
      return r.error("ERR Library not found");
    }
    this.unlinkLibrary(lib);
    ctx.ks.sql.exec("DELETE FROM lua_libraries WHERE name = ?", libName);
    this.schemaReady = true;
    return r.ok;
  }

  functionList(pattern: Uint8Array | null, withCode: boolean): Reply {
    const items: Array<Reply> = [];
    for (const lib of this.libraries.values()) {
      if (pattern && !globMatch(pattern, bytes(lib.name), true)) continue;
      const fnReplies: Array<Reply> = [];
      for (const fn of lib.functions) {
        const flags = flagNames(fn.flags).map((f) => r.simple(f));
        fnReplies.push(
          r.map([
            [r.bulk("name"), r.bulk(fn.name)],
            [r.bulk("description"), fn.desc !== null ? r.bulk(fn.desc) : r.nil],
            [r.bulk("flags"), r.set(flags)],
          ]),
        );
      }
      const entries: Array<[Reply, Reply]> = [
        [r.bulk("library_name"), r.bulk(lib.name)],
        [r.bulk("engine"), r.bulk("LUA")],
        [r.bulk("functions"), r.array(fnReplies)],
      ];
      if (withCode) entries.push([r.bulk("library_code"), r.bulk(lib.code)]);
      items.push(r.map(entries));
    }
    this.schemaReady = true;
    return r.array(items);
  }

  functionFlush(ctx: Ctx): Reply {
    ctx.ks.sql.exec("DELETE FROM lua_libraries");
    this.libraries.clear();
    this.functions.clear();
    this.vm.resetFunctions();
    this.schemaReady = true;
    return r.ok;
  }

  functionStats(): Reply {
    this.schemaReady = true;
    return r.map([
      [r.bulk("running_script"), r.nil],
      [
        r.bulk("engines"),
        r.map([
          [
            r.bulk("LUA"),
            r.map([
              [r.bulk("libraries_count"), r.int(this.libraries.size)],
              [r.bulk("functions_count"), r.int(this.functions.size)],
            ]),
          ],
        ]),
      ],
    ]);
  }

  functionDump(): Reply {
    const codes: Array<Uint8Array> = [];
    for (const lib of this.libraries.values()) codes.push(lib.code);
    this.schemaReady = true;
    return r.bulk(dumpFunctions(codes));
  }

  functionRestore(ctx: Ctx, payload: Uint8Array, policy: "APPEND" | "REPLACE" | "FLUSH"): Reply {
    const parsed = parseFunctionsDump(payload);
    if (!parsed.ok) {
      this.schemaReady = true;
      return r.error(parsed.error);
    }

    interface StagedLib {
      name: string;
      code: Uint8Array;
      fns: Array<RegisteredFn>;
    }
    const staged: Array<StagedLib> = [];
    const cleanupStaged = () => {
      for (const s of staged) {
        for (const fn of s.fns) this.vm.unrefFunction(fn.ref);
      }
      this.schemaReady = true;
    };

    const stagedLibNames = new Set<string>();
    const stagedFnNames = new Set<string>();

    for (const code of parsed.codes) {
      const meta = extractFunctionMeta(code);
      if (!meta.ok) {
        cleanupStaged();
        return r.error(meta.error);
      }
      if (!isValidName(meta.name)) {
        cleanupStaged();
        return r.error("ERR Library names can only contain letters, numbers, or underscores(_) and must be at least one character long");
      }
      if (meta.engine.toLowerCase() !== "lua") {
        cleanupStaged();
        return r.error(`ERR Engine '${meta.engine}' not found`);
      }
      if (stagedLibNames.has(meta.name)) {
        cleanupStaged();
        return r.error(`ERR Library ${meta.name} already exists`);
      }
      if (policy !== "FLUSH" && this.libraries.has(meta.name) && policy !== "REPLACE") {
        cleanupStaged();
        return r.error(`ERR Library ${meta.name} already exists`);
      }
      stagedLibNames.add(meta.name);

      const registered: Array<RegisteredFn> = [];
      const loadErr = this.vm.loadFunctionLibrary(code.subarray(meta.codeOffset), 0, this.makeLoadHost(ctx, registered));
      if (loadErr) {
        for (const fn of registered) this.vm.unrefFunction(fn.ref);
        cleanupStaged();
        return r.error(loadErr);
      }
      if (registered.length === 0) {
        cleanupStaged();
        return r.error("ERR No functions registered");
      }
      for (const fn of registered) {
        const lower = fn.name.toLowerCase();
        if (stagedFnNames.has(lower)) {
          for (const rfn of registered) this.vm.unrefFunction(rfn.ref);
          cleanupStaged();
          return r.error(`ERR Function ${fn.name} already exists`);
        }
        stagedFnNames.add(lower);
      }
      staged.push({ name: meta.name, code, fns: registered });
    }

    if (policy !== "FLUSH") {
      for (const s of staged) {
        for (const fn of s.fns) {
          const existing = this.functions.get(fn.name.toLowerCase());
          if (!existing) continue;
          if (policy === "REPLACE" && stagedLibNames.has(existing.libName)) continue;
          cleanupStaged();
          return r.error(`ERR Function ${fn.name} already exists`);
        }
      }
    }

    if (policy === "FLUSH") {
      for (const lib of this.libraries.values()) this.unlinkLibrary(lib);
      ctx.ks.sql.exec("DELETE FROM lua_libraries");
    } else if (policy === "REPLACE") {
      for (const s of staged) {
        const old = this.libraries.get(s.name);
        if (old) {
          this.unlinkLibrary(old);
          ctx.ks.sql.exec("DELETE FROM lua_libraries WHERE name = ?", s.name);
        }
      }
    }

    for (const s of staged) {
      this.commitLibrary(s.name, s.code, s.fns, null);
      ctx.ks.sql.exec("INSERT OR REPLACE INTO lua_libraries (name, code) VALUES (?, ?)", s.name, blob(s.code));
    }
    this.schemaReady = true;
    return r.ok;
  }

  fcall(ctx: Ctx, args: Array<Uint8Array>, ro: boolean): Reply {
    const fn = this.functions.get(text(args[1]).toLowerCase());
    if (!fn) {
      this.schemaReady = true;
      return r.error("ERR Function not found");
    }

    const numkeys = toInt64(args[2]);
    if (numkeys === undefined) {
      this.schemaReady = true;
      return r.error("ERR Bad number of keys provided");
    }
    const avail = BigInt(args.length - 3);
    if (numkeys > avail) {
      this.schemaReady = true;
      return r.error("ERR Number of keys can't be greater than number of args");
    }
    if (numkeys < 0n) {
      this.schemaReady = true;
      return r.error("ERR Number of keys can't be negative");
    }

    const noWrites = (fn.flags & FLAG_NO_WRITES) !== 0;
    if (ro && !noWrites) {
      this.schemaReady = true;
      return r.error("ERR Can not execute a script with write flag using *_ro command.");
    }

    const readOnly = ro || noWrites;
    const nkeys = Number(numkeys);
    const keys = args.slice(3, 3 + nkeys);
    const argv = args.slice(3 + nkeys);
    const { timedOut, out } = this.vm.callFunction(
      fn.ref,
      fn.name,
      keys,
      argv,
      ctx.session.proto,
      SCRIPT_TIMEOUT_MS,
      this.makeCallHost(ctx, readOnly),
    );
    if (timedOut) throw new RedisError(text(out));
    this.schemaReady = true;
    return decodeReply(out);
  }
}

const runtimes = new WeakMap<Server, LuaRuntime>();

export function getRuntime(ctx: Ctx): LuaRuntime {
  let rt = runtimes.get(ctx.server);
  if (!rt) {
    rt = new LuaRuntime(ctx);
    runtimes.set(ctx.server, rt);
  } else {
    rt.ensureSchema(ctx);
  }
  return rt;
}
