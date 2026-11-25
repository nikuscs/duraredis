import { expect, test } from "bun:test";
import { describeDual } from "./dual";
import type { Pair } from "./dual";
import { decodeResp } from "./wire";
import type { RespArg, RespValue } from "./wire";

const dec = new TextDecoder();

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomVec(rng: () => number, dim: number): Array<string> {
  return Array.from({ length: dim }, () => (rng() * 2 - 1).toFixed(6));
}

function extractElements(v: RespValue): Array<string> {
  if (v.kind !== "array") throw new Error(`Expected array, got ${v.kind}`);
  return v.items.map((item) => {
    if (item.kind !== "bulk") throw new Error(`Expected bulk, got ${item.kind}`);
    return dec.decode(item.value);
  });
}

function recallAtK(approx: Array<string>, truth: Array<string>): number {
  if (truth.length === 0) return approx.length === 0 ? 1 : 0;
  const set = new Set(truth);
  let hits = 0;
  for (const e of approx) if (set.has(e)) hits++;
  return hits / truth.length;
}

function fp32Bytes(values: Array<number>): Uint8Array {
  const buf = new ArrayBuffer(values.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, values[i], true);
  return new Uint8Array(buf);
}

function asMapObject(v: RespValue): Map<string, RespValue> {
  const out = new Map<string, RespValue>();
  if (v.kind === "map") {
    for (const [k, val] of v.entries) {
      const key = k.kind === "simple" || k.kind === "bulk" ? (typeof k.value === "string" ? k.value : dec.decode(k.value)) : "";
      out.set(key, val);
    }
    return out;
  }
  if (v.kind === "array") {
    for (let i = 0; i < v.items.length; i += 2) {
      const k = v.items[i];
      const key = k.kind === "simple" || k.kind === "bulk" ? (typeof k.value === "string" ? k.value : dec.decode(k.value)) : "";
      out.set(key, v.items[i + 1]);
    }
    return out;
  }
  throw new Error(`Expected map or array, got ${v.kind}`);
}

async function batchAdd(
  s: Pair,
  key: string,
  vectors: Array<{ elem: string; vec: Array<string>; attr?: string }>,
  quant: "Q8" | "NOQUANT" | "BIN",
) {
  const cmds: Array<Array<RespArg>> = vectors.map(({ elem, vec, attr }) => {
    const args: Array<RespArg> = ["VADD", key, "VALUES", String(vec.length), ...vec, elem, quant];
    if (attr !== undefined) args.push("SETATTR", attr);
    return args;
  });
  for (let i = 0; i < cmds.length; i += 50) {
    await Promise.all([
      s.redis.pipeline(cmds.slice(i, i + 50)),
      s.dura.pipeline(cmds.slice(i, i + 50)),
    ]);
  }
}

describeDual("vector sets vs redis:8", (run) => {
  test("missing keys, WRONGTYPE, key lifecycle, and option validation", () => run(async (s) => {
    await s.script([
      ["SET", "str", "hello"],
      ["VCARD", "missing"], ["VCARD", "str"],
      ["VDIM", "missing"], ["VDIM", "str"],
      ["VINFO", "missing"], ["VINFO", "str"],
      ["VEMB", "missing", "e1"], ["VEMB", "str", "e1"], ["VEMB", "missing", "e1", "RAW"],
      ["VEMB", "missing", "e1", "BAD"], ["VEMB", "missing", "e1", "RAW", "EXTRA"],
      ["VGETATTR", "missing", "e1"], ["VGETATTR", "str", "e1"],
      ["VSETATTR", "missing", "e1", "{}"], ["VSETATTR", "str", "e1", "{}"],
      ["VISMEMBER", "missing", "e1"], ["VISMEMBER", "str", "e1"],
      ["VLINKS", "missing", "e1"], ["VLINKS", "str", "e1"], ["VLINKS", "missing", "e1", "WITHSCORES"],
      ["VLINKS", "missing", "e1", "BAD"], ["VLINKS", "missing", "e1", "WITHSCORES", "EXTRA"],
      ["VRANDMEMBER", "missing"], ["VRANDMEMBER", "missing", "0"], ["VRANDMEMBER", "missing", "2"], ["VRANDMEMBER", "missing", "-2"],
      ["VRANDMEMBER", "missing", "bad"], ["VRANDMEMBER", "missing", "1", "2"], ["VRANDMEMBER", "str"],
      ["VRANGE", "missing", "-", "+"], ["VRANGE", "missing", "bad", "+"], ["VRANGE", "missing", "-", "bad"],
      ["VRANGE", "missing", "+", "-"], ["VRANGE", "missing", "-", "+", "bad"], ["VRANGE", "missing", "-", "+", "1", "2"],
      ["VRANGE", "str", "-", "+"],
      ["VREM", "missing", "e1"], ["VREM", "str", "e1"],
      ["VSIM", "missing", "VALUES", "2", "1", "0"],
      ["VSIM", "missing", "ELE", "e1"],
      ["VSIM", "missing", "VALUES", "2", "1", "0", "WITHSCORES"],
      ["VSIM", "missing", "VALUES", "2", "1", "0", "WITHATTRIBS"],
      ["VSIM", "missing", "VALUES", "2", "1", "0", "WITHSCORES", "WITHATTRIBS"],
      ["VSIM", "missing", "VALUES", "2", "1", "0", "BOGUS"],
      ["VSIM", "str", "VALUES", "2", "1", "0"],
      ["VADD", "str", "VALUES", "2", "1", "0", "e1"],
      ["VADD", "k1", "VALUES", "2", "1", "0", "e1", "NOQUANT"],
      ["TYPE", "k1"],
      ["EXISTS", "k1"],
      ["RENAME", "k1", "k2"],
      ["TYPE", "k2"],
      ["VCARD", "k2"],
      ["VDIM", "k2"],
      ["VISMEMBER", "k2", "e1"],
      ["VREM", "k2", "nope"],
      ["VREM", "k2", "e1"],
      ["EXISTS", "k2"],
      ["VREM", "k2", "e1"],
      ["VADD", "kdel", "VALUES", "2", "1", "0", "e1"],
      ["DEL", "kdel"],
      ["EXISTS", "kdel"],
    ]);
  }));

  test("VADD, VEMB, quantization, FP32, REDUCE, updates, and error priority", () => run(async (s) => {
    await s.script([
      ["VADD", "nq", "VALUES", "5", "0.1", "0.2", "0.3", "0.4", "0.5", "e1", "NOQUANT"],
      ["VADD", "nq", "VALUES", "5", "0.5", "0.4", "0.3", "0.2", "0.1", "e2", "NOQUANT", "CAS"],
      ["VEMB", "nq", "e1"],
      ["VEMB", "nq", "e1", "RAW"],
      ["VEMB", "nq", "missing"],
      ["VADD", "nq", "VALUES", "5", "0", "0", "0", "0", "0", "zero", "NOQUANT"],
      ["VEMB", "nq", "zero"],
      ["VEMB", "nq", "zero", "RAW"],
      ["VADD", "nq", "VALUES", "5", "+1", "1e2", "0x10", "inf", "-inf", "special", "NOQUANT"],
      ["VEMB", "nq", "special"],
      ["VEMB", "nq", "special", "RAW"],

      ["VADD", "fp", "FP32", fp32Bytes([1.5, -2.5, 0.25]), "e1", "NOQUANT"],
      ["VEMB", "fp", "e1"],
      ["VADD", "fpnan", "FP32", fp32Bytes([Number.NaN, 1]), "e1", "NOQUANT"],
      ["VEMB", "fpnan", "e1"],
      ["VADD", "fpbad", "FP32", new Uint8Array([1, 2, 3]), "e1"],
      ["VADD", "fpbad", "FP32", new Uint8Array(0), "e1"],

      ["VADD", "q8", "VALUES", "17", "1", String(1 / 254), String(3 / 254), String(5 / 254), String(7 / 254),
        String(-1 / 254), String(-3 / 254), String(-5 / 254), String(-7 / 254),
        String(0.5 / 127), String(-0.5 / 127), String(1.5 / 127), String(-1.5 / 127),
        String(2.5 / 127), String(-2.5 / 127), String(126.5 / 127), String(-126.5 / 127), "r1", "Q8"],
      ["VEMB", "q8", "r1"],
      ["VEMB", "q8", "r1", "RAW"],
      ["VADD", "q8z", "VALUES", "3", "0", "0", "0", "z", "Q8"],
      ["VEMB", "q8z", "z"],
      ["VEMB", "q8z", "z", "RAW"],

      ["VADD", "bin4", "VALUES", "4", "1", "-2", "0", "3", "e1", "BIN"],
      ["VADD", "bin4", "VALUES", "4", "-1", "-1", "-1", "1", "e2", "BIN"],
      ["VADD", "bin4", "VALUES", "4", "0", "0", "0", "0", "z", "BIN"],
      ["VEMB", "bin4", "e1"],
      ["VEMB", "bin4", "e1", "RAW"],
      ["VEMB", "bin4", "z"],
      ["VEMB", "bin4", "z", "RAW"],
      ["VADD", "bin65", "VALUES", "65", ...Array.from({ length: 65 }, (_, i) => (i % 3 === 0 ? "1" : "-1")), "e1", "BIN"],
      ["VEMB", "bin65", "e1", "RAW"],
      ["VADD", "bin129", "VALUES", "129", ...Array.from({ length: 129 }, (_, i) => (i % 2 === 0 ? "1" : "-1")), "e1", "BIN"],
      ["VEMB", "bin129", "e1", "RAW"],

      ["VADD", "red", "REDUCE", "3", "VALUES", "6", "1", "0", "0", "0", "0", "0", "e1", "NOQUANT"],
      ["VADD", "red", "REDUCE", "3", "VALUES", "6", "0", "1", "0", "0", "0", "0", "e2", "NOQUANT"],
      ["VDIM", "red"],
      ["VEMB", "red", "e1"],
      ["VEMB", "red", "e2"],
      ["VADD", "red", "VALUES", "6", "0", "0", "1", "0", "0", "0", "e3", "NOQUANT"],
      ["VADD", "red", "REDUCE", "2", "VALUES", "6", "0", "0", "1", "0", "0", "0", "e3", "NOQUANT"],
      ["VADD", "red", "REDUCE", "3", "VALUES", "5", "0", "0", "1", "0", "0", "e3", "NOQUANT"],
      ["VADD", "red", "VALUES", "3", "1", "0", "0", "e3", "NOQUANT"],
      ["VADD", "red4", "REDUCE", "4", "VALUES", "4", "1", "2", "3", "4", "e1"],
      ["VEMB", "red4", "e1"],
      ["VEMB", "red4", "e1", "RAW"],
      ["VADD", "nq", "REDUCE", "2", "VALUES", "5", "1", "0", "0", "0", "0", "e9", "NOQUANT"],

      ["VADD", "upd", "VALUES", "2", "1", "0", "e1", "NOQUANT", "SETATTR", '{"a":1}'],
      ["VADD", "upd", "VALUES", "2", "0", "1", "e1", "NOQUANT"],
      ["VGETATTR", "upd", "e1"],
      ["VEMB", "upd", "e1"],
      ["VADD", "upd", "VALUES", "2", "1", "1", "e1", "NOQUANT", "SETATTR", '{"a":2}'],
      ["VGETATTR", "upd", "e1"],
      ["VADD", "upd", "VALUES", "2", "1", "1", "e1", "NOQUANT", "SETATTR", ""],
      ["VGETATTR", "upd", "e1"],

      ["VADD", "binel", "VALUES", "2", "1", "0", "", "NOQUANT"],
      ["VADD", "binel", "VALUES", "2", "0", "1", new Uint8Array([0x61, 0x00, 0x62]), "NOQUANT"],
      ["VISMEMBER", "binel", ""],
      ["VISMEMBER", "binel", new Uint8Array([0x61, 0x00, 0x62])],
      ["VEMB", "binel", ""],
      ["VRANGE", "binel", "-", "+"],

      ["VADD", "ex", "VALUES", "3", "1", "0", "0", "e1", "NOQUANT", "M", "8"],
      ["VADD", "ex", "VALUES", "2", "1", "0", "e2"],
      ["VADD", "ex", "VALUES", "2", "1", "0", "e2", "M", "8"],
      ["VADD", "ex", "VALUES", "2", "1", "0", "e2", "M", "8", "NOQUANT"],
      ["VADD", "ex", "VALUES", "3", "1", "0", "0", "e2", "NOQUANT"],
      ["VADD", "ex", "VALUES", "3", "1", "0", "0", "e2", "M", "8"],

      ["VADD", "bad", "VALUES", "0", "e1"],
      ["VADD", "bad", "VALUES", "-1", "e1"],
      ["VADD", "bad", "VALUES", "2", "1", "nan", "e1"],
      ["VADD", "bad", "VALUES", "2", "1", "abc", "e1"],
      ["VADD", "bad", "VALUES", "2", "1", "2"],
      ["VADD", "bad", "VALUES", "2", "1", "2", "e1", "M", "3"],
      ["VADD", "bad", "VALUES", "2", "1", "2", "e1", "M", "4097"],
      ["VADD", "bad", "VALUES", "2", "1", "2", "e1", "M", "abc"],
      ["VADD", "bad", "VALUES", "2", "1", "2", "e1", "EF", "0"],
      ["VADD", "bad", "VALUES", "2", "1", "2", "e1", "EF", "-1"],
      ["VADD", "bad", "VALUES", "2", "1", "2", "e1", "EF"],
      ["VADD", "bad", "VALUES", "2", "1", "2", "e1", "M"],
      ["VADD", "bad", "VALUES", "2", "1", "2", "e1", "SETATTR"],
      ["VADD", "bad", "VALUES", "2", "1", "2", "e1", "BOGUS"],
      ["VADD", "tq", "values", "2", "1", "0", "e1", "q8", "bin", "m", "4096", "ef", "10", "cas"],
      ["VDIM", "tq"],
    ]);
  }));

  test("VGETATTR, VSETATTR, VRANGE, and VRANDMEMBER", () => run(async (s) => {
    await s.script([
      ["VADD", "vs", "VALUES", "2", "1", "0", "a", "NOQUANT", "SETATTR", '{"n":1}'],
      ["VADD", "vs", "VALUES", "2", "0", "1", "b", "NOQUANT"],
      ["VADD", "vs", "VALUES", "2", "-1", "0", "c", "NOQUANT"],
      ["VADD", "vs", "VALUES", "2", "0", "-1", "d", "NOQUANT"],
      ["VADD", "vs", "VALUES", "2", "1", "1", "e", "NOQUANT"],

      ["VGETATTR", "vs", "a"],
      ["VGETATTR", "vs", "b"],
      ["VGETATTR", "vs", "missing"],
      ["VSETATTR", "vs", "a", ' { "n" : 10 , "k" : "v" } '],
      ["VGETATTR", "vs", "a"],
      ["VSETATTR", "vs", "a", "{bad}"],
      ["VGETATTR", "vs", "a"],
      ["VSETATTR", "vs", "a", ""],
      ["VGETATTR", "vs", "a"],
      ["VSETATTR", "vs", "b", ""],
      ["VSETATTR", "vs", "c", "null"],
      ["VGETATTR", "vs", "c"],
      ["VSETATTR", "vs", "c", "[1,2]"],
      ["VGETATTR", "vs", "c"],
      ["VSETATTR", "vs", "missing", '{"a":1}'],

      ["VRANGE", "vs", "-", "+"],
      ["VRANGE", "vs", "-", "+", "3"],
      ["VRANGE", "vs", "-", "+", "0"],
      ["VRANGE", "vs", "-", "+", "-1"],
      ["VRANGE", "vs", "-", "+", "9223372036854775807"],
      ["VRANGE", "vs", "-", "+", "99999999999999999999"],
      ["VRANGE", "vs", "[b", "[e"],
      ["VRANGE", "vs", "(b", "(e"],
      ["VRANGE", "vs", "[a", "[a"],
      ["VRANGE", "vs", "(a", "[a"],
      ["VRANGE", "vs", "[a", "(a"],
      ["VRANGE", "vs", "[e", "[b"],
      ["VRANGE", "vs", "[", "+"],
      ["VRANGE", "vs", "-", "("],
      ["VRANGE", "vs", "-", "-"],
      ["VRANGE", "vs", "+", "+"],

      ["VRANDMEMBER", "vs", "0"],
    ]);

    const [singleR, singleD] = await s.shape("VRANDMEMBER", "vs");
    expect(singleR.kind).toBe("bulk");
    expect(singleD.kind).toBe("bulk");
    if (singleD.kind === "bulk") expect(["a", "b", "c", "d", "e"]).toContain(dec.decode(singleD.value));

    const [, posD] = await s.shape("VRANDMEMBER", "vs", "3");
    const posEls = extractElements(posD);
    expect(posEls.length).toBe(3);
    expect(new Set(posEls).size).toBe(3);

    const [, allD] = await s.shape("VRANDMEMBER", "vs", "100");
    expect(extractElements(allD).toSorted()).toEqual(["a", "b", "c", "d", "e"]);

    const [, negD] = await s.shape("VRANDMEMBER", "vs", "-8");
    const negEls = extractElements(negD);
    expect(negEls.length).toBe(8);
    for (const e of negEls) expect(["a", "b", "c", "d", "e"]).toContain(e);
  }));

  test("VINFO and VLINKS parity and multi-layer structure", () => run(async (s) => {
    await s.script([
      ["VADD", "single", "VALUES", "3", "1", "2", "3", "e1", "NOQUANT", "SETATTR", '{"x":1}'],
      ["VLINKS", "single", "missing"],
    ]);

    const [, linksSingleD] = await s.shape("VLINKS", "single", "e1");
    expect(linksSingleD.kind).toBe("array");
    if (linksSingleD.kind === "array") {
      expect(linksSingleD.items.length).toBeGreaterThanOrEqual(1);
      for (const layer of linksSingleD.items) expect(layer).toEqual({ kind: "array", items: [] });
    }
    const [, linksScoresD] = await s.shape("VLINKS", "single", "e1", "WITHSCORES");
    expect(linksScoresD.kind).toBe("array");
    if (linksScoresD.kind === "array") {
      expect(linksScoresD.items.length).toBeGreaterThanOrEqual(1);
      for (const layer of linksScoresD.items) {
        expect(asMapObject(layer).size).toBe(0);
      }
    }

    const [infoR, infoD] = await s.shape("VINFO", "single");
    const mr = asMapObject(infoR);
    const md = asMapObject(infoD);
    for (const key of ["quant-type", "hnsw-m", "vector-dim", "projection-input-dim", "size", "attributes-count", "hnsw-max-node-uid"]) {
      expect(md.get(key)).toEqual(mr.get(key));
    }
    expect(md.get("max-level")?.kind).toBe("int");
    expect(md.get("vset-uid")?.kind).toBe("int");

    const nodes = Array.from({ length: 30 }, (_, i) => ({
      elem: `n${i}`,
      vec: [String(Math.cos(i * 0.4)), String(Math.sin(i * 0.4)), String((i % 5) * 0.25)],
    }));
    await batchAdd(s, "multi", nodes, "NOQUANT");

    const [, multiInfoD] = await s.shape("VINFO", "multi");
    const multiMap = asMapObject(multiInfoD);
    expect(multiMap.get("size")).toEqual({ kind: "int", value: 30n });
    expect(multiMap.get("hnsw-max-node-uid")).toEqual({ kind: "int", value: 30n });

    const linksResp = decodeResp(await s.dura.cmd("VLINKS", "multi", "n0", "WITHSCORES"));
    expect(linksResp.kind).toBe("array");
    if (linksResp.kind === "array") {
      expect(linksResp.items.length).toBeGreaterThanOrEqual(1);
      const lastLayer = linksResp.items.at(-1);
      expect(lastLayer).toBeDefined();
      if (lastLayer) {
        const layer0 = asMapObject(lastLayer);
        expect(layer0.size).toBeGreaterThan(0);
        for (const [nb, val] of layer0) {
          expect(nb.startsWith("n")).toBe(true);
          expect(val.kind === "double" || val.kind === "bulk").toBe(true);
        }
      }
    }
  }));

  test("VSIM TRUTH differential parity across quantizations, options, and tie-breaking", () => run(async (s) => {
    for (const quant of ["NOQUANT", "Q8", "BIN"] as const) {
      const k = `sim_${quant}`;
      await s.script([
        ["VADD", k, "VALUES", "4", "1", "2", "3", "4", "v1", quant, "SETATTR", '{"id":1}'],
        ["VADD", k, "VALUES", "4", "4", "3", "2", "1", "v2", quant, "SETATTR", '{"id":2}'],
        ["VADD", k, "VALUES", "4", "-1", "2", "-3", "4", "v3", quant],
        ["VSIM", k, "VALUES", "4", "1", "2", "3", "4", "TRUTH"],
        ["VSIM", k, "VALUES", "4", "1", "2", "3", "4", "WITHSCORES", "TRUTH"],
        ["VSIM", k, "VALUES", "4", "1", "2", "3", "4", "WITHATTRIBS", "TRUTH"],
        ["VSIM", k, "VALUES", "4", "1", "2", "3", "4", "WITHSCORES", "WITHATTRIBS", "TRUTH"],
        ["VSIM", k, "FP32", fp32Bytes([1, 2, 3, 4]), "WITHSCORES", "TRUTH"],
        ["VSIM", k, "ELE", "v1", "WITHSCORES", "TRUTH"],
        ["VSIM", k, "ELE", "v2", "WITHSCORES", "WITHATTRIBS", "TRUTH", "NOTHREAD"],
        ["VSIM", k, "VALUES", "4", "1", "2", "3", "4", "FILTER", ".id == 999", "TRUTH"],
        ["VSIM", k, "VALUES", "4", "1", "2", "3", "4", "FILTER", ".id == 999", "WITHSCORES", "TRUTH"],
        ["VSIM", k, "VALUES", "4", "1", "2", "3", "4", "FILTER", ".id == 999", "WITHATTRIBS", "TRUTH"],
        ["VSIM", k, "VALUES", "4", "1", "2", "3", "4", "FILTER", ".id == 999", "WITHSCORES", "WITHATTRIBS", "TRUTH"],
      ]);
    }

    await s.script([
      ["VADD", "eb", "VALUES", "2", "1", "0", "a", "NOQUANT"],
      ["VADD", "eb", "VALUES", "2", "0", "1", "b", "NOQUANT"],
      ["VADD", "eb", "VALUES", "2", "-1", "0", "c", "NOQUANT"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "EPSILON", "0.5", "TRUTH", "WITHSCORES"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "EPSILON", "0.499999", "TRUTH", "WITHSCORES"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "EPSILON", "1.0", "TRUTH", "WITHSCORES"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "EPSILON", "0.999999", "TRUTH", "WITHSCORES"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "EPSILON", "inf", "TRUTH"],
      ["VSIM", "eb", "VALUES", "2", "0", "0", "WITHSCORES", "TRUTH"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "COUNT", "2", "TRUTH"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "COUNT", "100", "TRUTH"],

      ["VADD", "tie", "VALUES", "2", "1", "0", "c", "NOQUANT"],
      ["VADD", "tie", "VALUES", "2", "1", "0", "a", "NOQUANT"],
      ["VADD", "tie", "VALUES", "2", "1", "0", "b", "NOQUANT"],
      ["VSIM", "tie", "VALUES", "2", "1", "0", "TRUTH"],
      ["VADD", "tie", "VALUES", "2", "1", "0", "c", "NOQUANT"],
      ["VSIM", "tie", "VALUES", "2", "1", "0", "TRUTH"],

      ["VADD", "sred", "REDUCE", "2", "VALUES", "4", "1", "0", "0", "0", "e1", "NOQUANT"],
      ["VADD", "sred", "REDUCE", "2", "VALUES", "4", "0", "1", "0", "0", "e2", "NOQUANT"],
      ["VSIM", "sred", "VALUES", "4", "1", "0", "0", "0", "WITHSCORES", "TRUTH"],
      ["VSIM", "sred", "VALUES", "2", "1", "0", "TRUTH"],
      ["VSIM", "sred", "VALUES", "3", "1", "0", "0", "TRUTH"],

      ["VSIM", "eb", "ELE", "nope"],
      ["VSIM", "eb", "VALUES", "3", "1", "0", "0"],
      ["VSIM", "eb", "FP32", new Uint8Array([1, 2])],
      ["VSIM", "eb", "VALUES", "0"],
      ["VSIM", "eb", "VALUES", "2", "1", "nan"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "COUNT", "0"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "COUNT", "-1"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "COUNT", "abc"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "EPSILON", "0"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "EPSILON", "-0.1"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "EPSILON", "nan"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "EPSILON", "abc"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "EF", "0"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "EF", "abc"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "FILTER-EF", "0"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "FILTER-EF", "abc"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "BADOPT"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "COUNT"],
      ["VSIM", "eb", "VALUES", "2", "1", "0", "FILTER"],
    ]);
  }));

  test("VSIM FILTER expression language differential parity", () => run(async (s) => {
    await s.script([
      ["VADD", "flt", "VALUES", "2", "1", "0", "a", "NOQUANT", "SETATTR", JSON.stringify({
        year: 1980,
        rating: 8.5,
        genre: "sci-fi",
        active: true,
        empty: null,
        tags: ["a", "b", 1, "2", null],
        nested: { x: 10 },
        zero: 0,
        str: "",
        "a-b": 5,
        _u: 7,
        "123": 9,
        q: 'a"b',
        sq: "a'b",
        bs: String.raw`a\b`,
        litnl: String.raw`a\nb`,
        nl: "a\nb",
      })],
      ["VADD", "flt", "VALUES", "2", "1", "0", "b", "NOQUANT", "SETATTR", JSON.stringify({
        year: 1995,
        rating: 7.0,
        genre: "drama",
        active: false,
        empty: "not-null",
        tags: ["b", "c"],
        nested: {},
        zero: 1,
        str: "hi",
      })],
      ["VADD", "flt", "VALUES", "2", "1", "0", "c", "NOQUANT", "SETATTR", JSON.stringify({
        year: "1980",
        rating: 9.2,
        genre: "action",
        tags: [1, 2, 3],
        other: 1,
      })],
      ["VADD", "flt", "VALUES", "2", "1", "0", "d", "NOQUANT"],
      ["VADD", "flt", "VALUES", "2", "1", "0", "e", "NOQUANT", "SETATTR", "{bad json"],
      ["VADD", "flt", "VALUES", "2", "1", "0", "f", "NOQUANT", "SETATTR", "[1,2]"],
    ]);

    const expressions = [
      ".year == 1980",
      ".year != 1980",
      ".year > 1980",
      ".year >= 1980",
      ".year < 2000",
      ".year <= 1995",
      '.year == "1980"',
      ".year == '1980'",
      '.genre == "sci-fi"',
      '.genre != "sci-fi"',
      '.genre < "drama"',
      '.genre <= "drama"',
      ".active == 1",
      ".active == 0",
      ".active",
      "!.active",
      "not .active",
      ".zero",
      ".str",
      ".empty == null",
      ".empty != null",
      ".other == 1",
      "not (.other == 1)",
      ".other == 1 or .year == 1980",
      ".year == 1980 or .other == 1",
      ".other == 1 and .year == 1980",
      ".year == 1980 or 1",
      "1 or .other == 1",
      "0 and .other == 1",
      ".nested == 0",
      ".nested == null",
      "not (.nested == 0)",
      "1 or .nested == 1",
      ".year >= 1980 and .year <= 2000",
      ".year >= 1980 && .year <= 2000",
      ".year == 1980 or .year == 1995",
      ".year == 1980 || .year == 1995",
      "(.year == 1980 or .year == 1995) and .rating > 8",
      ".year == 1980 or .year == 1995 and .rating > 8",
      ".year + 15 == 1995",
      ".year - 1980 == 0",
      ".rating * 2 == 17",
      ".rating / 2 == 3.5",
      ".year % 10 == 0",
      ".rating ** 2 > 70",
      "2 ** 3 ** 2 == 512",
      "-2 ** 2 == 4",
      "2 * 3 ** 2 == 18",
      ".rating / 0 == 0",
      "1 / 0",
      "1 % 0",
      ".a-b == 5",
      "._u == 7",
      ".123 == 9",
      '.genre in ["sci-fi", "action"]',
      '"a" in .tags',
      "1 in .tags",
      '"2" in .tags',
      "null in .tags",
      "99 in .tags",
      '"sci" in .genre',
      '"a" not in .tags',
      '10 not in .tags',
      'not ("a" in .tags)',
      '.year in [1980, ]',
      '.year in []',
      '.tags == [99]',
      '.tags != [99]',
      '.tags == 0',
      '"abc" == 0',
      '"2" < "10"',
      '"abc" < "def"',
      '"abc" <= "def"',
      '"10" + 5 == 15',
      '"10" + "5" == "105"',
      '"a" + "b" == "ab"',
      '.q == \'a"b\'',
      '.sq == "a\'b"',
      String.raw`.bs == "a\\b"`,
      String.raw`.litnl == "a\nb"`,
      String.raw`.nl == "a\nb"`,
      "1",
      "0",
      '""',
      '"x"',
      "null",
      "!null",
      "null == null",
      "null == 0",
      "null < 1",
      "null + 1 == 1",
      "!0 + 1 == 2",
      "not 0 + 1 == 2",
      "!2 ** 2 == 0",
      "2 ** !0 == 2",
      "!(!1)",
      "1 not",
      "0 not",
      "1.5e2 == 150",
      "",
      "   ",
      ".year ==",
      "== 1",
      ".year = 1980",
      ".active == true",
      ".active == false",
      "unknown == 1",
      ".nested.x == 10",
      '.nested["x"] == 10',
      "0x10 == 16",
      "-(1 + 2) == -3",
      "+5 == 5",
      "not not 1",
      "!!1",
      "1 == 1 2",
      "()",
      "(.year == 1980",
      ".year == 1980)",
      ". == 1",
      ".tags in [[1]]",
      ".empty in [null]",
      ".year == 1980 AND .rating > 5",
      '"unterminated',
    ];

    for (const expr of expressions) {
      await s.cmd("VSIM", "flt", "VALUES", "2", "1", "0", "COUNT", "20", "TRUTH", "FILTER", expr);
    }
  }));

  test("approximate HNSW recall >= 0.95 (Q8, NOQUANT, filtered, after VREM, and cold SQLite rebuild)", () => run(async (s) => {
    const rng = mulberry32(42);
    const dim = 16;
    const count = 250;
    const items = Array.from({ length: count }, (_, i) => ({
      elem: `v${i}`,
      vec: randomVec(rng, dim),
      attr: JSON.stringify({ group: i % 5, score: i }),
    }));
    const queries = Array.from({ length: 20 }, () => randomVec(rng, dim));

    for (const quant of ["Q8", "NOQUANT"] as const) {
      const key = `bench_${quant}`;
      await batchAdd(s, key, items, quant);

      let duraRecallSum = 0;
      let redisRecallSum = 0;
      for (const q of queries) {
        const [dApprox, dTruth, rApprox, rTruth] = await Promise.all([
          s.dura.cmd("VSIM", key, "VALUES", String(dim), ...q, "COUNT", "10"),
          s.dura.cmd("VSIM", key, "VALUES", String(dim), ...q, "COUNT", "10", "TRUTH"),
          s.redis.cmd("VSIM", key, "VALUES", String(dim), ...q, "COUNT", "10"),
          s.redis.cmd("VSIM", key, "VALUES", String(dim), ...q, "COUNT", "10", "TRUTH"),
        ]);
        duraRecallSum += recallAtK(extractElements(decodeResp(dApprox)), extractElements(decodeResp(dTruth)));
        redisRecallSum += recallAtK(extractElements(decodeResp(rApprox)), extractElements(decodeResp(rTruth)));
      }
      expect(duraRecallSum / queries.length).toBeGreaterThanOrEqual(0.95);
      expect(redisRecallSum / queries.length).toBeGreaterThanOrEqual(0.95);
    }

    let filterRecallSum = 0;
    for (const q of queries) {
      const [dApprox, dTruth] = await Promise.all([
        s.dura.cmd("VSIM", "bench_Q8", "VALUES", String(dim), ...q, "COUNT", "10", "FILTER", ".group == 2", "FILTER-EF", "2000"),
        s.dura.cmd("VSIM", "bench_Q8", "VALUES", String(dim), ...q, "COUNT", "10", "FILTER", ".group == 2", "TRUTH"),
      ]);
      filterRecallSum += recallAtK(extractElements(decodeResp(dApprox)), extractElements(decodeResp(dTruth)));
    }
    expect(filterRecallSum / queries.length).toBeGreaterThanOrEqual(0.95);

    const remCmds: Array<Array<RespArg>> = Array.from({ length: 50 }, (_, i) => ["VREM", "bench_NOQUANT", `v${i}`]);
    await Promise.all([s.redis.pipeline(remCmds), s.dura.pipeline(remCmds)]);
    await s.cmd("VCARD", "bench_NOQUANT");

    let postRemRecallSum = 0;
    for (const q of queries) {
      const [dApprox, dTruth] = await Promise.all([
        s.dura.cmd("VSIM", "bench_NOQUANT", "VALUES", String(dim), ...q, "COUNT", "10"),
        s.dura.cmd("VSIM", "bench_NOQUANT", "VALUES", String(dim), ...q, "COUNT", "10", "TRUTH"),
      ]);
      postRemRecallSum += recallAtK(extractElements(decodeResp(dApprox)), extractElements(decodeResp(dTruth)));
    }
    expect(postRemRecallSum / queries.length).toBeGreaterThanOrEqual(0.95);

    await s.cmd("COPY", "bench_NOQUANT", "bench_cold");
    const before = await Promise.all(queries.map((q) => s.dura.cmd("VSIM", "bench_NOQUANT", "VALUES", String(dim), ...q, "COUNT", "10", "TRUTH", "WITHSCORES")));
    const card = await s.dura.cmd("VCARD", "bench_NOQUANT");
    const embedding = await s.dura.cmd("VEMB", "bench_NOQUANT", "v100");
    const links = await s.dura.cmd("VLINKS", "bench_NOQUANT", "v100", "WITHSCORES");
    expect(decodeResp(await s.dura.cmd("RENAME", "bench_NOQUANT", "bench_cold"))).toEqual({ kind: "simple", value: "OK" });
    expect(await s.dura.cmd("VCARD", "bench_cold")).toEqual(card);
    expect(await s.dura.cmd("VEMB", "bench_cold", "v100")).toEqual(embedding);
    expect(await s.dura.cmd("VLINKS", "bench_cold", "v100", "WITHSCORES")).toEqual(links);

    let coldRecallSum = 0;
    for (const [i, q] of queries.entries()) {
      const [cApprox, cTruth, cTruthScores] = await Promise.all([
        s.dura.cmd("VSIM", "bench_cold", "VALUES", String(dim), ...q, "COUNT", "10"),
        s.dura.cmd("VSIM", "bench_cold", "VALUES", String(dim), ...q, "COUNT", "10", "TRUTH"),
        s.dura.cmd("VSIM", "bench_cold", "VALUES", String(dim), ...q, "COUNT", "10", "TRUTH", "WITHSCORES"),
      ]);
      expect(cTruthScores).toEqual(before[i]);
      coldRecallSum += recallAtK(extractElements(decodeResp(cApprox)), extractElements(decodeResp(cTruth)));
    }
    expect(coldRecallSum / queries.length).toBeGreaterThanOrEqual(0.95);
  }));
});
