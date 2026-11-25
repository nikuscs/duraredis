import { expect, test } from "bun:test";
import { describeDual } from "./dual";
import type { Pair } from "./dual";
import { decodeResp } from "./wire";
import type { RespArg } from "./wire";

const dec = new TextDecoder();

async function scandumpRoundtrip(s: Pair, prefix: "BF" | "CF", src: string, dst: string) {
  let iter = "0";
  const chunks: Array<{ iter: string; data: Uint8Array }> = [];
  for (let step = 0; step < 32; step++) {
    const raw = await s.cmd(`${prefix}.SCANDUMP`, src, iter);
    const val = decodeResp(raw);
    expect(val.kind).toBe("array");
    if (val.kind !== "array") break;
    const [nextVal, dataVal] = val.items;
    expect(nextVal.kind).toBe("int");
    if (nextVal.kind !== "int") break;
    iter = String(nextVal.value);
    if (iter === "0") {
      if (prefix === "CF") expect(dataVal.kind === "null-bulk" || dataVal.kind === "null").toBe(true);
      else expect(dataVal.kind).toBe("bulk");
      break;
    }
    expect(dataVal.kind).toBe("bulk");
    if (dataVal.kind !== "bulk") break;
    chunks.push({ iter, data: dataVal.value });
  }
  for (const c of chunks) await s.cmd(`${prefix}.LOADCHUNK`, dst, c.iter, c.data);
}

describeDual("probabilistic data types (RedisBloom) vs redis:8", (run) => {
  test("bloom filter commands, scaling, scandump/loadchunk, and >2MB storage", () => run(async (s) => {
    await s.script([
      ["BF.RESERVE", "bf1", "0.01", "100"],
      ["BF.RESERVE", "bf1", "0.01", "100"],
      ["BF.RESERVE", "bf_cap", "0.5", "100"],
      ["BF.RESERVE", "bf_ns", "0.01", "10", "NONSCALING"],
      ["BF.RESERVE", "bf_exp0", "0.01", "10", "EXPANSION", "0"],
      ["BF.RESERVE", "bf_extra", "0.01", "10", "EXTRA", "IGNORED"],
      ["BF.RESERVE", "bf_e1", "0", "100"],
      ["BF.RESERVE", "bf_e2", "1", "100"],
      ["BF.RESERVE", "bf_e3", "abc", "100"],
      ["BF.RESERVE", "bf_e4", "0.01", "0"],
      ["BF.RESERVE", "bf_e5", "0.01", "100", "NONSCALING", "EXPANSION", "2"],
      ["BF.RESERVE", "bf_e6", "0.01", "100", "EXPANSION"],
      ["BF.RESERVE", "bf_e7", "0.01", "100", "EXPANSION", "bad"],
      ["BF.RESERVE", "bf_e8", "0.01", "100", "EXPANSION", "99999"],
      ["BF.INFO", "bf1"],
      ["BF.INFO", "bf1", "CAPACITY"],
      ["BF.INFO", "bf1", "SIZE"],
      ["BF.INFO", "bf1", "FILTERS"],
      ["BF.INFO", "bf1", "ITEMS"],
      ["BF.INFO", "bf1", "EXPANSION"],
      ["BF.INFO", "bf1", "BOGUS"],
      ["BF.INFO", "bf_ns"],
      ["BF.INFO", "bf_ns", "EXPANSION"],
      ["BF.INFO", "bf_exp0", "EXPANSION"],
      ["BF.INFO", "missing"],
      ["BF.DEBUG", "bf1"],
      ["BF.DEBUG", "bf_cap"],
      ["BF.DEBUG", "missing"],
      ["BF.CARD", "missing"],
      ["BF.EXISTS", "missing", "a"],
      ["BF.MEXISTS", "missing", "a", "b"],
      ["BF.ADD", "bf1", "alpha"],
      ["BF.ADD", "bf1", "alpha"],
      ["BF.MADD", "bf1", "alpha", "beta", "gamma", "beta"],
      ["BF.EXISTS", "bf1", "alpha"],
      ["BF.EXISTS", "bf1", "nope"],
      ["BF.MEXISTS", "bf1", "alpha", "gamma", "nope"],
      ["BF.CARD", "bf1"],
      ["BF.INFO", "bf1"],
      ["BF.DEBUG", "bf1"],
      ["BF.INSERT", "bf_nc", "NOCREATE", "ITEMS", "a"],
      ["BF.INSERT", "bf_ins", "ERROR", "0.001", "CAPACITY", "25", "EXPANSION", "3", "ITEMS", "x", "y", "x"],
      ["BF.INSERT", "bf_ins2", "NONSCALING", "EXPANSION", "2", "ITEMS", "x"],
      ["BF.INFO", "bf_ins2", "EXPANSION"],
      ["BF.INSERT", "bf_bad1", "ERROR", "1", "ITEMS", "x"],
      ["BF.INSERT", "bf_bad2", "CAPACITY", "0", "ITEMS", "x"],
      ["BF.INSERT", "bf_bad3", "EXPANSION", "-1", "ITEMS", "x"],
      ["BF.INSERT", "bf_bad4", "FOO", "ITEMS", "x"],
      ["BF.INSERT", "bf_bad5", "CAPACITY", "10"],
      ["BF.INSERT", "bf_bad6", "CAPACITY"],
      ["BF.MADD", "bf_ns", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
      ["BF.ADD", "bf_ns", "13"],
      ["BF.CARD", "bf_ns"],
      ["BF.MADD", "bf_ns", "1", "13"],
    ]);

    await s.cmd("BF.RESERVE", "bf_scale", "0.01", "5", "EXPANSION", "2");
    await s.pipeline(Array.from({ length: 30 }, (_, i) => ["BF.ADD", "bf_scale", `item-${i}`]));
    await s.script([
      ["BF.INFO", "bf_scale"],
      ["BF.DEBUG", "bf_scale"],
      ["BF.CARD", "bf_scale"],
      ["BF.MEXISTS", "bf_scale", "item-0", "item-14", "item-29", "missing-item"],
    ]);

    await scandumpRoundtrip(s, "BF", "bf_scale", "bf_copy");
    await s.script([
      ["BF.INFO", "bf_copy"],
      ["BF.DEBUG", "bf_copy"],
      ["BF.MEXISTS", "bf_copy", "item-0", "item-14", "item-29", "missing-item"],
      ["BF.SCANDUMP", "bf1", "x"],
      ["BF.SCANDUMP", "bf1", "-1"],
      ["BF.LOADCHUNK", "bf_l1", "x", "abc"],
      ["BF.LOADCHUNK", "bf_l1", "2", "abc"],
      ["BF.LOADCHUNK", "bf_l1", "1", "short"],
      ["BF.LOADCHUNK", "bf1", "99999", "abc"],
      ["SET", "strk", "v"],
      ["BF.RESERVE", "strk", "0.01", "10"],
      ["BF.ADD", "strk", "a"],
      ["BF.EXISTS", "strk", "a"],
      ["BF.MEXISTS", "strk", "a", "b"],
      ["BF.CARD", "strk"],
      ["BF.INFO", "strk"],
      ["BF.SCANDUMP", "strk", "0"],
    ]);

    await s.script([
      ["BF.RESERVE", "bigbf", "0.001", "1500000"],
      ["BF.ADD", "bigbf", "needle"],
      ["BF.EXISTS", "bigbf", "needle"],
      ["BF.EXISTS", "bigbf", "absent"],
      ["BF.INFO", "bigbf"],
      ["BF.DEBUG", "bigbf"],
    ]);
    await scandumpRoundtrip(s, "BF", "bigbf", "bigbf_clone");
    await s.script([
      ["BF.EXISTS", "bigbf_clone", "needle"],
      ["BF.EXISTS", "bigbf_clone", "absent"],
      ["BF.INFO", "bigbf_clone"],
      ["DEL", "bigbf", "bigbf_clone"],
    ]);
    await s.cmd("BF.RESERVE", "bf_ns0", "0.01", "10", "NONSCALING", "EXPANSION", "0");
    await s.cmd("BF.INFO", "bf_ns0", "expansion");
    await s.cmd("BF.INFO", "bf1", "capacity");
    await s.cmd("BF.INFO", "bf1", "size");
    await s.cmd("BF.INFO", "bf1", "filters");
    await s.cmd("BF.INFO", "bf1", "items");
    await s.cmd("COPY", "bf1", "bf1_sqlcopy");
  }));

  test("cuckoo filter commands, kicks, compaction, scandump/loadchunk, and >2MB storage", () => run(async (s) => {
    await s.script([
      ["CF.RESERVE", "cf1", "100"],
      ["CF.RESERVE", "cf1", "100"],
      ["CF.RESERVE", "cf_opts", "20", "BUCKETSIZE", "4", "MAXITERATIONS", "15", "EXPANSION", "3"],
      ["CF.RESERVE", "cf_exp0", "8", "BUCKETSIZE", "2", "EXPANSION", "0"],
      ["CF.RESERVE", "cf_extra", "8", "FOO", "BAR"],
      ["CF.RESERVE", "cf_b1", "2", "BUCKETSIZE", "2"],
      ["CF.RESERVE", "cf_b2", "bad"],
      ["CF.RESERVE", "cf_b3", "100", "BUCKETSIZE", "0"],
      ["CF.RESERVE", "cf_b4", "100", "MAXITERATIONS", "0"],
      ["CF.RESERVE", "cf_b5", "100", "EXPANSION", "-1"],
      ["CF.INFO", "cf1"],
      ["CF.INFO", "cf_opts"],
      ["CF.DEBUG", "cf_opts"],
      ["CF.INFO", "missing"],
      ["CF.EXISTS", "missing", "a"],
      ["CF.MEXISTS", "missing", "a", "b"],
      ["CF.COUNT", "missing", "a"],
      ["CF.DEL", "missing", "a"],
      ["CF.COMPACT", "missing"],
      ["CF.ADD", "cf1", "foo"],
      ["CF.ADD", "cf1", "foo"],
      ["CF.ADDNX", "cf1", "foo"],
      ["CF.ADDNX", "cf1", "bar"],
      ["CF.EXISTS", "cf1", "foo"],
      ["CF.MEXISTS", "cf1", "foo", "bar", "baz"],
      ["CF.COUNT", "cf1", "foo"],
      ["CF.COUNT", "cf1", "baz"],
      ["CF.DEL", "cf1", "foo"],
      ["CF.COUNT", "cf1", "foo"],
      ["CF.DEL", "cf1", "foo"],
      ["CF.DEL", "cf1", "foo"],
      ["CF.INSERT", "cf_nc", "NOCREATE", "ITEMS", "a"],
      ["CF.INSERT", "cf_i1", "CAPACITY", "16", "ITEMS", "a", "b", "a"],
      ["CF.INSERTNX", "cf_i1", "ITEMS", "a", "b", "c"],
      ["CF.INSERT", "cf_bad", "CAPACITY", "2", "ITEMS", "a"],
      ["CF.INSERT", "cf_bad2", "FOO", "ITEMS", "a"],
      ["CF.INSERT", "cf_bad3", "CAPACITY", "16"],
      ["CF.INSERT", "cf_exp0", "ITEMS", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9", "k10", "k11", "k12"],
      ["CF.INSERTNX", "cf_exp0", "ITEMS", "k1", "z1", "z2", "z3", "z4", "z5", "z6"],
      ["CF.ADD", "cf_exp0", "overflow1"],
      ["CF.ADDNX", "cf_exp0", "overflow2"],
    ]);

    await s.cmd("CF.RESERVE", "cf_grow", "8", "BUCKETSIZE", "2", "MAXITERATIONS", "5", "EXPANSION", "2");
    const items = Array.from({ length: 40 }, (_, i) => `ck-${i}`);
    await s.cmd("CF.INSERT", "cf_grow", "ITEMS", ...items);
    await s.script([
      ["CF.INFO", "cf_grow"],
      ["CF.DEBUG", "cf_grow"],
      ["CF.MEXISTS", "cf_grow", ...items.slice(0, 10), "absent"],
    ]);
    await scandumpRoundtrip(s, "CF", "cf_grow", "cf_clone");
    await s.script([
      ["CF.INFO", "cf_clone"],
      ["CF.DEBUG", "cf_clone"],
      ["CF.MEXISTS", "cf_clone", ...items.slice(0, 10), "absent"],
      ["CF.SCANDUMP", "cf_opts", "0"],
      ["CF.SCANDUMP", "cf_grow", "-1"],
      ["CF.LOADCHUNK", "cf_l1", "0", "abc"],
      ["CF.LOADCHUNK", "cf_l1", "1", "short"],
      ["CF.LOADCHUNK", "cf_l1", "2", "abc"],
      ["CF.LOADCHUNK", "cf_grow", "999999", "abc"],
    ]);

    for (let i = 0; i < 30; i++) await s.cmd("CF.DEL", "cf_grow", items[i]);
    await s.cmd("CF.COMPACT", "cf_grow");
    await s.script([
      ["CF.INFO", "cf_grow"],
      ["CF.MEXISTS", "cf_grow", ...items.slice(30), items[0]],
      ["SET", "strk", "v"],
      ["CF.EXISTS", "strk", "a"],
      ["CF.COUNT", "strk", "a"],
      ["CF.DEL", "strk", "a"],
      ["CF.COMPACT", "strk"],
      ["CF.INFO", "strk"],
    ]);

    await s.script([
      ["CF.RESERVE", "bigcf", "3000000"],
      ["CF.ADD", "bigcf", "big-item"],
      ["CF.EXISTS", "bigcf", "big-item"],
      ["CF.COUNT", "bigcf", "big-item"],
      ["CF.INFO", "bigcf"],
    ]);
    await scandumpRoundtrip(s, "CF", "bigcf", "bigcf_clone");
    await s.script([
      ["CF.EXISTS", "bigcf_clone", "big-item"],
      ["CF.INFO", "bigcf_clone"],
      ["DEL", "bigcf", "bigcf_clone"],
    ]);
  }));

  test("count-min sketch commands", () => run(async (s) => {
    await s.script([
      ["CMS.INITBYDIM", "cm1", "10", "5"],
      ["CMS.INITBYDIM", "cm1", "10", "5"],
      ["CMS.INITBYDIM", "cm_c1", "5", "3", "CELL_SIZE", "1"],
      ["CMS.INITBYDIM", "cm_c2", "5", "3", "CELL_SIZE", "2"],
      ["CMS.INITBYDIM", "cm_c8", "5", "3", "CELL_SIZE", "8"],
      ["CMS.INITBYDIM", "cm_e1", "0", "5"],
      ["CMS.INITBYDIM", "cm_e2", "5", "0"],
      ["CMS.INITBYDIM", "cm_e3", "5", "3", "FOO", "4"],
      ["CMS.INITBYDIM", "cm_e4", "5", "3", "CELL_SIZE", "3"],
      ["CMS.INITBYPROB", "cmp1", "0.01", "0.5"],
      ["CMS.INITBYPROB", "cmp2", "0.01", "0.25"],
      ["CMS.INITBYPROB", "cmp3", "0.01", "0.01", "CELL_SIZE", "8"],
      ["CMS.INITBYPROB", "cmp_e1", "0", "0.1"],
      ["CMS.INITBYPROB", "cmp_e2", "0.1", "1"],
      ["CMS.INFO", "cmp1"],
      ["CMS.INFO", "cmp2"],
      ["CMS.INFO", "cmp3"],
      ["CMS.INFO", "missing"],
      ["CMS.INCRBY", "missing", "a", "1"],
      ["CMS.QUERY", "missing", "a"],
      ["CMS.INCRBY", "cm1", "a", "3", "b", "5", "a", "2"],
      ["CMS.QUERY", "cm1", "a", "b", "c"],
      ["CMS.INFO", "cm1"],
      ["CMS.INCRBY", "cm_c1", "a", "250", "b", "-5", "a", "10", "c", "7"],
      ["CMS.QUERY", "cm_c1", "a", "b", "c"],
      ["CMS.INFO", "cm_c1"],
      ["CMS.INCRBY", "cm_c8", "big", "9007199254740993", "big", "5"],
      ["CMS.QUERY", "cm_c8", "big"],
      ["CMS.INCRBY", "cm_c8", "big", "-9223372036854775808"],
      ["CMS.INCRBY", "cm_c8", "big", "bad"],
      ["CMS.INITBYDIM", "m1", "5", "3"],
      ["CMS.INITBYDIM", "m2", "5", "3"],
      ["CMS.INITBYDIM", "mdst", "5", "3"],
      ["CMS.INCRBY", "m1", "x", "10", "y", "4"],
      ["CMS.INCRBY", "m2", "x", "3", "z", "2"],
      ["CMS.MERGE", "mdst", "2", "m1", "m2"],
      ["CMS.QUERY", "mdst", "x", "y", "z"],
      ["CMS.INFO", "mdst"],
      ["CMS.MERGE", "mdst", "2", "m1", "m2", "WEIGHTS", "2", "-1"],
      ["CMS.QUERY", "mdst", "x", "y", "z"],
      ["CMS.INFO", "mdst"],
      ["CMS.MERGE", "m1", "2", "m1", "m2"],
      ["CMS.QUERY", "m1", "x", "y", "z"],
      ["CMS.MERGE", "mdst", "0", "m1"],
      ["CMS.MERGE", "mdst", "1", "m1", "m2"],
      ["CMS.MERGE", "mdst", "1", "m1", "WEIGHTS", "1", "2"],
      ["CMS.MERGE", "mdst", "1", "cm1"],
      ["CMS.MERGE", "mdst", "1", "m1", "WEIGHTS", "-1"],
      ["CMS.INITBYDIM", "m_cs1", "5", "3", "CELL_SIZE", "1"],
      ["CMS.MERGE", "mdst", "1", "m_cs1"],
      ["SET", "strk", "v"],
      ["CMS.INITBYDIM", "strk", "5", "3"],
      ["CMS.INCRBY", "strk", "a", "1"],
    ]);
  }));

  test("top-k commands", () => run(async (s) => {
    await s.script([
      ["TOPK.RESERVE", "tk_def", "3"],
      ["TOPK.RESERVE", "tk_def", "3"],
      ["TOPK.RESERVE", "tk_bad1", "0"],
      ["TOPK.RESERVE", "tk_bad2", "3", "8", "7", "0"],
      ["TOPK.RESERVE", "tk_bad3", "3", "8", "7", "1.5"],
      ["TOPK.RESERVE", "tk_bad4", "3", "8"],
      ["TOPK.INFO", "tk_def"],
      ["TOPK.INFO", "missing"],
      ["TOPK.ADD", "missing", "a"],
      ["TOPK.QUERY", "missing", "a"],
      ["TOPK.COUNT", "missing", "a"],
      ["TOPK.LIST", "missing"],
      ["TOPK.LIST", "tk_def", "NOPE"],
      ["TOPK.ADD", "tk_def", "a", "b", "c", "a"],
      ["TOPK.LIST", "tk_def"],
      ["TOPK.LIST", "tk_def", "WITHCOUNT"],
      ["TOPK.LIST", "tk_def", "WITH"],
      ["TOPK.QUERY", "tk_def", "a", "b", "z"],
      ["TOPK.COUNT", "tk_def", "a", "b", "z"],
      ["TOPK.INCRBY", "tk_def", "d", "0"],
      ["TOPK.QUERY", "tk_def", "d"],
      ["TOPK.LIST", "tk_def", "WITHCOUNT"],
      ["TOPK.INCRBY", "tk_def", "x", "2", "y", "-1", "z", "5"],
      ["TOPK.COUNT", "tk_def", "x", "y", "z"],
      ["TOPK.INCRBY", "tk_def", "x", "100001"],
      ["TOPK.RESERVE", "tk_det", "3", "4", "3", "1"],
      ["TOPK.ADD", "tk_det", "a", "b", "c", "d", "e", "f", "g", "h", "a", "a"],
      ["TOPK.LIST", "tk_det", "WITHCOUNT"],
      ["TOPK.QUERY", "tk_det", "a", "h", "b", "c"],
      ["TOPK.COUNT", "tk_det", "a", "h", "b", "c"],
      ["TOPK.ADD", "tk_det", new Uint8Array([107, 0, 120]), "n1", "n2", "n3", "n4", "n5", "n6"],
      ["TOPK.LIST", "tk_det", "WITHCOUNT"],
      ["SET", "strk", "v"],
      ["TOPK.RESERVE", "strk", "3"],
      ["TOPK.ADD", "strk", "a"],
      ["TOPK.LIST", "strk"],
    ]);

    await s.cmd("TOPK.RESERVE", "tk_big", "3", "32", "5", "0.9");
    const adds: Array<RespArg> = [];
    for (let i = 0; i < 200; i++) adds.push("hot1", "hot2");
    for (let i = 0; i < 150; i++) adds.push("hot3");
    for (let i = 0; i < 60; i++) adds.push(`noise-${i % 30}`);
    const [, dList] = await s.shape("TOPK.ADD", "tk_big", ...adds);
    expect(dList.kind).toBe("array");
    const [rList, dTop] = await s.shape("TOPK.LIST", "tk_big");
    expect(rList.kind).toBe("array");
    expect(dTop.kind).toBe("array");
    if (rList.kind === "array" && dTop.kind === "array") {
      const rSet = new Set(rList.items.map((x) => (x.kind === "bulk" ? dec.decode(x.value) : "")));
      const dSet = new Set(dTop.items.map((x) => (x.kind === "bulk" ? dec.decode(x.value) : "")));
      expect(dSet).toEqual(rSet);
      expect(dSet).toEqual(new Set(["hot1", "hot2", "hot3"]));
    }
  }));

  test("t-digest commands, compression-on-read, watch, and merge", () => run(async (s) => {
    await s.script([
      ["TDIGEST.CREATE", "td_e"],
      ["TDIGEST.CREATE", "td_e"],
      ["TDIGEST.CREATE", "td_c", "COMPRESSION", "50"],
      ["TDIGEST.CREATE", "td_bad1", "COMPRESSION", "0"],
      ["TDIGEST.CREATE", "td_bad2", "COMPRESSION", "1.5"],
      ["TDIGEST.CREATE", "td_bad3", "FOO", "100"],
      ["TDIGEST.CREATE", "td_bad4", "COMPRESSION", "100", "EXTRA"],
      ["TDIGEST.CREATE", "td_big", "COMPRESSION", "400000000"],
      ["TDIGEST.INFO", "td_e"],
      ["TDIGEST.MIN", "td_e"],
      ["TDIGEST.MAX", "td_e"],
      ["TDIGEST.QUANTILE", "td_e", "0.5"],
      ["TDIGEST.CDF", "td_e", "1"],
      ["TDIGEST.RANK", "td_e", "1"],
      ["TDIGEST.REVRANK", "td_e", "1"],
      ["TDIGEST.BYRANK", "td_e", "0"],
      ["TDIGEST.BYREVRANK", "td_e", "0"],
      ["TDIGEST.TRIMMED_MEAN", "td_e", "0.1", "0.9"],
      ["TDIGEST.INFO", "missing"],
      ["TDIGEST.ADD", "missing", "1"],
      ["TDIGEST.ADD", "td_e", "nan"],
      ["TDIGEST.ADD", "td_e", "inf"],
      ["TDIGEST.ADD", "td_e", "-inf"],
      ["TDIGEST.ADD", "td_e", " 1"],
      ["TDIGEST.QUANTILE", "td_e", "nan"],
      ["TDIGEST.QUANTILE", "td_e", "1.1"],
      ["TDIGEST.BYRANK", "td_e", "-1"],
      ["TDIGEST.BYRANK", "td_e", "bad"],
      ["TDIGEST.TRIMMED_MEAN", "td_e", "0.5", "0.5"],
      ["TDIGEST.TRIMMED_MEAN", "td_e", "0.6", "0.4"],
      ["TDIGEST.ADD", "td_e", "-0.0", "0.1", "1", "2", "3", "3", "1e20", "1e-10"],
      ["TDIGEST.INFO", "td_e"],
      ["TDIGEST.MIN", "td_e"],
      ["TDIGEST.MAX", "td_e"],
      ["TDIGEST.QUANTILE", "td_e", "0", "0.9", "0.1", "0.5", "1"],
      ["TDIGEST.INFO", "td_e"],
      ["TDIGEST.CDF", "td_e", "-inf", "-1", "0", "1", "3", "1e20", "inf"],
      ["TDIGEST.RANK", "td_e", "-inf", "-1", "0", "3", "1e20", "inf"],
      ["TDIGEST.REVRANK", "td_e", "-inf", "-1", "0", "3", "1e20", "inf"],
      ["TDIGEST.BYRANK", "td_e", "0", "1", "4", "7", "8"],
      ["TDIGEST.BYREVRANK", "td_e", "0", "1", "4", "7", "8"],
      ["TDIGEST.TRIMMED_MEAN", "td_e", "0", "0.5"],
      ["TDIGEST.TRIMMED_MEAN", "td_e", "0.1", "0.9"],
      ["TDIGEST.RESET", "td_e"],
      ["TDIGEST.INFO", "td_e"],
      ["TDIGEST.MIN", "td_e"],
    ]);

    await s.cmd("TDIGEST.CREATE", "td10", "COMPRESSION", "10");
    const samples = Array.from({ length: 120 }, (_, i) => String(((i * 37) % 23) + 0.5));
    await s.cmd("TDIGEST.ADD", "td10", ...samples);
    await s.script([
      ["TDIGEST.INFO", "td10"],
      ["TDIGEST.QUANTILE", "td10", "0", "0.1", "0.25", "0.5", "0.75", "0.9", "1"],
      ["TDIGEST.INFO", "td10"],
      ["TDIGEST.CDF", "td10", "0.5", "5.5", "11.5", "22.5"],
      ["TDIGEST.RANK", "td10", "0.5", "5.5", "11.5", "22.5"],
      ["TDIGEST.REVRANK", "td10", "0.5", "5.5", "11.5", "22.5"],
      ["TDIGEST.BYRANK", "td10", "0", "10", "60", "119", "120"],
      ["TDIGEST.BYREVRANK", "td10", "0", "10", "60", "119", "120"],
      ["TDIGEST.TRIMMED_MEAN", "td10", "0.1", "0.9"],
    ]);

    const peer = await s.peer();
    await s.cmd("TDIGEST.CREATE", "tdw");
    await s.cmd("TDIGEST.ADD", "tdw", "1", "2", "3");
    await s.cmd("WATCH", "tdw");
    await peer.cmd("TDIGEST.QUANTILE", "tdw", "0.5");
    await s.script([["MULTI"], ["SET", "w_ok", "1"], ["EXEC"]]);
    await s.cmd("TDIGEST.INFO", "tdw");

    await s.script([
      ["TDIGEST.CREATE", "td_unmerged"],
      ["TDIGEST.ADD", "td_unmerged", "5", "10", "15"],
      ["TDIGEST.BYRANK", "td_unmerged", "0", "3"],
      ["TDIGEST.INFO", "td_unmerged"],
      ["TDIGEST.RANK", "td_unmerged", "1", "20"],
      ["TDIGEST.INFO", "td_unmerged"],
      ["TDIGEST.RESET", "missing"],
      ["TDIGEST.CREATE", "tm1", "COMPRESSION", "50"],
      ["TDIGEST.ADD", "tm1", "1", "2", "3"],
      ["TDIGEST.CREATE", "tm2", "COMPRESSION", "200"],
      ["TDIGEST.ADD", "tm2", "4", "5", "6"],
      ["TDIGEST.MERGE", "tm_out", "2", "tm1", "tm2"],
      ["TDIGEST.INFO", "tm_out"],
      ["TDIGEST.INFO", "tm1"],
      ["TDIGEST.MERGE", "tm_out", "1", "tm1", "OVERRIDE"],
      ["TDIGEST.INFO", "tm_out"],
      ["TDIGEST.MERGE", "tm_out", "2", "tm1", "tm2", "COMPRESSION", "75"],
      ["TDIGEST.INFO", "tm_out"],
      ["TDIGEST.MERGE", "tm1", "1", "tm1"],
      ["TDIGEST.INFO", "tm1"],
      ["TDIGEST.MERGE", "tm_bad", "1", "tm1", "FOO"],
      ["SET", "strk", "v"],
      ["TDIGEST.CREATE", "strk"],
      ["TDIGEST.ADD", "strk", "1"],
      ["TDIGEST.MERGE", "strk", "1", "tm1"],
    ]);
  }));

  test("keyspace commands TYPE, EXISTS, DEL, RENAME, COPY, EXPIRE across all 5 types", () => run(async (s) => {
    await s.script([
      ["BF.ADD", "k_bf", "a"],
      ["CF.ADD", "k_cf", "a"],
      ["CMS.INITBYDIM", "k_cms", "5", "3"],
      ["CMS.INCRBY", "k_cms", "a", "2"],
      ["TOPK.RESERVE", "k_tk", "3"],
      ["TOPK.ADD", "k_tk", "a"],
      ["TDIGEST.CREATE", "k_td"],
      ["TDIGEST.ADD", "k_td", "1", "2"],
      ["TYPE", "k_bf"],
      ["TYPE", "k_cf"],
      ["TYPE", "k_cms"],
      ["TYPE", "k_tk"],
      ["TYPE", "k_td"],
      ["RENAME", "k_bf", "k_bf2"],
      ["RENAME", "k_cf", "k_cf2"],
      ["RENAME", "k_cms", "k_cms2"],
      ["RENAME", "k_tk", "k_tk2"],
      ["RENAME", "k_td", "k_td2"],
      ["BF.EXISTS", "k_bf2", "a"],
      ["CF.EXISTS", "k_cf2", "a"],
      ["CMS.QUERY", "k_cms2", "a"],
      ["TOPK.LIST", "k_tk2", "WITHCOUNT"],
      ["TDIGEST.QUANTILE", "k_td2", "0.5"],
      ["EXPIRE", "k_bf2", "100"],
      ["TTL", "k_bf2"],
      ["DEL", "k_bf2", "k_cf2", "k_cms2", "k_tk2", "k_td2"],
      ["EXISTS", "k_bf2", "k_cf2", "k_cms2", "k_tk2", "k_td2"],
    ]);
    await s.cmd("CMS.INITBYDIM", "k_cms_c", "5", "3");
    await s.cmd("CMS.INCRBY", "k_cms_c", "a", "2");
    await s.cmd("TOPK.RESERVE", "k_tk_c", "3");
    await s.cmd("TOPK.ADD", "k_tk_c", "a");
    await s.cmd("TDIGEST.CREATE", "k_td_c");
    await s.cmd("TDIGEST.ADD", "k_td_c", "1", "2");
    await s.cmd("CF.ADD", "k_cf_c", "a");
    for (const [src, dst] of [["k_cf_c", "k_cf_cp"], ["k_cms_c", "k_cms_cp"], ["k_tk_c", "k_tk_cp"], ["k_td_c", "k_td_cp"]]) await s.cmd("COPY", src, dst);
  }));
});
