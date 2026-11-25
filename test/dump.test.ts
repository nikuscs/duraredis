import { expect, test } from "bun:test";
import { crc64, RDB_DUMP_VERSION, RdbWriter } from "../src/store/rdb/codec";
import { encodeListpack } from "../src/store/rdb/listpack";
import { describeDual } from "./dual";
import type { Pair } from "./dual";
import { decodeResp } from "./wire";
import type { RespArg, RespValue } from "./wire";

const dec = new TextDecoder();

function bulkBytes(raw: Uint8Array): Uint8Array {
  const val = decodeResp(raw);
  expect(val.kind).toBe("bulk");
  if (val.kind !== "bulk") throw new Error(`Expected bulk reply, got ${val.kind}`);
  return val.value;
}

function wrapPayload(body: Array<number>, version = RDB_DUMP_VERSION): Uint8Array {
  const out = [...body, version & 0xff, (version >> 8) & 0xff];
  let sum = crc64(Uint8Array.from(out));
  for (let i = 0; i < 8; i++) {
    out.push(Number(sum & 0xffn));
    sum >>= 8n;
  }
  return Uint8Array.from(out);
}

function encodeZiplist(items: Array<{ type: "str"; data: Uint8Array } | { type: "int"; value: bigint }>): Uint8Array {
  const w = new RdbWriter();
  w.u32le(0);
  w.u32le(0);
  w.u16le(items.length >= 65_535 ? 65_535 : items.length);
  let prevLen = 0;
  let lastOffset = 10;
  for (const item of items) {
    lastOffset = w.length;
    if (prevLen < 254) {
      w.u8(prevLen);
    } else {
      w.u8(0xfe);
      w.u32le(prevLen);
    }
    const start = w.length - (prevLen < 254 ? 1 : 5);
    if (item.type === "str") {
      const b = item.data;
      if (b.length <= 63) {
        w.u8(b.length);
      } else if (b.length <= 16_383) {
        w.u8(0x40 | (b.length >> 8));
        w.u8(b.length & 0xff);
      } else {
        w.u8(0x80);
        w.u32be(b.length);
      }
      w.raw(b);
    } else {
      const v = item.value;
      if (v >= 0n && v <= 12n) {
        w.u8(0xf1 + Number(v));
      } else if (v >= -128n && v <= 127n) {
        w.u8(0xfe);
        w.u8(Number(v) & 0xff);
      } else if (v >= -32_768n && v <= 32_767n) {
        w.u8(0xc0);
        w.i16le(Number(v));
      } else if (v >= -8_388_608n && v <= 8_388_607n) {
        const u = Number(v < 0n ? v + 16_777_216n : v);
        w.u8(0xf0);
        w.u8(u & 0xff);
        w.u8((u >> 8) & 0xff);
        w.u8((u >> 16) & 0xff);
      } else if (v >= -2_147_483_648n && v <= 2_147_483_647n) {
        w.u8(0xd0);
        w.i32le(Number(v));
      } else {
        w.u8(0xe0);
        w.i64le(v);
      }
    }
    prevLen = w.length - start;
  }
  w.u8(0xff);
  const out = w.bytes();
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, true);
  view.setUint32(4, lastOffset, true);
  return out;
}

function encodeLegacylistPayload(items: Array<string>): Uint8Array {
  const w = new RdbWriter();
  w.u8(1);
  w.len(items.length);
  for (const item of items) w.rawString(new TextEncoder().encode(item), true);
  return w.finishDump();
}

function encodeLegacyZsetPayload(entries: Array<[string, string | number]>): Uint8Array {
  const w = new RdbWriter();
  w.u8(3);
  w.len(entries.length);
  for (const [member, score] of entries) {
    w.rawString(new TextEncoder().encode(member), true);
    if (score === -Infinity) {
      w.u8(255);
    } else if (score === Infinity) {
      w.u8(254);
    } else {
      const b = new TextEncoder().encode(String(score));
      w.u8(b.length);
      w.raw(b);
    }
  }
  return w.finishDump();
}

function encodeLegacyHashPreGaPayload(hasMinExpire: boolean, items: Array<[string, string, number]>): Uint8Array {
  const w = new RdbWriter();
  w.u8(hasMinExpire ? 24 : 22);
  if (hasMinExpire) w.i64le(2_000_000_000_000n);
  w.len(items.length);
  for (const [f, v, exp] of items) {
    w.len(exp);
    w.rawString(new TextEncoder().encode(f), true);
    w.rawString(new TextEncoder().encode(v), true);
  }
  return w.finishDump();
}

function encodeLegacyStreamPayload(version: 15 | 19 | 21): Uint8Array {
  const w = new RdbWriter();
  w.u8(version);
  w.len(1);
  const idBuf = new Uint8Array(16);
  const idView = new DataView(idBuf.buffer);
  idView.setBigUint64(0, 1000n, false);
  idView.setBigUint64(8, 0n, false);
  w.blobString(idBuf);
  w.blobString(encodeListpack([
    1n,
    0n,
    1n,
    new TextEncoder().encode("f"),
    0n,
    2n,
    0n,
    0n,
    new TextEncoder().encode("v"),
    4n,
  ]));
  w.len(1);
  w.len(1000);
  w.len(0);
  if (version >= 19) {
    w.len(1000);
    w.len(0);
    w.len(0);
    w.len(0);
    w.len(1);
  }
  w.len(1);
  w.rawString(new TextEncoder().encode("g1"));
  w.len(1000);
  w.len(0);
  if (version >= 19) w.len(1);
  w.len(1);
  w.u64be(1000n);
  w.u64be(0n);
  w.i64le(1_700_000_000_000n);
  w.len(2);
  w.len(1);
  w.rawString(new TextEncoder().encode("c1"));
  w.i64le(1_700_000_000_000n);
  if (version >= 21) w.i64le(-1n);
  w.len(1);
  w.u64be(1000n);
  w.u64be(0n);
  return w.finishDump();
}

async function expectCrossRestore(
  s: Pair,
  key: string,
  setup: Array<Array<RespArg>>,
  orderedChecks: Array<(target: string) => Array<RespArg>>,
  unorderedChecks: Array<(target: string) => Array<RespArg>> = [],
) {
  await s.script(setup);
  const rDump = bulkBytes(await s.redis.cmd("DUMP", key));
  const dDump = bulkBytes(await s.dura.cmd("DUMP", key));
  const r2d = `${key}_r2d`;
  const d2r = `${key}_d2r`;
  expect(dec.decode(await s.dura.cmd("RESTORE", r2d, "0", rDump))).toBe("+OK\r\n");
  expect(dec.decode(await s.redis.cmd("RESTORE", d2r, "0", dDump))).toBe("+OK\r\n");

  for (const mkCmd of orderedChecks) {
    const orig = await s.redis.cmd(...mkCmd(key));
    const fromR = await s.dura.cmd(...mkCmd(r2d));
    const fromD = await s.redis.cmd(...mkCmd(d2r));
    expect(fromR).toEqual(orig);
    expect(fromD).toEqual(orig);
  }

  const canonical = (v: RespValue): string => {
    if (v.kind === "map") return `map{${v.entries.map(([k, x]) => `${canonical(k)}=${canonical(x)}`).toSorted().join(",")}}`;
    if (v.kind !== "array" && v.kind !== "set" && v.kind !== "push") return `${v.kind}:${"value" in v ? String(v.value instanceof Uint8Array ? [...v.value] : v.value) : ""}`;
    return `${v.kind}[${v.items.map(canonical).toSorted().join(",")}]`;
  };
  for (const mkCmd of unorderedChecks) {
    const orig = canonical(decodeResp(await s.redis.cmd(...mkCmd(key))));
    const fromR = canonical(decodeResp(await s.dura.cmd(...mkCmd(r2d))));
    const fromD = canonical(decodeResp(await s.redis.cmd(...mkCmd(d2r))));
    expect(fromR).toBe(orig);
    expect(fromD).toBe(orig);
  }
}

describeDual("DUMP and RESTORE vs redis:8", (run) => {
  test("byte-for-byte DUMP parity for strings, lists, sets, zsets, hashes, and streams", () => run(async (s) => {
    const binary = new Uint8Array([0, 1, 2, 13, 10, 255, 128, 65]);
    await s.script([
      ["SET", "s_empty", ""], ["DUMP", "s_empty"],
      ["SET", "s_short", "hello"], ["DUMP", "s_short"],
      ["SET", "s_bin", binary], ["DUMP", "s_bin"],
      ["SET", "s_i0", "0"], ["DUMP", "s_i0"],
      ["SET", "s_im1", "-1"], ["DUMP", "s_im1"],
      ["SET", "s_i127", "127"], ["DUMP", "s_i127"],
      ["SET", "s_im128", "-128"], ["DUMP", "s_im128"],
      ["SET", "s_i128", "128"], ["DUMP", "s_i128"],
      ["SET", "s_i32767", "32767"], ["DUMP", "s_i32767"],
      ["SET", "s_im32768", "-32768"], ["DUMP", "s_im32768"],
      ["SET", "s_i32768", "32768"], ["DUMP", "s_i32768"],
      ["SET", "s_i32max", "2147483647"], ["DUMP", "s_i32max"],
      ["SET", "s_i32min", "-2147483648"], ["DUMP", "s_i32min"],
      ["SET", "s_i32over", "2147483648"], ["DUMP", "s_i32over"],
      ["SET", "s_i64max", "9223372036854775807"], ["DUMP", "s_i64max"],
      ["SET", "s_i64min", "-9223372036854775808"], ["DUMP", "s_i64min"],
      ["SET", "s_00", "00"], ["DUMP", "s_00"],
      ["SET", "s_neg0", "-0"], ["DUMP", "s_neg0"],
      ["SET", "s_space", " 5"], ["DUMP", "s_space"],
      ["SET", "s_20", "a".repeat(20)], ["DUMP", "s_20"],
      ["SET", "s_21", "a".repeat(21)], ["DUMP", "s_21"],
      ["SET", "s_22", "a".repeat(22)], ["DUMP", "s_22"],
      ["SET", "s_23", "a".repeat(23)], ["DUMP", "s_23"],
      ["SET", "s_40", "a".repeat(40)], ["DUMP", "s_40"],
      ["SET", "s_incomp", "abcdefghijklmnopqrstu"], ["DUMP", "s_incomp"],
      ["SET", "s_rep", "redis-duraredis-".repeat(60)], ["DUMP", "s_rep"],

      ["RPUSH", "l_edges", "0", "127", "128", "-1", "-4096", "4095", "4096", "-4097", "32767", "-32768", "32768", "-32769",
        "8388607", "-8388608", "8388608", "2147483647", "-2147483648", "2147483648", "9223372036854775807", "-9223372036854775808",
        "", "a".repeat(63), "a".repeat(64), "b".repeat(126), "c".repeat(127), "d".repeat(4095), "e".repeat(4096)],
      ["DUMP", "l_edges"],
      ["RPUSH", "l_8192", "x".repeat(8192)], ["DUMP", "l_8192"],
      ["RPUSH", "l_8193", "x".repeat(8193)], ["DUMP", "l_8193"],
      ["RPUSH", "l_plain", "x".repeat(9000), "y"], ["DUMP", "l_plain"],
      ["RPUSH", "l_many", ...Array.from({ length: 200 }, (_, i) => `item_${i}_${"z".repeat(40)}`)], ["DUMP", "l_many"],

      ["SADD", "set_i16", "3", "1", "-2", "32767", "-32768"], ["DUMP", "set_i16"],
      ["SADD", "set_i32", "1", "100000"], ["DUMP", "set_i32"],
      ["SADD", "set_i64", "1", "9223372036854775807"], ["DUMP", "set_i64"],
      ["SADD", "set_i_lzf", ...Array.from({ length: 30 }, (_, i) => String(i))], ["DUMP", "set_i_lzf"],
      ["SADD", "set_lp", "hello", "1", "world"], ["DUMP", "set_lp"],
      ["SADD", "set_lpex", "a", "b"],
      ["SPEXPIREAT", "set_lpex", "2000000000000", "MEMBERS", "1", "a"],
      ["SPEXPIREAT", "set_lpex", "2000000005000", "MEMBERS", "1", "b"],
      ["DUMP", "set_lpex"],

      ["ZADD", "z_lp", "-inf", "c", "+inf", "d", "-0", "negzero", "1", "a", "2.5", "b", "1.2345678901234567", "f",
        "1e-7", "m_em7", "1.5e-7", "m_15em7", "1e-6", "m_em6", "1e-5", "m_em5", "1e-4", "m_em4", "1e15", "m_e15",
        "1e18", "m_e18", "9e18", "m_9e18", "1e19", "m_e19", "1.2345678901234567e19", "m_f19",
        "9007199254740992", "m_safe", "9223372036854774784", "m_near64", "9223372036854775808", "m_2p63", "-9223372036854775808", "m_min64"],
      ["DUMP", "z_lp"],
      ["ZADD", "z_sl", "1.5", "a".repeat(65), "-inf", "b", "+inf", "c", "0", "d", "42", "42", "-5", "-5"], ["DUMP", "z_sl"],

      ["HSET", "h_lp", "a", "1", "b", "hello", "c", "99999999999"], ["DUMP", "h_lp"],
      ["HSET", "h_lpex", "a", "1", "b", "2"],
      ["HPEXPIREAT", "h_lpex", "2000000000000", "FIELDS", "1", "a"],
      ["HPEXPIREAT", "h_lpex", "2000000005000", "FIELDS", "1", "b"],
      ["DUMP", "h_lpex"],

      ["XGROUP", "CREATE", "st_empty", "g1", "0", "MKSTREAM"], ["DUMP", "st_empty"],
      ["XADD", "st_one", "1000-0", "f1", "v1", "f2", "v2"], ["DUMP", "st_one"],
      ["XADD", "st_multi", "1000-0", "f1", "v1", "f2", "v2"],
      ["XADD", "st_multi", "1000-1", "f1", "v3", "f2", "v4"],
      ["XADD", "st_multi", "1001-0", "f3", "v5"],
      ["DUMP", "st_multi"],
      ["XADD", "st_cfg", "1000-0", "f", "v"],
      ["XCFGSET", "st_cfg", "IDMP-DURATION", "200", "IDMP-MAXSIZE", "50"],
      ["XGROUP", "CREATE", "st_cfg", "g1", "0"],
      ["XGROUP", "CREATECONSUMER", "st_cfg", "g1", "idle_c"],
      ["DUMP", "st_cfg"],
    ]);
  }));

  test("cross-server DUMP and RESTORE for hashtable, TTL-metadata, zset2, list, and complex streams", () => run(async (s) => {
    await expectCrossRestore(
      s,
      "set_ht",
      [["SADD", "set_ht", "a".repeat(65), "42", "-5", "0", ...Array.from({ length: 140 }, (_, i) => `m_${i}`)]],
      [(k) => ["SCARD", k], (k) => ["SISMEMBER", k, "42"], (k) => ["SISMEMBER", k, "a".repeat(65)]],
      [(k) => ["SMEMBERS", k]],
    );

    await expectCrossRestore(
      s,
      "set_meta",
      [
        ["SADD", "set_meta", "a".repeat(65), "42", "persist_m", ...Array.from({ length: 130 }, (_, i) => `sm_${i}`)],
        ["SPEXPIREAT", "set_meta", "2000000000000", "MEMBERS", "1", "42"],
        ["SPEXPIREAT", "set_meta", "2000000005000", "MEMBERS", "1", "a".repeat(65)],
      ],
      [
        (k) => ["SCARD", k],
        (k) => ["SPEXPIRETIME", k, "MEMBERS", "3", "42", "a".repeat(65), "persist_m"],
      ],
      [(k) => ["SMEMBERS", k]],
    );

    await expectCrossRestore(
      s,
      "hash_ht",
      [["HSET", "hash_ht", "a".repeat(65), "123", "42", "99999", ...Array.from({ length: 140 }, (_, i) => [`f_${i}`, `v_${i}`]).flat()]],
      [(k) => ["HLEN", k], (k) => ["HGET", k, "a".repeat(65)], (k) => ["HGET", k, "42"]],
      [(k) => ["HGETALL", k]],
    );

    await expectCrossRestore(
      s,
      "hash_meta",
      [
        ["HSET", "hash_meta", "a".repeat(65), "v1", "b", "v2", "persist_f", "v3", ...Array.from({ length: 130 }, (_, i) => [`hf_${i}`, `hv_${i}`]).flat()],
        ["HPEXPIREAT", "hash_meta", "2000000000000", "FIELDS", "1", "b"],
        ["HPEXPIREAT", "hash_meta", "2000000005000", "FIELDS", "1", "a".repeat(65)],
      ],
      [
        (k) => ["HLEN", k],
        (k) => ["HPEXPIRETIME", k, "FIELDS", "3", "b", "a".repeat(65), "persist_f"],
      ],
      [(k) => ["HGETALL", k]],
    );

    await expectCrossRestore(
      s,
      "zset_big",
      [["ZADD", "zset_big", ...Array.from({ length: 150 }, (_, i) => [String((i % 10) * 1.5), `zm_${i}`]).flat(), "-inf", "lo", "+inf", "hi"]],
      [(k) => ["ZCARD", k], (k) => ["ZRANGE", k, "0", "-1", "WITHSCORES"]],
    );

    await expectCrossRestore(
      s,
      "list_big",
      [["RPUSH", "list_big", "x".repeat(9000), ...Array.from({ length: 150 }, (_, i) => `li_${i}`)]],
      [(k) => ["LLEN", k], (k) => ["LRANGE", k, "0", "-1"]],
    );

    const streamSetup: Array<Array<RespArg>> = [];
    for (let i = 1; i <= 105; i++) streamSetup.push(["XADD", "st_full", `${1000 + i}-0`, "k", `val_${i}`]);
    streamSetup.push(
      ["XDEL", "st_full", "1001-0"],
      ["XGROUP", "CREATE", "st_full", "g1", "0", "ENTRIESREAD", "10"],
      ["XREADGROUP", "GROUP", "g1", "c1", "COUNT", "2", "STREAMS", "st_full", ">"],
      ["XNACK", "st_full", "g1", "FAIL", "IDS", "1", "1002-0"],
      ["XGROUP", "CREATECONSUMER", "st_full", "g1", "c_idle"],
    );
    await expectCrossRestore(
      s,
      "st_full",
      streamSetup,
      [
        (k) => ["XLEN", k],
        (k) => ["XRANGE", k, "-", "+"],
        (k) => ["XPENDING", k, "g1"],
      ],
    );
    const origPend = decodeResp(await s.redis.cmd("XPENDING", "st_full", "g1", "-", "+", "10"));
    const duraPend = decodeResp(await s.dura.cmd("XPENDING", "st_full_r2d", "g1", "-", "+", "10"));
    const redisPend = decodeResp(await s.redis.cmd("XPENDING", "st_full_d2r", "g1", "-", "+", "10"));
    for (const got of [duraPend, redisPend]) {
      expect(got.kind).toBe("array");
      expect(origPend.kind).toBe("array");
      if (got.kind === "array" && origPend.kind === "array") {
        expect(got.items.length).toBe(origPend.items.length);
        for (let i = 0; i < origPend.items.length; i++) {
          const o = origPend.items[i];
          const g = got.items[i];
          expect(o.kind).toBe("array");
          expect(g.kind).toBe("array");
          if (o.kind === "array" && g.kind === "array") {
            expect(g.items[0]).toEqual(o.items[0]);
            expect(g.items[1]).toEqual(o.items[1]);
            expect(g.items[3]).toEqual(o.items[3]);
            expect(g.items[2].kind).toBe("int");
            expect(o.items[2].kind).toBe("int");
            if (o.items[2].kind === "int" && g.items[2].kind === "int") {
              if (o.items[2].value < 0n) expect(g.items[2].value).toBe(o.items[2].value);
              else expect(Number(g.items[2].value)).toBeGreaterThanOrEqual(0);
            }
          }
        }
      }
    }

    await Promise.all([
      s.redis.cmd("XADD", "st_idmp", "IDMP", "p1", "iid1", "*", "f", "v1"),
      s.dura.cmd("XADD", "st_idmp", "IDMP", "p1", "iid1", "*", "f", "v1"),
    ]);
    await Promise.all([
      s.redis.cmd("XADD", "st_idmp", "IDMP", "p1", "iid2", "*", "f", "v2"),
      s.dura.cmd("XADD", "st_idmp", "IDMP", "p1", "iid2", "*", "f", "v2"),
    ]);
    const rIdmpDump = bulkBytes(await s.redis.cmd("DUMP", "st_idmp"));
    const dIdmpDump = bulkBytes(await s.dura.cmd("DUMP", "st_idmp"));
    expect(dec.decode(await s.dura.cmd("RESTORE", "st_idmp_r2d", "0", rIdmpDump))).toBe("+OK\r\n");
    expect(dec.decode(await s.redis.cmd("RESTORE", "st_idmp_d2r", "0", dIdmpDump))).toBe("+OK\r\n");
    const firstIdR = bulkBytes(await s.dura.cmd("XADD", "st_idmp_r2d", "IDMP", "p1", "iid1", "*", "f", "v1"));
    const firstEntryR = decodeResp(await s.dura.cmd("XRANGE", "st_idmp_r2d", "-", "+", "COUNT", "1"));
    expect(firstEntryR.kind).toBe("array");
    if (firstEntryR.kind === "array" && firstEntryR.items[0]?.kind === "array") {
      expect(firstEntryR.items[0].items[0]).toEqual({ kind: "bulk", value: firstIdR });
    }
    const firstIdD = bulkBytes(await s.redis.cmd("XADD", "st_idmp_d2r", "IDMP", "p1", "iid1", "*", "f", "v1"));
    const firstEntryD = decodeResp(await s.redis.cmd("XRANGE", "st_idmp_d2r", "-", "+", "COUNT", "1"));
    expect(firstEntryD.kind).toBe("array");
    if (firstEntryD.kind === "array" && firstEntryD.items[0]?.kind === "array") {
      expect(firstEntryD.items[0].items[0]).toEqual({ kind: "bulk", value: firstIdD });
    }
  }));

  test("legacy RDB payload RESTORE parity", () => run(async (s) => {
    const legList = encodeLegacylistPayload(["a", "42", "hello"]);
    const legZset = encodeLegacyZsetPayload([["neg", -Infinity], ["pi", 3.14], ["pos", Infinity]]);

    const zlList = encodeZiplist([
      { type: "int", value: 5n },
      { type: "int", value: 100n },
      { type: "int", value: -5000n },
      { type: "int", value: 100_000n },
      { type: "str", data: new TextEncoder().encode("x".repeat(300)) },
    ]);
    const wListZl = new RdbWriter();
    wListZl.u8(10);
    wListZl.blobString(zlList);

    const zlZset = encodeZiplist([
      { type: "str", data: new TextEncoder().encode("beta") },
      { type: "str", data: new TextEncoder().encode("2.5") },
      { type: "str", data: new TextEncoder().encode("alpha") },
      { type: "int", value: 10n },
    ]);
    const wZsetZl = new RdbWriter();
    wZsetZl.u8(12);
    wZsetZl.blobString(zlZset);

    const zlHash = encodeZiplist([
      { type: "str", data: new TextEncoder().encode("k1") },
      { type: "str", data: new TextEncoder().encode("v1") },
      { type: "str", data: new TextEncoder().encode("k2") },
      { type: "int", value: 99n },
    ]);
    const wHashZl = new RdbWriter();
    wHashZl.u8(13);
    wHashZl.blobString(zlHash);

    const wQl1 = new RdbWriter();
    wQl1.u8(14);
    wQl1.len(1);
    wQl1.blobString(zlList);

    await s.script([
      ["RESTORE", "leg_list", "0", legList], ["LRANGE", "leg_list", "0", "-1"],
      ["RESTORE", "leg_zset", "0", legZset], ["ZRANGE", "leg_zset", "0", "-1", "WITHSCORES"],
      ["RESTORE", "leg_lzl", "0", wListZl.finishDump()], ["LRANGE", "leg_lzl", "0", "-1"],
      ["RESTORE", "leg_zzl", "0", wZsetZl.finishDump()], ["ZRANGE", "leg_zzl", "0", "-1", "WITHSCORES"],
      ["RESTORE", "leg_hzl", "0", wHashZl.finishDump()], ["HGETALL", "leg_hzl"],
      ["RESTORE", "leg_ql1", "0", wQl1.finishDump()], ["LRANGE", "leg_ql1", "0", "-1"],
      ["RESTORE", "leg_st1", "0", encodeLegacyStreamPayload(15)], ["XPENDING", "leg_st1", "g1"],
      ["RESTORE", "leg_st2", "0", encodeLegacyStreamPayload(19)], ["XPENDING", "leg_st2", "g1"],
      ["RESTORE", "leg_st3", "0", encodeLegacyStreamPayload(21)], ["XPENDING", "leg_st3", "g1"],
      ["RESTORE", "leg_hm22", "0", encodeLegacyHashPreGaPayload(false, [["f1", "v1", 2_000_000_000_000], ["f2", "v2", 0]])],
      ["HGETALL", "leg_hm22"],
      ["HPEXPIRETIME", "leg_hm22", "FIELDS", "2", "f1", "f2"],
    ]);
  }));

  test("RESTORE and RESTORE-ASKING options, TTLs, and error handling parity", () => run(async (s) => {
    await s.cmd("SET", "src", "hello");
    const valid = bulkBytes(await s.redis.cmd("DUMP", "src"));
    const badCrc = new Uint8Array(valid);
    badCrc[badCrc.length - 1] ^= 1;
    const badVer = new Uint8Array(valid);
    badVer[badVer.length - 10] = 99;
    const futureAbs = String(Date.now() + 60_000);

    await s.script([
      ["DUMP"], ["DUMP", "a", "b"], ["DUMP", "missing"],
      ["RESTORE", "x", "0"], ["RESTORE-ASKING", "x", "0"],
      ["RESTORE", "src", "0", valid],
      ["RESTORE", "src", "0", badCrc],
      ["RESTORE", "src", "-1", valid],
      ["RESTORE", "src", "0", valid, "FOO"],
      ["RESTORE", "k2", "-1", valid],
      ["RESTORE", "k2", "abc", valid],
      ["RESTORE", "k2", "99999999999999999999999", valid],
      ["RESTORE", "k2", "9223372036854775807", valid],
      ["RESTORE", "k2", "0", badCrc],
      ["RESTORE", "k2", "0", badVer],
      ["RESTORE", "k2", "0", new Uint8Array([0, 1, 2])],
      ["RESTORE", "k2", "0", new Uint8Array(0)],
      ["RESTORE", "k2", "0", valid, "IDLETIME", "10", "FREQ", "5"],
      ["RESTORE", "k2", "0", valid, "IDLETIME", "-1"],
      ["RESTORE", "k2", "0", valid, "IDLETIME", "x"],
      ["RESTORE", "k2", "0", valid, "IDLETIME"],
      ["RESTORE", "k2", "0", valid, "FREQ", "-1"],
      ["RESTORE", "k2", "0", valid, "FREQ", "256"],
      ["RESTORE", "k2", "0", valid, "FREQ", "x"],
      ["RESTORE", "k2", "0", valid, "FREQ"],
      ["RESTORE", "k2", "0", valid, "IDLETIME", "1", "IDLETIME", "2"],
      ["RESTORE", "k2", "0", valid, "FREQ", "1", "FREQ", "255"],
      ["RESTORE", "k2", "0", valid, "REPLACE", "REPLACE", "ABSTTL", "ABSTTL"],
      ["GET", "k2"], ["PTTL", "k2"],
      ["RESTORE", "k_ab0", "0", valid, "ABSTTL"], ["PTTL", "k_ab0"],
      ["RESTORE", "k_past", "1", valid, "ABSTTL"], ["EXISTS", "k_past"],
      ["RESTORE", "src", "1", valid, "ABSTTL"], ["EXISTS", "src"],
      ["RESTORE", "src", "1", valid, "REPLACE", "ABSTTL"], ["EXISTS", "src"],
      ["RESTORE", "k_past2", "1", badCrc, "ABSTTL"],
      ["RESTORE-ASKING", "k_ask", "0", valid], ["GET", "k_ask"],
      ["RESTORE", "k_badtype", "0", wrapPayload([99, 0])],
      ["RESTORE", "k_eh", "0", wrapPayload([4, 0])], ["EXISTS", "k_eh"],
      ["RESTORE", "k_es", "0", wrapPayload([2, 0])], ["EXISTS", "k_es"],
      ["RESTORE", "k_el", "0", wrapPayload([18, 0])], ["EXISTS", "k_el"],
      ["RESTORE", "k_ez", "0", wrapPayload([5, 0])], ["EXISTS", "k_ez"],
      ["RESTORE", "k_ver0", "0", wrapPayload([0, 1, 0x61], 0)], ["GET", "k_ver0"],
      ["RESTORE", "k_ver18", "0", wrapPayload([0, 1, 0x61], 18)],
      ["RESTORE", "k_trail", "0", wrapPayload([0, 1, 0x61, 0xff])], ["GET", "k_trail"],
      ["RESTORE", "k_trunc", "0", wrapPayload([0, 20, 0x61])],
      ["RESTORE", "k_mod", "0", wrapPayload([7, 0x81, 0, 0, 0, 0, 0, 0, 0, 1, 0])],
    ]);

    await s.cmd("RESTORE", "k_ttl", "10000", valid);
    await s.approx(500, "PTTL", "k_ttl");
    await s.cmd("RESTORE", "k_fut", futureAbs, valid, "ABSTTL");
    await s.approx(500, "PTTL", "k_fut");
    await s.cmd("RESTORE", "k_huge_abs", "9223372036854775807", valid, "ABSTTL");
    await s.shape("PTTL", "k_huge_abs");
  }));

  test("module and extension types round-trip on Duraredis and isolate from redis:8", () => run(async (s) => {
    await s.dura.cmd("JSON.SET", "mj", "$", '{"a":1,"b":[2,3]}');
    await s.dura.cmd("BF.ADD", "mbf", "x");
    await s.dura.cmd("CF.ADD", "mcf", "y");
    await s.dura.cmd("CMS.INITBYDIM", "mcms", "10", "5");
    await s.dura.cmd("CMS.INCRBY", "mcms", "item", "3");
    await s.dura.cmd("TOPK.RESERVE", "mtopk", "5");
    await s.dura.cmd("TOPK.ADD", "mtopk", "alpha");
    await s.dura.cmd("TDIGEST.CREATE", "mtd");
    await s.dura.cmd("TDIGEST.ADD", "mtd", "42");
    await s.dura.cmd("TS.CREATE", "mts", "LABELS", "env", "prod");
    await s.dura.cmd("TS.ADD", "mts", "1000", "3.5");
    await s.dura.cmd("ARSET", "marr", "0", "hello", "1", "world");

    for (const [src, dst, verify] of [
      ["mj", "mj2", ["JSON.GET", "mj2"]],
      ["mbf", "mbf2", ["BF.EXISTS", "mbf2", "x"]],
      ["mcf", "mcf2", ["CF.EXISTS", "mcf2", "y"]],
      ["mcms", "mcms2", ["CMS.QUERY", "mcms2", "item"]],
      ["mtopk", "mtopk2", ["TOPK.QUERY", "mtopk2", "alpha"]],
      ["mtd", "mtd2", ["TDIGEST.QUANTILE", "mtd2", "0.5"]],
      ["mts", "mts2", ["TS.GET", "mts2"]],
      ["marr", "marr2", ["ARGET", "marr2", "1"]],
    ] as Array<[string, string, Array<RespArg>]>) {
      const payload = bulkBytes(await s.dura.cmd("DUMP", src));
      expect(dec.decode(await s.dura.cmd("RESTORE", dst, "0", payload))).toBe("+OK\r\n");
      const origCmd: Array<RespArg> = [verify[0], src, ...verify.slice(2)];
      expect(await s.dura.cmd(...verify)).toEqual(await s.dura.cmd(...origCmd));
      expect(dec.decode(await s.redis.cmd("RESTORE", `r_${dst}`, "0", payload))).toBe("-ERR Bad data format\r\n");
    }

    await s.redis.cmd("JSON.SET", "rj", "$", '{"a":1}');
    const rJsonDump = bulkBytes(await s.redis.cmd("DUMP", "rj"));
    expect(dec.decode(await s.dura.cmd("RESTORE", "dj_bad", "0", rJsonDump))).toBe("-ERR Bad data format\r\n");
  }));
});
