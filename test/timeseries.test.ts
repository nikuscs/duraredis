import { expect, test } from "bun:test";
import { describeDual } from "./dual";
import type { Pair } from "./dual";
import type { RespValue } from "./wire";

function pairsOf(v: RespValue): Array<[string, RespValue]> {
  if (v.kind === "map") {
    return v.entries.map(([k, val]) => [k.kind === "simple" ? k.value : "", val]);
  }
  expect(v.kind).toBe("array");
  if (v.kind !== "array") return [];
  const out: Array<[string, RespValue]> = [];
  for (let i = 0; i < v.items.length; i += 2) {
    const k = v.items[i];
    out.push([k.kind === "simple" ? k.value : "", v.items[i + 1]]);
  }
  return out;
}

async function checkInfo(s: Pair, key: string, debug = false) {
  const args = debug ? ["TS.INFO", key, "DEBUG"] : ["TS.INFO", key];
  const [rv, dv] = await s.shape(...args);
  const rp = pairsOf(rv);
  const dp = pairsOf(dv);
  expect(dp.map(([k]) => k)).toEqual(rp.map(([k]) => k));
  for (let i = 0; i < rp.length; i++) {
    const [k, rval] = rp[i];
    const dval = dp[i][1];
    if (k === "memoryUsage") {
      expect(dval.kind).toBe("int");
      if (dval.kind === "int") expect(dval.value).toBeGreaterThan(0n);
    } else {
      expect(dval).toEqual(rval);
    }
  }
}

describeDual("timeseries vs redis:8", (run) => {
  test("create, alter, info, type, keyspace ops and errors", () => run(async (s) => {
    await s.script([
      ["TS.CREATE", "s1"],
      ["TYPE", "s1"],
      ["TS.CREATE", "s2", "RETENTION", "5000", "ENCODING", "UNCOMPRESSED", "CHUNK_SIZE", "128", "DUPLICATE_POLICY", "LAST", "IGNORE", "10", "0.5", "LABELS", "a", "1", "b", "2"],
      ["TS.CREATE", "s3", "UNCOMPRESSED"],
      ["TS.CREATE", "s1"],
      ["TS.ALTER", "s2", "RETENTION", "1000", "CHUNK_SIZE", "256", "DUPLICATE_POLICY", "SUM", "IGNORE", "0", "0", "LABELS", "a", "9", "c", "3"],
      ["TS.ALTER", "s2", "LABELS"],
      ["TS.CREATE", "bad1", "CHUNK_SIZE", "47"],
      ["TS.CREATE", "bad2", "CHUNK_SIZE", "49"],
      ["TS.CREATE", "bad3", "CHUNK_SIZE", "48"],
      ["TS.CREATE", "bad4", "RETENTION", "-1"],
      ["TS.CREATE", "bad5", "DUPLICATE_POLICY", "NOPE"],
      ["TS.CREATE", "bad6", "ENCODING", "NOPE"],
      ["TS.CREATE", "bad7", "IGNORE", "-1", "0"],
      ["TS.CREATE", "bad8", "IGNORE", "0", "-1"],
      ["TS.CREATE", "dup_lbl", "LABELS", "a", "1", "a", "2"],
      ["TS.CREATE", "odd_lbl", "LABELS", "x"],
      ["TS.CREATE", "empty_val", "LABELS", "a", ""],
      ["TS.CREATE", "empty_key", "LABELS", "", "1"],
      ["TS.ALTER", "missing", "RETENTION", "100"],
      ["SET", "str", "v"],
      ["TS.CREATE", "str"],
      ["TS.ALTER", "str", "RETENTION", "100"],
      ["TS.INFO", "missing"],
      ["TS.INFO", "str"],
    ]);
    await checkInfo(s, "s1");
    await checkInfo(s, "s1", true);
    await checkInfo(s, "s2");
    await checkInfo(s, "s2", true);
    await checkInfo(s, "s3");
    await checkInfo(s, "dup_lbl");
    await checkInfo(s, "odd_lbl");
    await s.cmd("TS.CREATE", "iflt", "IGNORE", "10", "0.1");
    await checkInfo(s, "iflt");
    await s.cmd("TS.ADD", "s1", "1000", "1.5");
    await s.cmd("TS.ADD", "s1", "2000", "2");
    await checkInfo(s, "s1");
    await checkInfo(s, "s1", true);
    await s.script([
      ["COPY", "s1", "s1_copy"],
      ["TS.RANGE", "s1_copy", "-", "+"],
      ["RENAME", "s1", "s1_ren"],
      ["TS.RANGE", "s1_ren", "-", "+"],
      ["DEL", "s1_ren"],
      ["TS.INFO", "s1_ren"],
    ]);
  }));

  test("add, madd, incrby, decrby, del, duplicates, ignore, retention and floats", () => run(async (s) => {
    await s.script([
      ["TS.ADD", "auto", "1000", "10", "RETENTION", "5000", "ENCODING", "UNCOMPRESSED", "CHUNK_SIZE", "64", "DUPLICATE_POLICY", "LAST", "LABELS", "k", "v"],
      ["TS.ADD", "auto", "1000", "20"],
      ["TS.GET", "auto"],
      ["TS.ADD", "auto", "1000", "5", "ON_DUPLICATE", "MIN"],
      ["TS.GET", "auto"],
      ["TS.ADD", "auto", "1000", "30", "ON_DUPLICATE", "MAX"],
      ["TS.GET", "auto"],
      ["TS.ADD", "auto", "1000", "12", "ON_DUPLICATE", "SUM"],
      ["TS.GET", "auto"],
      ["TS.ADD", "auto", "1000", "99", "ON_DUPLICATE", "FIRST"],
      ["TS.GET", "auto"],
      ["TS.ADD", "auto", "1000", "99", "ON_DUPLICATE", "BLOCK"],
      ["TS.ADD", "auto", "1000", "nan", "ON_DUPLICATE", "MIN"],
      ["TS.ADD", "auto", "1000", "nan", "ON_DUPLICATE", "MAX"],
      ["TS.ADD", "auto", "1000", "nan", "ON_DUPLICATE", "SUM"],
      ["TS.ADD", "auto", "1000", "nan", "ON_DUPLICATE", "LAST"],
      ["TS.GET", "auto"],
      ["TS.CREATE", "ret", "RETENTION", "1000", "DUPLICATE_POLICY", "LAST"],
      ["TS.ADD", "ret", "1000", "1"],
      ["TS.ADD", "ret", "1500", "2"],
      ["TS.ADD", "ret", "2000", "3"],
      ["TS.ADD", "ret", "2001", "4"],
      ["TS.RANGE", "ret", "-", "+"],
      ["TS.ADD", "ret", "1000", "99"],
      ["TS.ADD", "ret", "1001", "99"],
      ["TS.ADD", "ret", "1500", "20"],
      ["TS.RANGE", "ret", "-", "+"],
    ]);
    await checkInfo(s, "ret");
    await s.script([
      ["TS.CREATE", "ign1", "DUPLICATE_POLICY", "LAST", "IGNORE", "100", "5"],
      ["TS.ADD", "ign1", "1000", "10"],
      ["TS.ADD", "ign1", "1050", "15"],
      ["TS.ADD", "ign1", "1100", "15"],
      ["TS.ADD", "ign1", "1101", "15"],
      ["TS.ADD", "ign1", "1150", "20.1"],
      ["TS.RANGE", "ign1", "-", "+"],
      ["TS.CREATE", "ign2", "DUPLICATE_POLICY", "BLOCK", "IGNORE", "100", "5"],
      ["TS.ADD", "ign2", "1000", "10"],
      ["TS.ADD", "ign2", "1050", "14"],
      ["TS.ADD", "ign2", "1050", "10", "ON_DUPLICATE", "LAST"],
      ["TS.RANGE", "ign2", "-", "+"],
      ["TS.CREATE", "flt"],
      ...["0", "-0", "1", "-1", "0.5", "0.1", "0.01", "0.12345", "1.5", "1e15", "1e20", "1e-10", "100000000", "1234567890123456", "nan", "-nan"].map(
        (v, i) => ["TS.ADD", "flt", String(i + 1), v],
      ),
      ["TS.RANGE", "flt", "-", "+"],
      ["TS.ADD", "flt", "100", "inf"],
      ["TS.ADD", "flt", "100", "-inf"],
      ["TS.ADD", "flt", "-1", "1"],
      ["TS.ADD", "flt", "abc", "1"],
      ["TS.ADD", "flt", "100", "abc"],
      ["TS.CREATE", "m1"],
      ["TS.CREATE", "m2", "DUPLICATE_POLICY", "LAST"],
      ["TS.MADD", "m1", "1000", "1", "m2", "1000", "2", "missing", "1000", "3", "m1", "1000", "4", "m2", "1000", "5"],
      ["TS.MADD", "m1", "1000"],
      ["SET", "str", "x"],
      ["TS.MADD", "str", "1000", "1", "m1", "2000", "9"],
      ["TS.RANGE", "m1", "-", "+"],
      ["TS.RANGE", "m2", "-", "+"],
      ["TS.INCRBY", "inc", "5", "TIMESTAMP", "1000", "LABELS", "t", "inc"],
      ["TS.INCRBY", "inc", "3", "TIMESTAMP", "1000"],
      ["TS.DECRBY", "inc", "2", "TIMESTAMP", "2000"],
      ["TS.INCRBY", "inc", "1", "TIMESTAMP", "1500"],
      ["TS.RANGE", "inc", "-", "+"],
      ["TS.ADD", "inc", "3000", "nan"],
      ["TS.INCRBY", "inc", "5", "TIMESTAMP", "3000"],
      ["TS.CREATE", "d", "RETENTION", "1000"],
      ["TS.ADD", "d", "1000", "1"],
      ["TS.ADD", "d", "1500", "2"],
      ["TS.ADD", "d", "2000", "3"],
      ["TS.DEL", "d", "1000", "1500"],
      ["TS.RANGE", "d", "-", "+"],
      ["TS.DEL", "d", "100", "500"],
      ["TS.DEL", "d", "500", "100"],
      ["TS.DEL", "missing", "0", "100"],
      ["TS.DEL", "str", "0", "100"],
      ["TS.DEL", "d", "-", "+"],
    ]);
  }));

  test("range and revrange with all aggregators, align, buckettimestamp, empty and filters", () => run(async (s) => {
    const aggs = ["avg", "sum", "min", "max", "range", "count", "first", "last", "std.p", "std.s", "var.p", "var.s", "twa", "countnan", "countall"];
    await s.script([
      ["TS.CREATE", "s"],
      ["TS.ADD", "s", "10", "10"],
      ["TS.ADD", "s", "15", "20"],
      ["TS.ADD", "s", "20", "30"],
      ["TS.ADD", "s", "25", "nan"],
      ["TS.ADD", "s", "40", "40"],
      ["TS.ADD", "s", "45", "50"],
      ...aggs.map((a) => ["TS.RANGE", "s", "10", "50", "AGGREGATION", a, "10"]),
      ...aggs.map((a) => ["TS.RANGE", "s", "10", "50", "AGGREGATION", a, "10", "EMPTY"]),
      ["TS.RANGE", "s", "10", "50", "ALIGN", "start", "AGGREGATION", "sum", "10"],
      ["TS.RANGE", "s", "10", "50", "ALIGN", "-", "AGGREGATION", "sum", "10"],
      ["TS.RANGE", "s", "10", "50", "ALIGN", "end", "AGGREGATION", "sum", "10"],
      ["TS.RANGE", "s", "10", "50", "ALIGN", "+", "AGGREGATION", "sum", "10"],
      ["TS.RANGE", "s", "10", "50", "ALIGN", "5", "AGGREGATION", "sum", "10"],
      ["TS.RANGE", "s", "10", "50", "AGGREGATION", "sum", "10", "BUCKETTIMESTAMP", "-"],
      ["TS.RANGE", "s", "10", "50", "AGGREGATION", "sum", "10", "BUCKETTIMESTAMP", "+"],
      ["TS.RANGE", "s", "10", "50", "AGGREGATION", "sum", "10", "BUCKETTIMESTAMP", "~"],
      ["TS.RANGE", "s", "10", "50", "AGGREGATION", "sum", "10", "BUCKETTIMESTAMP", "mid"],
      ["TS.REVRANGE", "s", "10", "50", "AGGREGATION", "sum", "10"],
      ["TS.REVRANGE", "s", "10", "50", "COUNT", "2"],
      ["TS.RANGE", "s", "-", "+", "FILTER_BY_TS", "10", "25", "40"],
      ["TS.RANGE", "s", "-", "+", "FILTER_BY_VALUE", "15", "45"],
      ["TS.RANGE", "s", "-", "+", "FILTER_BY_VALUE", "15", "45", "AGGREGATION", "sum", "10"],
      ["TS.RANGE", "s", "20", "10"],
      ["TS.RANGE", "s", "-", "+", "COUNT", "0"],
      ["TS.RANGE", "s", "-", "+", "ALIGN", "start", "AGGREGATION", "sum", "5"],
      ["TS.RANGE", "s", "-", "+", "ALIGN", "end", "AGGREGATION", "sum", "5"],
      ["TS.RANGE", "s", "-", "+", "ALIGN", "start"],
      ["TS.RANGE", "s", "bad", "+"],
      ["TS.RANGE", "s", "-", "bad"],
      ["TS.RANGE", "s", "-", "+", "AGGREGATION", "nope", "10"],
      ["TS.RANGE", "s", "-", "+", "AGGREGATION", "sum", "0"],
      ["TS.RANGE", "missing", "-", "+"],
      ["TS.CREATE", "tw"],
      ["TS.ADD", "tw", "5", "0"],
      ["TS.ADD", "tw", "15", "20"],
      ["TS.RANGE", "tw", "10", "20", "AGGREGATION", "twa", "10"],
      ["TS.ADD", "tw", "25", "40"],
      ["TS.RANGE", "tw", "10", "20", "AGGREGATION", "twa", "10"],
      ["TS.CREATE", "tw2"],
      ["TS.ADD", "tw2", "40", "40"],
      ["TS.ADD", "tw2", "42", "50"],
      ["TS.RANGE", "tw2", "20", "60", "AGGREGATION", "twa", "10", "EMPTY"],
    ]);
  }));

  test("get, mget, mrange, mrevrange, queryindex, querylabels and groupby", () => run(async (s) => {
    const reducers = ["avg", "sum", "min", "max", "range", "count", "first", "last", "std.p", "std.s", "var.p", "var.s", "twa", "countnan", "countall"];
    await s.script([
      ["TS.CREATE", "ts:b", "LABELS", "env", "prod", "host", "h2", "role", "web"],
      ["TS.CREATE", "ts:a", "LABELS", "env", "prod", "host", "h1", "role", "db"],
      ["TS.CREATE", "ts:c", "LABELS", "env", "dev", "host", "h1"],
      ["TS.CREATE", "ts:d", "LABELS", "env", "prod"],
      ["TS.ADD", "ts:a", "10", "10"],
      ["TS.ADD", "ts:a", "20", "20"],
      ["TS.ADD", "ts:b", "10", "100"],
      ["TS.ADD", "ts:b", "20", "nan"],
      ["TS.ADD", "ts:c", "10", "5"],
      ["TS.GET", "ts:a"],
      ["TS.GET", "ts:d"],
      ["TS.GET", "missing"],
      ["TS.MGET", "FILTER", "env=prod"],
      ["TS.MGET", "WITHLABELS", "FILTER", "env=prod"],
      ["TS.MGET", "SELECTED_LABELS", "env", "missing", "FILTER", "env=prod"],
      ["TS.MGET", "WITHLABELS", "SELECTED_LABELS", "env", "FILTER", "env=prod"],
      ["TS.MGET", "FILTER", "env!=prod"],
      ["TS.QUERYINDEX", "env=prod"],
      ["TS.QUERYINDEX", "env=prod", "host!=h1"],
      ["TS.QUERYINDEX", "env=(prod,dev)", "role="],
      ["TS.QUERYINDEX", "env=prod", "role!="],
      ["TS.QUERYINDEX", "env=prod", "host=(h1,h2)"],
      ["TS.QUERYINDEX", "env=prod", "host!=(h2)"],
      ["TS.QUERYINDEX", "env!=dev"],
      ["TS.QUERYINDEX", "badfilter"],
      ["TS.QUERYLABELS", "LABELS"],
      ["TS.QUERYLABELS", "LABELS", "FILTER", "env=prod"],
      ["TS.QUERYLABELS", "VALUES", "host"],
      ["TS.QUERYLABELS", "VALUES", "host", "FILTER", "env=prod"],
      ["TS.QUERYLABELS", "VALUES", "nonexistent"],
      ["TS.QUERYLABELS", "LABELS", "FILTER", "env!=prod"],
      ["TS.QUERYLABELS", "NOPE"],
      ["TS.QUERYLABELS", "VALUES"],
      ["TS.QUERYLABELS", "LABELS", "FILTER"],
      ["TS.MRANGE", "-", "+", "FILTER", "env=prod"],
      ["TS.MRANGE", "-", "+", "WITHLABELS", "FILTER", "env=prod"],
      ["TS.MRANGE", "-", "+", "SELECTED_LABELS", "env", "role", "FILTER", "env=prod"],
      ["TS.MRANGE", "-", "+", "EXCLUDEEMPTY", "FILTER", "env=prod"],
      ["TS.MREVRANGE", "-", "+", "WITHLABELS", "FILTER", "env=prod"],
      ["TS.MRANGE", "0", "30", "AGGREGATION", "avg", "10", "FILTER", "env=prod"],
      ["TS.MRANGE", "-", "+", "WITHLABELS", "FILTER", "env=prod", "GROUPBY", "env", "REDUCE", "sum"],
      ["TS.MRANGE", "-", "+", "SELECTED_LABELS", "env", "__reducer__", "__source__", "FILTER", "env=prod", "GROUPBY", "env", "REDUCE", "avg"],
      ["TS.MRANGE", "-", "+", "COUNT", "1", "FILTER", "env=prod", "GROUPBY", "env", "REDUCE", "sum"],
      ["TS.MRANGE", "-", "+", "EXCLUDEEMPTY", "FILTER", "env=prod", "GROUPBY", "env", "REDUCE", "sum"],
      ...reducers.map((red) => ["TS.MRANGE", "-", "+", "FILTER", "env=prod", "GROUPBY", "env", "REDUCE", red]),
    ]);
  }));

  test("compaction rules and nrange/nrevrange", () => run(async (s) => {
    await s.script([
      ["TS.CREATE", "src", "DUPLICATE_POLICY", "LAST", "LABELS", "k", "1"],
      ["TS.CREATE", "dst", "LABELS", "k", "2"],
      ["TS.CREATERULE", "src", "dst", "AGGREGATION", "avg", "10"],
      ["TS.ADD", "src", "10", "10"],
      ["TS.ADD", "src", "15", "20"],
      ["TS.RANGE", "dst", "-", "+"],
      ["TS.RANGE", "dst", "-", "+", "LATEST"],
      ["TS.GET", "dst"],
      ["TS.GET", "dst", "LATEST"],
      ["TS.MGET", "LATEST", "FILTER", "k=2"],
      ["TS.MRANGE", "-", "+", "LATEST", "FILTER", "k=2"],
      ["TS.ADD", "src", "20", "30"],
      ["TS.RANGE", "dst", "-", "+"],
      ["TS.RANGE", "dst", "-", "+", "LATEST"],
      ["TS.ADD", "src", "15", "40"],
      ["TS.RANGE", "dst", "-", "+", "LATEST"],
      ["TS.DEL", "src", "15", "15"],
      ["TS.RANGE", "dst", "-", "+", "LATEST"],
      ["TS.DEL", "src", "10", "10"],
      ["TS.RANGE", "dst", "-", "+", "LATEST"],
      ["TS.DEL", "src", "20", "20"],
      ["TS.RANGE", "dst", "-", "+", "LATEST"],
      ["TS.DELETERULE", "src", "dst"],
      ["TS.CREATERULE", "src", "dst", "AGGREGATION", "sum", "10", "7"],
      ["TS.ADD", "src", "2", "10"],
      ["TS.ADD", "src", "10", "20"],
      ["TS.RANGE", "dst", "-", "+", "LATEST"],
      ["RENAME", "dst", "dst2"],
      ["RENAME", "src", "src2"],
    ]);
    await checkInfo(s, "src2");
    await checkInfo(s, "dst2");
    await s.script([
      ["COPY", "src2", "src_copy"],
      ["TS.DEL", "src_copy", "0", "0"],
    ]);
    await checkInfo(s, "src_copy");
    await s.script([
      ["TS.CREATE", "d3"],
      ["TS.CREATERULE", "src2", "src2", "AGGREGATION", "sum", "10"],
      ["TS.CREATERULE", "missing", "d3", "AGGREGATION", "sum", "10"],
      ["TS.CREATERULE", "src2", "dst2", "AGGREGATION", "sum", "10"],
      ["TS.CREATERULE", "dst2", "d3", "AGGREGATION", "sum", "10"],
      ["TS.DELETERULE", "src2", "d3"],
      ["DEL", "dst2"],
    ]);
    await checkInfo(s, "src2");

    await s.script([
      ["TS.CREATE", "na"],
      ["TS.CREATE", "nb"],
      ["TS.ADD", "na", "10", "1"],
      ["TS.ADD", "na", "15", "3"],
      ["TS.ADD", "na", "30", "5"],
      ["TS.ADD", "nb", "10", "10"],
      ["TS.ADD", "nb", "20", "20"],
      ["TS.ADD", "nb", "30", "30"],
      ["TS.NRANGE", "2", "na", "nb", "-", "+"],
      ["TS.NREVRANGE", "2", "na", "nb", "-", "+"],
      ["TS.NRANGE", "2", "na", "nb", "10", "30", "COUNT", "2"],
      ["TS.NREVRANGE", "2", "na", "nb", "10", "30", "COUNT", "2"],
      ["TS.NRANGE", "2", "na", "nb", "10", "30", "AGGREGATION", "sum", "avg", "10"],
      ["TS.NRANGE", "2", "na", "nb", "10", "30", "ALIGN", "5", "AGGREGATION", "sum", "avg", "10"],
      ["TS.NRANGE", "2", "na", "nb", "10", "30", "AGGREGATION", "sum", "avg", "10", "EMPTY"],
      ["TS.NRANGE", "2", "na", "nb", "10", "30", "AGGREGATION", "sum", "avg", "10", "BUCKETTIMESTAMP", "+"],
      ["TS.NREVRANGE", "2", "na", "nb", "10", "30", "AGGREGATION", "sum", "avg", "10"],
      ["TS.NRANGE", "2", "na", "nb", "-", "+", "FILTER_BY_VALUE", "2", "25"],
      ["TS.NRANGE", "2", "na", "nb", "10", "30", "AGGREGATION", "sum", "10"],
      ["TS.NRANGE", "1", "na", "10", "30", "AGGREGATION", "sum", "avg", "10"],
      ["TS.NRANGE", "0", "na", "-", "+"],
      ["TS.NRANGE", "1", "missing", "-", "+"],
    ]);
  }));

  test("ts.read sync and blocking", () => run(async (s) => {
    const peer = await s.peer();
    await s.script([
      ["TS.CREATE", "r"],
      ["TS.READ", "r", "0"],
      ["TS.READ", "r", "-"],
      ["TS.READ", "r", "+"],
      ["TS.READ", "r", "*"],
      ["TS.READ", "missing", "0"],
      ["SET", "str", "v"],
      ["TS.READ", "str", "0"],
      ["TS.ADD", "r", "10", "1"],
      ["TS.ADD", "r", "20", "2"],
      ["TS.ADD", "r", "30", "3"],
      ["TS.READ", "r", "10"],
      ["TS.READ", "r", "15"],
      ["TS.READ", "r", "+"],
      ["TS.READ", "r", "10", "MAX_COUNT", "2"],
      ["TS.READ", "r", "10", "MAX_COUNT", "0"],
      ["TS.READ", "r", "20", "BLOCK", "-1", "1"],
      ["TS.READ", "r", "20", "BLOCK", "50", "0"],
      ["TS.READ", "r", "10", "BLOCK", "50", "5", "MAX_COUNT", "2"],
      ["TS.READ", "r", "40", "BLOCK", "50", "1"],
      ["TS.READ", "r", "20", "BLOCK", "50", "2"],
      ["MULTI"],
      ["TS.READ", "r", "100", "BLOCK", "50", "1"],
      ["EXEC"],
    ]);

    await peer.send("TS.READ", "r", "40", "BLOCK", "2000", "2", "MAX_COUNT", "5");
    await Bun.sleep(50);
    await s.cmd("TS.ADD", "r", "40", "4");
    await Bun.sleep(50);
    await s.cmd("TS.ADD", "r", "50", "5");
    await peer.next("TS.READ BLOCK 2 samples wakeup");

    await peer.send("TS.READ", "r", "60", "BLOCK", "150", "2");
    await Bun.sleep(30);
    await s.cmd("TS.ADD", "r", "60", "6");
    await peer.next("TS.READ BLOCK partial timeout");

    await peer.send("TS.READ", "newk", "0", "BLOCK", "2000", "1");
    await Bun.sleep(30);
    await s.cmd("TS.ADD", "newk", "10", "7");
    await peer.next("TS.READ BLOCK missing key wakeup");

    await peer.send("TS.READ", "r", "+", "BLOCK", "2000", "2");
    await Bun.sleep(30);
    await s.cmd("TS.ADD", "r", "70", "8");
    await peer.next("TS.READ BLOCK + min_count=2 wakeup");
  }));
});
