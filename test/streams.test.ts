import { expect, test } from "bun:test";
import { describeDual } from "./dual";
import type { Pair } from "./dual";
import { decodeResp } from "./wire";
import type { RespArg, RespValue } from "./wire";

const dec = new TextDecoder();

function pairsOf(v: RespValue): Array<[string, RespValue]> {
  if (v.kind === "map") {
    return v.entries.map(([k, val]) => [k.kind === "bulk" ? dec.decode(k.value) : "", val]);
  }
  expect(v.kind).toBe("array");
  if (v.kind !== "array") return [];
  const out: Array<[string, RespValue]> = [];
  for (let i = 0; i < v.items.length; i += 2) {
    const k = v.items[i];
    out.push([k.kind === "bulk" ? dec.decode(k.value) : "", v.items[i + 1]]);
  }
  return out;
}

function asInt(v: RespValue): bigint {
  expect(v.kind).toBe("int");
  return v.kind === "int" ? v.value : -999n;
}

function asBulk(v: RespValue): string {
  expect(v.kind).toBe("bulk");
  return v.kind === "bulk" ? dec.decode(v.value) : "";
}

function isNull(v: RespValue): boolean {
  return v.kind === "null" || v.kind === "null-bulk" || v.kind === "null-array";
}

function checkConsumerMap(rv: RespValue, dv: RespValue) {
  expect(dv.kind).toBe(rv.kind);
  const rp = pairsOf(rv);
  const dp = pairsOf(dv);
  expect(dp.map(([k]) => k)).toEqual(rp.map(([k]) => k));
  for (let i = 0; i < rp.length; i++) {
    const [k, rval] = rp[i];
    const dval = dp[i][1];
    if (k === "idle") {
      expect(asInt(dval)).toBeGreaterThanOrEqual(0n);
      expect(asInt(dval)).toBeLessThan(5000n);
    } else if (k === "inactive") {
      if (asInt(rval) === -1n) expect(asInt(dval)).toBe(-1n);
      else {
        expect(asInt(dval)).toBeGreaterThanOrEqual(0n);
        expect(asInt(dval)).toBeLessThan(5000n);
      }
    } else if (k === "seen-time") {
      expect(Math.abs(Number(asInt(dval) - asInt(rval)))).toBeLessThan(5000);
    } else if (k === "active-time") {
      if (asInt(rval) === -1n) expect(asInt(dval)).toBe(-1n);
      else expect(Math.abs(Number(asInt(dval) - asInt(rval)))).toBeLessThan(5000);
    } else if (k === "pending" && rval.kind === "array" && dval.kind === "array") {
      expect(dval.items.length).toBe(rval.items.length);
      for (let j = 0; j < rval.items.length; j++) {
        const ri = rval.items[j];
        const di = dval.items[j];
        expect(ri.kind).toBe("array");
        expect(di.kind).toBe("array");
        if (ri.kind !== "array" || di.kind !== "array") continue;
        expect(di.items.length).toBe(ri.items.length);
        expect(di.items[0]).toEqual(ri.items[0]);
        expect(Math.abs(Number(asInt(di.items[1]) - asInt(ri.items[1])))).toBeLessThan(5000);
        expect(di.items[2]).toEqual(ri.items[2]);
      }
    } else {
      expect(dval).toEqual(rval);
    }
  }
}

function checkGroupMap(rv: RespValue, dv: RespValue) {
  expect(dv.kind).toBe(rv.kind);
  const rp = pairsOf(rv);
  const dp = pairsOf(dv);
  expect(dp.map(([k]) => k)).toEqual(rp.map(([k]) => k));
  for (let i = 0; i < rp.length; i++) {
    const [k, rval] = rp[i];
    const dval = dp[i][1];
    if (k === "pending" && rval.kind === "array" && dval.kind === "array") {
      expect(dval.items.length).toBe(rval.items.length);
      for (let j = 0; j < rval.items.length; j++) {
        const ri = rval.items[j];
        const di = dval.items[j];
        expect(ri.kind).toBe("array");
        expect(di.kind).toBe("array");
        if (ri.kind !== "array" || di.kind !== "array") continue;
        expect(di.items.length).toBe(ri.items.length);
        expect(di.items[0]).toEqual(ri.items[0]);
        expect(di.items[1]).toEqual(ri.items[1]);
        expect(Math.abs(Number(asInt(di.items[2]) - asInt(ri.items[2])))).toBeLessThan(5000);
        expect(di.items[3]).toEqual(ri.items[3]);
      }
    } else if (k === "consumers" && rval.kind === "array" && dval.kind === "array") {
      expect(dval.items.length).toBe(rval.items.length);
      for (let j = 0; j < rval.items.length; j++) checkConsumerMap(rval.items[j], dval.items[j]);
    } else {
      expect(dval).toEqual(rval);
    }
  }
}

async function checkXinfoStream(s: Pair, ...args: Array<RespArg>) {
  const [rv, dv] = await s.shape(...args);
  const rp = pairsOf(rv);
  const dp = pairsOf(dv);
  expect(dp.map(([k]) => k)).toEqual(rp.map(([k]) => k));
  for (let i = 0; i < rp.length; i++) {
    const [k, rval] = rp[i];
    const dval = dp[i][1];
    if (k === "groups" && rval.kind === "array" && dval.kind === "array") {
      expect(dval.items.length).toBe(rval.items.length);
      for (let j = 0; j < rval.items.length; j++) checkGroupMap(rval.items[j], dval.items[j]);
    } else {
      expect(dval).toEqual(rval);
    }
  }
}

async function checkXinfoConsumers(s: Pair, ...args: Array<RespArg>) {
  const [rv, dv] = await s.shape(...args);
  expect(rv.kind).toBe("array");
  expect(dv.kind).toBe("array");
  if (rv.kind !== "array" || dv.kind !== "array") return;
  expect(dv.items.length).toBe(rv.items.length);
  for (let i = 0; i < rv.items.length; i++) checkConsumerMap(rv.items[i], dv.items[i]);
}

async function checkXpendingExt(s: Pair, ...args: Array<RespArg>) {
  const [rv, dv] = await s.shape(...args);
  expect(rv.kind).toBe("array");
  expect(dv.kind).toBe("array");
  if (rv.kind !== "array" || dv.kind !== "array") return;
  expect(dv.items.length).toBe(rv.items.length);
  for (let i = 0; i < rv.items.length; i++) {
    const ri = rv.items[i];
    const di = dv.items[i];
    expect(ri.kind).toBe("array");
    expect(di.kind).toBe("array");
    if (ri.kind !== "array" || di.kind !== "array") continue;
    expect(di.items.length).toBe(4);
    expect(di.items[0]).toEqual(ri.items[0]);
    expect(di.items[1]).toEqual(ri.items[1]);
    if (asInt(ri.items[2]) === -1n) expect(asInt(di.items[2])).toBe(-1n);
    else {
      expect(asInt(di.items[2])).toBeGreaterThanOrEqual(0n);
      expect(asInt(di.items[2])).toBeLessThan(5000n);
    }
    expect(di.items[3]).toEqual(ri.items[3]);
  }
}

function entriesListOf(v: RespValue): Array<[string, RespValue]> {
  if (v.kind === "map") {
    return v.entries.map(([k, val]) => [k.kind === "bulk" ? dec.decode(k.value) : "", val]);
  }
  expect(v.kind).toBe("array");
  if (v.kind !== "array") return [];
  return v.items.map((item) => {
    expect(item.kind).toBe("array");
    if (item.kind !== "array") return ["", item];
    expect(item.items.length).toBe(2);
    return [asBulk(item.items[0]), item.items[1]];
  });
}

async function checkClaimReply(s: Pair, ...args: Array<RespArg>) {
  const [rv, dv] = await s.shape(...args);
  if (isNull(rv)) {
    expect(isNull(dv)).toBe(true);
    return;
  }
  const rs = entriesListOf(rv);
  const ds = entriesListOf(dv);
  expect(ds.map(([k]) => k)).toEqual(rs.map(([k]) => k));
  for (let i = 0; i < rs.length; i++) {
    const rArr = rs[i][1];
    const dArr = ds[i][1];
    expect(rArr.kind).toBe("array");
    expect(dArr.kind).toBe("array");
    if (rArr.kind !== "array" || dArr.kind !== "array") continue;
    expect(dArr.items.length).toBe(rArr.items.length);
    for (let j = 0; j < rArr.items.length; j++) {
      const re = rArr.items[j];
      const de = dArr.items[j];
      expect(re.kind).toBe("array");
      expect(de.kind).toBe("array");
      if (re.kind !== "array" || de.kind !== "array") continue;
      expect(de.items.length).toBe(re.items.length);
      expect(de.items[0]).toEqual(re.items[0]);
      expect(de.items[1]).toEqual(re.items[1]);
      if (re.items.length === 4) {
        const ri = asInt(re.items[2]);
        const di = asInt(de.items[2]);
        expect(Math.abs(Number(di - ri))).toBeLessThan(5000);
        expect(de.items[3]).toEqual(re.items[3]);
      }
    }
  }
}

async function checkIdmpInfo(s: Pair, key: string) {
  const [rv, dv] = await s.shape("XINFO", "STREAM", key);
  const rp = pairsOf(rv);
  const dp = pairsOf(dv);
  expect(dp.map(([k]) => k)).toEqual(rp.map(([k]) => k));
  for (let i = 0; i < rp.length; i++) {
    const [k, rval] = rp[i];
    const dval = dp[i][1];
    if (k === "last-generated-id" || k === "recorded-first-entry-id") {
      expect(asBulk(dval)).toMatch(/^\d+-\d+$/);
      expect(asBulk(rval)).toMatch(/^\d+-\d+$/);
    } else if ((k === "first-entry" || k === "last-entry") && rval.kind === "array" && dval.kind === "array") {
      expect(dval.items.length).toBe(2);
      expect(asBulk(dval.items[0])).toMatch(/^\d+-\d+$/);
      expect(dval.items[1]).toEqual(rval.items[1]);
    } else if (rval.kind === "bulk" && /^\d+-\d+$/.test(asBulk(rval))) {
      expect(asBulk(dval)).toMatch(/^\d+-\d+$/);
    } else {
      expect(dval).toEqual(rval);
    }
  }
}

describeDual("streams vs redis:8", (run) => {
  test("xadd, xlen, xrange, xrevrange, xdel, xtrim, xsetid", () => run(async (s) => {
    await s.script([
      ["XADD", "s", "*"],
      ["XADD", "s", "*", "f1"],
      ["XADD", "s", "0-0", "f", "v"],
      ["XADD", "s", "0", "f", "v"],
      ["XADD", "s", "abc", "f", "v"],
      ["XADD", "s", "-1-0", "f", "v"],
      ["XADD", "s", "18446744073709551616-0", "f", "v"],
      ["XADD", "s", "1-2-3", "f", "v"],
      ["XADD", "s", "1-", "f", "v"],
      ["XADD", "s", "MAXLEN"],
      ["XADD", "s", "MAXLEN", "-1", "*", "a", "1"],
      ["XADD", "s", "MAXLEN", "=", "5", "LIMIT", "1", "*", "a", "1"],
      ["XADD", "s", "MAXLEN", "5", "LIMIT", "1", "*", "a", "1"],
      ["XADD", "s", "MAXLEN", "~", "5", "LIMIT", "-1", "*", "a", "1"],
      ["XADD", "s", "MAXLEN", "~", "5", "LIMIT", "abc", "*", "a", "1"],
      ["XADD", "s", "MAXLEN", "=", "abc", "*", "a", "1"],
      ["XADD", "s", "MINID", "bad", "*", "a", "1"],
      ["XADD", "s", "MAXLEN", "5", "MINID", "1-0", "*", "a", "1"],
      ["XADD", "missing", "NOMKSTREAM", "*", "a", "1"],
      ["EXISTS", "missing"],
      ["XADD", "s0", "0-*", "a", "1"],
      ["XADD", "s5", "5", "a", "1"],
      ["XADD", "s1", "1-*", "a", "1"],
      ["XADD", "s1", "1-*", "a", "2"],
      ["XADD", "s1", "1-0", "a", "3"],
      ["XADD", "s1", "1-1", "a", "3"],
      ["XADD", "s1", "0-*", "a", "3"],
      ["XADD", "s1", "2-0", "a", "3", "a", "4"],
      ["XADD", "s1", "MAXLEN", "10", "NOMKSTREAM", "3-0", "b", "5"],
      ["XLEN", "s1"],
      ["XLEN", "missing"],
      ["TYPE", "s1"],
      ["OBJECT", "ENCODING", "s1"],
      ["XADD", "smax", "18446744073709551615-18446744073709551615", "a", "1"],
      ["XADD", "smax", "*", "a", "2"],
      ["XADD", "smax", "18446744073709551615-*", "a", "2"],
      ["XADD", "szero", "MAXLEN", "0", "10-0", "a", "1"],
      ["EXISTS", "szero"],
      ["XLEN", "szero"],
      ["XADD", "sapprox", "MAXLEN", "~", "0", "1-0", "a", "1"],
      ["XLEN", "sapprox"],
    ]);

    const binKey = new Uint8Array([0, 1, 2, 255]);
    const binVal = new Uint8Array([10, 13, 0, 254]);
    await s.cmd("XADD", "sbin", "1-0", binKey, binVal);
    await s.cmd("XRANGE", "sbin", "-", "+");

    const [rAuto, dAuto] = await s.shape("XADD", "sauto", "*", "k", "v1");
    const [rAuto2, dAuto2] = await s.shape("XADD", "sauto", "*", "k", "v2");
    expect(asBulk(dAuto)).toMatch(/^\d+-\d+$/);
    expect(asBulk(dAuto2)).toMatch(/^\d+-\d+$/);
    expect(asBulk(rAuto)).toMatch(/^\d+-\d+$/);
    expect(asBulk(rAuto2)).toMatch(/^\d+-\d+$/);
    await s.cmd("XLEN", "sauto");

    await s.script([
      ["XRANGE", "missing", "bad", "+"],
      ["XRANGE", "missing", "-", "+", "COUNT", "abc"],
      ["XRANGE", "missing", "-", "+", "COUNT", "0"],
      ["XRANGE", "s1", "(-", "+"],
      ["XRANGE", "s1", "-", "(+"],
      ["XRANGE", "s1", "(0-0", "+"],
      ["XRANGE", "s1", "-", "(0-0"],
      ["XRANGE", "s1", "(18446744073709551615-18446744073709551615", "+"],
      ["XRANGE", "s1", "-", "+"],
      ["XRANGE", "s1", "(1-0", "+"],
      ["XRANGE", "s1", "(1", "+"],
      ["XRANGE", "s1", "-", "(1"],
      ["XRANGE", "s1", "1-1", "2-0", "COUNT", "1"],
      ["XRANGE", "s1", "-", "+", "COUNT", "0"],
      ["XRANGE", "s1", "-", "+", "COUNT", "-1"],
      ["XRANGE", "szero", "-", "+", "COUNT", "0"],
      ["XRANGE", "s1", "-", "+", "FOO", "1"],
      ["XREVRANGE", "s1", "+", "-"],
      ["XREVRANGE", "s1", "1", "(1"],
      ["XREVRANGE", "s1", "(1", "0"],
      ["XREVRANGE", "s1", "+", "-", "COUNT", "2"],
      ["XREVRANGE", "szero", "+", "-", "COUNT", "0"],
      ["XDEL", "missing", "bad"],
      ["XDEL", "s1", "bad"],
      ["XDEL", "s1", "1"],
      ["XDEL", "s1", "1-0", "99-0"],
      ["XRANGE", "s1", "-", "+"],
      ["XTRIM", "missing", "MAXLEN", "-1"],
      ["XTRIM", "missing", "MAXLEN", "5"],
      ["XTRIM", "s1", "FOO", "5"],
      ["XTRIM", "s1", "MAXLEN", "5", "EXTRA"],
      ["XADD", "s1", "4-0", "a", "4"],
      ["XADD", "s1", "5-0", "a", "5"],
      ["XTRIM", "s1", "MAXLEN", "=", "2"],
      ["XRANGE", "s1", "-", "+"],
      ["XADD", "tm", "1-0", "k", "1"],
      ["XADD", "tm", "2-0", "k", "2"],
      ["XADD", "tm", "3-0", "k", "3"],
      ["XADD", "tm", "4-0", "k", "4"],
      ["XTRIM", "tm", "MINID", "=", "2-0"],
      ["XTRIM", "tm", "MINID", "3"],
      ["XRANGE", "tm", "-", "+"],
      ["XTRIM", "tm", "MINID", "10-0"],
      ["EXISTS", "tm"],
      ["XTRIM", "tm", "MAXLEN", "~", "0"],
      ["XADD", "tlim", "1-0", "a", "1"],
      ["XADD", "tlim", "2-0", "a", "2"],
      ["XADD", "tlim", "3-0", "a", "3"],
      ["XTRIM", "tlim", "MAXLEN", "~", "0", "LIMIT", "10"],
      ["XLEN", "tlim"],
      ["XADD", "tmin", "1-0", "a", "1"],
      ["XADD", "tmin", "2-0", "a", "2"],
      ["XTRIM", "tmin", "MINID", "~", "3-0", "LIMIT", "10"],
      ["XLEN", "tmin"],
      ["XTRIM", "tlim", "MAXLEN", "~", "1", "LIMIT", "1"],
      ["XTRIM", "tlim", "MAXLEN", "~", "0", "LIMIT", "1"],
      ["XADD", "t3", "1-0", "a", "1"],
      ["XADD", "t3", "2-0", "a", "2"],
      ["XADD", "t3", "3-0", "a", "3"],
      ["XTRIM", "t3", "MINID", "~", "3-0", "LIMIT", "10"],
      ["XLEN", "t3"],
      ["XSETID", "missing", "1-0"],
      ["XSETID", "s1", "4-0"],
      ["XSETID", "s1", "5-0"],
      ["XSETID", "s1", "6-0", "ENTRIESADDED", "1"],
      ["XSETID", "s1", "6-0", "ENTRIESADDED", "-1"],
      ["XSETID", "s1", "6-0", "MAXDELETEDID", "7-0"],
      ["XSETID", "s1", "6-0", "ENTRIESADDED"],
      ["XSETID", "s1", "6-0", "BADOPT", "1"],
      ["XSETID", "s1", "6-0", "ENTRIESADDED", "5", "ENTRIESADDED", "10", "MAXDELETEDID", "2-0"],
      ["XSETID", "s1", "6-0", "MAXDELETEDID", "0-0"],
      ["XSETID", "szero", "0-0"],
    ]);

    await checkXinfoStream(s, "XINFO", "STREAM", "s1");
    await checkXinfoStream(s, "XINFO", "STREAM", "szero");
    await checkXinfoStream(s, "XINFO", "STREAM", "tm");
    await checkXinfoStream(s, "XINFO", "STREAM", "s1", "FULL");
  }));

  test("approximate trimming removes whole nodes of 100 entries", () => run(async (s) => {
    for (let i = 1; i <= 250; i++) await s.cmd("XADD", "big", `${i}-0`, "f", "v");
    await s.script([
      ["XTRIM", "big", "MAXLEN", "~", "120"],
      ["XLEN", "big"],
      ["XTRIM", "big", "MAXLEN", "~", "10", "LIMIT", "50"],
      ["XTRIM", "big", "MINID", "~", "240-0"],
      ["XLEN", "big"],
      ["XADD", "big", "MAXLEN", "~", "10", "251-0", "f", "v"],
      ["XLEN", "big"],
      ["XRANGE", "big", "-", "+", "COUNT", "2"],
    ]);
  }));

  test("xread and blocking xread", () => run(async (s) => {
    await s.script([
      ["XADD", "sr", "1-0", "k", "v1"],
      ["XADD", "sr", "2-0", "k", "v2"],
      ["XADD", "sr2", "1-0", "k", "x1"],
      ["XREAD", "STREAMS", "sr", "0"],
      ["XREAD", "COUNT", "1", "STREAMS", "sr", "0"],
      ["XREAD", "COUNT", "0", "STREAMS", "sr", "0"],
      ["XREAD", "COUNT", "-1", "STREAMS", "sr", "0"],
      ["XREAD", "STREAMS", "sr", "+"],
      ["XREAD", "STREAMS", "sr", "$"],
      ["XREAD", "STREAMS", "missing", "0"],
      ["XREAD", "STREAMS", "missing", "+"],
      ["XREAD", "BLOCK", "10", "STREAMS", "sr", "+"],
      ["XREAD", "BLOCK", "10", "STREAMS", "missing", "+"],
      ["XREAD", "STREAMS", "sr", "sr2", "1-0", "0-0"],
      ["XREAD", "STREAMS", "sr", "sr", "0-0", "1-0"],
      ["XREAD", "STREAMS", "sr", "0-0", "extra"],
      ["XREAD", "COUNT", "1", "sr", "0-0"],
      ["XREAD", "BLOCK", "-1", "STREAMS", "sr", "0-0"],
      ["XREAD", "STREAMS", "sr", ">"],
    ]);

    const p = await s.peer();
    await p.send("XREAD", "BLOCK", "2000", "STREAMS", "sr", "$");
    await Bun.sleep(50);
    await s.cmd("XADD", "sr", "3-0", "k", "v3");
    await p.next("XREAD BLOCK $ woke on XADD");

    await p.send("XREAD", "BLOCK", "2000", "STREAMS", "bm", "+");
    await Bun.sleep(50);
    await s.cmd("XADD", "bm", "1-0", "a", "1");
    await p.next("XREAD BLOCK missing + woke on XADD");

    await p.send("XREAD", "BLOCK", "150", "STREAMS", "sr", "$");
    await Bun.sleep(50);
    await s.cmd("DEL", "sr");
    await s.cmd("XADD", "sr", "1-0", "a", "small");
    await p.next("XREAD BLOCK $ timed out after DEL + smaller ID");

    await s.script([
      ["MULTI"],
      ["XREAD", "BLOCK", "100", "STREAMS", "sr", "$"],
      ["EXEC"],
      ["EVAL", "return redis.call('XREAD','BLOCK','100','STREAMS','sr','$')", "1", "sr"],
    ]);
  }));

  test("xgroup, xreadgroup, xack, xpending, xclaim, xautoclaim, xinfo", () => run(async (s) => {
    await s.script([
      ["XGROUP", "HELP"],
      ["XINFO", "HELP"],
      ["XGROUP", "NOPE"],
      ["XINFO", "NOPE"],
      ["XGROUP", "CREATE", "missing", "g1", "0"],
      ["XGROUP", "CREATE", "gm", "g1", "$", "MKSTREAM"],
      ["XGROUP", "CREATE", "gm", "g1", "$"],
      ["XGROUP", "CREATE", "gm", "g2", "bad"],
      ["XGROUP", "CREATE", "gm", "g2", "0", "ENTRIESREAD", "-1"],
      ["XGROUP", "CREATE", "gm", "g3", "0", "ENTRIESREAD", "-2"],
      ["XGROUP", "CREATE", "gm", "g3", "0", "ENTRIESREAD", "5"],
      ["XGROUP", "CREATE", "gm", "g4", "0", "FOO"],
      ["XGROUP", "CREATE", "gm", "g4"],
      ["XGROUP", "CREATECONSUMER", "missing", "g1", "c1"],
      ["XGROUP", "CREATECONSUMER", "gm", "nogrp", "c1"],
      ["XGROUP", "CREATECONSUMER", "gm", "g1", "c1"],
      ["XGROUP", "CREATECONSUMER", "gm", "g1", "c1"],
      ["XGROUP", "DELCONSUMER", "missing", "g1", "c1"],
      ["XGROUP", "DELCONSUMER", "gm", "nogrp", "c1"],
      ["XGROUP", "DELCONSUMER", "gm", "g1", "nocons"],
      ["XGROUP", "DELCONSUMER", "gm", "g1", "c1"],
      ["XGROUP", "DESTROY", "missing", "g1"],
      ["XGROUP", "DESTROY", "gm", "nogrp"],
      ["XGROUP", "DESTROY", "gm", "g3"],
      ["XGROUP", "SETID", "missing", "g1", "0"],
      ["XGROUP", "SETID", "gm", "nogrp", "0"],
      ["XGROUP", "SETID", "gm", "g1", "0", "ENTRIESREAD", "0"],
      ["XGROUP", "SETID", "gm", "g1", "$", "ENTRIESREAD", "-1"],
      ["XGROUP", "SETID", "gm", "g1", "$", "ENTRIESREAD", "-2"],
      ["XGROUP", "SETID", "gm", "g1", "0", "FOO"],
      ["XADD", "st", "1-0", "k", "v1"],
      ["XADD", "st", "2-0", "k", "v2"],
      ["XADD", "st", "3-0", "k", "v3"],
      ["XGROUP", "CREATE", "st", "grp", "0"],
      ["XREADGROUP", "GROUP", "grp", "c1", "STREAMS", "missing", ">"],
      ["XREADGROUP", "GROUP", "nogrp", "c1", "STREAMS", "st", ">"],
      ["XREADGROUP", "GROUP", "grp", "c1", "STREAMS", "st", "$"],
      ["XREADGROUP", "GROUP", "grp", "c1", "STREAMS", "st", "+"],
      ["XREADGROUP", "GROUP", "grp", "c1", "STREAMS", "st", ">", "extra"],
      ["XREADGROUP", "GROUP", "grp", "c1", "BLOCK", "-1", "STREAMS", "st", ">"],
      ["XREADGROUP", "COUNT", "1", "GROUP", "grp", "c1", "STREAMS", "st", ">"],
      ["XREADGROUP", "GROUP", "grp", "c1", "COUNT", "1", "STREAMS", "st", ">"],
      ["XREADGROUP", "GROUP", "grp", "c2", "NOACK", "STREAMS", "st", ">"],
      ["XREADGROUP", "GROUP", "grp", "c1", "STREAMS", "st", "0"],
      ["XREADGROUP", "GROUP", "grp", "c2", "STREAMS", "st", "0"],
      ["XREADGROUP", "GROUP", "grp", "c3", "STREAMS", "st", ">"],
      ["XINFO", "GROUPS", "st"],
      ["XINFO", "CONSUMERS", "missing", "grp"],
      ["XINFO", "CONSUMERS", "st", "nogrp"],
      ["XINFO", "GROUPS", "missing"],
      ["XINFO", "STREAM", "missing"],
      ["XINFO", "STREAM", "st", "BAD"],
      ["XINFO", "STREAM", "st", "FULL", "BAD"],
      ["XINFO", "STREAM", "st", "FULL", "COUNT", "abc"],
      ["XPENDING", "missing", "grp"],
      ["XPENDING", "st", "nogrp"],
      ["XPENDING", "st", "grp"],
      ["XPENDING", "st", "grp", "-", "+", "0"],
      ["XPENDING", "st", "grp", "-", "+", "-1"],
      ["XPENDING", "st", "grp", "-"],
      ["XPENDING", "st", "grp", "IDLE", "abc", "-", "+", "10"],
    ]);

    await checkXinfoConsumers(s, "XINFO", "CONSUMERS", "st", "grp");
    await checkXpendingExt(s, "XPENDING", "st", "grp", "-", "+", "10");
    await checkXpendingExt(s, "XPENDING", "st", "grp", "-", "+", "10", "c1");
    await checkXpendingExt(s, "XPENDING", "st", "grp", "IDLE", "0", "-", "+", "10");
    await checkXpendingExt(s, "XPENDING", "st", "grp", "IDLE", "-1", "-", "+", "10");
    await checkXinfoStream(s, "XINFO", "STREAM", "st", "FULL");
    await checkXinfoStream(s, "XINFO", "STREAM", "st", "FULL", "COUNT", "1");

    await s.script([
      ["XDEL", "st", "1-0"],
      ["XREADGROUP", "GROUP", "grp", "c1", "STREAMS", "st", "0"],
      ["XCLAIM", "st", "grp", "c2", "0", "1-0"],
      ["XPENDING", "st", "grp"],
      ["XCLAIM", "st", "grp", "c2", "99999", "2-0"],
      ["XCLAIM", "st", "grp", "c2", "0", "2-0", "JUSTID"],
      ["XCLAIM", "st", "grp", "c2", "0", "2-0", "TIME", "1000", "RETRYCOUNT", "5"],
      ["XCLAIM", "st", "grp", "c2", "0", "2-0", "IDLE", "0", "LASTID", "5-0"],
      ["XCLAIM", "st", "grp", "c2", "0", "2-0", "BADOPT"],
      ["XCLAIM", "st", "grp", "c2", "0", "2-0", "IDLE", "abc"],
      ["XCLAIM", "st", "grp", "c2", "abc", "2-0"],
      ["XCLAIM", "missing", "grp", "c2", "0", "2-0"],
      ["XADD", "st", "6-0", "k", "v6"],
      ["XCLAIM", "st", "grp", "c2", "0", "6-0", "FORCE", "JUSTID"],
      ["XADD", "st", "7-0", "k", "v7"],
      ["XCLAIM", "st", "grp", "c2", "0", "7-0", "FORCE"],
      ["XADD", "st", "8-0", "k", "v8"],
      ["XREADGROUP", "GROUP", "grp", "c1", "STREAMS", "st", ">"],
      ["XDEL", "st", "6-0"],
      ["XAUTOCLAIM", "st", "grp", "c4", "999999", "0-0"],
      ["XAUTOCLAIM", "st", "grp", "c4", "0", "0-0", "COUNT", "2"],
      ["XAUTOCLAIM", "st", "grp", "c1", "0", "(2-0", "COUNT", "1", "JUSTID"],
      ["XAUTOCLAIM", "st", "grp", "c1", "0", "-", "COUNT", "10", "JUSTID"],
      ["XAUTOCLAIM", "st", "grp", "c1", "0", "+"],
      ["XAUTOCLAIM", "st", "grp", "c1", "0", "0-0", "COUNT", "0"],
      ["XAUTOCLAIM", "st", "grp", "c1", "0", "0-0", "FOO"],
      ["XAUTOCLAIM", "missing", "grp", "c1", "0", "0-0"],
      ["XINFO", "GROUPS", "st"],
    ]);

    await checkXpendingExt(s, "XPENDING", "st", "grp", "-", "+", "10");

    await s.script([
      ["XACK", "missing", "grp", "1-0"],
      ["XACK", "missing", "grp", "bad"],
      ["XACK", "st", "nogrp", "1-0"],
      ["XACK", "st", "grp", "2-0", "7-0", "8-0", "99-0"],
      ["XPENDING", "st", "grp"],
      ["XGROUP", "DELCONSUMER", "st", "grp", "c1"],
      ["XGROUP", "DELCONSUMER", "st", "grp", "c2"],
    ]);
    await checkXinfoConsumers(s, "XINFO", "CONSUMERS", "st", "grp");

    await s.script([
      ["XADD", "lg", "1-0", "a", "1"],
      ["XADD", "lg", "2-0", "a", "2"],
      ["XADD", "lg", "3-0", "a", "3"],
      ["XGROUP", "CREATE", "lg", "g0", "0"],
      ["XGROUP", "CREATE", "lg", "gdollar", "$"],
      ["XGROUP", "CREATE", "lg", "gmid", "2-0"],
      ["XGROUP", "CREATE", "lg", "gmid_er", "2-0", "ENTRIESREAD", "2"],
      ["XGROUP", "CREATE", "lg", "gfuture", "9-0"],
      ["XINFO", "GROUPS", "lg"],
      ["XREADGROUP", "GROUP", "g0", "c", "COUNT", "1", "STREAMS", "lg", ">"],
      ["XREADGROUP", "GROUP", "gmid", "c", "COUNT", "1", "STREAMS", "lg", ">"],
      ["XINFO", "GROUPS", "lg"],
      ["XADD", "lg", "4-0", "a", "4"],
      ["XINFO", "GROUPS", "lg"],
      ["XDEL", "lg", "4-0"],
      ["XINFO", "GROUPS", "lg"],
      ["XGROUP", "SETID", "lg", "g0", "$"],
      ["XGROUP", "SETID", "lg", "gmid", "0"],
      ["XINFO", "GROUPS", "lg"],
    ]);
  }));

  test("blocking xreadgroup, keyspace integration, and wrongtype", () => run(async (s) => {
    await s.script([
      ["XGROUP", "CREATE", "bs", "bg", "$", "MKSTREAM"],
    ]);
    const p = await s.peer();
    await p.send("XREADGROUP", "GROUP", "bg", "c1", "BLOCK", "2000", "STREAMS", "bs", ">");
    await Bun.sleep(50);
    await s.cmd("XADD", "bs", "1-0", "k", "v");
    await p.next("XREADGROUP BLOCK > woke on XADD");

    await p.send("XREADGROUP", "GROUP", "bg", "c1", "BLOCK", "2000", "STREAMS", "bs", ">");
    await Bun.sleep(50);
    await s.cmd("XGROUP", "DESTROY", "bs", "bg");
    await p.next("XREADGROUP BLOCK > woke with NOGROUP on XGROUP DESTROY");

    await s.cmd("XGROUP", "CREATE", "bs", "bg", "$");
    await p.send("XREADGROUP", "GROUP", "bg", "c1", "BLOCK", "2000", "STREAMS", "bs", ">");
    await Bun.sleep(50);
    await s.cmd("DEL", "bs");
    await p.next("XREADGROUP BLOCK > woke with NOGROUP on DEL");

    await s.script([
      ["XADD", "sc", "1-0", "a", "1"],
      ["XGROUP", "CREATE", "sc", "g", "0"],
      ["XREADGROUP", "GROUP", "g", "c1", "STREAMS", "sc", ">"],
      ["COPY", "sc", "sc2"],
      ["RENAME", "sc", "sc3"],
      ["EXISTS", "sc"],
      ["TYPE", "sc2"],
      ["TYPE", "sc3"],
      ["DEL", "sc3"],
      ["EXISTS", "sc3"],
    ]);
    await checkXinfoStream(s, "XINFO", "STREAM", "sc2", "FULL");

    const scanRes = decodeResp(await s.cmd("SCAN", "0", "TYPE", "stream"));
    expect(scanRes.kind).toBe("array");
    if (scanRes.kind === "array" && scanRes.items[1]?.kind === "array") {
      expect(scanRes.items[1].items.map((x) => asBulk(x)).toSorted()).toEqual(["sc2"]);
    }

    await s.script([
      ["SET", "str", "hello"],
      ["XADD", "str", "*", "a", "1"],
      ["XADD", "str", "NOMKSTREAM", "*", "a", "1"],
      ["XLEN", "str"],
      ["XRANGE", "str", "-", "+"],
      ["XREVRANGE", "str", "+", "-"],
      ["XDEL", "str", "1-0"],
      ["XTRIM", "str", "MAXLEN", "0"],
      ["XSETID", "str", "1-0"],
      ["XREAD", "STREAMS", "str", "0"],
      ["XGROUP", "CREATE", "str", "g", "0"],
      ["XGROUP", "CREATE", "str", "g", "0", "MKSTREAM"],
      ["XREADGROUP", "GROUP", "g", "c", "STREAMS", "str", ">"],
      ["XACK", "str", "g", "1-0"],
      ["XPENDING", "str", "g"],
      ["XCLAIM", "str", "g", "c", "0", "1-0"],
      ["XAUTOCLAIM", "str", "g", "c", "0", "0-0"],
      ["XINFO", "STREAM", "str"],
      ["XINFO", "GROUPS", "str"],
      ["XINFO", "CONSUMERS", "str", "g"],
    ]);

    expect(isNull(decodeResp(await s.cmd("XREAD", "BLOCK", "50", "STREAMS", "sc2", "$")))).toBe(true);
  }));

  test("xdelex, xackdel, and keepref/delref/acked trimming", () => run(async (s) => {
    await s.script([
      ["XDELEX", "missing", "IDS", "1", "1-0"],
      ["XDELEX", "missing", "IDS", "0"],
      ["XDELEX", "missing", "IDS", "-1"],
      ["XDELEX", "missing", "IDS", "abc"],
      ["XDELEX", "missing", "IDS", "0", "1-0"],
      ["XDELEX", "missing", "IDS", "2", "1-0"],
      ["XDELEX", "missing", "IDS", "1", "1-0", "2-0"],
      ["XDELEX", "missing", "IDS", "1", "bad"],
      ["XDELEX", "missing", "BADOPT", "IDS", "1", "1-0"],
      ["XDELEX", "missing", "KEEPREF", "DELREF", "IDS", "1", "1-0"],
      ["XDELEX", "missing", "1", "1-0"],
      ["XDELEX", "missing", "IDS"],
      ["XACKDEL", "missing", "g", "IDS", "1", "1-0"],
      ["XACKDEL", "missing", "g", "IDS", "0"],
      ["XACKDEL", "missing", "g", "IDS", "-1"],
      ["XACKDEL", "missing", "g", "IDS", "0", "1-0"],
      ["XACKDEL", "missing", "g", "IDS", "2", "1-0", "2-0"],
      ["XACKDEL", "missing", "g", "IDS", "2", "1-0"],
      ["XACKDEL", "missing", "g", "IDS", "1", "1-0", "2-0"],
      ["XACKDEL", "missing", "g", "IDS", "1", "bad"],
      ["XACKDEL", "missing", "g", "BADOPT", "IDS", "1", "1-0"],
      ["XACKDEL", "missing", "g", "KEEPREF", "ACKED", "IDS", "1", "1-0"],
      ["SET", "str", "v"],
      ["XDELEX", "str", "IDS", "1", "1-0"],
      ["XDELEX", "str", "BADOPT", "IDS", "1", "1-0"],
      ["XDELEX", "str", "IDS", "0", "1-0"],
      ["XDELEX", "str", "IDS", "1", "bad"],
      ["XACKDEL", "str", "g", "IDS", "1", "1-0"],
      ["XACKDEL", "str", "g", "BADOPT", "IDS", "1", "1-0"],
      ["XACKDEL", "str", "g", "IDS", "0", "1-0"],
      ["XACKDEL", "str", "g", "IDS", "1", "bad"],
    ]);

    await s.script([
      ["XADD", "s", "1-0", "k", "1"],
      ["XADD", "s", "2-0", "k", "2"],
      ["XADD", "s", "3-0", "k", "3"],
      ["XADD", "s", "4-0", "k", "4"],
      ["XADD", "s", "5-0", "k", "5"],
      ["XADD", "s", "6-0", "k", "6"],
      ["XGROUP", "CREATE", "s", "g1", "0"],
      ["XGROUP", "CREATE", "s", "g2", "0"],
      ["XREADGROUP", "GROUP", "g1", "c1", "COUNT", "3", "STREAMS", "s", ">"],
      ["XREADGROUP", "GROUP", "g2", "c2", "COUNT", "2", "STREAMS", "s", ">"],
      ["XACK", "s", "g1", "1-0", "2-0"],
      ["XACK", "s", "g2", "1-0"],
      ["XDELEX", "s", "IDS", "1", "bad"],
      ["XDELEX", "s", "ACKED", "IDS", "5", "1-0", "2-0", "3-0", "4-0", "99-0"],
      ["XDELEX", "s", "ACKED", "IDS", "4", "0-1", "1-0", "1-5", "99-0"],
      ["XRANGE", "s", "-", "+"],
      ["XDELEX", "s", "IDS", "2", "2-0", "4-0"],
      ["XDELEX", "s", "KEEPREF", "IDS", "2", "5-0", "5-0"],
      ["XPENDING", "s", "g2"],
      ["XDELEX", "s", "DELREF", "IDS", "3", "2-0", "3-0", "99-0"],
      ["XPENDING", "s", "g1"],
      ["XPENDING", "s", "g2"],
    ]);
    await checkXinfoStream(s, "XINFO", "STREAM", "s");

    await s.script([
      ["XADD", "sng", "1-0", "k", "1"],
      ["XDELEX", "sng", "ACKED", "IDS", "1", "1-0"],
      ["XLEN", "sng"],
      ["XADD", "sg", "1-0", "k", "1"],
      ["XADD", "sg", "2-0", "k", "2"],
      ["XGROUP", "CREATE", "sg", "g1", "$"],
      ["XADD", "sg", "3-0", "k", "3"],
      ["XDELEX", "sg", "ACKED", "IDS", "3", "1-0", "2-0", "3-0"],
      ["XRANGE", "sg", "-", "+"],
      ["XADD", "sn", "1-0", "k", "1"],
      ["XADD", "sn", "2-0", "k", "2"],
      ["XGROUP", "CREATE", "sn", "g1", "0"],
      ["XREADGROUP", "GROUP", "g1", "c1", "NOACK", "COUNT", "1", "STREAMS", "sn", ">"],
      ["XDELEX", "sn", "ACKED", "IDS", "2", "1-0", "2-0"],
      ["XADD", "sd", "1-0", "k", "1"],
      ["XGROUP", "CREATE", "sd", "g1", "0"],
      ["XREADGROUP", "GROUP", "g1", "c1", "STREAMS", "sd", ">"],
      ["XDEL", "sd", "1-0"],
      ["XDELEX", "sd", "ACKED", "IDS", "1", "1-0"],
      ["XDELEX", "sd", "DELREF", "IDS", "1", "1-0"],
      ["XPENDING", "sd", "g1"],
    ]);

    await s.script([
      ["XADD", "ad", "1-0", "k", "1"],
      ["XADD", "ad", "2-0", "k", "2"],
      ["XADD", "ad", "3-0", "k", "3"],
      ["XADD", "ad", "4-0", "k", "4"],
      ["XADD", "ad", "5-0", "k", "5"],
      ["XADD", "ad", "6-0", "k", "6"],
      ["XADD", "ad", "7-0", "k", "7"],
      ["XGROUP", "CREATE", "ad", "g1", "0"],
      ["XGROUP", "CREATE", "ad", "g2", "0"],
      ["XREADGROUP", "GROUP", "g1", "c1", "COUNT", "5", "STREAMS", "ad", ">"],
      ["XREADGROUP", "GROUP", "g2", "c2", "COUNT", "4", "STREAMS", "ad", ">"],
      ["XACK", "ad", "g2", "1-0"],
      ["XACKDEL", "ad", "nogrp", "IDS", "1", "1-0"],
      ["XACKDEL", "ad", "nogrp", "IDS", "1", "bad"],
      ["XACKDEL", "ad", "g1", "IDS", "1", "bad"],
      ["XACKDEL", "ad", "g1", "ACKED", "IDS", "5", "1-0", "2-0", "5-0", "6-0", "99-0"],
      ["XACKDEL", "ad", "g1", "IDS", "2", "3-0", "6-0"],
      ["XACKDEL", "ad", "g1", "DELREF", "IDS", "2", "3-0", "4-0"],
      ["XACKDEL", "ad", "g2", "KEEPREF", "IDS", "2", "2-0", "2-0"],
      ["XRANGE", "ad", "-", "+"],
      ["XPENDING", "ad", "g1"],
      ["XPENDING", "ad", "g2"],
      ["XADD", "ad2", "1-0", "k", "1"],
      ["XADD", "ad2", "2-0", "k", "2"],
      ["XADD", "ad2", "3-0", "k", "3"],
      ["XGROUP", "CREATE", "ad2", "g1", "0"],
      ["XGROUP", "CREATE", "ad2", "g2", "0"],
      ["XREADGROUP", "GROUP", "g1", "c1", "STREAMS", "ad2", ">"],
      ["XREADGROUP", "GROUP", "g2", "c2", "STREAMS", "ad2", ">"],
      ["XDEL", "ad2", "1-0", "2-0", "3-0"],
      ["XACKDEL", "ad2", "g1", "KEEPREF", "IDS", "1", "1-0"],
      ["XACKDEL", "ad2", "g1", "DELREF", "IDS", "1", "2-0"],
      ["XACKDEL", "ad2", "g1", "ACKED", "IDS", "1", "3-0"],
      ["XPENDING", "ad2", "g1"],
      ["XPENDING", "ad2", "g2"],
      ["XADD", "adf", "1-0", "k", "1"],
      ["XADD", "adf", "2-0", "k", "2"],
      ["XGROUP", "CREATE", "adf", "g1", "0"],
      ["XCLAIM", "adf", "g1", "c1", "0", "2-0", "FORCE"],
      ["XACKDEL", "adf", "g1", "ACKED", "IDS", "1", "2-0"],
      ["XRANGE", "adf", "-", "+"],
      ["XPENDING", "adf", "g1"],
    ]);

    await s.script([
      ["XADD", "xt", "1-0", "k", "1"],
      ["XADD", "xt", "2-0", "k", "2"],
      ["XADD", "xt", "3-0", "k", "3"],
      ["XADD", "xt", "4-0", "k", "4"],
      ["XADD", "xt", "5-0", "k", "5"],
      ["XADD", "xt", "6-0", "k", "6"],
      ["XGROUP", "CREATE", "xt", "g1", "0"],
      ["XREADGROUP", "GROUP", "g1", "c1", "COUNT", "4", "STREAMS", "xt", ">"],
      ["XACK", "xt", "g1", "1-0", "3-0"],
      ["XTRIM", "xt", "MAXLEN", "2", "ACKED"],
      ["XRANGE", "xt", "-", "+"],
      ["XTRIM", "xt", "MAXLEN", "1", "DELREF"],
      ["XRANGE", "xt", "-", "+"],
      ["XPENDING", "xt", "g1"],
      ["XTRIM", "xt", "KEEPREF", "MAXLEN", "=", "1"],
      ["XTRIM", "xt", "MAXLEN", "=", "1", "KEEPREF", "DELREF"],
      ["XTRIM", "xt", "MAXLEN", "~", "1", "LIMIT", "10", "ACKED"],
      ["XTRIM", "xt", "MAXLEN", "~", "1", "ACKED", "LIMIT", "10"],
      ["XADD", "xa", "KEEPREF", "MAXLEN", "1", "1-0", "k", "v"],
      ["XADD", "xa", "MAXLEN", "1", "KEEPREF", "1-0", "k", "v"],
      ["XADD", "xa", "MAXLEN", "~", "5", "KEEPREF", "LIMIT", "10", "2-0", "k", "v"],
      ["XADD", "xa", "MAXLEN", "~", "5", "LIMIT", "10", "DELREF", "3-0", "k", "v"],
      ["XADD", "xa", "KEEPREF", "DELREF", "4-0", "k", "v"],
      ["XADD", "xa", "MAXLEN", "5", "KEEPREF", "DELREF", "4-0", "k", "v"],
      ["XADD", "xa", "ACKED", "4-0", "k", "v"],
    ]);
    await checkXinfoStream(s, "XINFO", "STREAM", "xt");

    for (let i = 1; i <= 250; i++) await s.cmd("XADD", "big", `${i}-0`, "f", "v");
    await s.cmd("XGROUP", "CREATE", "big", "g1", "0");
    await s.cmd("XREADGROUP", "GROUP", "g1", "c1", "COUNT", "150", "STREAMS", "big", ">");
    const ackIds = Array.from({ length: 150 }, (_, idx) => `${idx + 1}-0`).filter((id) => id !== "50-0");
    await s.cmd("XACK", "big", "g1", ...ackIds);
    await s.script([
      ["XTRIM", "big", "MAXLEN", "~", "120", "ACKED"],
      ["XLEN", "big"],
      ["XRANGE", "big", "-", "+", "COUNT", "2"],
      ["XTRIM", "big", "MAXLEN", "~", "120", "ACKED"],
      ["XTRIM", "big", "MAXLEN", "~", "50", "LIMIT", "30", "DELREF"],
      ["XTRIM", "big", "MAXLEN", "~", "50", "LIMIT", "130", "DELREF"],
      ["XLEN", "big"],
      ["XPENDING", "big", "g1"],
    ]);
  }));

  test("idmp: xcfgset, xadd idmp/idmpauto, xidmprecord, xinfo, copy", () => run(async (s) => {
    await s.script([
      ["XCFGSET", "missing"],
      ["XCFGSET", "missing", "IDMP-DURATION", "50"],
      ["XCFGSET", "missing", "BAD", "1"],
      ["XADD", "s", "1-0", "k", "v"],
      ["XCFGSET", "s"],
      ["XCFGSET", "s", "IDMP-DURATION", "0"],
      ["XCFGSET", "s", "IDMP-DURATION", "-1"],
      ["XCFGSET", "s", "IDMP-DURATION", "86401"],
      ["XCFGSET", "s", "IDMP-DURATION", "86400"],
      ["XCFGSET", "s", "IDMP-DURATION", "1"],
      ["XCFGSET", "s", "IDMP-MAXSIZE", "0"],
      ["XCFGSET", "s", "IDMP-MAXSIZE", "-1"],
      ["XCFGSET", "s", "IDMP-MAXSIZE", "10001"],
      ["XCFGSET", "s", "IDMP-MAXSIZE", "10000"],
      ["XCFGSET", "s", "IDMP-MAXSIZE", "1"],
      ["XCFGSET", "s", "IDMP-DURATION", "abc"],
      ["XCFGSET", "s", "IDMP-DURATION"],
      ["XCFGSET", "s", "FOO", "1"],
      ["XCFGSET", "s", "IDMP-DURATION", "10", "IDMP-DURATION", "20"],
      ["XCFGSET", "s", "IDMP-MAXSIZE", "10", "IDMP-MAXSIZE", "20"],
      ["XCFGSET", "s", "IDMP-DURATION", "0", "IDMP-MAXSIZE", "5"],
      ["XCFGSET", "s", "IDMP-DURATION", "200", "IDMP-MAXSIZE", "50"],
      ["SET", "str", "x"],
      ["XCFGSET", "str", "IDMP-DURATION", "50"],
      ["XIDMPRECORD", "str", "p1", "i1", "1-0"],
    ]);
    await checkXinfoStream(s, "XINFO", "STREAM", "s");

    await s.script([
      ["XADD", "se", "IDMP", "p1", "i1", "1-0", "k", "v"],
      ["XADD", "se", "IDMP", "p1", "i1", "0-0", "k", "v"],
      ["XADD", "se", "IDMP", "p1", "i1", "100-*", "k", "v"],
      ["XADD", "se", "IDMPAUTO", "p1", "1-0", "k", "v"],
      ["XADD", "se", "IDMPAUTO", "p1", "100-*", "k", "v"],
      ["XADD", "se", "IDMP", "p1", "i1", "IDMPAUTO", "p1", "*", "k", "v"],
      ["XADD", "se", "IDMP", "p1", "i1", "IDMP", "p1", "i2", "*", "k", "v"],
      ["XADD", "se", "IDMPAUTO", "p1", "IDMPAUTO", "p2", "*", "k", "v"],
      ["XADD", "se", "IDMP", "p1", "*", "a", "1"],
      ["XADD", "se", "IDMPAUTO", "*", "a", "1"],
      ["XADD", "missing", "NOMKSTREAM", "IDMP", "p1", "i1", "*", "k", "v"],
      ["XADD", "missing", "NOMKSTREAM", "IDMPAUTO", "p1", "*", "k", "v"],
      ["XADD", "str", "IDMP", "p1", "i1", "*", "k", "v"],
    ]);

    const [ri1, di1] = await s.shape("XADD", "id", "IDMP", "p1", "i1", "*", "k", "1");
    const [ri1Dup, di1Dup] = await s.shape("XADD", "id", "IDMP", "p1", "i1", "MAXLEN", "0", "*", "k", "1");
    expect(asBulk(ri1Dup)).toBe(asBulk(ri1));
    expect(asBulk(di1Dup)).toBe(asBulk(di1));
    await s.cmd("XLEN", "id");
    await s.shape("XADD", "id", "IDMP", "p1", "i2", "*", "k", "2");
    await s.shape("XADD", "id", "IDMP", "p2", "i1", "*", "k", "3");
    await checkIdmpInfo(s, "id");

    await Promise.all([s.redis.cmd("XDEL", "id", asBulk(ri1)), s.dura.cmd("XDEL", "id", asBulk(di1))]);
    const [ri1AfterDel, di1AfterDel] = await s.shape("XADD", "id", "IDMP", "p1", "i1", "*", "k", "1");
    expect(asBulk(ri1AfterDel)).toBe(asBulk(ri1));
    expect(asBulk(di1AfterDel)).toBe(asBulk(di1));

    await s.cmd("XCFGSET", "id", "IDMP-DURATION", "200");
    await checkIdmpInfo(s, "id");
    const [ri1AfterCfg, di1AfterCfg] = await s.shape("XADD", "id", "IDMP", "p1", "i1", "*", "k", "1");
    expect(asBulk(ri1AfterCfg)).not.toBe(asBulk(ri1));
    expect(asBulk(di1AfterCfg)).not.toBe(asBulk(di1));
    await s.cmd("XCFGSET", "id", "IDMP-DURATION", "200");
    await checkIdmpInfo(s, "id");

    const [ra1, da1] = await s.shape("XADD", "auto", "IDMPAUTO", "p1", "*", "a", "1", "b", "2");
    const [ra2, da2] = await s.shape("XADD", "auto", "IDMPAUTO", "p1", "*", "b", "2", "a", "1");
    expect(asBulk(ra2)).toBe(asBulk(ra1));
    expect(asBulk(da2)).toBe(asBulk(da1));
    const [ra3, da3] = await s.shape("XADD", "auto", "IDMPAUTO", "p1", "*", "a", "1", "a", "1");
    const [ra4, da4] = await s.shape("XADD", "auto", "IDMPAUTO", "p1", "*", "a", "1");
    expect(asBulk(ra3)).not.toBe(asBulk(ra4));
    expect(asBulk(da3)).not.toBe(asBulk(da4));
    const [ra5, da5] = await s.shape("XADD", "auto", "IDMPAUTO", "p1", "*", "ab", "c");
    const [ra6, da6] = await s.shape("XADD", "auto", "IDMPAUTO", "p1", "*", "a", "bc");
    expect(asBulk(ra5)).not.toBe(asBulk(ra6));
    expect(asBulk(da5)).not.toBe(asBulk(da6));
    const [ra7, da7] = await s.shape("XADD", "auto", "IDMPAUTO", "p2", "*", "a", "1", "b", "2");
    expect(asBulk(ra7)).not.toBe(asBulk(ra1));
    expect(asBulk(da7)).not.toBe(asBulk(da1));
    await checkIdmpInfo(s, "auto");

    await s.cmd("XADD", "ev", "1-0", "k", "0");
    await s.cmd("XCFGSET", "ev", "IDMP-MAXSIZE", "2");
    const [re1, de1] = await s.shape("XADD", "ev", "IDMP", "p1", "i1", "*", "k", "1");
    await s.shape("XADD", "ev", "IDMP", "p1", "i2", "*", "k", "2");
    const [re3, de3] = await s.shape("XADD", "ev", "IDMP", "p1", "i3", "*", "k", "3");
    const [rp2, dp2] = await s.shape("XADD", "ev", "IDMPAUTO", "p2", "*", "k", "4");
    const [re1Retry, de1Retry] = await s.shape("XADD", "ev", "IDMP", "p1", "i1", "*", "k", "1");
    const [re3Retry, de3Retry] = await s.shape("XADD", "ev", "IDMP", "p1", "i3", "*", "k", "3");
    const [rp2Retry, dp2Retry] = await s.shape("XADD", "ev", "IDMPAUTO", "p2", "*", "k", "4");
    expect(asBulk(re1Retry)).not.toBe(asBulk(re1));
    expect(asBulk(de1Retry)).not.toBe(asBulk(de1));
    expect(asBulk(re3Retry)).toBe(asBulk(re3));
    expect(asBulk(de3Retry)).toBe(asBulk(de3));
    expect(asBulk(rp2Retry)).toBe(asBulk(rp2));
    expect(asBulk(dp2Retry)).toBe(asBulk(dp2));

    await s.cmd("XADD", "exp", "1-0", "k", "0");
    await s.cmd("XCFGSET", "exp", "IDMP-DURATION", "1");
    const [rx1, dx1] = await s.shape("XADD", "exp", "IDMP", "p1", "i1", "*", "k", "1");
    await Bun.sleep(2100);
    await checkIdmpInfo(s, "exp");
    const [rx2, dx2] = await s.shape("XADD", "exp", "IDMP", "p1", "i1", "*", "k", "1");
    expect(asBulk(rx2)).not.toBe(asBulk(rx1));
    expect(asBulk(dx2)).not.toBe(asBulk(dx1));

    await s.script([
      ["XADD", "rec", "1-0", "k", "1"],
      ["XADD", "rec", "2-0", "k", "2"],
      ["XCFGSET", "rec", "IDMP-MAXSIZE", "2"],
      ["XIDMPRECORD", "missing", "p1", "i1", "1-0"],
      ["XIDMPRECORD", "rec", "p1", "i1", "bad"],
      ["XIDMPRECORD", "rec", "p1", "i1", "0-0"],
      ["XIDMPRECORD", "rec", "p1", "i1", "99-0"],
      ["XIDMPRECORD", "rec", "p1", "i1", "1-0"],
      ["XIDMPRECORD", "rec", "p1", "i1", "1-0"],
      ["XIDMPRECORD", "rec", "p1", "i1", "2-0"],
      ["XADD", "rec", "IDMP", "p1", "i1", "*", "k", "dup"],
      ["XIDMPRECORD", "rec", "p1", "i2", "1-0"],
      ["XIDMPRECORD", "rec", "p1", "i3", "2-0"],
      ["COPY", "rec", "rec2"],
      ["XADD", "rec2", "IDMP", "p1", "i3", "*", "k", "dup2"],
      ["XDEL", "rec", "1-0"],
      ["XIDMPRECORD", "rec", "p2", "i1", "1-0"],
    ]);
    await checkXinfoStream(s, "XINFO", "STREAM", "rec");
    await checkXinfoStream(s, "XINFO", "STREAM", "rec2");
  }));

  test("xnack, xclaim/xautoclaim/xpending/xinfo nacked support, and blocking wakeup", () => run(async (s) => {
    await s.script([
      ["XADD", "sn", "1-0", "k", "1"],
      ["XADD", "sn", "2-0", "k", "2"],
      ["XADD", "sn", "3-0", "k", "3"],
      ["XADD", "sn", "4-0", "k", "4"],
      ["XADD", "sn", "5-0", "k", "5"],
      ["XADD", "sn", "6-0", "k", "6"],
      ["XADD", "sn", "7-0", "k", "7"],
      ["XADD", "sn", "8-0", "k", "8"],
      ["XADD", "sn", "9-0", "k", "9"],
      ["XGROUP", "CREATE", "sn", "g1", "0"],
      ["XREADGROUP", "GROUP", "g1", "c1", "COUNT", "5", "STREAMS", "sn", ">"],
      ["SET", "str", "x"],
      ["XNACK", "str", "g1", "BADMODE", "IDS", "1", "1-0"],
      ["XNACK", "missing", "g1", "BADMODE", "IDS", "1", "1-0"],
      ["XNACK", "sn", "nogrp", "BADMODE", "IDS", "1", "1-0"],
      ["XNACK", "sn", "g1", "BADMODE", "IDS", "1", "1-0"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "0"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "-1", "1-0"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "abc", "1-0"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "2", "1-0"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "1", "1-0", "2-0"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "1", "bad"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "1", "1-0", "RETRYCOUNT", "-1"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "1", "1-0", "RETRYCOUNT", "abc"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "1", "1-0", "RETRYCOUNT"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "1", "1-0", "BADOPT"],
      ["XNACK", "sn", "g1", "SILENT", "FORCE", "FORCE", "FORCE"],
    ]);

    await s.script([
      ["XNACK", "sn", "g1", "SILENT", "IDS", "1", "1-0"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "1", "1-0"],
      ["XNACK", "sn", "g1", "FAIL", "IDS", "1", "2-0"],
      ["XNACK", "sn", "g1", "FATAL", "IDS", "1", "3-0"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "1", "3-0"],
      ["XNACK", "sn", "g1", "FATAL", "IDS", "1", "3-0"],
      ["XNACK", "sn", "g1", "FAIL", "IDS", "1", "4-0", "RETRYCOUNT", "7"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "2", "5-0", "99-0", "RETRYCOUNT", "0"],
      ["XNACK", "sn", "g1", "SILENT", "FORCE", "IDS", "2", "6-0", "99-0"],
      ["XNACK", "sn", "g1", "FATAL", "IDS", "1", "7-0", "FORCE"],
      ["XDEL", "sn", "8-0"],
      ["XNACK", "sn", "g1", "FAIL", "IDS", "1", "8-0", "FORCE"],
      ["XNACK", "sn", "g1", "SILENT", "IDS", "1", "9-0", "FORCE", "RETRYCOUNT", "3"],
      ["XPENDING", "sn", "g1"],
      ["XINFO", "GROUPS", "sn"],
    ]);

    await checkXpendingExt(s, "XPENDING", "sn", "g1", "-", "+", "20");
    await checkXpendingExt(s, "XPENDING", "sn", "g1", "IDLE", "999999", "-", "+", "20");
    await checkXinfoConsumers(s, "XINFO", "CONSUMERS", "sn", "g1");
    await checkXinfoStream(s, "XINFO", "STREAM", "sn", "FULL");

    await s.script([
      ["XCLAIM", "sn", "g1", "c2", "999999", "1-0", "2-0", "3-0"],
      ["XAUTOCLAIM", "sn", "g1", "c3", "999999", "0-0", "COUNT", "2"],
      ["XACK", "sn", "g1", "6-0"],
      ["XACKDEL", "sn", "g1", "KEEPREF", "IDS", "1", "7-0"],
      ["XDELEX", "sn", "DELREF", "IDS", "1", "9-0"],
      ["XPENDING", "sn", "g1"],
    ]);

    await s.script([
      ["XADD", "se", "1-0", "k", "1"],
      ["XADD", "se", "2-0", "k", "2"],
      ["XGROUP", "CREATE", "se", "g1", "0"],
      ["XREADGROUP", "GROUP", "g1", "", "COUNT", "1", "STREAMS", "se", ">"],
      ["XREADGROUP", "GROUP", "g1", "c1", "COUNT", "1", "STREAMS", "se", ">"],
      ["XNACK", "se", "g1", "FAIL", "IDS", "1", "2-0"],
      ["XPENDING", "se", "g1"],
      ["XGROUP", "DELCONSUMER", "se", "g1", ""],
      ["XPENDING", "se", "g1"],
    ]);
    await checkXpendingExt(s, "XPENDING", "se", "g1", "-", "+", "10");
    await checkXpendingExt(s, "XPENDING", "se", "g1", "-", "+", "10", "");

    await s.script([
      ["XADD", "sb", "1-0", "k", "1"],
      ["XGROUP", "CREATE", "sb", "g1", "0"],
      ["XREADGROUP", "GROUP", "g1", "c1", "STREAMS", "sb", ">"],
    ]);
    const p1 = await s.peer();
    await p1.send("XREADGROUP", "GROUP", "g1", "c2", "BLOCK", "150", "STREAMS", "sb", ">");
    await Bun.sleep(50);
    await s.cmd("XNACK", "sb", "g1", "FAIL", "IDS", "1", "1-0");
    await p1.next("XREADGROUP BLOCK without CLAIM ignores XNACK");

    await p1.send("XREADGROUP", "GROUP", "g1", "c2", "BLOCK", "2000", "CLAIM", "999999", "STREAMS", "sb", ">");
    await Bun.sleep(50);
    await s.cmd("XNACK", "sb", "g1", "FAIL", "IDS", "1", "1-0");
    const [rb, db] = await Promise.all([p1.redis.readReply(), p1.dura.readReply()]);
    const rVal = decodeResp(rb);
    const dVal = decodeResp(db);
    expect(dVal.kind).toBe(rVal.kind);
    const rs = entriesListOf(rVal);
    const ds = entriesListOf(dVal);
    expect(ds.length).toBe(1);
    expect(rs.length).toBe(1);
  }));

  test("xreadgroup claim and blocking claim", () => run(async (s) => {
    await s.script([
      ["XADD", "sc", "1-0", "k", "v1"],
      ["XADD", "sc", "2-0", "k", "v2"],
      ["XADD", "sc", "3-0", "k", "v3"],
      ["XADD", "sc", "4-0", "k", "v4"],
      ["XADD", "sc", "5-0", "k", "v5"],
      ["XADD", "sc", "6-0", "k", "v6"],
      ["XGROUP", "CREATE", "sc", "g1", "0"],
      ["XREADGROUP", "GROUP", "g1", "c1", "CLAIM", "-1", "STREAMS", "sc", ">"],
      ["XREADGROUP", "GROUP", "g1", "c1", "CLAIM", "abc", "STREAMS", "sc", ">"],
      ["XREADGROUP", "GROUP", "g1", "c1", "CLAIM", "9223372036854775808", "STREAMS", "sc", ">"],
      ["XREADGROUP", "GROUP", "g1", "c1", "COUNT", "2", "STREAMS", "sc", ">"],
    ]);
    await Bun.sleep(30);
    await s.script([
      ["XREADGROUP", "GROUP", "g1", "c2", "COUNT", "2", "STREAMS", "sc", ">"],
      ["XNACK", "sc", "g1", "FAIL", "IDS", "1", "3-0"],
      ["XCLAIM", "sc", "g1", "c1", "0", "2-0", "TIME", "1000"],
      ["XCLAIM", "sc", "g1", "c1", "0", "1-0", "TIME", "1000"],
    ]);
    await checkClaimReply(s, "XREADGROUP", "GROUP", "g1", "c3", "CLAIM", "10", "COUNT", "4", "STREAMS", "sc", ">");
    await checkClaimReply(s, "XREADGROUP", "GROUP", "g1", "c3", "CLAIM", "0", "NOACK", "STREAMS", "sc", ">");
    await checkXpendingExt(s, "XPENDING", "sc", "g1", "-", "+", "10");

    await s.script([
      ["XADD", "sd", "1-0", "k", "1"],
      ["XADD", "sd", "2-0", "k", "2"],
      ["XGROUP", "CREATE", "sd", "g1", "0"],
      ["XREADGROUP", "GROUP", "g1", "c1", "STREAMS", "sd", ">"],
      ["XDEL", "sd", "1-0"],
    ]);
    await checkClaimReply(s, "XREADGROUP", "GROUP", "g1", "c2", "COUNT", "1", "CLAIM", "0", "STREAMS", "sd", ">");
    await checkXpendingExt(s, "XPENDING", "sd", "g1", "-", "+", "10");

    await s.script([
      ["XADD", "m1", "1-0", "k", "1"],
      ["XADD", "m1", "2-0", "k", "2"],
      ["XADD", "m2", "1-0", "k", "1"],
      ["XADD", "m2", "2-0", "k", "2"],
      ["XADD", "m3", "1-0", "k", "1"],
      ["XADD", "m3", "2-0", "k", "2"],
      ["XGROUP", "CREATE", "m1", "g1", "0"],
      ["XGROUP", "CREATE", "m2", "g1", "0"],
      ["XGROUP", "CREATE", "m3", "g1", "0"],
      ["XREADGROUP", "GROUP", "g1", "c1", "COUNT", "1", "STREAMS", "m1", "m2", "m3", ">", ">", ">"],
    ]);
    await checkClaimReply(s, "XREADGROUP", "GROUP", "g1", "c1", "CLAIM", "0", "STREAMS", "m1", "m2", "m3", ">", "0", ">");

    await s.script([
      ["XADD", "emp", "1-0", "k", "1"],
      ["XGROUP", "CREATE", "emp", "g1", "$"],
      ["XREADGROUP", "GROUP", "g1", "newc", "CLAIM", "0", "STREAMS", "emp", ">"],
    ]);
    await checkXinfoConsumers(s, "XINFO", "CONSUMERS", "emp", "g1");

    await s.cmd("XGROUP", "CREATE", "bc", "g1", "$", "MKSTREAM");
    const p = await s.peer();
    await p.send("XREADGROUP", "GROUP", "g1", "c1", "BLOCK", "2000", "CLAIM", "5000", "STREAMS", "bc", ">");
    await Bun.sleep(50);
    await s.cmd("XADD", "bc", "1-0", "k", "v1");
    await p.next("XREADGROUP BLOCK CLAIM woke on XADD");
    await s.cmd("XREADGROUP", "GROUP", "g1", "c2", "BLOCK", "20", "CLAIM", "999999", "STREAMS", "bc", ">");
  }));

  test("xread and xreadgroup maxcount and maxsize", () => run(async (s) => {
    await s.script([
      ["XREAD", "MAXCOUNT", "0", "STREAMS", "s", "0"],
      ["XREAD", "MAXCOUNT", "-1", "STREAMS", "s", "0"],
      ["XREAD", "MAXCOUNT", "abc", "STREAMS", "s", "0"],
      ["XREAD", "MAXCOUNT", "9223372036854775808", "STREAMS", "s", "0"],
      ["XREAD", "MAXSIZE", "0", "STREAMS", "s", "0"],
      ["XREAD", "MAXSIZE", "-1", "STREAMS", "s", "0"],
      ["XREAD", "MAXSIZE", "abc", "STREAMS", "s", "0"],
      ["XREAD", "MAXSIZE", "9223372036854775808", "STREAMS", "s", "0"],
      ["XREADGROUP", "GROUP", "g", "c", "MAXCOUNT", "0", "STREAMS", "s", ">"],
      ["XREADGROUP", "GROUP", "g", "c", "MAXSIZE", "0", "STREAMS", "s", ">"],
    ]);

    for (let i = 1; i <= 14; i++) await s.cmd("XADD", "s1", `${i}-0`, "a", "1");
    await s.cmd("XADD", "s2", "1-0", "b", "2");
    await s.cmd("XADD", "s2", "2-0", "c", "3");
    await s.script([
      ["XREAD", "MAXCOUNT", "3", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "COUNT", "2", "MAXCOUNT", "3", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "COUNT", "0", "MAXCOUNT", "2", "STREAMS", "s1", "0"],
      ["XREAD", "MAXCOUNT", "1", "STREAMS", "s1", "s2", "+", "+"],
      ["XREAD", "MAXSIZE", "1", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "MAXSIZE", "42", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "MAXSIZE", "43", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "MAXSIZE", "44", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "MAXSIZE", "323", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "MAXSIZE", "324", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "MAXSIZE", "456", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "MAXSIZE", "457", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "MAXSIZE", "468", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "MAXSIZE", "469", "STREAMS", "s1", "s2", "0", "0"],
      ["XREAD", "MAXSIZE", "50", "STREAMS", "s1", "s2", "+", "+"],
      ["XREAD", "MAXSIZE", "60", "STREAMS", "s1", "s2", "+", "+"],
    ]);

    await s.script([
      ["XADD", "g1", "1-0", "a", "1"],
      ["XADD", "g1", "2-0", "b", "2"],
      ["XADD", "g1", "3-0", "c", "3"],
      ["XADD", "g2", "1-0", "d", "4"],
      ["XADD", "g2", "2-0", "e", "5"],
      ["XGROUP", "CREATE", "g1", "grp", "0"],
      ["XGROUP", "CREATE", "g2", "grp", "0"],
      ["XGROUP", "CREATE", "g0", "grp", "0", "MKSTREAM"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXCOUNT", "2", "STREAMS", "g1", "g2", ">", ">"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXCOUNT", "3", "STREAMS", "g1", "g2", ">", ">"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXCOUNT", "3", "STREAMS", "g1", "g2", "0", "0"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXSIZE", "1", "STREAMS", "g0", "g1", "g2", "0", "0", "0"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXSIZE", "74", "STREAMS", "g1", "g2", "0", "0"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXSIZE", "105", "STREAMS", "g1", "g2", "0", "0"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXSIZE", "140", "STREAMS", "g1", "g2", "0", "0"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXSIZE", "152", "STREAMS", "g1", "g2", "0", "0"],
      ["XDEL", "g1", "1-0"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXSIZE", "23", "STREAMS", "g1", "0"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXSIZE", "24", "STREAMS", "g1", "0"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXSIZE", "29", "STREAMS", "g1", "0"],
      ["XREADGROUP", "GROUP", "grp", "c1", "MAXSIZE", "30", "STREAMS", "g1", "0"],
    ]);

    for (const sz of [47, 48, 51, 52]) {
      await s.script([
        ["XADD", `mc${sz}`, "1-0", "a", "1"],
        ["XADD", `mc${sz}`, "2-0", "b", "2"],
        ["XGROUP", "CREATE", `mc${sz}`, "g", "0"],
        ["XREADGROUP", "GROUP", "g", "c1", "CLAIM", "0", "MAXSIZE", String(sz), "STREAMS", `mc${sz}`, ">"],
      ]);
    }
    await s.script([
      ["XADD", "mcx1", "1-0", "a", "1"],
      ["XADD", "mcx1", "2-0", "b", "2"],
      ["XADD", "mcx2", "1-0", "a", "1"],
      ["XADD", "mcx2", "2-0", "b", "2"],
      ["XGROUP", "CREATE", "mcx1", "g", "0"],
      ["XGROUP", "CREATE", "mcx2", "g", "0"],
      ["XREADGROUP", "GROUP", "g", "c1", "COUNT", "1", "STREAMS", "mcx1", "mcx2", ">", ">"],
    ]);
    await checkClaimReply(s, "XREADGROUP", "GROUP", "g", "c2", "CLAIM", "0", "MAXCOUNT", "2", "STREAMS", "mcx1", "mcx2", ">", ">");
  }));
});
