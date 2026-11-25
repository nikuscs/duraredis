import { bytes, r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import type { KeyRow } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { opt } from "./args";
import { keyless, spec } from "./types";
import type { Ctx, Table } from "./types";
import { deleteAtPath, evalTargets, evalValues, parsePath, setAtPath } from "../json/path";
import type { ParsedPath } from "../json/path";
import {
  DEFAULT_FMT, I64_MAX, I64_MIN, jClone, jMemBytes, jNum, jStrictEq, jToExpand, jToResp, jType, mergePatch, objSet, parseJson, stringifyJson, utf8Len,
} from "../json/value";
import type { JsonFmt, JVal } from "../json/value";

const WRONG_TYPE = "Existing key has wrong Redis type";
const NO_KEY = "ERR could not perform this operation on a key that doesn't exist";
const NO_PATH = "ERR Path does not exist";
const FPHA_TYPES = new Set(["BF16", "FP16", "FP32", "FP64"]);
const SET_FORMATS = new Set(["STRING", "JSON"]);
const GET_FORMATS = new Set(["STRING", "EXPAND1", "EXPAND"]);
const POP_FORMATS = new Set(["STRINGS", "EXPAND1", "EXPAND"]);

function wrongArgs(cmd: string): never {
  throw new RedisError(`ERR wrong number of arguments for '${cmd}' command`);
}

function loadRow(ctx: Ctx, key: Uint8Array): KeyRow | undefined {
  const row = ctx.ks.get(key);
  if (row && row.type !== TYPE.json) throw new RedisError(WRONG_TYPE);
  return row;
}

function decodeDoc(row: KeyRow): JVal {
  return row.value ? parseJson(text(row.value)) : { t: "null" };
}

function saveDoc(ctx: Ctx, key: Uint8Array, row: KeyRow | undefined, doc: JVal): void {
  const encoded = bytes(stringifyJson(doc));
  if (row) ctx.ks.updateValue(row.id, key, encoded);
  else ctx.ks.create(key, TYPE.json, encoded);
}

function parseIntArg(arg: Uint8Array): number {
  const s = text(arg);
  if (!/^[+-]?\d+$/.test(s)) throw new RedisError("Couldn't parse as integer");
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new RedisError("Couldn't parse as integer");
  return n;
}

function numReply(v: JVal): Reply {
  if (v.t === "int") return v.v <= I64_MAX ? r.int(v.v) : r.double(Number(v.v));
  return r.double(jNum(v));
}

function parseSetOpts(args: Array<Uint8Array>): "NX" | "XX" | undefined {
  let cond: "NX" | "XX" | undefined;
  let fpha = false;
  let fmt = false;
  for (let i = 4; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "NX" || o === "XX") {
      if (cond) throw new RedisError("ERR syntax error");
      cond = o;
    } else if (o === "FPHA" && !fpha && i + 1 < args.length && FPHA_TYPES.has(opt(args[i + 1]))) {
      fpha = true;
      i++;
    } else if (o === "FORMAT" && !fmt && i + 1 < args.length && SET_FORMATS.has(opt(args[i + 1]))) {
      fmt = true;
      i++;
    } else {
      throw new RedisError("ERR syntax error");
    }
  }
  return cond;
}

function jsonSet(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const row = loadRow(ctx, key);
  const cond = parseSetOpts(args);
  const p = parsePath(text(args[2]));
  const val = parseJson(text(args[3]), "");
  if (!row) {
    if (cond === "XX") return r.nil;
    if (!p.isRoot) throw new RedisError("ERR new objects must be created at the root");
    saveDoc(ctx, key, undefined, val);
    return r.ok;
  }
  if (p.isRoot) {
    if (cond === "NX") return r.nil;
    saveDoc(ctx, key, row, val);
    return r.ok;
  }
  const doc = decodeDoc(row);
  if (!setAtPath(doc, p, val, cond)) return r.nil;
  saveDoc(ctx, key, row, doc);
  return r.ok;
}

function parseGetArgs(ctx: Ctx, args: Array<Uint8Array>) {
  const fmt: JsonFmt = { ...DEFAULT_FMT };
  let format = "STRING";
  const paths: Array<string> = [];
  for (let i = 2; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "INDENT") {
      if (i + 1 >= args.length) wrongArgs("json.get");
      fmt.indent = text(args[++i]);
    } else if (o === "NEWLINE") {
      if (i + 1 >= args.length) wrongArgs("json.get");
      fmt.newline = text(args[++i]);
    } else if (o === "SPACE") {
      if (i + 1 >= args.length) wrongArgs("json.get");
      fmt.space = text(args[++i]);
    } else if (o === "NOESCAPE") {
      continue;
    } else if (o === "FORMAT") {
      if (i + 1 >= args.length) wrongArgs("json.get");
      if (ctx.session.proto !== 3) throw new RedisError("ERR FORMAT argument is not supported on RESP2");
      format = opt(args[++i]);
      if (!GET_FORMATS.has(format)) throw new RedisError("ERR wrong reply format");
    } else {
      paths.push(text(args[i]));
    }
  }
  return { fmt, format, paths };
}

function jsonGet(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const { fmt, format, paths } = parseGetArgs(ctx, args);
  const row = loadRow(ctx, args[1]);
  if (!row) return r.nil;
  const doc = decodeDoc(row);
  if (format !== "STRING") {
    const parsed = (paths.length ? paths : ["$"]).map(parsePath);
    return r.array(parsed.map((p) => {
      const vals = evalValues(doc, p);
      return r.array(vals.map((v) => (format === "EXPAND" ? jToExpand(v) : r.bulk(stringifyJson(v, fmt)))));
    }));
  }
  if (!paths.length) return r.bulk(stringifyJson(doc, fmt));
  const parsed = paths.map(parsePath);
  if (parsed.length === 1) {
    const vals = evalValues(doc, parsed[0]);
    if (parsed[0].isV2) return r.bulk(stringifyJson({ t: "arr", v: vals }, fmt));
    if (!vals.length) throw new RedisError(NO_PATH);
    return r.bulk(stringifyJson(vals[0], fmt));
  }
  const anyV2 = parsed.some((p) => p.isV2);
  const entries: Array<[string, JVal]> = [];
  for (const p of parsed) {
    const vals = evalValues(doc, p);
    if (anyV2) {
      entries.push([p.raw, { t: "arr", v: vals }]);
    } else {
      if (!vals.length) throw new RedisError(NO_PATH);
      entries.push([p.raw, vals[0]]);
    }
  }
  const obj: JVal = { t: "obj", v: [] };
  for (const [k, v] of entries) objSet(obj.v, k, v);
  return r.bulk(stringifyJson(obj, fmt));
}

function jsonMget(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const pathArg = args.at(-1);
  if (!pathArg) wrongArgs("json.mget");
  const p = parsePath(text(pathArg));
  const items = args.slice(1, -1).map((key) => {
    const row = ctx.ks.get(key);
    if (!row || row.type !== TYPE.json) return r.nil;
    const vals = evalValues(decodeDoc(row), p);
    if (p.isV2) return r.bulk(stringifyJson({ t: "arr", v: vals }));
    return vals.length ? r.bulk(stringifyJson(vals[0])) : r.nil;
  });
  return r.array(items);
}

function jsonMset(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if ((args.length - 1) % 3 !== 0) wrongArgs("json.mset");
  const ops: Array<{ key: Uint8Array; p: ParsedPath; val: JVal }> = [];
  const created = new Set<string>();
  for (let i = 1; i < args.length; i += 3) {
    const key = args[i];
    const row = loadRow(ctx, key);
    const p = parsePath(text(args[i + 1]));
    const val = parseJson(text(args[i + 2]), "");
    const ks = text(key);
    if (!row && !created.has(ks)) {
      if (!p.isRoot) throw new RedisError("ERR new objects must be created at the root");
      created.add(ks);
    }
    ops.push({ key, p, val });
  }
  let anyNil = false;
  for (const { key, p, val } of ops) {
    const row = loadRow(ctx, key);
    if (!row || p.isRoot) {
      saveDoc(ctx, key, row, val);
      continue;
    }
    const doc = decodeDoc(row);
    if (!setAtPath(doc, p, val)) anyNil = true;
    else saveDoc(ctx, key, row, doc);
  }
  return anyNil ? r.nil : r.ok;
}

function jsonDel(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const row = loadRow(ctx, key);
  if (!row) return r.int(0);
  const p = args.length >= 3 ? parsePath(text(args[2])) : parsePath(".");
  if (p.isRoot) {
    ctx.ks.delete(key);
    return r.int(1);
  }
  const doc = decodeDoc(row);
  const deleted = deleteAtPath(doc, p);
  if (deleted > 0) saveDoc(ctx, key, row, doc);
  return r.int(deleted);
}

function jsonType(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const wrap = (rep: Reply) => (ctx.session.proto === 3 ? r.array([rep]) : rep);
  const row = loadRow(ctx, args[1]);
  const p = args.length >= 3 ? parsePath(text(args[2])) : parsePath(".");
  if (!row) return wrap(r.nil);
  const vals = evalValues(decodeDoc(row), p);
  if (p.isV2) return wrap(r.array(vals.map((v) => r.bulk(jType(v)))));
  return wrap(vals.length ? r.bulk(jType(vals[0])) : r.nil);
}

function intPow(base: bigint, exp: bigint): bigint | undefined {
  if (exp < 0n) return undefined;
  if (exp === 0n || base === 1n) return 1n;
  if (base === 0n) return 0n;
  if (base === -1n) return exp % 2n === 0n ? 1n : -1n;
  if (exp > 63n) return undefined;
  let acc = 1n;
  let b = base;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      acc *= b;
      if (acc < I64_MIN || acc > I64_MAX) return undefined;
    }
    e >>= 1n;
    if (e > 0n) {
      b *= b;
      if (b < I64_MIN || b > I64_MAX) return undefined;
    }
  }
  return acc;
}

function numArith(cur: JVal, by: JVal, op: "add" | "mul" | "pow"): JVal {
  if (cur.t === "int" && cur.v <= I64_MAX && by.t === "int" && by.v <= I64_MAX) {
    const res =
      op === "add" ? cur.v + by.v :
      op === "mul" ? cur.v * by.v :
      intPow(cur.v, by.v);
    if (res === undefined || res < I64_MIN || res > I64_MAX) throw new RedisError("ERR numeric overflow");
    return { t: "int", v: res };
  }
  const a = jNum(cur);
  const b = jNum(by);
  const res = op === "add" ? a + b : op === "mul" ? a * b : a ** b;
  if (!Number.isFinite(res)) throw new RedisError("ERR result is not a number");
  return { t: "float", v: res };
}

function numOp(ctx: Ctx, [, key, pathArg, byArg]: Array<Uint8Array>, op: "add" | "mul" | "pow"): Reply {
  const row = loadRow(ctx, key);
  if (!row) throw new RedisError(NO_KEY);
  const p = parsePath(text(pathArg));
  const by = parseJson(text(byArg), "ERR ");
  if (by.t !== "int" && by.t !== "float") throw new RedisError("bad input number");
  let doc = decodeDoc(row);
  const targets = evalTargets(doc, p, (v) => { doc = v; });
  const computed = targets.map((t) => {
    const cur = t.get();
    return cur.t === "int" || cur.t === "float" ? numArith(cur, by, op) : null;
  });
  if (ctx.session.proto === 3) {
    let changed = false;
    for (let i = 0; i < targets.length; i++) {
      const next = computed[i];
      if (!next) continue;
      targets[i].set(next);
      changed = true;
    }
    if (changed) saveDoc(ctx, key, row, doc);
    return r.array(computed.map((v) => (v ? numReply(v) : r.nil)));
  }
  if (p.isV2) {
    let changed = false;
    for (let i = 0; i < targets.length; i++) {
      const next = computed[i];
      if (!next) continue;
      targets[i].set(next);
      changed = true;
    }
    if (changed) saveDoc(ctx, key, row, doc);
    return r.bulk(stringifyJson({ t: "arr", v: computed.map((v) => v ?? { t: "null" }) }));
  }
  if (!computed.length || !computed[0]) throw new RedisError("ERR Path does not exist or does not contains a number");
  targets[0].set(computed[0]);
  saveDoc(ctx, key, row, doc);
  return r.bulk(stringifyJson(computed[0]));
}

function jsonStrAppend(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const row = loadRow(ctx, key);
  if (!row) throw new RedisError(NO_KEY);
  const p = args.length === 3 ? parsePath(".") : parsePath(text(args[2]));
  const addVal = parseJson(text(args.length === 3 ? args[2] : args[3]), "ERR ");
  if (addVal.t !== "str") throw new RedisError("WRONGTYPE wrong type of path value - expected string");
  let doc = decodeDoc(row);
  const targets = evalTargets(doc, p, (v) => { doc = v; });
  if (p.isV2) {
    let changed = false;
    const out = targets.map((t) => {
      const cur = t.get();
      if (cur.t !== "str") return r.nil;
      const next = cur.v + addVal.v;
      t.set({ t: "str", v: next });
      changed = true;
      return r.int(utf8Len(next));
    });
    if (changed) saveDoc(ctx, key, row, doc);
    return r.array(out);
  }
  if (!targets.length || targets[0].get().t !== "str") throw new RedisError("ERR Path does not exist or not a string");
  const cur = targets[0].get();
  if (cur.t !== "str") throw new RedisError("ERR Path does not exist or not a string");
  const next = cur.v + addVal.v;
  targets[0].set({ t: "str", v: next });
  saveDoc(ctx, key, row, doc);
  return r.int(utf8Len(next));
}

function jsonStrLen(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const row = loadRow(ctx, args[1]);
  const p = args.length >= 3 ? parsePath(text(args[2])) : parsePath(".");
  if (!row) {
    if (p.isV2) throw new RedisError(NO_KEY);
    return r.nil;
  }
  const vals = evalValues(decodeDoc(row), p);
  if (p.isV2) return r.array(vals.map((v) => (v.t === "str" ? r.int(utf8Len(v.v)) : r.nil)));
  if (!vals.length) throw new RedisError(NO_PATH);
  if (vals[0].t !== "str") throw new RedisError("WRONGTYPE wrong type of path value - expected string");
  return r.int(utf8Len(vals[0].v));
}

function jsonArrAppend(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length < 4) wrongArgs("json.arrappend");
  const key = args[1];
  const row = loadRow(ctx, key);
  if (!row) throw new RedisError(NO_KEY);
  const p = parsePath(text(args[2]));
  const adds = args.slice(3).map((a) => parseJson(text(a), "ERR "));
  const doc = decodeDoc(row);
  const targets = evalTargets(doc, p);
  if (p.isV2) {
    let changed = false;
    const out = targets.map((t) => {
      const cur = t.get();
      if (cur.t !== "arr") return r.nil;
      cur.v.push(...adds.map(jClone));
      changed = true;
      return r.int(cur.v.length);
    });
    if (changed) saveDoc(ctx, key, row, doc);
    return r.array(out);
  }
  const first = targets[0]?.get();
  if (!first || first.t !== "arr") throw new RedisError("ERR Path does not exist or not an array");
  first.v.push(...adds.map(jClone));
  saveDoc(ctx, key, row, doc);
  return r.int(first.v.length);
}

function jsonArrIndex(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 6) wrongArgs("json.arrindex");
  const row = loadRow(ctx, args[1]);
  if (!row) throw new RedisError(NO_PATH);
  const p = parsePath(text(args[2]));
  const needle = parseJson(text(args[3]), "ERR ");
  const start = args.length >= 5 ? parseIntArg(args[4]) : 0;
  const stop = args.length >= 6 ? parseIntArg(args[5]) : 0;
  const search = (arr: Array<JVal>): number => {
    const len = arr.length;
    const s = start < 0 ? Math.max(0, len + start) : Math.min(len, start);
    const e = stop === 0 ? len : stop < 0 ? Math.max(0, len + stop) : Math.min(len, stop);
    for (let i = s; i < e; i++) if (jStrictEq(arr[i], needle)) return i;
    return -1;
  };
  const vals = evalValues(decodeDoc(row), p);
  if (p.isV2) return r.array(vals.map((v) => (v.t === "arr" ? r.int(search(v.v)) : r.nil)));
  if (!vals.length) throw new RedisError(NO_PATH);
  if (vals[0].t !== "arr") throw new RedisError("WRONGTYPE wrong type of path value - expected array");
  return r.int(search(vals[0].v));
}

function jsonArrInsert(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const row = loadRow(ctx, key);
  if (!row) throw new RedisError(NO_KEY);
  const p = parsePath(text(args[2]));
  const index = parseIntArg(args[3]);
  const inserts = args.slice(4).map((a) => parseJson(text(a), "ERR "));
  const doc = decodeDoc(row);
  const targets = evalTargets(doc, p);
  if (!p.isV2 && (!targets.length || targets[0].get().t !== "arr")) throw new RedisError("ERR Path does not exist or not an array");
  const plans: Array<{ arr: Array<JVal>; pos: number } | null> = targets.map((t) => {
    const cur = t.get();
    if (cur.t !== "arr") return null;
    const pos = index < 0 ? cur.v.length + index : index;
    if (pos < 0 || pos > cur.v.length) throw new RedisError("ERR index out of bounds");
    return { arr: cur.v, pos };
  });
  let changed = false;
  const out = plans.map((plan) => {
    if (!plan) return r.nil;
    plan.arr.splice(plan.pos, 0, ...inserts.map(jClone));
    changed = true;
    return r.int(plan.arr.length);
  });
  if (changed) saveDoc(ctx, key, row, doc);
  return p.isV2 ? r.array(out) : out[0];
}

function jsonArrLen(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const row = loadRow(ctx, args[1]);
  const p = args.length >= 3 ? parsePath(text(args[2])) : parsePath(".");
  if (!row) {
    if (p.isV2) throw new RedisError(NO_KEY);
    return r.nil;
  }
  const vals = evalValues(decodeDoc(row), p);
  if (p.isV2) return r.array(vals.map((v) => (v.t === "arr" ? r.int(v.v.length) : r.nil)));
  if (!vals.length) throw new RedisError(NO_PATH);
  if (vals[0].t !== "arr") throw new RedisError("ERR Path does not exist or not an array");
  return r.int(vals[0].v.length);
}

function jsonArrPop(ctx: Ctx, args: Array<Uint8Array>): Reply {
  let format = "STRINGS";
  let nextIdx = 2;
  if (args.length >= 3 && opt(args[2]) === "FORMAT") {
    if (args.length < 4) wrongArgs("json.arrpop");
    format = opt(args[3]);
    if (!POP_FORMATS.has(format)) throw new RedisError("ERR wrong reply format");
    if (ctx.session.proto !== 3) throw new RedisError("ERR FORMAT argument is not supported on RESP2");
    nextIdx = 4;
  }
  const key = args[1];
  const row = loadRow(ctx, key);
  if (!row) throw new RedisError(NO_KEY);
  const p = args[nextIdx] ? parsePath(text(args[nextIdx])) : parsePath(".");
  const rawIdx = args[nextIdx + 1] ? text(args[nextIdx + 1]) : undefined;
  const idx = rawIdx !== undefined && /^[+-]?\d+$/.test(rawIdx) && Number.isSafeInteger(Number(rawIdx)) ? Number(rawIdx) : -1;
  const doc = decodeDoc(row);
  const targets = evalTargets(doc, p);
  const popFrom = (arr: Array<JVal>): Reply => {
    if (!arr.length) return r.nil;
    const pos = idx < 0 ? Math.max(0, arr.length + idx) : Math.min(arr.length - 1, idx);
    const popped = arr.splice(pos, 1)[0];
    return format === "EXPAND" ? jToExpand(popped) : r.bulk(stringifyJson(popped));
  };
  if (p.isV2) {
    let changed = false;
    const out = targets.map((t) => {
      const cur = t.get();
      if (cur.t !== "arr" || !cur.v.length) return r.nil;
      changed = true;
      return popFrom(cur.v);
    });
    if (changed) saveDoc(ctx, key, row, doc);
    return r.array(out);
  }
  const first = targets[0]?.get();
  if (!first || first.t !== "arr") throw new RedisError("ERR Path does not exist or not an array");
  const rep = popFrom(first.v);
  if (rep !== r.nil) saveDoc(ctx, key, row, doc);
  return rep;
}

function jsonArrTrim(ctx: Ctx, [, key, pathArg, startArg, stopArg]: Array<Uint8Array>): Reply {
  const row = loadRow(ctx, key);
  if (!row) throw new RedisError(NO_KEY);
  const p = parsePath(text(pathArg));
  const start = parseIntArg(startArg);
  const stop = parseIntArg(stopArg);
  const doc = decodeDoc(row);
  const targets = evalTargets(doc, p);
  const trim = (arr: Array<JVal>): number => {
    const len = arr.length;
    if (!len) return 0;
    const s = start < 0 ? Math.max(0, len + start) : start;
    const e = stop < 0 ? Math.max(0, len + stop) : Math.min(len - 1, stop);
    if (s >= len || s > e) {
      arr.length = 0;
      return 0;
    }
    const kept = arr.slice(s, e + 1);
    arr.splice(0, len, ...kept);
    return arr.length;
  };
  if (p.isV2) {
    let changed = false;
    const out = targets.map((t) => {
      const cur = t.get();
      if (cur.t !== "arr") return r.nil;
      changed = true;
      return r.int(trim(cur.v));
    });
    if (changed) saveDoc(ctx, key, row, doc);
    return r.array(out);
  }
  const first = targets[0]?.get();
  if (!first || first.t !== "arr") throw new RedisError("ERR Path does not exist or not an array");
  const len = trim(first.v);
  saveDoc(ctx, key, row, doc);
  return r.int(len);
}

function jsonObjKeys(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const row = loadRow(ctx, args[1]);
  const p = args.length >= 3 ? parsePath(text(args[2])) : parsePath(".");
  if (!row) {
    if (p.isV2) throw new RedisError(NO_KEY);
    return r.nil;
  }
  const vals = evalValues(decodeDoc(row), p);
  if (p.isV2) return r.array(vals.map((v) => (v.t === "obj" ? r.bulks(v.v.map(([k]) => k)) : r.nil)));
  if (!vals.length) return r.nil;
  if (vals[0].t !== "obj") throw new RedisError("ERR Path does not exist or not an object");
  return r.bulks(vals[0].v.map(([k]) => k));
}

function jsonObjLen(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const row = loadRow(ctx, args[1]);
  const p = args.length >= 3 ? parsePath(text(args[2])) : parsePath(".");
  if (!row) {
    if (p.isV2) throw new RedisError("ERR Path does not exist or not an object");
    return r.nil;
  }
  const vals = evalValues(decodeDoc(row), p);
  if (p.isV2) return r.array(vals.map((v) => (v.t === "obj" ? r.int(v.v.length) : r.nil)));
  if (!vals.length) return r.nil;
  if (vals[0].t !== "obj") throw new RedisError("WRONGTYPE wrong type of path value - expected object");
  return r.int(vals[0].v.length);
}

function jsonToggle(ctx: Ctx, [, key, pathArg]: Array<Uint8Array>): Reply {
  const row = loadRow(ctx, key);
  if (!row) throw new RedisError(NO_KEY);
  const p = parsePath(text(pathArg));
  let doc = decodeDoc(row);
  const targets = evalTargets(doc, p, (v) => { doc = v; });
  if (p.isV2) {
    let changed = false;
    const out = targets.map((t) => {
      const cur = t.get();
      if (cur.t !== "bool") return r.nil;
      const next = !cur.v;
      t.set({ t: "bool", v: next });
      changed = true;
      return r.int(next ? 1 : 0);
    });
    if (changed) saveDoc(ctx, key, row, doc);
    return r.array(out);
  }
  const first = targets[0]?.get();
  if (!first || first.t !== "bool") throw new RedisError("ERR Path does not exist or not a bool");
  const next = !first.v;
  targets[0].set({ t: "bool", v: next });
  saveDoc(ctx, key, row, doc);
  return r.bulk(next ? "true" : "false");
}

function jsonClear(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 3) wrongArgs("json.clear");
  const key = args[1];
  const row = loadRow(ctx, key);
  if (!row) throw new RedisError(NO_KEY);
  const p = args.length === 3 ? parsePath(text(args[2])) : parsePath(".");
  let doc = decodeDoc(row);
  const targets = evalTargets(doc, p, (v) => { doc = v; });
  let cleared = 0;
  for (const t of targets) {
    const v = t.get();
    if (v.t === "arr" && v.v.length > 0) {
      v.v.length = 0;
      cleared++;
    } else if (v.t === "obj" && v.v.length > 0) {
      v.v.length = 0;
      cleared++;
    } else if ((v.t === "int" && v.v !== 0n) || (v.t === "float" && v.v !== 0)) {
      t.set({ t: "int", v: 0n });
      cleared++;
    }
  }
  if (cleared > 0) saveDoc(ctx, key, row, doc);
  return r.int(cleared);
}

function jsonMerge(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length !== 4 && args.length !== 6) throw new RedisError("ERR syntax error");
  if (args.length === 6 && (opt(args[4]) !== "FORMAT" || !SET_FORMATS.has(opt(args[5])))) {
    throw new RedisError("ERR syntax error");
  }
  const key = args[1];
  const row = loadRow(ctx, key);
  const p = parsePath(text(args[2]));
  const patch = parseJson(text(args[3]), "");
  if (!row) {
    if (!p.isRoot) throw new RedisError("ERR new objects must be created at the root");
    saveDoc(ctx, key, undefined, patch);
    return r.ok;
  }
  const doc = decodeDoc(row);
  if (p.isRoot) {
    saveDoc(ctx, key, row, mergePatch(doc, patch));
    return r.ok;
  }
  const targets = evalTargets(doc, p);
  if (targets.length > 0) {
    for (const t of targets) {
      if (t.kind === "computed") throw new RedisError("ERR wrong static path");
      if (patch.t === "null" && t.numericArr) throw new RedisError("ERR bad object type");
    }
    for (const t of targets) t.set(mergePatch(t.get(), patch));
    saveDoc(ctx, key, row, doc);
    return r.ok;
  }
  if (!setAtPath(doc, p, patch)) return r.nil;
  saveDoc(ctx, key, row, doc);
  return r.ok;
}

function jsonResp(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const row = loadRow(ctx, args[1]);
  if (!row) return r.nil;
  const p = args.length >= 3 ? parsePath(text(args[2])) : parsePath(".");
  const vals = evalValues(decodeDoc(row), p);
  if (p.isV2) return r.array(vals.map(jToResp));
  if (!vals.length) throw new RedisError(NO_PATH);
  return jToResp(vals[0]);
}

function jsonDebug(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const sub = opt(args[1]);
  if (sub === "HELP") return r.bulks(["MEMORY <key> [path] - reports memory usage", "HELP                - this message"]);
  if (sub !== "MEMORY") throw new RedisError("ERR unknown subcommand - try `JSON.DEBUG HELP`");
  if (args.length < 3) wrongArgs("json.debug");
  const row = loadRow(ctx, args[2]);
  const p = args.length >= 4 ? parsePath(text(args[3])) : parsePath(".");
  if (!row) return p.isV2 ? r.array([]) : r.int(0);
  const vals = evalValues(decodeDoc(row), p);
  if (p.isV2) return r.array(vals.map((v) => r.int(jMemBytes(v))));
  if (!vals.length) throw new RedisError(NO_PATH);
  return r.int(jMemBytes(vals[0]));
}

export const jsonCommands: Table = {
  "json.set": spec(-4, ["write"], jsonSet),
  "json.get": spec(-2, ["readonly"], jsonGet),
  "json.mget": spec(-3, ["readonly"], jsonMget, [1, -2, 1]),
  "json.mset": spec(-4, ["write"], jsonMset, [1, -1, 3]),
  "json.del": spec(-2, ["write"], jsonDel),
  "json.forget": spec(-2, ["write"], jsonDel),
  "json.type": spec(-2, ["readonly"], jsonType),
  "json.numincrby": spec(4, ["write"], (ctx, args) => numOp(ctx, args, "add")),
  "json.nummultby": spec(4, ["write"], (ctx, args) => numOp(ctx, args, "mul")),
  "json.numpowby": spec(4, ["write"], (ctx, args) => numOp(ctx, args, "pow")),
  "json.strappend": spec(-3, ["write"], jsonStrAppend),
  "json.strlen": spec(-2, ["readonly"], jsonStrLen),
  "json.arrappend": spec(-3, ["write"], jsonArrAppend),
  "json.arrindex": spec(-4, ["readonly"], jsonArrIndex),
  "json.arrinsert": spec(-5, ["write"], jsonArrInsert),
  "json.arrlen": spec(-2, ["readonly"], jsonArrLen),
  "json.arrpop": spec(-2, ["write"], jsonArrPop),
  "json.arrtrim": spec(5, ["write"], jsonArrTrim),
  "json.objkeys": spec(-2, ["readonly"], jsonObjKeys),
  "json.objlen": spec(-2, ["readonly"], jsonObjLen),
  "json.toggle": spec(3, ["write"], jsonToggle),
  "json.clear": spec(-2, ["write"], jsonClear),
  "json.merge": spec(-4, ["write"], jsonMerge),
  "json.resp": spec(-2, ["readonly"], jsonResp),
  "json.debug": keyless(-2, ["readonly"], jsonDebug),
};
