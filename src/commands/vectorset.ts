import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { checkSize, keyString } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { int, opt, toInt64 } from "./args";
import { sample } from "./random";
import { spec } from "./types";
import type { Ctx, Table } from "./types";
import { compileFilter } from "../vectorset/filter";
import type { CompiledFilter } from "../vectorset/filter";
import { DEFAULT_EF_BUILD, DEFAULT_M, insertNode, randomLevel, removeNode, searchHnsw, searchTruth } from "../vectorset/hnsw";
import type { HnswNode } from "../vectorset/hnsw";
import {
  decodeVector,
  distance,
  encodeVector,
  parseFp32Blob,
  parseVectorFloat,
  projectVector,
  QUANT,
  QUANT_NAME,
  toQuant,
  vlinkScore,
  vsimScore,
} from "../vectorset/math";
import type { EncodedVector, QuantType } from "../vectorset/math";
import {
  allElements,
  createIndex,
  evictIndex,
  loadIndex,
  persistAddedNode,
  persistRemovedNode,
  rangeElements,
  readMeta,
  readNodeByElement,
  saveMeta,
  updateNodeAttrs,
} from "../vectorset/store";

interface RangeBound {
  value: Uint8Array | null;
  exclusive: boolean;
}

interface ParsedInputVector {
  rawVec: Float32Array;
  reduceDim: number;
  nextIdx: number;
}

interface VaddOptions {
  quant: QuantType;
  ef: number;
  m: number;
  setAttr: Uint8Array | undefined;
}

interface VsimOptions {
  withScores: boolean;
  withAttribs: boolean;
  count: number;
  epsilon: number | undefined;
  ef: number | undefined;
  filter: CompiledFilter | undefined;
  filterEf: number | undefined;
  truth: boolean;
}

function parseInputVector(args: Array<Uint8Array>, start: number, allowReduce: boolean): ParsedInputVector {
  let i = start;
  let reduceDim = 0;
  if (allowReduce && i < args.length && opt(args[i]) === "REDUCE") {
    if (i + 1 >= args.length) throw new RedisError("ERR invalid vector specification");
    const n = toInt64(args[i + 1]);
    if (n === undefined || n <= 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RedisError("ERR invalid vector specification");
    reduceDim = Number(n);
    i += 2;
  }
  if (i >= args.length) throw new RedisError("ERR invalid vector specification");
  const format = opt(args[i++]);
  if (format === "FP32") {
    if (i >= args.length) throw new RedisError("ERR invalid vector specification");
    const rawVec = parseFp32Blob(args[i++]);
    if (!rawVec) throw new RedisError("ERR invalid vector specification");
    if (reduceDim > rawVec.length) throw new RedisError("ERR invalid vector specification");
    return { rawVec, reduceDim, nextIdx: i };
  }
  if (format === "VALUES") {
    if (i >= args.length) throw new RedisError("ERR invalid vector specification");
    const dimBig = toInt64(args[i++]);
    if (dimBig === undefined || dimBig <= 0n || dimBig > 100_000n) throw new RedisError("ERR invalid vector specification");
    const dim = Number(dimBig);
    if (i + dim > args.length) throw new RedisError("ERR invalid vector specification");
    const rawVec = new Float32Array(dim);
    for (let j = 0; j < dim; j++) {
      const f = parseVectorFloat(args[i + j]);
      if (f === undefined) throw new RedisError("ERR invalid vector specification");
      rawVec[j] = f;
    }
    if (reduceDim > dim) throw new RedisError("ERR invalid vector specification");
    return { rawVec, reduceDim, nextIdx: i + dim };
  }
  throw new RedisError("ERR invalid vector specification");
}

function parseVaddOptions(args: Array<Uint8Array>, start: number): VaddOptions {
  let quant: QuantType = QUANT.q8;
  let ef = DEFAULT_EF_BUILD;
  let m = DEFAULT_M;
  let setAttr: Uint8Array | undefined;
  for (let i = start; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "CAS") continue;
    if (o === "NOQUANT") {
      quant = QUANT.noquant;
      continue;
    }
    if (o === "Q8") {
      quant = QUANT.q8;
      continue;
    }
    if (o === "BIN") {
      quant = QUANT.bin;
      continue;
    }
    if (o === "EF") {
      if (i + 1 >= args.length) throw new RedisError("ERR invalid option after element");
      const n = toInt64(args[++i]);
      if (n === undefined || n <= 0n) throw new RedisError("ERR invalid EF");
      ef = Number(n);
      continue;
    }
    if (o === "M") {
      if (i + 1 >= args.length) throw new RedisError("ERR invalid option after element");
      const n = toInt64(args[++i]);
      if (n === undefined || n < 4n || n > 4096n) throw new RedisError("ERR invalid M");
      m = Number(n);
      continue;
    }
    if (o === "SETATTR") {
      if (i + 1 >= args.length) throw new RedisError("ERR invalid option after element");
      setAttr = args[++i];
      continue;
    }
    throw new RedisError("ERR invalid option after element");
  }
  return { quant, ef, m, setAttr };
}

function vadd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  const { rawVec, reduceDim, nextIdx } = parseInputVector(args, 2, true);
  if (nextIdx >= args.length) throw new RedisError("ERR wrong number of arguments for 'VADD' command");
  const element = args[nextIdx];
  const opts = parseVaddOptions(args, nextIdx + 1);

  if (row) {
    const meta = readMeta(ctx.ks.sql, row.id);
    if (!meta) throw new Error(`duraredis: missing vectorset_meta for key_id ${row.id}`);
    if (opts.quant !== meta.quant) throw new RedisError("ERR asked quantization mismatch with existing vector set");
    if (opts.m !== meta.m) throw new RedisError("ERR asked M value mismatch with existing vector set");
    if (meta.input_dim === 0) {
      if (reduceDim > 0) throw new RedisError("ERR cannot add projection to existing set without projection");
      if (rawVec.length !== meta.dim) throw new RedisError(`ERR Vector dimension mismatch - got ${rawVec.length} but set has ${meta.dim}`);
    } else {
      if (reduceDim !== meta.dim) throw new RedisError(`ERR Vector dimension mismatch - got ${rawVec.length} but set has ${meta.dim}`);
      if (rawVec.length !== meta.input_dim) throw new RedisError(`ERR Input dimension mismatch for projection - got ${rawVec.length} but projection expects ${meta.input_dim}`);
    }
  }

  const effectiveVec = reduceDim > 0 ? projectVector(rawVec, reduceDim) : rawVec;
  const encoded = encodeVector(effectiveVec, opts.quant);

  const keyId = row ? row.id : ctx.ks.create(key, TYPE.vectorset);
  const index = row ? loadIndex(ctx.ks.sql, keyId) : createIndex(ctx.ks.sql, keyId, opts.quant, effectiveVec.length, reduceDim > 0 ? rawVec.length : 0, opts.m);

  const elemKey = keyString(element);
  const oldUid = index.byElement.get(elemKey);
  const oldNode = oldUid !== undefined ? index.nodes.get(oldUid) : undefined;
  const attrs = opts.setAttr === undefined ? (oldNode?.attrs ?? null) : (opts.setAttr.length === 0 ? null : opts.setAttr);
  checkSize(key, element, encoded.vec, attrs);

  try {
    if (oldUid !== undefined) {
      const remDirty = removeNode(index, oldUid);
      persistRemovedNode(ctx.ks.sql, keyId, index, oldUid, remDirty);
    }
    const uid = ++index.maxNodeUid;
    const level = randomLevel();
    const node: HnswNode = {
      uid,
      element,
      elemKey,
      level,
      vec: encoded.vec,
      f32: encoded.f32,
      i8: encoded.i8,
      u32: encoded.u32,
      norm: encoded.norm,
      quantRange: encoded.quantRange,
      attrs,
      links: Array.from({ length: level + 1 }, () => []),
    };
    const addDirty = insertNode(index, node, opts.ef);
    persistAddedNode(ctx.ks.sql, keyId, index, node, addDirty);
    saveMeta(ctx.ks.sql, keyId, index);
    if (row) ctx.ks.onChange(key);
  } catch (error) {
    evictIndex(ctx.ks.sql, keyId);
    throw error;
  }

  return r.bool(oldUid === undefined);
}

function vcard(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  if (!row) return r.int(0);
  return r.int(readMeta(ctx.ks.sql, row.id)?.size ?? 0);
}

function vdim(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  if (!row) throw new RedisError("ERR key does not exist");
  return r.int(readMeta(ctx.ks.sql, row.id)?.dim ?? 0);
}

function vemb(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, element, extra] = args;
  if (args.length > 4 || (extra && opt(extra) !== "RAW")) throw new RedisError("ERR invalid option");
  const raw = extra !== undefined;
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  if (!row) return r.nil;
  const meta = readMeta(ctx.ks.sql, row.id);
  if (!meta) return r.nil;
  const node = readNodeByElement(ctx.ks.sql, row.id, element);
  if (!node) return r.nil;
  const quant = toQuant(meta.quant);
  if (raw) {
    const items: Array<Reply> = [r.simple(QUANT_NAME[quant]), r.bulk(node.vec), r.double(node.norm)];
    if (quant === QUANT.q8) items.push(r.double(node.quantRange));
    return r.array(items);
  }
  const values = decodeVector(node.vec, quant, meta.dim, node.norm, node.quantRange);
  return r.array(Array.from(values, (v) => r.double(v)));
}

function vgetattr(ctx: Ctx, [, key, element]: Array<Uint8Array>): Reply {
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  if (!row) return r.nil;
  const node = readNodeByElement(ctx.ks.sql, row.id, element);
  return node?.attrs ? r.bulk(node.attrs) : r.nil;
}

function vsetattr(ctx: Ctx, [, key, element, json]: Array<Uint8Array>): Reply {
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  if (!row) return r.bool(false);
  const nextAttrs = json.length === 0 ? null : json;
  checkSize(key, element, nextAttrs);
  const updated = updateNodeAttrs(ctx.ks.sql, row.id, element, nextAttrs);
  if (updated) ctx.ks.onChange(key);
  return r.bool(updated);
}

function vinfo(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  if (!row) return r.nilArray;
  const m = readMeta(ctx.ks.sql, row.id);
  if (!m) return r.nilArray;
  return r.map([
    [r.simple("quant-type"), r.simple(QUANT_NAME[toQuant(m.quant)])],
    [r.simple("hnsw-m"), r.int(m.m)],
    [r.simple("vector-dim"), r.int(m.dim)],
    [r.simple("projection-input-dim"), r.int(m.input_dim)],
    [r.simple("size"), r.int(m.size)],
    [r.simple("max-level"), r.int(m.max_level)],
    [r.simple("attributes-count"), r.int(m.attrs_count)],
    [r.simple("vset-uid"), r.int(m.vset_uid)],
    [r.simple("hnsw-max-node-uid"), r.int(m.max_node_uid)],
  ]);
}

function vismember(ctx: Ctx, [, key, element]: Array<Uint8Array>): Reply {
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  if (!row) return r.bool(false);
  return r.bool(readNodeByElement(ctx.ks.sql, row.id, element) !== undefined);
}

function vlinks(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, element, extra] = args;
  if (args.length > 4 || (extra && opt(extra) !== "WITHSCORES")) {
    throw new RedisError("ERR wrong number of arguments for 'VLINKS' command");
  }
  const withScores = extra !== undefined;
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  if (!row) return r.nil;
  const index = loadIndex(ctx.ks.sql, row.id);
  const uid = index.byElement.get(keyString(element));
  if (uid === undefined) return r.nil;
  const node = index.nodes.get(uid);
  if (!node) return r.nil;
  const layers: Array<Reply> = [];
  for (let lc = node.level; lc >= 0; lc--) {
    const neighbors: Array<HnswNode> = [];
    for (const nbUid of node.links[lc]) {
      const nb = index.nodes.get(nbUid);
      if (nb) neighbors.push(nb);
    }
    if (!withScores) {
      layers.push(r.bulks(neighbors.map((nb) => nb.element)));
      continue;
    }
    const entries: Array<[Reply, Reply]> = neighbors.map((nb) => {
      const dist = distance(index.quant, index.dim, node, nb);
      return [r.bulk(nb.element), r.double(vlinkScore(dist))];
    });
    layers.push(r.map(entries));
  }
  return r.array(layers);
}

function vrandmember(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 3) throw new RedisError("ERR wrong number of arguments for 'VRANDMEMBER' command");
  const [, key, countArg] = args;
  const count = countArg !== undefined ? int(countArg, "ERR COUNT value is not an integer") : undefined;
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  if (count === undefined) {
    if (!row) return r.nil;
    const elems = allElements(ctx.ks.sql, row.id);
    return elems.length ? r.bulk(sample(elems, 1)[0]) : r.nil;
  }
  if (!row || count === 0) return r.array([]);
  return r.bulks(sample(allElements(ctx.ks.sql, row.id), count));
}

function parseRangeBound(b: Uint8Array, isStart: boolean): RangeBound {
  if (b.length === 1 && (b[0] === 0x2d || b[0] === 0x2b)) {
    if ((isStart && b[0] === 0x2b) || (!isStart && b[0] === 0x2d)) {
      throw new RedisError("ERR '-' can only be used as first argument, '+' only as second");
    }
    return { value: null, exclusive: false };
  }
  if (b.length >= 2 && (b[0] === 0x5b || b[0] === 0x28)) {
    return { value: b.subarray(1), exclusive: b[0] === 0x28 };
  }
  throw new RedisError(isStart ? "ERR invalid start range format" : "ERR invalid end range format");
}

function vrange(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 5) throw new RedisError("ERR wrong number of arguments for 'VRANGE' command");
  const [, key, startArg, endArg, countArg] = args;
  const start = parseRangeBound(startArg, true);
  const end = parseRangeBound(endArg, false);
  let count = -1;
  if (countArg !== undefined) {
    const c64 = toInt64(countArg);
    if (c64 === undefined) throw new RedisError("ERR invalid COUNT value");
    count = c64 < 0n || c64 > 2_147_483_647n ? -1 : Number(c64);
  }
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  if (!row || count === 0) return r.array([]);
  return r.bulks(rangeElements(ctx.ks.sql, row.id, start.value, start.exclusive, end.value, end.exclusive, count));
}

function vrem(ctx: Ctx, [, key, element]: Array<Uint8Array>): Reply {
  const row = ctx.ks.getTyped(key, TYPE.vectorset);
  if (!row) return r.bool(false);
  const index = loadIndex(ctx.ks.sql, row.id);
  const uid = index.byElement.get(keyString(element));
  if (uid === undefined) return r.bool(false);
  try {
    const dirty = removeNode(index, uid);
    if (index.nodes.size === 0) {
      evictIndex(ctx.ks.sql, row.id);
      ctx.ks.delete(key);
    } else {
      persistRemovedNode(ctx.ks.sql, row.id, index, uid, dirty);
      saveMeta(ctx.ks.sql, row.id, index);
      ctx.ks.onChange(key);
    }
  } catch (error) {
    evictIndex(ctx.ks.sql, row.id);
    throw error;
  }
  return r.bool(true);
}

function parseVsimEpsilon(b: Uint8Array): number {
  const s = text(b);
  if (!s.length || s !== s.trim()) throw new RedisError("ERR invalid EPSILON");
  let n: number;
  if (/^[+-]?inf(inity)?$/i.test(s)) n = s.startsWith("-") ? -Infinity : Infinity;
  else if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) n = Number(s);
  else throw new RedisError("ERR invalid EPSILON");
  if (Number.isNaN(n) || n <= 0) throw new RedisError("ERR invalid EPSILON");
  return n;
}

function parseVsimOptions(args: Array<Uint8Array>, start: number): VsimOptions {
  const opts: VsimOptions = {
    withScores: false,
    withAttribs: false,
    count: 10,
    epsilon: undefined,
    ef: undefined,
    filter: undefined,
    filterEf: undefined,
    truth: false,
  };
  for (let i = start; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "WITHSCORES") opts.withScores = true;
    else if (o === "WITHATTRIBS") opts.withAttribs = true;
    else if (o === "TRUTH") opts.truth = true;
    else if (o === "NOTHREAD") continue;
    else if (o === "COUNT") {
      if (i + 1 >= args.length) throw new RedisError("ERR syntax error in VSIM command");
      const n = toInt64(args[++i]);
      if (n === undefined || n <= 0n) throw new RedisError("ERR invalid COUNT");
      opts.count = Number(n);
    } else if (o === "EPSILON") {
      if (i + 1 >= args.length) throw new RedisError("ERR syntax error in VSIM command");
      opts.epsilon = parseVsimEpsilon(args[++i]);
    } else if (o === "EF") {
      if (i + 1 >= args.length) throw new RedisError("ERR syntax error in VSIM command");
      const n = toInt64(args[++i]);
      if (n === undefined || n <= 0n) throw new RedisError("ERR invalid EF");
      opts.ef = Number(n);
    } else if (o === "FILTER") {
      if (i + 1 >= args.length) throw new RedisError("ERR syntax error in VSIM command");
      opts.filter = compileFilter(text(args[++i]));
    } else if (o === "FILTER-EF") {
      if (i + 1 >= args.length) throw new RedisError("ERR syntax error in VSIM command");
      const n = toInt64(args[++i]);
      if (n === undefined || n <= 0n) throw new RedisError("ERR invalid FILTER-EF");
      opts.filterEf = Number(n);
    } else {
      throw new RedisError("ERR syntax error in VSIM command");
    }
  }
  return opts;
}

function vsim(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const row = ctx.ks.getTyped(args[1], TYPE.vectorset);
  if (!row) return r.array([]);
  const index = loadIndex(ctx.ks.sql, row.id);

  let query: EncodedVector;
  let nextIdx: number;
  const firstOpt = opt(args[2]);
  if (firstOpt === "ELE") {
    const uid = index.byElement.get(keyString(args[3]));
    const node = uid === undefined ? undefined : index.nodes.get(uid);
    if (!node) throw new RedisError("ERR element not found in set");
    if (index.quant === QUANT.q8) {
      query = encodeVector(decodeVector(node.vec, index.quant, index.dim, node.norm, node.quantRange), index.quant, true);
    } else {
      query = node;
    }
    nextIdx = 4;
  } else {
    const parsed = parseInputVector(args, 2, false);
    const rawVec = parsed.rawVec;
    nextIdx = parsed.nextIdx;
    if (rawVec.length === index.dim) {
      query = encodeVector(rawVec, index.quant);
    } else if (index.inputDim > 0) {
      if (rawVec.length !== index.inputDim) {
        throw new RedisError(`ERR Input dimension mismatch for projection - got ${rawVec.length} but projection expects ${index.inputDim}`);
      }
      query = encodeVector(projectVector(rawVec, index.dim), index.quant);
    } else {
      throw new RedisError(`ERR Vector dimension mismatch - got ${rawVec.length} but set has ${index.dim}`);
    }
  }

  const opts = parseVsimOptions(args, nextIdx);
  const hits = opts.truth
    ? searchTruth(index, query, opts.count, opts.epsilon, opts.filter)
    : searchHnsw(index, query, opts.count, opts.ef, opts.epsilon, opts.filter, opts.filterEf);

  if (!opts.withScores && !opts.withAttribs) return r.bulks(hits.map((h) => h.node.element));
  if (opts.withScores && !opts.withAttribs) {
    return r.map(hits.map((h) => [r.bulk(h.node.element), r.double(vsimScore(h.dist))]));
  }
  if (!opts.withScores && opts.withAttribs) {
    return r.map(hits.map((h) => [r.bulk(h.node.element), h.node.attrs ? r.bulk(h.node.attrs) : r.nil]));
  }
  if (ctx.session.proto === 3) {
    return r.map(
      hits.map((h) => [r.bulk(h.node.element), r.array([r.double(vsimScore(h.dist)), h.node.attrs ? r.bulk(h.node.attrs) : r.nil])]),
    );
  }
  return r.array(
    hits.flatMap((h) => [r.bulk(h.node.element), r.double(vsimScore(h.dist)), h.node.attrs ? r.bulk(h.node.attrs) : r.nil]),
  );
}

const TABLE: Table = {
  vadd: spec(-5, ["write"], vadd),
  vcard: spec(2, ["readonly", "fast"], vcard),
  vdim: spec(2, ["readonly", "fast"], vdim),
  vemb: spec(-3, ["readonly", "fast"], vemb),
  vgetattr: spec(3, ["readonly", "fast"], vgetattr),
  vinfo: spec(2, ["readonly", "fast"], vinfo),
  vismember: spec(3, ["readonly"], vismember),
  vlinks: spec(-3, ["readonly", "fast"], vlinks),
  vrandmember: spec(-2, ["readonly"], vrandmember),
  vrange: spec(-4, ["readonly"], vrange),
  vrem: spec(3, ["write"], vrem),
  vsetattr: spec(4, ["write", "fast"], vsetattr),
  vsim: spec(-4, ["readonly"], vsim),
};

export const vectorset: Table = Object.fromEntries(Object.entries(TABLE).map(([name, command]) => [name, { ...command, label: name.toUpperCase() }]));
