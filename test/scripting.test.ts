import { describe, expect, test } from "bun:test";
import { describeDual } from "./dual";
import type { Pair } from "./dual";
import { freshDb, serverHost, serverPort } from "./setup";
import { decodeResp, WireClient } from "./wire";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string) => enc.encode(s);

async function withDura(prefix: string, fn: (c: WireClient) => Promise<void>) {
  const c = await WireClient.connect(serverHost(), serverPort());
  try {
    expect(dec.decode(await c.cmd("AUTH", freshDb(prefix), "x"))).toBe("+OK\r\n");
    await fn(c);
  } finally {
    await c.close();
  }
}

describeDual("scripting differential vs redis:8", (run) => {
  const clean = (fn: (s: Pair) => Promise<void>) =>
    run(async (s) => {
      await s.redis.pipeline([["SCRIPT", "FLUSH"], ["FUNCTION", "FLUSH"]]);
      await fn(s);
    });

  test("EVAL, EVALSHA, SCRIPT LOAD/EXISTS/FLUSH/KILL/DEBUG/HELP, FLUSHALL persistence", () => clean(async (s) => {
    const bin = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x0d, 0x0a]);
    await s.script([
      ["EVAL", "return {KEYS[1], KEYS[2], ARGV[1], ARGV[2]}", "2", "k1", bin, "a1", bin],
      ["EVAL", "return {KEYS[1], ARGV[1]}", "0", "onlyarg"],
      ["EVAL", "return 1", "-1"], ["EVAL", "return 1", "5", "k1"], ["EVAL", "return 1", "notint"], ["EVAL", "return 1"],
      ["EVALSHA", "0000000000000000000000000000000000000000", "0"], ["EVALSHA", "short", "0"],
      ["SCRIPT", "LOAD", "return tonumber(ARGV[1]) + 10"],
      ["EVALSHA", "8F1032404B3ADCE1B4E808415EEFA00CF046C7C7", "0", "32"],
      ["SCRIPT", "LOAD", "return 'cached'"],
    ]);
    const shaVal = decodeResp(await s.cmd("SCRIPT", "LOAD", "return KEYS[1]"));
    expect(shaVal.kind).toBe("bulk");
    if (shaVal.kind !== "bulk") return;
    const sha = dec.decode(shaVal.value);
    await s.script([
      ["SCRIPT", "EXISTS", sha, sha.toUpperCase(), "0000000000000000000000000000000000000000", "bad"],
      ["EVALSHA", sha, "1", "mykey"], ["EVALSHA", sha.toUpperCase(), "1", "mykey"],
      ["SET", "k", "v"], ["FLUSHALL"], ["SCRIPT", "EXISTS", sha], ["EVALSHA", sha, "1", "afterflush"],
      ["SCRIPT", "FLUSH", "SYNC"], ["SCRIPT", "EXISTS", sha], ["EVALSHA", sha, "1", "afterscriptflush"],
      ["SCRIPT", "LOAD", "return 99"], ["SCRIPT", "FLUSH", "ASYNC"],
      ["SCRIPT", "EXISTS", "e0e1f9fabfc9d4800c877a703b823ac0578ff8db"],
      ["SCRIPT", "EXISTS"], ["SCRIPT", "LOAD"], ["SCRIPT", "LOAD", "a", "b"],
      ["SCRIPT", "FLUSH", "INVALID"], ["SCRIPT", "FLUSH", "SYNC", "EXTRA"],
      ["SCRIPT", "KILL"], ["SCRIPT", "KILL", "EXTRA"],
      ["SCRIPT", "DEBUG", "NO"],
      ["SCRIPT", "HELP"], ["SCRIPT", "HELP", "EXTRA"], ["SCRIPT", "NOSUCH"],
    ]);
  }));

  test("EVAL_RO, EVALSHA_RO, shebang flags, read-only enforcement", () => clean(async (s) => {
    await s.script([
      ["SET", "rokey", "hello"],
      ["EVAL_RO", "return redis.call('GET', KEYS[1])", "1", "rokey"],
      ["EVAL_RO", "return redis.call('SET', 'x', '1')", "0"],
      ["EVAL_RO", "return redis.call('FLUSHDB')", "0"],
      ["EVAL_RO", "return redis.call('PUBLISH', 'ch', 'msg')", "0"],
      ["EVAL_RO", "return redis.call('SPUBLISH', 'ch', 'msg')", "0"],
      ["EVAL_RO", "#!lua\nreturn 1", "0"],
      ["EVAL_RO", "#!lua flags=no-writes\nreturn redis.call('GET', 'rokey')", "1", "rokey"],
      ["EVAL_RO", "#!lua flags=no-writes,allow-stale\nreturn redis.call('SET', 'x', '1')", "0"],
      ["EVAL", "#!lua flags=no-writes\nreturn redis.call('SET', 'x', '1')", "0"],
      ["EVAL", "#!lua flags=\nreturn 7", "0"], ["EVAL", "#!lua\r\nreturn 8", "0"],
      ["EVAL", "#!lua", "0"], ["EVAL", "#!js\nreturn 1", "0"],
      ["EVAL", "#!lua flags=unknown\nreturn 1", "0"], ["EVAL", "#!lua unknown=1\nreturn 1", "0"],
    ]);
    const roVal = decodeResp(await s.cmd("SCRIPT", "LOAD", "#!lua flags=no-writes\nreturn redis.call('GET', KEYS[1])"));
    const rwVal = decodeResp(await s.cmd("SCRIPT", "LOAD", "#!lua\nreturn 1"));
    if (roVal.kind !== "bulk" || rwVal.kind !== "bulk") return;
    await s.script([
      ["EVALSHA_RO", dec.decode(roVal.value), "1", "rokey"],
      ["EVALSHA_RO", dec.decode(rwVal.value), "0"],
    ]);
  }));

  test("redis.* API, errors, line suffixes, noscript, blocking, globals sandbox", () => clean(async (s) => {
    await s.script([
      ["EVAL", "return redis.sha1hex('abc')", "0"], ["EVAL", String.raw`return redis.sha1hex('a\0b')`, "0"], ["EVAL", "return redis.sha1hex()", "0"],
      ["EVAL", "return redis.error_reply('MYERR custom')", "0"], ["EVAL", "return redis.error_reply('-MYERR dash')", "0"],
      ["EVAL", "return redis.error_reply('plain')", "0"], ["EVAL", String.raw`return redis.error_reply('ERR a\nb')`, "0"],
      ["EVAL", "return redis.error_reply(123)", "0"], ["EVAL", "return redis.status_reply('YAY')", "0"],
      ["EVAL", String.raw`return redis.status_reply('OK\n2')`, "0"], ["EVAL", "return redis.status_reply(123)", "0"],
      ["EVAL", "redis.log(redis.LOG_DEBUG, 'd', 1); redis.log(redis.LOG_WARNING, 'w'); return 1", "0"],
      ["EVAL", "redis.log(redis.LOG_WARNING)", "0"], ["EVAL", "redis.log('bad', 'x')", "0"], ["EVAL", "redis.log(99, 'x')", "0"],
      ["EVAL", "return redis.set_repl(redis.REPL_NONE)", "0"], ["EVAL", "return redis.set_repl(redis.REPL_ALL)", "0"],
      ["EVAL", "return redis.set_repl(99)", "0"], ["EVAL", "return redis.set_repl()", "0"],
      ["EVAL", "return redis.replicate_commands()", "0"],
      ["EVAL", "return redis.setresp(4)", "0"], ["EVAL", "return redis.setresp()", "0"],
      ["EVAL", "return redis.acl_check_cmd('GET', 'k')", "0"], ["EVAL", "return redis.acl_check_cmd('MULTI')", "0"], ["EVAL", "return redis.acl_check_cmd('NOPE')", "0"],
      ["EVAL", "return redis.call()", "0"], ["EVAL", "return redis.call('GET', {})", "0"], ["EVAL", "return redis.pcall('GET', {})", "0"],
      ["EVAL", "return redis.call('GET')", "0"], ["EVAL", "return redis.pcall('GET')", "0"], ["EVAL", "return redis.call('NOPE')", "0"],
      ["EVAL", "return redis.call('MULTI')", "0"], ["EVAL", "return redis.call('MULTI', 'extra')", "0"],
      ["EVAL", "return redis.call('AUTH', 'x')", "0"], ["EVAL", "return redis.call('HELLO', 2)", "0"], ["EVAL", "return redis.call('QUIT')", "0"],
      ["EVAL", "return redis.call('CLIENT', 'ID')", "0"], ["EVAL", "return redis.call('CONFIG', 'GET', 'databases')", "0"],
      ["EVAL", "return redis.call('EVAL', 'return 1', 0)", "0"], ["EVAL", "return redis.call('SCRIPT', 'EXISTS', 'a')", "0"],
      ["EVAL", "return redis.call('FUNCTION', 'STATS')", "0"], ["EVAL", "return redis.call('FCALL', 'f', 0)", "0"],
      ["EVAL", "return redis.call('PING')", "0"], ["EVAL", "return redis.call('SELECT', 0)", "0"],
      ["EVAL", "return redis.call('BLPOP', 'missing_list', 1)", "0"],
      ["EVAL", "error('boom')", "0"], ["EVAL", String.raw`error('a\nb')`, "0"],
      ["EVAL", "local ok, e = pcall(function() return redis.call('GET') end); return {tostring(ok), tostring(e)}", "0"],
      ["EVAL", "if then", "0"],
      ["SET", "wt_str", "1"],
      ["EVAL", "return redis.call('HGET', 'wt_str', 'f')", "0"], ["EVAL", "return redis.pcall('HGET', 'wt_str', 'f')", "0"],
      ["EVAL", "redis.call('SET', 'kept', 'yes')\nerror('fail_after_write')", "0"], ["GET", "kept"],
      ["EVAL", "return nonexistent_global", "0"], ["EVAL", "new_global = 1", "0"], ["EVAL", "math.sin = 1", "0"], ["EVAL", "redis.call = 1", "0"],
      ["EVAL", "return {rawget(_G, 'debug') == nil, rawget(_G, 'dofile') == nil, rawget(_G, 'loadfile') == nil, rawget(_G, 'print') == nil}", "0"],
    ]);
    const [rc, dc] = await s.shape("EVAL", "return redis.call('COMMAND', 'COUNT')", "0");
    expect(rc.kind === "int" && rc.value > 0n).toBe(true);
    expect(dc.kind === "int" && dc.value > 0n).toBe(true);
  }));

  test("bidirectional Lua <-> RESP conversions (RESP2 & RESP3)", () => clean((s) => s.script([
    ["EVAL", "return 'hello'", "0"], ["EVAL", "return ''", "0"], ["EVAL", "return 42", "0"], ["EVAL", "return -7", "0"],
    ["EVAL", "return 3.9", "0"], ["EVAL", "return -3.9", "0"], ["EVAL", "return 0/0", "0"], ["EVAL", "return 1/0", "0"],
    ["EVAL", "return true", "0"], ["EVAL", "return false", "0"], ["EVAL", "return nil", "0"],
    ["EVAL", "redis.setresp(3); return true", "0"], ["EVAL", "redis.setresp(3); return false", "0"],
    ["EVAL", "return {1, nil, 2}", "0"], ["EVAL", "return {1, false, 2}", "0"],
    ["EVAL", "redis.setresp(3); return {1, false, 2}", "0"],
    ["EVAL", "return {1, {2, {3, 'x'}}}", "0"], ["EVAL", "return {}", "0"],
    ["EVAL", "return {ok='PONG'}", "0"], ["EVAL", "return {err='ERR custom'}", "0"],
    ["EVAL", "return {double=1.5}", "0"], ["EVAL", "return {double=42}", "0"],
    ["EVAL", "return {double=1/0}", "0"], ["EVAL", "return {double=-1/0}", "0"], ["EVAL", "return {double=0/0}", "0"], ["EVAL", "return {double=-0.0}", "0"],
    ["EVAL", "return {map={a=1}}", "0"], ["EVAL", "return {set={a=true}}", "0"],
    ["EVAL", "return {big_number='123456789012345678901234567890'}", "0"],
    ["EVAL", "return {verbatim_string={format='txt', string='hello'}}", "0"],
    ["EVAL", "return {verbatim_string={format='md', string='hi'}}", "0"],
    ["EVAL", "redis.call('SET', 'num1', 1000000000); return redis.call('GET', 'num1')", "0"],
    ["EVAL", "redis.call('SET', 'num2', 1.5); return redis.call('GET', 'num2')", "0"],
    ["EVAL", "return redis.call('PING', -0.0)", "0"], ["EVAL", "return redis.call('PING', 0/0)", "0"],
    ["EVAL", "return redis.call('PING', 1/0)", "0"], ["EVAL", "return redis.call('PING', 1e20)", "0"],
    ["HSET", "h1", "f1", "v1"], ["SADD", "s1", "m1"], ["ZADD", "z1", "2.5", "m1"],
    ["EVAL", "redis.setresp(3); local r = redis.call('HGETALL', 'h1'); return {r.map.f1, redis.call('GET', 'nope') == nil}", "0"],
    ["EVAL", "redis.setresp(3); return redis.call('SMEMBERS', 's1').set.m1", "0"],
    ["EVAL", "redis.setresp(3); return redis.call('ZSCORE', 'z1', 'm1').double", "0"],
    ["EVAL", "return redis.call('GET', 'nope') == false", "0"],
  ])));

  test("bundled libraries (cjson, cmsgpack, struct, bit) and deterministic math.random", () => clean((s) => s.script([
    ["EVAL", "local t = cjson.decode('{\"a\":1,\"b\":\"x\",\"c\":null}'); return {t.a, t.b, t.c == cjson.null, cjson.encode({k='v'})}", "0"],
    ["EVAL", "local p = cmsgpack.pack({1, 'two', {three=3}}); local u = cmsgpack.unpack(p); return {u[1], u[2], u[3].three}", "0"],
    ["EVAL", "local b = struct.pack('>I4<hd c5', 42, -7, 2.5, 'hello'); local u1, u2, u3, u4 = struct.unpack('>I4<hd c5', b); return {u1, u2, tostring(u3), u4, struct.size('>I4<hd c5')}", "0"],
    ["EVAL", "return {bit.band(0xff0f, 0x0fff), bit.bor(1, 2, 4), bit.bxor(0xf0, 0x0f), bit.lshift(1, 8), bit.rshift(256, 4), bit.tohex(0xdeadbeef)}", "0"],
    ["EVAL", "math.randomseed(42); return {tostring(math.random()), math.random(100), math.random(10, 20), math.random(50)}", "0"],
    ["EVAL", "math.randomseed(0); return {math.random(1000000), math.random(1000000)}", "0"],
  ])));

  test("Redis Functions, FCALL/FCALL_RO, FUNCTION DUMP/RESTORE", () => clean(async (s) => {
    const libA = "#!lua name=liba\nredis.register_function('echo_pos', function(k, a) return {k[1], a[1]} end)\nredis.register_function({function_name='GetRo', description='read key', callback=function(k, a) return redis.call('GET', k[1]) end, flags={'no-writes'}})";
    const libAReplace = "#!lua name=liba\nredis.register_function('echo_pos', function(k, a) return a[1] end)";
    const libB = "#!lua name=libb\nredis.register_function('write_fn', function(k, a) redis.call('SET', k[1], a[1]); return 'done' end)";
    await s.script([
      ["FUNCTION", "STATS"], ["FUNCTION", "KILL"], ["FUNCTION", "HELP"],
      ["FUNCTION", "LOAD", "no shebang"], ["FUNCTION", "LOAD", "#!js name=x\n"], ["FUNCTION", "LOAD", "#!lua\n"],
      ["FUNCTION", "LOAD", "#!lua name=a name=b\n"], ["FUNCTION", "LOAD", "#!lua name=bad-name\n"],
      ["FUNCTION", "LOAD", "#!lua name=empty\nlocal x = 1"],
      ["FUNCTION", "LOAD", "#!lua name=badglob\nlocal s = string.upper('a')\nredis.register_function('f', function() return s end)"],
      ["FUNCTION", "LOAD", "#!lua name=badfn\nredis.register_function('bad-fn', function() end)"],
      ["FUNCTION", "LOAD", libA], ["FUNCTION", "LOAD", libA],
      ["SET", "fk", "fval"], ["FCALL", "echo_pos", "1", "fk", "arg1"], ["FCALL", "ECHO_POS", "1", "fk", "arg1"],
      ["FCALL", "getro", "1", "fk"], ["FCALL_RO", "getro", "1", "fk"], ["FCALL_RO", "echo_pos", "1", "fk", "arg1"],
      ["FCALL", "missing_fn", "0"], ["FCALL", "missing_fn", "badnum"], ["FCALL", "echo_pos", "badnum"], ["FCALL", "echo_pos", "-1"], ["FCALL", "echo_pos", "2", "k1"],
    ]);
    await s.unordered("FUNCTION", "LIST", "LIBRARYNAME", "lib*");
    await s.unordered("FUNCTION", "LIST", "LIBRARYNAME", "LIBA", "WITHCODE");
    await s.script([
      ["FUNCTION", "STATS"],
      ["FUNCTION", "LOAD", "REPLACE", libAReplace], ["FCALL", "echo_pos", "0", "replaced"], ["FCALL", "getro", "1", "fk"],
      ["FUNCTION", "LOAD", libB], ["FCALL", "write_fn", "1", "wk", "wv"], ["GET", "wk"],
      ["FUNCTION", "LOAD", "#!lua name=dup\nredis.register_function('write_fn', function() return 1 end)"],
      ["FUNCTION", "LOAD", "#!lua name=errlib\nredis.register_function('err_fn', function() error('boom') end)\nredis.register_function('reg_in_fcall', function() redis.register_function('inner', function() end) end)"],
      ["FCALL", "err_fn", "0"], ["FCALL", "reg_in_fcall", "0"],
      ["FLUSHALL"], ["FCALL", "echo_pos", "0", "survives_flushall"],
      ["FUNCTION", "DELETE", "LIBB"], ["FUNCTION", "DELETE", "libb"], ["FUNCTION", "DELETE", "errlib"], ["FUNCTION", "DELETE", "libb"],
      ["FUNCTION", "LIST"],
    ]);
    const dumpVal = decodeResp(await s.cmd("FUNCTION", "DUMP"));
    expect(dumpVal.kind).toBe("bulk");
    if (dumpVal.kind !== "bulk") return;
    const dumpPayload = dumpVal.value;
    await s.script([
      ["FUNCTION", "RESTORE", dumpPayload], ["FUNCTION", "RESTORE", dumpPayload, "REPLACE"],
      ["FUNCTION", "FLUSH", "SYNC"], ["FUNCTION", "STATS"],
      ["FUNCTION", "RESTORE", dumpPayload, "APPEND"], ["FCALL", "echo_pos", "0", "restored"],
      ["FUNCTION", "LOAD", "#!lua name=extra\nredis.register_function('extra_fn', function() return 77 end)"],
      ["FUNCTION", "RESTORE", dumpPayload, "FLUSH"], ["FCALL", "extra_fn", "0"], ["FCALL", "echo_pos", "0", "after_flush_restore"],
      ["FUNCTION", "RESTORE", "corrupt"], ["FUNCTION", "RESTORE", dumpPayload, "BADPOLICY"],
      ["FUNCTION", "FLUSH", "BAD"], ["FUNCTION", "FLUSH", "SYNC", "EXTRA"], ["FUNCTION", "RESTORE", dumpPayload, "APPEND", "EXTRA"],
      ["FUNCTION", "LIST", "LIBRARYNAME"], ["FUNCTION", "LIST", "BADARG"],
    ]);
  }));

  test("FUNCTION DUMP/RESTORE cross-compatibility between redis:8 and Duraredis", () => clean(async (s) => {
    const lib = "#!lua name=interop\nredis.register_function('mul', function(k, a) return tonumber(a[1]) * tonumber(a[2]) end)";
    await s.redis.cmd("FUNCTION", "LOAD", lib);
    const rDump = decodeResp(await s.redis.cmd("FUNCTION", "DUMP"));
    expect(rDump.kind).toBe("bulk");
    if (rDump.kind !== "bulk") return;
    expect(dec.decode(await s.dura.cmd("FUNCTION", "RESTORE", rDump.value))).toBe("+OK\r\n");
    expect(dec.decode(await s.dura.cmd("FCALL", "mul", "0", "6", "7"))).toBe(":42\r\n");
    await s.redis.cmd("FUNCTION", "FLUSH");
    const dDump = decodeResp(await s.dura.cmd("FUNCTION", "DUMP"));
    expect(dDump.kind).toBe("bulk");
    if (dDump.kind !== "bulk") return;
    expect(dec.decode(await s.redis.cmd("FUNCTION", "RESTORE", dDump.value))).toBe("+OK\r\n");
    expect(dec.decode(await s.redis.cmd("FCALL", "mul", "0", "8", "9"))).toBe(":72\r\n");
  }));
});

describe("Duraredis-specific scripting behavior", () => {
  test("redis.REDIS_VERSION reports 8.12.0", () => withDura("lua-ver", async (c) => {
    await c.cmd("HELLO", "3");
    const v = decodeResp(await c.cmd("EVAL", "return {redis.REDIS_VERSION, redis.REDIS_VERSION_NUM}", "0"));
    expect(v).toEqual({ kind: "array", items: [{ kind: "bulk", value: b("8.12.0") }, { kind: "int", value: 527_360n }] });
  }));

  test("scripts and functions persist across connections", async () => {
    const db = freshDb("lua-persist");
    let sha = "";
    const c1 = await WireClient.connect(serverHost(), serverPort());
    try {
      expect(dec.decode(await c1.cmd("AUTH", db, "x"))).toBe("+OK\r\n");
      const shaReply = decodeResp(await c1.cmd("SCRIPT", "LOAD", "return 'persisted:' .. ARGV[1]"));
      expect(shaReply.kind).toBe("bulk");
      if (shaReply.kind !== "bulk") return;
      sha = dec.decode(shaReply.value);
      expect(decodeResp(await c1.cmd("FUNCTION", "LOAD", "#!lua name=persist\nredis.register_function('hello', function(k, a) return 'hi ' .. a[1] end)")))
        .toEqual({ kind: "bulk", value: b("persist") });
    } finally {
      await c1.close();
    }
    const c2 = await WireClient.connect(serverHost(), serverPort());
    try {
      expect(dec.decode(await c2.cmd("AUTH", db, "x"))).toBe("+OK\r\n");
      expect(decodeResp(await c2.cmd("EVALSHA", sha, "0", "world"))).toEqual({ kind: "bulk", value: b("persisted:world") });
      expect(decodeResp(await c2.cmd("FCALL", "hello", "0", "ada"))).toEqual({ kind: "bulk", value: b("hi ada") });
    } finally {
      await c2.close();
    }
  });

  test("runaway script times out after 5s, rolls back writes, and cannot evade with pcall", () => withDura("lua-timeout", async (c) => {
    const t0 = Date.now();
    const err1 = decodeResp(await c.cmd("EVAL", "redis.call('SET', 'rolled_back', '1'); while true do end", "0"));
    const elapsed = Date.now() - t0;
    expect(err1.kind).toBe("error");
    expect(elapsed).toBeGreaterThanOrEqual(4500);
    expect(elapsed).toBeLessThan(12_000);
    expect(decodeResp(await c.cmd("GET", "rolled_back"))).toEqual({ kind: "null-bulk" });
    expect(decodeResp(await c.cmd("EVAL", "return 42", "0"))).toEqual({ kind: "int", value: 42n });
    expect(decodeResp(await c.cmd("EVAL", "while true do pcall(function() while true do end end) end", "0")).kind).toBe("error");
    expect(decodeResp(await c.cmd("EVAL", "return 'alive'", "0"))).toEqual({ kind: "bulk", value: b("alive") });
  }));
});
