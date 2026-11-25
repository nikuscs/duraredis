import { expect, test } from "bun:test";
import { describeDual } from "./dual";
import type { Pair } from "./dual";
import type { RespArg, RespValue } from "./wire";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string) => enc.encode(s);

function parseTimeSec(v: RespValue): number {
  expect(v.kind === "array" && v.items.length === 2).toBe(true);
  if (v.kind !== "array" || v.items.length !== 2) return 0;
  const [sv, uv] = v.items;
  expect(sv.kind === "bulk" && uv.kind === "bulk").toBe(true);
  if (sv.kind !== "bulk" || uv.kind !== "bulk") return 0;
  const [ss, us] = [dec.decode(sv.value), dec.decode(uv.value)];
  expect(ss).toMatch(/^\d+$/);
  expect(us).toMatch(/^\d+$/);
  expect(Number(us)).toBeLessThan(1_000_000);
  return Number(ss);
}

async function checkHrandfield(s: Pair, expected: Record<string, string>, count?: number, withValues = false) {
  const args: Array<RespArg> = ["HRANDFIELD", "hs", ...(count === undefined ? [] : [String(count)]), ...(withValues ? ["WITHVALUES"] : [])];
  const [rv, dv] = await s.shape(...args);
  if (count === undefined) {
    for (const v of [rv, dv]) expect(v.kind === "bulk" && dec.decode(v.value) in expected).toBe(true);
    return;
  }
  const need = count > 0 ? Math.min(count, Object.keys(expected).length) : -count;
  for (const v of [rv, dv]) {
    expect(v.kind).toBe("array");
    if (v.kind !== "array") continue;
    const pairs: Array<[string, string]> = [];
    if (!withValues) {
      for (const it of v.items) {
        expect(it.kind).toBe("bulk");
        if (it.kind === "bulk") pairs.push([dec.decode(it.value), ""]);
      }
    } else if (s.proto === 2) {
      expect(v.items.length % 2).toBe(0);
      for (let i = 0; i < v.items.length; i += 2) {
        const [f, val] = [v.items[i], v.items[i + 1]];
        if (f.kind === "bulk" && val.kind === "bulk") pairs.push([dec.decode(f.value), dec.decode(val.value)]);
      }
    } else {
      for (const it of v.items) {
        expect(it.kind === "array" && it.items.length === 2).toBe(true);
        if (it.kind === "array" && it.items.length === 2 && it.items[0].kind === "bulk" && it.items[1].kind === "bulk") {
          pairs.push([dec.decode(it.items[0].value), dec.decode(it.items[1].value)]);
        }
      }
    }
    expect(pairs.length).toBe(need);
    const seen = new Set<string>();
    for (const [f, val] of pairs) {
      expect(f in expected).toBe(true);
      if (withValues) expect(val).toBe(expected[f]);
      if (count > 0) {
        expect(seen.has(f)).toBe(false);
        seen.add(f);
      }
    }
  }
}

describeDual("differential vs redis:8", (run) => {
  test("connection, server, SELECT, TIME, CLIENT, RESET, QUIT", () => run(async (s) => {
    await s.script([
      ["PING"], ["ping", "hello"], ["PING", b("a\u0000b\r\nc")], ["PING", "one", "two"],
      ["ECHO", "hello world"], ["ECHO", b("\u0000\u00ff\u00fe")], ["ECHO"],
      ["SELECT", "0"], ["SELECT", "-1"], ["SELECT", "999"], ["SELECT", "notanint"], ["SELECT"],
      ["DBSIZE"], ["SET", "k1", "v1"], ["DBSIZE"], ["FLUSHDB"], ["DBSIZE"],
      ["SET", "k2", "v2"], ["FLUSHDB", "SYNC"], ["SET", "k3", "v3"], ["FLUSHDB", "ASYNC"],
      ["FLUSHALL", "SYNC"], ["FLUSHDB", "BOGUS"], ["DBSIZE"],
      ["CLIENT", "GETNAME"], ["CLIENT", "SETNAME", "worker-1"], ["CLIENT", "GETNAME"],
      ["CLIENT", "SETNAME", ""], ["CLIENT", "GETNAME"], ["CLIENT", "SETNAME", "bad name"],
      ["CLIENT", "SETINFO", "LIB-NAME", "duraredis-test"], ["CLIENT", "SETINFO", "LIB-VER", "1.0.0"],
      ["CLIENT", "SETINFO", "UNKNOWN", "1"], ["CLIENT", "SETINFO", "LIB-NAME", "bad name"],
      ["CLIENT", "NO-EVICT", "ON"], ["CLIENT", "NO-TOUCH", "ON"], ["CLIENT", "BOGUS"],
      ["FOOBAR", "arg1", "arg2"], ["FOOBAR"],
    ]);
    const [rId, dId] = await s.shape("CLIENT", "ID");
    expect(rId.kind === "int" && rId.value > 0n).toBe(true);
    expect(dId.kind === "int" && dId.value > 0n).toBe(true);
    const [rt, dt] = await s.shape("TIME");
    expect(Math.abs(parseTimeSec(rt) - parseTimeSec(dt))).toBeLessThanOrEqual(2);
    await s.script([["CLIENT", "SETNAME", "before-reset"], ["RESET"], ["GET", "missing"], ["CLIENT", "GETNAME"]]);
    await s.cmd("QUIT");
    await Promise.all([expect(s.redis.readReply(2000)).rejects.toThrow(), expect(s.dura.readReply(2000)).rejects.toThrow()]);
  }));

  test("strings: GET, SET and SET options", () => run(async (s) => {
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const futureMs = futureSec * 1000 + 250;
    await s.script([
      ["GET", "missing"], ["SET", "k", "v"], ["GET", "k"], ["SET", "", ""], ["GET", ""], ["SET", "k", "v2"], ["GET", "k"],
      ["SET", "k", "nope", "NX"], ["GET", "k"], ["SET", "nxkey", "created", "NX"], ["GET", "nxkey"],
      ["SET", "missing2", "nope", "XX"], ["GET", "missing2"], ["SET", "nxkey", "updated", "XX"], ["GET", "nxkey"],
      ["SET", "getkey", "first", "GET"], ["SET", "getkey", "second", "GET"],
      ["SET", "getkey", "ignored", "NX", "GET"], ["SET", "getmissing", "ignored", "XX", "GET"], ["SET", "getkey", "third", "XX", "GET"],
      ["HSET", "h1", "f", "1"], ["SET", "h1", "nope", "GET"], ["SET", "h1", "nope", "NX"], ["SET", "h1", "now-str"], ["GET", "h1"],
      ["SET", "exk", "1", "EX", "100"], ["SET", "pxk", "1", "PX", "100000"],
      ["SET", "exatk", "1", "EXAT", String(futureSec)], ["EXPIRETIME", "exatk"],
      ["SET", "pxatk", "1", "PXAT", String(futureMs)], ["PEXPIRETIME", "pxatk"],
      ["SET", "exk", "2", "KEEPTTL"], ["GET", "exk"],
    ]);
    await s.approx(2, "TTL", "exk");
    await s.approx(1500, "PTTL", "pxk");
    await s.script([
      ["SET", "exk", "3"], ["TTL", "exk"],
      ["SET", "errk", "1", "EX", "0"], ["SET", "errk", "1", "EX", "-5"], ["SET", "errk", "1", "PX", "0"],
      ["SET", "errk", "1", "EXAT", "0"], ["SET", "errk", "1", "PXAT", "-1"], ["SET", "errk", "1", "EX", "abc"],
      ["SET", "errk", "1", "NX", "XX"], ["SET", "errk", "1", "EX", "10", "PX", "10"], ["SET", "errk", "1", "EX", "10", "KEEPTTL"],
      ["SET", "errk", "1", "EX"], ["SET", "errk", "1", "BOGUS"], ["HSET", "h2", "f", "1"], ["GET", "h2"],
    ]);
  }));

  test("strings: SETNX, SETEX, PSETEX, GETSET, GETDEL, GETEX", () => run(async (s) => {
    const futureSec = Math.floor(Date.now() / 1000) + 2000;
    await s.script([
      ["SETNX", "k", "v1"], ["SETNX", "k", "v2"], ["GET", "k"], ["HSET", "h", "f", "1"], ["SETNX", "h", "v"],
      ["SETEX", "se", "60", "hello"], ["GET", "se"], ["SETEX", "se", "0", "bad"], ["SETEX", "se", "-1", "bad"],
      ["PSETEX", "pse", "60000", "world"], ["GET", "pse"], ["PSETEX", "pse", "0", "bad"],
      ["GETSET", "gs", "first"], ["GETSET", "gs", "second"], ["GETSET", "h", "v"],
      ["GETDEL", "missing"], ["GETDEL", "gs"], ["GET", "gs"], ["GETDEL", "h"],
      ["GETEX", "missing"], ["SET", "gx", "val"], ["GETEX", "gx"], ["TTL", "gx"],
      ["GETEX", "gx", "EX", "120"], ["GETEX", "gx", "PERSIST"], ["TTL", "gx"],
      ["GETEX", "gx", "EXAT", String(futureSec)], ["EXPIRETIME", "gx"],
      ["GETEX", "gx", "EX", "0"], ["GETEX", "gx", "EX", "10", "PERSIST"], ["GETEX", "gx", "BOGUS"], ["GETEX", "h"],
    ]);
    await s.approx(2, "TTL", "se");
    await s.approx(1500, "PTTL", "pse");
  }));

  test("strings: MGET, MSET, MSETNX, APPEND, STRLEN", () => run((s) => s.script([
    ["HSET", "h", "f", "1"], ["MSET", "a", "1", "b", "2", "a", "3"], ["MGET", "a", "b", "missing", "h"],
    ["MSET", "odd"], ["MSET", "x", "1", "y"], ["MSETNX", "m1", "1", "m2", "2"], ["MSETNX", "m2", "20", "m3", "30"],
    ["MGET", "m1", "m2", "m3"], ["MSETNX", "h", "x", "m4", "4"], ["MGET", "m4"],
    ["APPEND", "app", "hello"], ["APPEND", "app", " world"], ["APPEND", "app", ""], ["GET", "app"],
    ["STRLEN", "app"], ["STRLEN", "missing"], ["STRLEN", "h"], ["APPEND", "h", "x"],
  ])));

  test("strings: INCR, DECR, INCRBY, DECRBY, INCRBYFLOAT", () => run(async (s) => {
    await s.script([
      ["INCR", "c"], ["INCR", "c"], ["DECR", "c"], ["INCRBY", "c", "10"], ["DECRBY", "c", "3"],
      ["INCRBY", "c", "-2"], ["DECRBY", "c", "-5"], ["GET", "c"],
      ["SET", "str", "not-an-int"], ["INCR", "str"], ["SET", "space", " 10"], ["INCR", "space"],
      ["SET", "plus", "+10"], ["INCR", "plus"], ["SET", "empty", ""], ["INCR", "empty"],
      ["SET", "max", "9223372036854775807"], ["INCR", "max"], ["DECR", "max"],
      ["SET", "min", "-9223372036854775808"], ["DECR", "min"],
      ["DECRBY", "c", "-9223372036854775808"], ["INCRBY", "c", "9223372036854775808"],
      ["SET", "c_ttl", "5", "EX", "100"], ["INCR", "c_ttl"],
      ["INCRBYFLOAT", "f", "10.5"], ["INCRBYFLOAT", "f", "0.1"], ["INCRBYFLOAT", "f", "-0.6"],
      ["INCRBYFLOAT", "f", "5.0e3"], ["INCRBYFLOAT", "f", "-5010"],
      ["SET", "f2", "0"], ["INCRBYFLOAT", "f2", "-0"],
      ["INCRBYFLOAT", "f", "nan"], ["INCRBYFLOAT", "f", "inf"], ["INCRBYFLOAT", "f", "-inf"], ["INCRBYFLOAT", "str", "1.5"],
      ["HSET", "h", "a", "1"], ["INCR", "h"], ["DECR", "h"], ["INCRBY", "h", "1"], ["DECRBY", "h", "1"], ["INCRBYFLOAT", "h", "1.0"],
    ]);
    await s.approx(2, "TTL", "c_ttl");
  }));

  test("strings: GETRANGE, SUBSTR, SETRANGE", () => run((s) => s.script([
    ["GETRANGE", "missing", "0", "10"], ["SET", "s", "Hello, World!"],
    ["GETRANGE", "s", "0", "4"], ["GETRANGE", "s", "-6", "-1"], ["GETRANGE", "s", "7", "100"],
    ["GETRANGE", "s", "-100", "2"], ["GETRANGE", "s", "5", "2"], ["GETRANGE", "s", "-1", "-5"], ["SUBSTR", "s", "0", "4"],
    ["SETRANGE", "s", "7", "Redis"], ["GET", "s"], ["SETRANGE", "pad", "5", "hi"], ["GET", "pad"],
    ["SETRANGE", "empty_create", "5", ""], ["EXISTS", "empty_create"],
    ["SETRANGE", "s", "-1", "x"], ["SETRANGE", "s", "bad", "x"],
    ["HSET", "h", "f", "1"], ["GETRANGE", "h", "0", "1"], ["SETRANGE", "h", "0", "x"],
  ])));

  test("keys: DEL, UNLINK, EXISTS, TOUCH, TYPE, RENAME, RENAMENX, COPY", () => run(async (s) => {
    await s.script([
      ["SET", "a", "1"], ["SET", "b", "2"], ["HSET", "h", "f1", "v1", "f2", "v2"],
      ["TYPE", "a"], ["TYPE", "h"], ["TYPE", "missing"],
      ["EXISTS", "a", "b", "a", "missing"], ["TOUCH", "a", "h", "missing", "a"],
      ["DEL", "a", "a", "missing"], ["EXISTS", "a"], ["UNLINK", "b", "missing"], ["EXISTS", "b"],
      ["RENAME", "missing", "x"], ["RENAMENX", "missing", "x"],
      ["SET", "src", "val", "EX", "100"], ["RENAME", "src", "src"], ["RENAMENX", "src", "src"],
      ["SET", "dst", "old"], ["RENAMENX", "src", "dst"], ["RENAME", "src", "dst"], ["GET", "src"], ["GET", "dst"],
      ["RENAMENX", "dst", "dst2"], ["GET", "dst2"],
      ["RENAME", "h", "h2"], ["HGETALL", "h2"], ["TYPE", "h"],
      ["COPY", "missing", "c1"], ["COPY", "dst2", "dst2"], ["COPY", "dst2", "c1"], ["GET", "c1"], ["COPY", "dst2", "c1"],
      ["SET", "newsrc", "fresh"], ["COPY", "newsrc", "c1", "REPLACE"], ["GET", "c1"],
      ["COPY", "h2", "hcopy"], ["HGETALL", "hcopy"],
      ["COPY", "newsrc", "c2", "DB", "0"], ["COPY", "newsrc", "c3", "DB", "999"], ["COPY", "newsrc", "c3", "BOGUS"],
    ]);
    await s.approx(2, "TTL", "dst2");
    await s.approx(2, "TTL", "c1");
  }));

  test("keys: KEYS, SCAN, RANDOMKEY", () => run(async (s) => {
    await s.cmd("RANDOMKEY");
    await s.unordered("KEYS", "*");
    await s.scan(["SCAN"]);
    const keys = new Set(["hello", "hallo", "hxllo", "hllo", "heeeeello", "h*llo", "myhash"]);
    await s.script([
      ["MSET", "hello", "1", "hallo", "2", "hxllo", "3", "hllo", "4", "heeeeello", "5"],
      ["SET", "h*llo", "6"],
      ["HSET", "myhash", "f", "1"],
    ]);
    for (const pat of ["*", "h?llo", "h*llo", "h[ae]llo", "h[^e]llo", "h[a-b]llo", String.raw`h\*llo`]) {
      await s.unordered("KEYS", pat);
    }
    for (const extra of [[], ["COUNT", "2"], ["MATCH", "h?llo", "COUNT", "3"], ["TYPE", "string"], ["TYPE", "hash"], ["TYPE", "list"]]) {
      await s.scan(["SCAN"], extra);
    }
    const [rk, dk] = await s.shape("RANDOMKEY");
    for (const v of [rk, dk]) expect(v.kind === "bulk" && keys.has(dec.decode(v.value))).toBe(true);
    await s.script([
      ["SCAN", "-1"], ["SCAN", "abc"], ["SCAN", "0", "COUNT", "0"], ["SCAN", "0", "COUNT", "-5"], ["SCAN", "0", "MATCH"], ["SCAN", "0", "BOGUS", "1"],
    ]);
  }));

  test("keys: expiry, NX/XX/GT/LT, <= 0 deletes, and real expiration", () => run(async (s) => {
    const f1 = Math.floor(Date.now() / 1000) + 500;
    const f2 = f1 + 500;
    const f0 = f1 - 300;
    await s.script([
      ["TTL", "missing"], ["PTTL", "missing"], ["EXPIRETIME", "missing"], ["PEXPIRETIME", "missing"], ["PERSIST", "missing"], ["EXPIRE", "missing", "10"],
      ["SET", "k", "v"], ["TTL", "k"], ["PTTL", "k"], ["EXPIRETIME", "k"], ["PEXPIRETIME", "k"], ["PERSIST", "k"],
      ["EXPIRE", "k", "100", "XX"], ["EXPIRE", "k", "100", "GT"], ["EXPIRE", "k", "100", "NX"], ["EXPIRE", "k", "200", "NX"],
      ["EXPIREAT", "k", String(f1), "XX"], ["EXPIRETIME", "k"],
      ["EXPIREAT", "k", String(f0), "GT"], ["EXPIRETIME", "k"],
      ["EXPIREAT", "k", String(f2), "GT"], ["EXPIRETIME", "k"],
      ["EXPIREAT", "k", String(f2), "LT"], ["EXPIREAT", "k", String(f1), "LT"], ["EXPIRETIME", "k"],
      ["SET", "p", "1"], ["EXPIREAT", "p", String(f1), "LT"], ["EXPIRETIME", "p"], ["PERSIST", "p"], ["TTL", "p"],
      ["PEXPIREAT", "p", String(f1 * 1000 + 345)], ["PEXPIRETIME", "p"],
      ["SET", "d1", "1"], ["EXPIRE", "d1", "0"], ["EXISTS", "d1"],
      ["SET", "d2", "1"], ["EXPIRE", "d2", "-5"], ["EXISTS", "d2"],
      ["SET", "d3", "1"], ["PEXPIRE", "d3", "0"], ["EXISTS", "d3"],
      ["SET", "d4", "1"], ["PEXPIRE", "d4", "-10"], ["EXISTS", "d4"],
      ["SET", "d5", "1"], ["EXPIREAT", "d5", "0"], ["EXISTS", "d5"],
      ["SET", "d6", "1"], ["PEXPIREAT", "d6", "1000"], ["EXISTS", "d6"],
      ["SET", "d7", "1"], ["EXPIRE", "d7", "0", "LT"], ["EXISTS", "d7"],
      ["EXPIRE", "p", "10", "NX", "XX"], ["EXPIRE", "p", "10", "NX", "GT"], ["EXPIRE", "p", "10", "NX", "LT"],
      ["EXPIRE", "p", "10", "GT", "LT"], ["EXPIRE", "p", "10", "BOGUS"], ["EXPIRE", "p", "notint"],
    ]);
    await s.approx(2, "TTL", "k");
    await s.approx(1500, "PTTL", "p");
    await s.script([["SET", "ephem", "bye"], ["PEXPIRE", "ephem", "120"]]);
    await Bun.sleep(320);
    await s.script([["GET", "ephem"], ["EXISTS", "ephem"], ["TTL", "ephem"], ["PTTL", "ephem"], ["TYPE", "ephem"]]);
  }));

  test("hashes: core CRUD and empty hash deletion", () => run((s) => s.script([
    ["HGET", "missing", "f"], ["HMGET", "missing", "f1", "f2"], ["HEXISTS", "missing", "f"], ["HLEN", "missing"],
    ["HSTRLEN", "missing", "f"], ["HKEYS", "missing"], ["HVALS", "missing"], ["HGETALL", "missing"], ["HDEL", "missing", "f"],
    ["HSET", "h", "f1", "v1", "f2", "v2"], ["HSET", "h", "f2", "v2b", "f3", "v3"], ["HSET", "h", "f4", "a", "f4", "b"],
    ["HMSET", "h", "f5", "v5", "f6", "v6"], ["HSETNX", "h", "f1", "ignored"], ["HSETNX", "h", "f7", "v7"],
    ["HGET", "h", "f4"], ["HGET", "h", "nope"], ["HMGET", "h", "f1", "nope", "f7"], ["HEXISTS", "h", "f1"], ["HEXISTS", "h", "nope"],
    ["HLEN", "h"], ["HSTRLEN", "h", "f2"], ["HSTRLEN", "h", "nope"], ["HKEYS", "h"], ["HVALS", "h"], ["HGETALL", "h"],
    ["HDEL", "h", "f1", "f1", "nope", "f2"], ["HLEN", "h"], ["HDEL", "h", "f3", "f4", "f5", "f6", "f7"], ["EXISTS", "h"], ["TYPE", "h"],
    ["HSET", "h_bad", "f"], ["HMSET", "h_bad", "f1", "v1", "f2"], ["SET", "strkey", "abc"],
    ["HSET", "strkey", "f", "1"], ["HGET", "strkey", "f"], ["HMGET", "strkey", "f"], ["HDEL", "strkey", "f"], ["HLEN", "strkey"], ["HGETALL", "strkey"],
  ])));

  test("hashes: HINCRBY, HINCRBYFLOAT, HSCAN, HRANDFIELD", () => run(async (s) => {
    await s.script([
      ["HINCRBY", "hn", "cnt", "5"], ["HINCRBY", "hn", "cnt", "-2"], ["HGET", "hn", "cnt"],
      ["HSET", "hn", "bad", "abc", "max", "9223372036854775807"], ["HINCRBY", "hn", "bad", "1"], ["HINCRBY", "hn", "max", "1"],
      ["HINCRBYFLOAT", "hn", "flt", "1.5"], ["HINCRBYFLOAT", "hn", "flt", "2.25"], ["HINCRBYFLOAT", "hn", "bad", "1.0"],
      ["HINCRBYFLOAT", "hn", "flt", "nan"], ["HINCRBYFLOAT", "hn", "flt", "inf"],
      ["SET", "strk", "x"], ["HINCRBY", "strk", "f", "1"], ["HINCRBYFLOAT", "strk", "f", "1"],
      ["HSCAN", "missing", "0"], ["HSCAN", "strk", "0"], ["HSCAN", "hn", "-1"],
      ["HSCAN", "hn", "0", "COUNT", "0"], ["HSCAN", "hn", "0", "MATCH"], ["HSCAN", "hn", "0", "BOGUS", "1"],
      ["HSET", "hs", "a1", "v1", "a2", "v2", "b1", "v3", "b2", "v4"],
    ]);
    await s.scan(["HSCAN", "hs"], [], true);
    await s.scan(["HSCAN", "hs"], ["COUNT", "2"], true);
    await s.scan(["HSCAN", "hs"], ["MATCH", "a*", "COUNT", "2"], true);
    await s.scan(["HSCAN", "hs"], ["NOVALUES"], false);
    const expected = { a1: "v1", a2: "v2", b1: "v3", b2: "v4" };
    await s.script([
      ["HRANDFIELD", "missing"], ["HRANDFIELD", "missing", "2"], ["HRANDFIELD", "hs", "0"],
      ["HRANDFIELD", "hs", "2", "BOGUS"], ["HRANDFIELD", "hs", "2", "WITHVALUES", "EXTRA"], ["HRANDFIELD", "strk"],
    ]);
    await checkHrandfield(s, expected);
    for (const c of [2, 10, -5]) await checkHrandfield(s, expected, c);
    for (const c of [2, -5]) await checkHrandfield(s, expected, c, true);
  }));

  test("transactions: MULTI, EXEC, DISCARD, EXECABORT, runtime errors", () => run((s) => s.script([
    ["EXEC"], ["EXEC", "extra"], ["DISCARD"], ["MULTI"], ["EXEC"],
    ["MULTI"], ["SET", "tx1", "10"], ["INCR", "tx1"], ["HSET", "txh", "f", "v"], ["HGETALL", "txh"], ["EXEC"], ["GET", "tx1"],
    ["MULTI"], ["MULTI"], ["WATCH", "tx1"], ["DISCARD"],
    ["MULTI"], ["SET", "tx1", "999"], ["DISCARD"], ["GET", "tx1"],
    ["MULTI"], ["SET", "abort1", "yes"], ["NOTACOMMAND", "arg"], ["EXEC"], ["EXISTS", "abort1"],
    ["MULTI"], ["SET", "abort2", "yes"], ["GET"], ["EXEC"], ["EXISTS", "abort2"],
    ["SET", "nonint", "abc"], ["HSET", "myh", "f", "1"],
    ["MULTI"], ["SET", "ok1", "before"], ["INCR", "nonint"], ["GET", "myh"], ["SET", "badopt", "1", "EX", "0"], ["SET", "ok2", "after"], ["EXEC"],
    ["MGET", "ok1", "ok2", "badopt"],
  ])));

  test("transactions: WATCH and UNWATCH", () => run(async (s) => {
    const peer = await s.peer();
    await s.script([["SET", "w1", "init"], ["WATCH", "w1"], ["MULTI"], ["SET", "w1", "updated"], ["EXEC"], ["GET", "w1"]]);
    await s.cmd("WATCH", "w1");
    await peer.cmd("SET", "w1", "peer-wrote");
    await s.script([["MULTI"], ["SET", "w1", "tx-should-abort"], ["EXEC"], ["GET", "w1"]]);
    await s.script([["WATCH", "w1"], ["SET", "w1", "self-wrote"], ["MULTI"], ["SET", "w1", "tx-should-abort-2"], ["EXEC"], ["GET", "w1"]]);
    await s.cmd("WATCH", "w_missing");
    await peer.cmd("SET", "w_missing", "appeared");
    await s.script([["MULTI"], ["SET", "w_missing", "tx-abort"], ["EXEC"], ["GET", "w_missing"]]);
    await s.script([["WATCH", "w1"], ["UNWATCH"]]);
    await peer.cmd("SET", "w1", "peer-2");
    await s.script([["MULTI"], ["SET", "w1", "committed-after-unwatch"], ["EXEC"], ["GET", "w1"]]);
    for (const [watchKey, peerCmd, outKey] of [
      ["w1", ["DEL", "w1"], "after_del"],
      ["wh", ["HSET", "wh", "f", "1"], "after_hset"],
      ["wh", ["FLUSHDB"], "after_flush"],
    ] as const) {
      await s.cmd("WATCH", watchKey);
      await peer.cmd(...peerCmd);
      await s.script([["MULTI"], ["SET", outKey, "1"], ["EXEC"], ["EXISTS", outKey]]);
    }
    await s.script([["SET", "w_exp", "soon"], ["PEXPIRE", "w_exp", "120"], ["WATCH", "w_exp"]]);
    await Bun.sleep(320);
    await s.script([["MULTI"], ["SET", "w_exp_out", "1"], ["EXEC"], ["EXISTS", "w_exp_out"]]);
  }));

  test("pipelining: mixed commands and pipelined MULTI/EXEC", () => run((s) => s.pipeline([
    ["PING"], ["SET", "p1", "10"], ["INCR", "p1"], ["INCRBY", "p1", "5"], ["GET", "p1"],
    ["SET", "p2", "hello"], ["APPEND", "p2", "!"], ["GET", "p2"],
    ["HSET", "ph", "a", "1", "b", "2"], ["HGETALL", "ph"], ["HINCRBY", "ph", "a", "9"], ["HGET", "ph", "a"],
    ["GET", "ph"], ["INCR", "p2"], ["MGET", "p1", "p2", "missing"], ["EXISTS", "p1", "ph"], ["DEL", "p1"], ["GET", "p1"],
    ["DBSIZE"], ["PING", "done"], ["MULTI"], ["SET", "ptx", "1"], ["INCR", "ptx"], ["GET", "ptx"], ["EXEC"],
  ])));

  test("inline commands: single, quoted, whitespace, blank lines, pipelined, error", () => run(async (s) => {
    for (const line of [
      "PING", "PING inline-arg", "SET ik1 ival1", "GET ik1", String.raw`SET "ik 2" "hello\nworld\t!"`,
      'GET "ik 2"', "SET 'ik 3' 'single quoted'", "GET 'ik 3'", "   ECHO   spaced   ", "HSET ih f1 v1 f2 v2", "HGETALL ih",
    ]) {
      await s.inline(line);
    }
    await s.rawPipeline(b("\r\n\r\nPING\r\nSET ip 42\r\nINCR ip\r\nGET ip\r\n"), 4);
    await s.inline('SET bad "unclosed');
  }));

  test("binary-safe keys, fields, and values (NUL, CRLF, invalid UTF-8, 0x00..0xff)", () => run((s) => {
    const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const badUtf8 = new Uint8Array([0x80, 0xff, 0xfe, 0xc0, 0xaf, 0x00, 0x0d, 0x0a, 0xed, 0xa0, 0x80]);
    const nulKey = new Uint8Array([0x6b, 0x00, 0x65, 0x00, 0x79]);
    const nulKey2 = new Uint8Array([0x6b, 0x00, 0x65, 0x00, 0x7a]);
    return s.script([
      ["ECHO", allBytes], ["PING", badUtf8], ["SET", nulKey, allBytes], ["GET", nulKey], ["STRLEN", nulKey],
      ["GETRANGE", nulKey, "0", "31"], ["SETRANGE", nulKey, "10", badUtf8], ["GET", nulKey],
      ["APPEND", nulKey, badUtf8], ["GET", nulKey], ["MSET", nulKey2, badUtf8], ["MGET", nulKey, nulKey2],
      ["EXISTS", nulKey, nulKey2], ["RENAME", nulKey, badUtf8], ["GET", badUtf8], ["COPY", badUtf8, nulKey], ["GET", nulKey],
      ["HSET", nulKey2, allBytes, badUtf8, badUtf8, allBytes], ["HGET", nulKey2, allBytes], ["HGET", nulKey2, badUtf8],
      ["HMGET", nulKey2, allBytes, badUtf8, nulKey], ["HSTRLEN", nulKey2, allBytes], ["HGETALL", nulKey2],
      ["HDEL", nulKey2, allBytes], ["HLEN", nulKey2], ["DEL", nulKey, badUtf8], ["EXISTS", nulKey, badUtf8],
    ]);
  }));

  test("exact error texts across commands", () => run((s) => s.script([
    ["GET"], ["GET", "a", "b"], ["SET"], ["SET", "a"], ["DEL"], ["EXISTS"], ["TYPE"], ["KEYS"], ["SCAN"],
    ["RANDOMKEY", "extra"], ["RENAME", "a"], ["COPY", "a"], ["EXPIRE", "a"], ["TTL"],
    ["HSET", "h"], ["HSET", "h", "f"], ["HGET", "h"], ["HMGET", "h"], ["HDEL", "h"], ["HLEN"], ["HKEYS"], ["HVALS"], ["HGETALL"],
    ["HINCRBY", "h", "f"], ["HINCRBYFLOAT", "h", "f"], ["HSCAN", "h"], ["HRANDFIELD"],
    ["MULTI", "extra"], ["DISCARD", "extra"], ["WATCH"], ["UNWATCH", "extra"], ["RESET", "extra"], ["DBSIZE", "extra"], ["TIME", "extra"],
    ["SET", "s", "v"], ["GETRANGE", "s", "0"], ["SETRANGE", "s", "-5", "a"], ["SETRANGE", "s", "0", "a", "b"],
    ["INCRBY", "s", "abc"], ["DECRBY", "s", "abc"], ["INCRBYFLOAT", "s", "abc"],
    ["RENAME", "no_such_key", "other"], ["RENAMENX", "no_such_key", "other"],
  ])));
});
