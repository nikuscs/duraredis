import { INT64_MAX, INT64_MIN, opt, toInt64 } from "../commands/args";
import type { Ctx } from "../commands/types";
import { r, RedisError } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { TYPE } from "../store/schema";
import { CHUNK_BYTES, CHUNK_MASK, ChunkStore, MAX_ALLOC_BYTES } from "./chunks";
import { argIndex, murmurHash2, parseDoubleStrict, wrongArity } from "./hash";

interface CMSketch {
  keyId: number;
  width: bigint;
  depth: bigint;
  counter: bigint;
  cellSize: number;
  chunks: ChunkStore;
}

function cellMax(cellSize: number): bigint {
  if (cellSize === 1) return 255n;
  if (cellSize === 2) return 65_535n;
  if (cellSize === 4) return 4_294_967_295n;
  return INT64_MAX;
}

function cellGet(cms: CMSketch, loc: number): bigint {
  const off = loc * cms.cellSize;
  const buf = cms.chunks.get(Math.floor(off / CHUNK_BYTES));
  const pos = off & CHUNK_MASK;
  if (cms.cellSize === 1) return BigInt(buf[pos]);
  const view = new DataView(buf.buffer, buf.byteOffset + pos, cms.cellSize);
  if (cms.cellSize === 2) return BigInt(view.getUint16(0, true));
  if (cms.cellSize === 4) return BigInt(view.getUint32(0, true));
  return view.getBigUint64(0, true);
}

function cellSet(cms: CMSketch, loc: number, val: bigint) {
  const off = loc * cms.cellSize;
  const chunkIdx = Math.floor(off / CHUNK_BYTES);
  const buf = cms.chunks.get(chunkIdx);
  const pos = off & CHUNK_MASK;
  if (cms.cellSize === 1) buf[pos] = Number(val);
  else {
    const view = new DataView(buf.buffer, buf.byteOffset + pos, cms.cellSize);
    if (cms.cellSize === 2) view.setUint16(0, Number(val), true);
    else if (cms.cellSize === 4) view.setUint32(0, Number(val), true);
    else view.setBigUint64(0, val, true);
  }
  cms.chunks.markDirty(chunkIdx);
}

function loadCMS(ctx: Ctx, key: Uint8Array): CMSketch {
  const row = ctx.ks.getTyped(key, TYPE.cms);
  if (!row) throw new RedisError("CMS: key does not exist");
  const m = ctx.ks.sql.exec<{ width: string; depth: string; counter: string; cell_size: number }>(
    "SELECT width, depth, counter, cell_size FROM cms_meta WHERE key_id = ?", row.id).one();
  const width = BigInt(m.width);
  const depth = BigInt(m.depth);
  return {
    keyId: row.id,
    width,
    depth,
    counter: BigInt(m.counter),
    cellSize: m.cell_size,
    chunks: new ChunkStore(ctx.ks.sql, row.id, "cms_chunks", Number(width * depth) * m.cell_size),
  };
}

function cmsCreate(ctx: Ctx, args: Array<Uint8Array>, byDim: boolean): Reply {
  if (args.length !== 4 && args.length !== 6) throw wrongArity(args[0]);
  if (ctx.ks.exists(args[1])) throw new RedisError("CMS: key already exists");

  let width: bigint;
  let depth: bigint;
  if (byDim) {
    const w = toInt64(args[2]);
    if (w === undefined || w < 1n) throw new RedisError("CMS: invalid width");
    const d = toInt64(args[3]);
    if (d === undefined || d < 1n) throw new RedisError("CMS: invalid depth");
    width = w;
    depth = d;
  } else {
    const overEst = parseDoubleStrict(args[2]);
    if (overEst === undefined || overEst <= 0 || overEst >= 1) throw new RedisError("CMS: invalid overestimation value");
    const prob = parseDoubleStrict(args[3]);
    if (prob === undefined || prob <= 0 || prob >= 1) throw new RedisError("CMS: invalid prob value");
    width = BigInt(Math.ceil(2 / overEst));
    depth = BigInt(Math.ceil(Math.fround(Math.fround(Math.log10(Math.fround(prob))) / Math.fround(Math.log10(0.5)))));
  }

  if (width < 1n || depth < 1n || width > INT64_MAX / depth) throw new RedisError("CMS: invalid init arguments");

  let cellSize = 4;
  if (args.length === 6) {
    if (opt(args[4]) !== "CELL_SIZE") throw new RedisError("CMS: unknown argument");
    const cs = toInt64(args[5]);
    if (cs === undefined || (cs !== 1n && cs !== 2n && cs !== 4n && cs !== 8n)) throw new RedisError("CMS: CELL_SIZE must be 1, 2, 4 or 8");
    cellSize = Number(cs);
  }

  if (width * depth * BigInt(cellSize) > BigInt(MAX_ALLOC_BYTES)) throw new RedisError("CMS: Insufficient memory to create the key");
  const keyId = ctx.ks.create(args[1], TYPE.cms);
  ctx.ks.sql.exec("INSERT INTO cms_meta (key_id, width, depth, counter, cell_size) VALUES (?, ?, ?, ?, ?)",
    keyId, String(width), String(depth), "0", cellSize);
  return r.ok;
}

function cmsIncrBy(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length < 4 || args.length % 2 === 1) throw wrongArity(args[0]);
  const cms = loadCMS(ctx, args[1]);
  const pairCount = (args.length - 2) / 2;
  const pairs: Array<{ item: Uint8Array; val: bigint }> = [];
  for (let i = 0; i < pairCount; i++) {
    const val = toInt64(args[2 + i * 2 + 1]);
    if (val === undefined) throw new RedisError("CMS: Cannot parse number");
    if (val === INT64_MIN) throw new RedisError("CMS: invalid increment");
    pairs.push({ item: args[2 + i * 2], val });
  }

  const maxCell = cellMax(cms.cellSize);
  const depthNum = Number(cms.depth);
  let changed = false;
  const out: Array<Reply> = [];

  for (const { item, val } of pairs) {
    const mag = val < 0n ? -val : val;
    if (val > 0n && mag > INT64_MAX - cms.counter) {
      out.push(r.error("CMS: INCRBY overflow"));
      continue;
    }
    if (val < 0n && mag > cms.counter) {
      out.push(r.error("CMS: INCRBY underflow"));
      continue;
    }
    const locs: Array<number> = [];
    const nexts: Array<bigint> = [];
    let failed: "overflow" | "underflow" | undefined;
    for (let i = 0; i < depthNum; i++) {
      const loc = Number((BigInt(murmurHash2(item, i)) % cms.width) + BigInt(i) * cms.width);
      const cell = cellGet(cms, loc);
      if (val > 0n && mag > maxCell - cell) {
        failed = "overflow";
        break;
      }
      if (val < 0n && mag > cell) {
        failed = "underflow";
        break;
      }
      locs.push(loc);
      nexts.push(val < 0n ? cell - mag : cell + mag);
    }
    if (failed) {
      out.push(r.error(failed === "overflow" ? "CMS: INCRBY overflow" : "CMS: INCRBY underflow"));
      continue;
    }
    let minCount = INT64_MAX;
    for (let i = 0; i < depthNum; i++) {
      cellSet(cms, locs[i], nexts[i]);
      if (nexts[i] < minCount) minCount = nexts[i];
    }
    cms.counter = val < 0n ? cms.counter - mag : cms.counter + mag;
    changed = true;
    out.push(r.int(minCount));
  }

  if (changed) {
    ctx.ks.sql.exec("UPDATE cms_meta SET counter = ? WHERE key_id = ?", String(cms.counter), cms.keyId);
    cms.chunks.flush();
    ctx.ks.onChange(args[1]);
  }
  return r.array(out);
}

function cmsQuery(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const cms = loadCMS(ctx, args[1]);
  const depthNum = Number(cms.depth);
  return r.array(args.slice(2).map((item) => {
    let minCount = cellMax(cms.cellSize);
    for (let i = 0; i < depthNum; i++) {
      const loc = Number((BigInt(murmurHash2(item, i)) % cms.width) + BigInt(i) * cms.width);
      const c = cellGet(cms, loc);
      if (c < minCount) minCount = c;
    }
    return r.int(minCount);
  }));
}

function fitsInt64(n: bigint): boolean {
  return n >= INT64_MIN && n <= INT64_MAX;
}

function cmsMerge(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const dest = loadCMS(ctx, args[1]);
  const numKeys64 = toInt64(args[2]);
  if (numKeys64 === undefined) throw new RedisError("CMS: invalid numkeys");
  if (numKeys64 <= 0n) throw new RedisError("CMS: Number of keys must be positive");
  const numKeys = Number(numKeys64);
  const rest = args.slice(3);
  const wPos = argIndex("WEIGHTS", rest);
  if (wPos < 0) {
    if (numKeys !== rest.length) throw new RedisError("CMS: wrong number of keys");
  } else if (wPos !== numKeys || rest.length !== 1 + numKeys * 2) {
    throw new RedisError("CMS: wrong number of keys/weights");
  }

  const srcs: Array<CMSketch> = [];
  const weights: Array<bigint> = [];
  for (let i = 0; i < numKeys; i++) {
    let w = 1n;
    if (wPos >= 0) {
      const parsed = toInt64(rest[numKeys + 1 + i]);
      if (parsed === undefined) throw new RedisError("CMS: invalid weight value");
      w = parsed;
    }
    weights.push(w);
    const src = loadCMS(ctx, rest[i]);
    if (src.width !== dest.width || src.depth !== dest.depth) throw new RedisError("CMS: width/depth is not equal");
    if (src.cellSize !== dest.cellSize) throw new RedisError("CMS: cell size is not equal");
    srcs.push(src);
  }

  const totalCells = Number(dest.width * dest.depth);
  const maxCell = cellMax(dest.cellSize);
  const merged = new Array<bigint>(totalCells);
  for (let loc = 0; loc < totalCells; loc++) {
    let sum = 0n;
    for (let k = 0; k < numKeys; k++) {
      const mul = cellGet(srcs[k], loc) * weights[k];
      if (!fitsInt64(mul)) throw new RedisError("CMS: MERGE overflow");
      sum += mul;
      if (!fitsInt64(sum)) throw new RedisError("CMS: MERGE overflow");
    }
    if (sum < 0n || sum > maxCell) throw new RedisError("CMS: MERGE overflow");
    merged[loc] = sum;
  }

  let totalCounter = 0n;
  for (let k = 0; k < numKeys; k++) {
    const mul = srcs[k].counter * weights[k];
    if (!fitsInt64(mul)) throw new RedisError("CMS: MERGE overflow");
    totalCounter += mul;
    if (!fitsInt64(totalCounter)) throw new RedisError("CMS: MERGE overflow");
  }
  if (totalCounter < 0n) throw new RedisError("CMS: MERGE overflow");

  for (let loc = 0; loc < totalCells; loc++) cellSet(dest, loc, merged[loc]);
  ctx.ks.sql.exec("UPDATE cms_meta SET counter = ? WHERE key_id = ?", String(totalCounter), dest.keyId);
  dest.chunks.flush();
  ctx.ks.onChange(args[1]);
  return r.ok;
}

function cmsInfo(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const cms = loadCMS(ctx, key);
  return r.map([
    [r.simple("width"), r.int(cms.width)],
    [r.simple("depth"), r.int(cms.depth)],
    [r.simple("count"), r.int(cms.counter)],
    [r.simple("cell_size"), r.int(cms.cellSize)],
  ]);
}

export const cmsCommands = {
  cmsCreate,
  cmsIncrBy,
  cmsQuery,
  cmsMerge,
  cmsInfo,
};
