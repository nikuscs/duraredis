import { expect, test } from "bun:test";
import { describeDual } from "./dual";
import type { Pair } from "./dual";
import { decodeResp } from "./wire";
import type { RespArg, RespValue } from "./wire";

const dec = new TextDecoder();

function normalizeResp(v: RespValue): string {
  if (v.kind === "map") {
    return `map{${v.entries.map(([k, val]) => `${normalizeResp(k)}=${normalizeResp(val)}`).toSorted().join(",")}}`;
  }
  if (v.kind === "array" || v.kind === "set" || v.kind === "push") return `${v.kind}[${v.items.map(normalizeResp).join(",")}]`;
  if (v.kind === "bulk" || v.kind === "verbatim" || v.kind === "blob-error") return `${v.kind}:${JSON.stringify(dec.decode(v.value))}`;
  if (v.kind === "int") return `int:${v.value}`;
  if ("value" in v) return `${v.kind}:${JSON.stringify(v.value)}`;
  return v.kind;
}

async function sameExpand(s: Pair, ...args: Array<RespArg>) {
  const [rv, dv] = await s.shape(...args);
  expect(normalizeResp(dv)).toEqual(normalizeResp(rv));
}

async function sameJsonReply(s: Pair, ...args: Array<RespArg>) {
  const [rv, dv] = await s.shape(...args);
  expect(rv.kind).toBe("bulk");
  expect(dv.kind).toBe("bulk");
  if (rv.kind !== "bulk" || dv.kind !== "bulk") return;
  expect(JSON.parse(dec.decode(dv.value))).toEqual(JSON.parse(dec.decode(rv.value)));
}

async function checkMemory(s: Pair, ...args: Array<RespArg>) {
  const [rv, dv] = await s.shape(...args);
  if (rv.kind === "int" && dv.kind === "int") {
    expect(dv.value > 0n).toBe(true);
    return;
  }
  expect(rv.kind).toBe("array");
  expect(dv.kind).toBe("array");
  if (rv.kind !== "array" || dv.kind !== "array") return;
  expect(dv.items.length).toBe(rv.items.length);
  for (const item of dv.items) {
    expect(item.kind).toBe("int");
    if (item.kind === "int") expect(item.value > 0n).toBe(true);
  }
}

describeDual("JSON (RedisJSON) vs redis:8", (run) => {
  test("JSON.SET, JSON.GET, JSON.MGET, JSON.MSET", () => run(async (s) => {
    await s.script([
      ["SET", "str", "hello"],
      ["JSON.SET", "str", "$", "1"],
      ["JSON.SET", "str", ".", "1"],
      ["JSON.GET", "str"],
      ["JSON.SET", "nx", "$", "1", "XX"],
      ["JSON.SET", "nx", "$", "1", "NX"],
      ["JSON.SET", "nx", "$", "2", "NX"],
      ["JSON.SET", "nx", "$", "2", "XX"],
      ["JSON.SET", "nx", "$", "3", "NX", "XX"],
      ["JSON.SET", "nx", "$", "3", "BAD"],
      ["JSON.SET", "newsub", "$.a", "1"],
      ["JSON.SET", "newsub", ".a", "1"],
      ["JSON.SET", "a", "$", "{\"a\":1,\"b\":2.0,\"c\":true,\"d\":null,\"e\":[1,2],\"f\":\"hi\"}"],
      ["JSON.GET", "a"],
      ["JSON.GET", "a", "$"],
      ["JSON.GET", "a", "."],
      ["JSON.GET", "a", ""],
      ["JSON.GET", "a", "$.a"],
      ["JSON.GET", "a", ".a"],
      ["JSON.GET", "a", "a"],
      ["JSON.GET", "a", "$.missing"],
      ["JSON.GET", "a", ".missing"],
      ["JSON.GET", "a", ".a", ".missing"],
      ["JSON.GET", "missing"],
      ["JSON.GET", "missing", "$"],
      ["JSON.GET", "missing", "."],
      ["JSON.GET", "a", "INDENT", "\t", "NEWLINE", "\n", "SPACE", " ", "$"],
      ["JSON.GET", "a", "INDENT", "  ", "NEWLINE", "\n", "SPACE", " ", "."],
      ["JSON.GET", "a", "INDENT", "  ", "$"],
      ["JSON.GET", "a", "NEWLINE", "\n", "$"],
      ["JSON.GET", "a", "SPACE", " ", "$"],
      ["JSON.GET", "a", "$", "INDENT", "  "],
      ["JSON.GET", "a", "NOESCAPE", "$"],
      ["JSON.GET", "a", "INDENT"],
      ["JSON.GET", "a", "FORMAT", "STRING", "$"],
      ["JSON.GET", "a", "FORMAT", "EXPAND1", "$"],
      ["JSON.GET", "a", "FORMAT", "EXPAND", "$.missing"],
      ["JSON.GET", "a", "FORMAT", "EXPAND", ".missing"],
      ["JSON.GET", "missing", "FORMAT", "EXPAND", "$"],
      ["JSON.GET", "a", "FORMAT", "BAD", "$"],
    ]);
    await sameExpand(s, "JSON.GET", "a", "FORMAT", "EXPAND", "$");
    await sameExpand(s, "JSON.GET", "a", "FORMAT", "EXPAND", ".");
    await sameExpand(s, "JSON.GET", "a", "FORMAT", "EXPAND", "$.a", "$.e");
    await sameJsonReply(s, "JSON.GET", "a", "$.a", "$.b");
    await sameJsonReply(s, "JSON.GET", "a", ".a", ".b");
    await sameJsonReply(s, "JSON.GET", "a", "$.a", ".b");
    await sameJsonReply(s, "JSON.GET", "a", ".a", "$.b");
    await sameJsonReply(s, "JSON.GET", "a", "$.a", "$.missing");
    await sameJsonReply(s, "JSON.GET", "a", "SPACE", " ", "$.a", "$.b");
    await s.script([
      ["JSON.GET", "a", "$.a", "$.a"],
      ["JSON.SET", "obj", "$", "{\"a\":{\"x\":1},\"b\":{\"x\":2}}"],
      ["JSON.SET", "obj", "$..x", "9"],
      ["JSON.GET", "obj", "$"],
      ["JSON.SET", "obj", "$..y", "5"],
      ["JSON.SET", "obj", "$.a.y", "5", "NX"],
      ["JSON.SET", "obj", "$.a.y", "6", "NX"],
      ["JSON.SET", "obj", "$.a.z", "6", "XX"],
      ["JSON.SET", "obj", "$.missing.deep", "1"],
      ["JSON.SET", "obj", ".missing.deep", "1"],
      ["JSON.SET", "obj", "$.a.x", "badjson"],
      ["JSON.SET", "obj", "$.a", "1", "FORMAT", "JSON"],
      ["JSON.SET", "obj", "$.b", "[1.5,2.5]", "FPHA", "FP32"],
      ["JSON.SET", "arr", "$", "[10,20,30]"],
      ["JSON.SET", "arr", "$[1]", "200"],
      ["JSON.SET", "arr", "$[-1]", "300"],
      ["JSON.SET", "arr", "$[-99]", "100"],
      ["JSON.GET", "arr", "$"],
      ["JSON.SET", "arr", "$[5]", "50"],
      ["JSON.SET", "arr", "[5]", "50"],
      ["JSON.SET", "arr", "$[1]", "21", "NX"],
      ["JSON.SET", "arr", "$[1]", "21", "XX"],
      ["JSON.SET", "emptyarr", "$", "[]"],
      ["JSON.SET", "emptyarr", "$[0]", "1"],
      ["JSON.SET", "emptyarr", "$[-1]", "1"],
      ["JSON.MSET", "m1", "$", "{\"a\":1}", "m2", "$", "{\"a\":2}"],
      ["JSON.MSET", "m1", "$.a", "10", "m1", "$.b", "20"],
      ["JSON.GET", "m1", "$"],
      ["JSON.MSET", "m1", "$.a", "99", "m2", "$", "badjson"],
      ["JSON.MSET", "m1", "$.a", "99", "str", "$", "1"],
      ["JSON.MSET", "m1", "$.a", "99", "mnew", "$.a", "1"],
      ["JSON.MSET", "m1", "$", "1", "m2"],
      ["JSON.GET", "m1", "$"],
      ["JSON.MSET", "m1", "$.a", "30", "m2", "$.missing.deep", "1"],
      ["JSON.GET", "m1", "$"],
      ["JSON.MGET", "m1", "m2", "missing", "str", "$.a"],
      ["JSON.MGET", "m1", "m2", "missing", "str", ".a"],
      ["JSON.MGET", "m1", "m2", "$.missing"],
      ["JSON.MGET", "m1", "m2", ".missing"],
    ]);
  }));

  test("JSON.DEL, JSON.FORGET, JSON.TYPE", () => run(async (s) => {
    await s.script([
      ["SET", "str", "x"],
      ["JSON.SET", "d", "$", "{\"a\":1,\"b\":2,\"c\":3,\"d\":4}"],
      ["JSON.DEL", "d", "$.b"],
      ["JSON.GET", "d", "$"],
      ["JSON.SET", "d2", "$", "{\"a\":[0,1,2,3,4],\"b\":{\"x\":{\"x\":1}}}"],
      ["JSON.DEL", "d2", "$.a[1,3]"],
      ["JSON.DEL", "d2", "$.a[-10]"],
      ["JSON.GET", "d2", "$"],
      ["JSON.DEL", "d2", "$.a[0,0]"],
      ["JSON.GET", "d2", "$"],
      ["JSON.DEL", "d2", "$..x"],
      ["JSON.GET", "d2", "$"],
      ["JSON.DEL", "d2", "$.missing"],
      ["JSON.DEL", "d2", ".missing"],
      ["JSON.DEL", "d2", "$"],
      ["EXISTS", "d2"],
      ["JSON.DEL", "missing"],
      ["JSON.DEL", "missing", "$"],
      ["JSON.DEL", "str"],
      ["JSON.DEL", "str", "$"],
      ["JSON.SET", "d3", "$", "{\"a\":1,\"b\":2}"],
      ["JSON.FORGET", "d3", ".a"],
      ["JSON.FORGET", "d3"],
      ["EXISTS", "d3"],
      ["JSON.SET", "t", "$", "{\"i\":1,\"f\":1.5,\"f0\":1.0,\"s\":\"hi\",\"b\":true,\"n\":null,\"a\":[],\"o\":{},\"big\":9223372036854775807,\"u64\":18446744073709551615}"],
      ["JSON.TYPE", "t"],
      ["JSON.TYPE", "t", "$"],
      ["JSON.TYPE", "t", "."],
      ["JSON.TYPE", "t", "$.*"],
      ["JSON.TYPE", "t", ".i"],
      ["JSON.TYPE", "t", ".f"],
      ["JSON.TYPE", "t", ".f0"],
      ["JSON.TYPE", "t", ".big"],
      ["JSON.TYPE", "t", ".u64"],
      ["JSON.TYPE", "t", "$.missing"],
      ["JSON.TYPE", "t", ".missing"],
      ["JSON.TYPE", "missing"],
      ["JSON.TYPE", "missing", "$"],
      ["JSON.TYPE", "missing", "."],
      ["JSON.TYPE", "str", "$"],
    ]);
  }));

  test("JSON.NUMINCRBY, JSON.NUMMULTBY, JSON.NUMPOWBY", () => run(async (s) => {
    await s.script([
      ["JSON.SET", "n", "$", "{\"a\":1,\"b\":1.5,\"s\":\"hi\",\"c\":[1,2.5,\"x\"],\"i64max\":9223372036854775807,\"i64min\":-9223372036854775808,\"u64\":18446744073709551615,\"neg\":-3}"],
      ["JSON.NUMINCRBY", "n", "$.a", "2"],
      ["JSON.NUMINCRBY", "n", ".a", "2"],
      ["JSON.NUMINCRBY", "n", "$.a", "0.0"],
      ["JSON.TYPE", "n", "$.a"],
      ["JSON.NUMINCRBY", "n", "$.b", "1.5"],
      ["JSON.NUMINCRBY", "n", "$.c[*]", "1"],
      ["JSON.NUMINCRBY", "n", ".s", "1"],
      ["JSON.NUMINCRBY", "n", "$.s", "1"],
      ["JSON.NUMINCRBY", "n", "$.missing", "1"],
      ["JSON.NUMINCRBY", "n", ".missing", "1"],
      ["JSON.NUMINCRBY", "missing", "$", "1"],
      ["JSON.NUMINCRBY", "n", "$.a", "abc"],
      ["JSON.NUMINCRBY", "n", "$.a", "true"],
      ["JSON.NUMINCRBY", "n", "$.a", "\"1\""],
      ["JSON.NUMINCRBY", "n", "$.a", "1e309"],
      ["JSON.NUMINCRBY", "n", "$.i64max", "1"],
      ["JSON.NUMINCRBY", "n", "$.i64min", "-1"],
      ["JSON.NUMINCRBY", "n", "$.u64", "1"],
      ["JSON.NUMINCRBY", "n", "$.a", "1e308"],
      ["JSON.NUMINCRBY", "n", "$.a", "1e308"],
      ["JSON.SET", "nm", "$", "{\"a\":2,\"b\":3.5,\"f\":2.0,\"s\":\"x\",\"big\":1000000000000,\"neg\":-2}"],
      ["JSON.NUMMULTBY", "nm", "$.a", "3"],
      ["JSON.NUMMULTBY", "nm", ".a", "2"],
      ["JSON.NUMMULTBY", "nm", "$.b", "2"],
      ["JSON.NUMMULTBY", "nm", "$.s", "2"],
      ["JSON.NUMMULTBY", "nm", ".s", "2"],
      ["JSON.NUMMULTBY", "nm", "$.big", "1000000000"],
      ["JSON.NUMMULTBY", "nm", "$.big", "1e10"],
      ["JSON.NUMPOWBY", "nm", "$.a", "2"],
      ["JSON.NUMPOWBY", "nm", ".a", "2"],
      ["JSON.NUMPOWBY", "nm", "$.b", "0.5"],
      ["JSON.NUMPOWBY", "nm", "$.f", "-2"],
      ["JSON.NUMPOWBY", "nm", "$.neg", "-1"],
      ["JSON.NUMPOWBY", "nm", "$.neg", "0"],
      ["JSON.NUMPOWBY", "nm", "$.neg", "3"],
      ["JSON.NUMPOWBY", "nm", "$.neg", "100"],
      ["JSON.NUMPOWBY", "nm", "$.neg", "0.5"],
      ["JSON.NUMPOWBY", "nm", "$.s", "2"],
      ["JSON.NUMPOWBY", "nm", ".s", "2"],
    ]);
  }));

  test("JSON.STRAPPEND, JSON.STRLEN, JSON.OBJKEYS, JSON.OBJLEN, JSON.TOGGLE, JSON.CLEAR", () => run(async (s) => {
    await s.script([
      ["JSON.SET", "s", "$", "{\"a\":\"foo\",\"b\":\"héllo🎉\",\"n\":1}"],
      ["JSON.STRLEN", "s", "$.a"],
      ["JSON.STRLEN", "s", ".a"],
      ["JSON.STRLEN", "s", "$.b"],
      ["JSON.STRLEN", "s", ".b"],
      ["JSON.STRLEN", "s", "$.n"],
      ["JSON.STRLEN", "s", ".n"],
      ["JSON.STRLEN", "s", "$.missing"],
      ["JSON.STRLEN", "s", ".missing"],
      ["JSON.STRLEN", "missing"],
      ["JSON.STRLEN", "missing", "$"],
      ["JSON.STRLEN", "missing", "."],
      ["JSON.STRAPPEND", "s", "$.a", "\"bar\""],
      ["JSON.STRAPPEND", "s", ".a", "\"!\""],
      ["JSON.STRAPPEND", "s", "$.b", "\"🚀\""],
      ["JSON.STRAPPEND", "s", "$.*", "\"z\""],
      ["JSON.STRAPPEND", "s", ".n", "\"z\""],
      ["JSON.STRAPPEND", "s", "$.a", "123"],
      ["JSON.STRAPPEND", "s", "$.a", "notjson"],
      ["JSON.SET", "sroot", "$", "\"abc\""],
      ["JSON.STRAPPEND", "sroot", "\"def\""],
      ["JSON.GET", "sroot", "$"],
      ["JSON.STRAPPEND", "missing", "$", "\"a\""],
      ["JSON.SET", "o", "$", "{\"a\":{\"x\":1,\"y\":2},\"b\":{},\"n\":1}"],
      ["JSON.OBJKEYS", "o"],
      ["JSON.OBJKEYS", "o", "$"],
      ["JSON.OBJKEYS", "o", "$.*"],
      ["JSON.OBJKEYS", "o", ".n"],
      ["JSON.OBJKEYS", "o", ".missing"],
      ["JSON.OBJKEYS", "o", "$.missing"],
      ["JSON.OBJKEYS", "missing"],
      ["JSON.OBJKEYS", "missing", "$"],
      ["JSON.OBJLEN", "o"],
      ["JSON.OBJLEN", "o", "$"],
      ["JSON.OBJLEN", "o", "$.*"],
      ["JSON.OBJLEN", "o", ".n"],
      ["JSON.OBJLEN", "o", ".missing"],
      ["JSON.OBJLEN", "o", "$.missing"],
      ["JSON.OBJLEN", "missing"],
      ["JSON.OBJLEN", "missing", "$"],
      ["JSON.SET", "tg", "$", "{\"a\":true,\"b\":false,\"n\":1}"],
      ["JSON.TOGGLE", "tg", "$.a"],
      ["JSON.TOGGLE", "tg", ".a"],
      ["JSON.TOGGLE", "tg", "$.*"],
      ["JSON.TOGGLE", "tg", ".n"],
      ["JSON.TOGGLE", "tg", "$.missing"],
      ["JSON.TOGGLE", "tg", ".missing"],
      ["JSON.TOGGLE", "missing", "$"],
      ["JSON.TOGGLE", "missing", "."],
      ["JSON.SET", "cl", "$", "{\"a\":[1,2],\"b\":{\"x\":1},\"c\":5,\"d\":0,\"e\":0.0,\"nf\":-0.0,\"f\":-1.5,\"s\":\"hi\",\"g\":true,\"h\":null,\"i\":[],\"j\":{}}"],
      ["JSON.CLEAR", "cl", "$.*"],
      ["JSON.GET", "cl", "$"],
      ["JSON.TYPE", "cl", "$.f"],
      ["JSON.CLEAR", "cl", "$"],
      ["JSON.GET", "cl", "$"],
      ["JSON.CLEAR", "missing"],
      ["JSON.CLEAR", "missing", "$"],
    ]);
  }));

  test("JSON array commands", () => run(async (s) => {
    await s.script([
      ["JSON.SET", "a", "$", "{\"x\":[1,2,3],\"y\":[],\"n\":5}"],
      ["JSON.ARRAPPEND", "a", "$.x", "4", "5"],
      ["JSON.ARRAPPEND", "a", ".x", "6"],
      ["JSON.ARRAPPEND", "a", "$.*", "9"],
      ["JSON.ARRAPPEND", "a", ".n", "9"],
      ["JSON.ARRAPPEND", "a", "$.missing", "9"],
      ["JSON.ARRAPPEND", "a", ".missing", "9"],
      ["JSON.ARRAPPEND", "a", "$"],
      ["JSON.ARRAPPEND", "missing", "$", "1"],
      ["JSON.ARRLEN", "a", "$.x"],
      ["JSON.ARRLEN", "a", ".x"],
      ["JSON.ARRLEN", "a", "$.*"],
      ["JSON.ARRLEN", "a", ".n"],
      ["JSON.ARRLEN", "missing"],
      ["JSON.ARRLEN", "missing", "$"],
      ["JSON.SET", "idx", "$", "{\"a\":[1,2,3,2,1,\"x\",[1],{\"k\":1,\"m\":2},1.0,true,null,-0.0,0.0],\"n\":1}"],
      ["JSON.ARRINDEX", "idx", "$.a", "2"],
      ["JSON.ARRINDEX", "idx", ".a", "2"],
      ["JSON.ARRINDEX", "idx", "$.a", "2", "2"],
      ["JSON.ARRINDEX", "idx", "$.a", "2", "0", "0"],
      ["JSON.ARRINDEX", "idx", "$.a", "2", "0", "1"],
      ["JSON.ARRINDEX", "idx", "$.a", "2", "0", "2"],
      ["JSON.ARRINDEX", "idx", "$.a", "2", "-5", "-1"],
      ["JSON.ARRINDEX", "idx", "$.a", "1.0"],
      ["JSON.ARRINDEX", "idx", "$.a", "1"],
      ["JSON.ARRINDEX", "idx", "$.a", "-0.0"],
      ["JSON.ARRINDEX", "idx", "$.a", "[1]"],
      ["JSON.ARRINDEX", "idx", "$.a", "{\"m\":2,\"k\":1}"],
      ["JSON.ARRINDEX", "idx", "$.*", "2"],
      ["JSON.ARRINDEX", "idx", ".n", "2"],
      ["JSON.ARRINDEX", "idx", ".missing", "2"],
      ["JSON.ARRINDEX", "idx", "$.missing", "2"],
      ["JSON.ARRINDEX", "idx", "$.a", "1", "x"],
      ["JSON.ARRINDEX", "idx", "$.a", "1", "0", "1", "2"],
      ["JSON.ARRINDEX", "missing", "$", "2"],
      ["JSON.SET", "ins", "$", "{\"a\":[1,2,3],\"b\":[10],\"n\":1}"],
      ["JSON.ARRINSERT", "ins", "$.a", "1", "10", "11"],
      ["JSON.ARRINSERT", "ins", ".a", "-1", "99"],
      ["JSON.ARRINSERT", "ins", "$.a", "100", "5"],
      ["JSON.ARRINSERT", "ins", "$.a", "-100", "5"],
      ["JSON.ARRINSERT", "ins", "$.b", "1", "77"],
      ["JSON.ARRINSERT", "ins", "$.*", "2", "88"],
      ["JSON.GET", "ins", "$"],
      ["JSON.SET", "pop", "$", "{\"a\":[1,2,3,4,5,6],\"e\":[],\"n\":1}"],
      ["JSON.ARRPOP", "pop", "$.a"],
      ["JSON.ARRPOP", "pop", ".a"],
      ["JSON.ARRPOP", "pop", "$.a", "0"],
      ["JSON.ARRPOP", "pop", "$.a", "99"],
      ["JSON.ARRPOP", "pop", "$.a", "-99"],
      ["JSON.ARRPOP", "pop", "$.a", "notint"],
      ["JSON.ARRPOP", "pop", "$.e"],
      ["JSON.ARRPOP", "pop", ".e"],
      ["JSON.ARRPOP", "pop", "$.*"],
      ["JSON.ARRPOP", "pop", ".n"],
      ["JSON.ARRPOP", "pop", "FORMAT", "EXPAND", "$.a"],
      ["JSON.ARRPOP", "pop", "FORMAT", "EXPAND1", "$.a"],
      ["JSON.ARRPOP", "pop", "FORMAT", "STRINGS", "$.a"],
      ["JSON.ARRPOP", "pop", "FORMAT", "BAD", "$.a"],
      ["JSON.ARRPOP", "missing"],
      ["JSON.ARRPOP", "missing", "$"],
    ]);
    for (const [start, stop] of [[-10, -8], [-10, -1], [0, -10], [10, 20], [3, 1], [-1, -3], [1, -1], [0, 0], [-5, -5], [-6, -6], [4, 4], [5, 5]]) {
      await s.cmd("JSON.SET", "tr", "$", "[0,1,2,3,4]");
      await s.cmd("JSON.ARRTRIM", "tr", "$", String(start), String(stop));
      await s.cmd("JSON.GET", "tr", "$");
    }
    await s.script([
      ["JSON.SET", "tr2", "$", "{\"a\":[1,2],\"n\":1}"],
      ["JSON.ARRTRIM", "tr2", "$.*", "0", "1"],
      ["JSON.ARRTRIM", "tr2", ".n", "0", "1"],
    ]);
  }));

  test("JSON.MERGE, JSON.RESP, JSON.DEBUG", () => run(async (s) => {
    await s.script([
      ["JSON.SET", "mg", "$", "{\"a\":1,\"b\":2,\"c\":3,\"d\":4}"],
      ["JSON.MERGE", "mg", "$", "{\"b\":null,\"e\":{\"x\":1,\"y\":null}}"],
      ["JSON.GET", "mg", "$"],
      ["JSON.MERGE", "mg", "$.newfield", "{\"x\":null,\"y\":1}"],
      ["JSON.GET", "mg", "$"],
      ["JSON.MERGE", "mg", "$.missing.deep", "1"],
      ["JSON.MERGE", "mg", "$..missing", "1"],
      ["JSON.MERGE", "mgnew", "$", "{\"a\":1,\"b\":null}"],
      ["JSON.GET", "mgnew", "$"],
      ["JSON.MERGE", "mgsub", "$.a", "1"],
      ["JSON.SET", "mga", "$", "[1,{\"a\":1,\"b\":2}]"],
      ["JSON.MERGE", "mga", "$[0]", "null"],
      ["JSON.MERGE", "mga", "$[1]", "null"],
      ["JSON.GET", "mga", "$"],
      ["JSON.SET", "mgn", "$", "{\"c\":[1,2]}"],
      ["JSON.MERGE", "mgn", "$.c[0]", "null"],
      ["JSON.GET", "mgn", "$"],
      ["JSON.MERGE", "mga", "$", "{}", "extra"],
      ["JSON.SET", "rp", "$", "{\"i\":1,\"f\":1.5,\"s\":\"hi\",\"t\":true,\"fa\":false,\"n\":null,\"a\":[1,\"x\"],\"o\":{\"k\":2},\"u\":18446744073709551615}"],
      ["JSON.RESP", "rp"],
      ["JSON.RESP", "rp", "$"],
      ["JSON.RESP", "rp", "$.i"],
      ["JSON.RESP", "rp", ".i"],
      ["JSON.RESP", "rp", "$.f"],
      ["JSON.RESP", "rp", ".f"],
      ["JSON.RESP", "rp", "$.t"],
      ["JSON.RESP", "rp", ".fa"],
      ["JSON.RESP", "rp", "$.n"],
      ["JSON.RESP", "rp", "$.u"],
      ["JSON.RESP", "rp", "$.missing"],
      ["JSON.RESP", "rp", ".missing"],
      ["JSON.RESP", "missing"],
      ["JSON.RESP", "missing", "$"],
      ["JSON.DEBUG", "HELP"],
      ["JSON.DEBUG", "NOPE"],
      ["JSON.DEBUG", "MEMORY"],
      ["JSON.DEBUG", "MEMORY", "missing"],
      ["JSON.DEBUG", "MEMORY", "missing", "$"],
      ["JSON.DEBUG", "MEMORY", "rp", ".missing"],
      ["JSON.DEBUG", "MEMORY", "rp", "$.missing"],
      ["SET", "str", "x"],
      ["JSON.DEBUG", "MEMORY", "str", "$"],
    ]);
    await checkMemory(s, "JSON.DEBUG", "MEMORY", "rp");
    await checkMemory(s, "JSON.DEBUG", "MEMORY", "rp", "$");
    await checkMemory(s, "JSON.DEBUG", "MEMORY", "rp", "$.*");
  }));

  test("JSONPath engine, legacy path rules, and number/string formatting", () => run(async (s) => {
    const doc = JSON.stringify({
      store: {
        book: [
          { category: "reference", author: "Nigel Rees", title: "Sayings", price: 8.95 },
          { category: "fiction", author: "Evelyn Waugh", title: "Sword", price: 12.99 },
          { category: "fiction", author: "Herman Melville", title: "Moby Dick", isbn: "0-553", price: 8.99 },
          { category: "fiction", author: "J. R. R. Tolkien", title: "LOTR", isbn: "0-395", price: 22.99 },
        ],
        bicycle: { color: "red", price: 399 },
      },
      "a.b": 1,
      "a b": 2,
      "a'b": 3,
      "a\"b": 4,
      "$x": 5,
      "a-b": 6,
      arr: [0, 1, 2, 3, 4, 5],
      nums: [1, 2, 3, 4, 5],
      mix: [1, "1", true, false, null, { a: 1 }, [1, 2]],
      tree: { a: { x: 1, b: { x: 2, y: 20 } }, c: { x: 3, d: [{ x: 4 }, { x: 5 }] }, x: 0 },
    });
    await s.cmd("JSON.SET", "jp", "$", doc);
    const queries = [
      "$.store.book[*].author",
      "$..author",
      "$.store.*",
      "$.store..price",
      "$.tree..x",
      "$.tree..*",
      "$..book[2]",
      "$..book[-1]",
      "$..book[0,1]",
      "$.arr[1:5:2]",
      "$.arr[:2]",
      "$.arr[-2:]",
      "$.arr[1:1]",
      "$.arr[10:20]",
      "$.arr[0:5:0]",
      "$..book[::-1]",
      "$..book[?(@.isbn)]",
      "$..book[?(!@.isbn)]",
      "$..book[?(@.price < 10)]",
      "$..book[?(@.price <= 8.99 && @.category == 'fiction')]",
      "$..book[?(@.category == 'reference' || @.price > 20)]",
      "$..book[?(@.author =~ \"(?i)tolkien\")]",
      "$..book[?(@.price < $.store.bicycle.price)]",
      "$..book[?(@.price + 1 > 10)].title",
      "$..book[?(@.category in [\"reference\"])].title",
      "$..book[?(@.category nin [\"reference\"])].title",
      "$.mix[?(@ == 1)]",
      "$.mix[?(@ == true)]",
      "$.mix[?(@ == null)]",
      "$.mix[?(@)]",
      "$.mix[?(@ subsetof [1, 2, 3])]",
      "$.mix[?(@ anyof [2, 9])]",
      "$.mix[?(@ noneof [9, 10])]",
      "$.mix[?(@ size 2)]",
      "$.mix[?(@ empty false)]",
      "$.nums.length()",
      "$.nums.min()",
      "$.nums.max()",
      "$.nums.avg()",
      "$.nums.sum()",
      "$.nums.stddev()",
      "$.store.bicycle~",
      "$.store.bicycle.keys()",
      "$.store.bicycle.price + 1",
      "$.store.bicycle.price + $.a-b",
      "$[\"a.b\"]",
      "$['a.b']",
      "$[\"a b\"]",
      "$[\"a'b\"]",
      "$['a\"b']",
      "$.$x",
      "$x",
      "$.a-b",
      ".store.book[0].author",
      "store.book[0].author",
      ".[\"a.b\"]",
      "[\"a.b\"]",
      "..author",
      ".store.*",
      "$.",
      "$[",
      "bad..path",
    ];
    for (const q of queries) await s.cmd("JSON.GET", "jp", q);

    const nums = "[0,-0,0.0,-0.0,1,1.0,-1,-1.0,0.1,0.00001,0.000001,1e15,1e16,1e20,9223372036854775807,-9223372036854775808,18446744073709551615,18446744073709551616]";
    await s.cmd("JSON.SET", "nf", "$", nums);
    await s.cmd("JSON.GET", "nf", "$");

    const esc = JSON.stringify({ ctrl: "\u0000\b\t\n\f\r\"\\", slash: "a/b", utf8: "é🎉\u007f" });
    await s.cmd("JSON.SET", "es", "$", esc);
    await s.cmd("JSON.GET", "es", "$");
  }));

  test("keyspace integration and 2 MB limit", () => run(async (s) => {
    await s.cmd("JSON.SET", "ks", "$", "{\"a\":1}");
    await s.cmd("TYPE", "ks");
    await s.cmd("EXPIRE", "ks", "100");
    await s.cmd("JSON.SET", "ks", "$.a", "2");
    await s.approx(2, "TTL", "ks");
    await s.cmd("JSON.MERGE", "ks", "$", "{\"b\":3}");
    await s.approx(2, "TTL", "ks");
    await s.cmd("COPY", "ks", "ks2");
    await s.cmd("JSON.GET", "ks2", "$");
    await s.cmd("RENAME", "ks2", "ks3");
    await s.cmd("JSON.GET", "ks3", "$");
    await s.cmd("DEL", "ks3");
    await s.cmd("EXISTS", "ks3");

    await s.script([
      ["MULTI"],
      ["JSON.SET", "tx", "$", "{\"v\":1}"],
      ["JSON.NUMINCRBY", "tx", "$.v", "4"],
      ["JSON.GET", "tx", "$"],
      ["EXEC"],
    ]);

    const big = JSON.stringify({ data: "x".repeat(2_000_001) });
    const reply = decodeResp(await s.dura.cmd("JSON.SET", "toobig", "$", big));
    expect(reply.kind).toBe("error");
  }));
});
