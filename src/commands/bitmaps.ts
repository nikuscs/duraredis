import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import type { KeyRow } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { ERR, int, int64, opt, toInt64 } from "./args";
import { spec } from "./types";
import type { Ctx, Table } from "./types";

const MAX_BIT_OFFSET = 4_294_967_295n;
const MAX_ROW_BYTES = 2_000_000;
const BIT_OFFSET_ERR = "ERR bit offset is not an integer or out of range";
const BIT_VALUE_ERR = "ERR bit is not an integer or out of range";
const ROW_LIMIT_ERR = "ERR duraredis: a key and its value must fit in 2 MB";
const BITFIELD_TYPE_ERR = "ERR Invalid bitfield type. Use something like i16 u8. Note that u64 is not supported but i64 is.";
const BITFIELD_RO_ERR = "ERR BITFIELD_RO only supports the GET subcommand";

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, i) => {
  let n = i;
  let c = 0;
  while (n) {
    c += n & 1;
    n >>= 1;
  }
  return c;
});

type BitOp = "AND" | "OR" | "XOR" | "NOT" | "DIFF" | "DIFF1" | "ANDOR" | "ONE";
type Overflow = "WRAP" | "SAT" | "FAIL";

interface BitfieldType {
  signed: boolean;
  bits: number;
}

type BitfieldOp =
  | { kind: "GET"; type: BitfieldType; offset: number }
  | { kind: "SET"; type: BitfieldType; offset: number; value: bigint; overflow: Overflow }
  | { kind: "INCRBY"; type: BitfieldType; offset: number; incr: bigint; overflow: Overflow };

const BITOPS = new Set<string>(["AND", "OR", "XOR", "NOT", "DIFF", "DIFF1", "ANDOR", "ONE"]);
const OVERFLOWS = new Set<string>(["WRAP", "SAT", "FAIL"]);

function parseBitOffset(arg: Uint8Array): number {
  const n = toInt64(arg);
  if (n === undefined || n < 0n || n > MAX_BIT_OFFSET) throw new RedisError(BIT_OFFSET_ERR);
  return Number(n);
}

function checkGrowth(key: Uint8Array, byteLen: number) {
  if (key.length + byteLen > MAX_ROW_BYTES) throw new RedisError(ROW_LIMIT_ERR);
}

function writeString(ctx: Ctx, key: Uint8Array, row: KeyRow | undefined, value: Uint8Array) {
  if (row) ctx.ks.updateValue(row.id, key, value);
  else ctx.ks.create(key, TYPE.string, value);
}

function normalizeRange(len: number, start: number, end: number, guardNegativeReverse: boolean): [number, number] | null {
  if (guardNegativeReverse && start < 0 && end < 0 && start > end) return null;
  let s = start < 0 ? start + len : start;
  let e = end < 0 ? end + len : end;
  if (s < 0) s = 0;
  if (e < 0) e = 0;
  if (e >= len) e = len - 1;
  if (s > e) return null;
  return [s, e];
}

function setbit(ctx: Ctx, [, key, offArg, bitArg]: Array<Uint8Array>): Reply {
  const offset = parseBitOffset(offArg);
  const bit = toInt64(bitArg);
  if (bit !== 0n && bit !== 1n) throw new RedisError(BIT_VALUE_ERR);
  const row = ctx.ks.getTyped(key, TYPE.string);
  const old = row?.value ?? new Uint8Array(0);
  const byteIdx = Math.floor(offset / 8);
  const needed = Math.max(old.length, byteIdx + 1);
  checkGrowth(key, needed);
  const mask = 0x80 >> (offset % 8);
  const prev = byteIdx < old.length && (old[byteIdx] & mask) !== 0 ? 1 : 0;
  const next = new Uint8Array(needed);
  next.set(old);
  if (bit === 1n) next[byteIdx] |= mask;
  else next[byteIdx] &= ~mask;
  writeString(ctx, key, row, next);
  return r.int(prev);
}

function getbit(ctx: Ctx, [, key, offArg]: Array<Uint8Array>): Reply {
  const offset = parseBitOffset(offArg);
  const row = ctx.ks.getTyped(key, TYPE.string);
  const v = row?.value;
  const byteIdx = Math.floor(offset / 8);
  if (!v || byteIdx >= v.length) return r.int(0);
  return r.int((v[byteIdx] & (0x80 >> (offset % 8))) !== 0 ? 1 : 0);
}

function bitcount(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length !== 2 && args.length !== 4 && args.length !== 5) throw new RedisError(ERR.syntax);
  const startArg = args.length >= 4 ? int(args[2]) : 0;
  const endArg = args.length >= 4 ? int(args[3]) : 0;
  let isBit = false;
  if (args.length === 5) {
    const unit = opt(args[4]);
    if (unit === "BIT") isBit = true;
    else if (unit !== "BYTE") throw new RedisError(ERR.syntax);
  }
  const v = ctx.ks.getTyped(args[1], TYPE.string)?.value;
  if (!v || v.length === 0) return r.int(0);
  if (args.length === 2) {
    let total = 0;
    for (const b of v) total += POPCOUNT[b];
    return r.int(total);
  }
  const range = normalizeRange(isBit ? v.length * 8 : v.length, startArg, endArg, true);
  if (!range) return r.int(0);
  const [start, end] = range;
  if (!isBit) {
    let total = 0;
    for (let i = start; i <= end; i++) total += POPCOUNT[v[i]];
    return r.int(total);
  }
  const b0 = Math.floor(start / 8);
  const b1 = Math.floor(end / 8);
  const m0 = 0xff >>> (start % 8);
  const m1 = (0xff << (7 - (end % 8))) & 0xff;
  if (b0 === b1) return r.int(POPCOUNT[v[b0] & m0 & m1]);
  let total = POPCOUNT[v[b0] & m0] + POPCOUNT[v[b1] & m1];
  for (let i = b0 + 1; i < b1; i++) total += POPCOUNT[v[i]];
  return r.int(total);
}

function bitpos(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 6) throw new RedisError(ERR.syntax);
  const bit = int(args[2]);
  if (bit !== 0 && bit !== 1) throw new RedisError("ERR The bit argument must be 1 or 0.");
  let isBit = false;
  const endGiven = args.length >= 5;
  if (args.length === 6) {
    const unit = opt(args[5]);
    if (unit === "BIT") isBit = true;
    else if (unit !== "BYTE") throw new RedisError(ERR.syntax);
  }
  const startArg = args.length >= 4 ? int(args[3]) : 0;
  const endArg = endGiven ? int(args[4]) : 0;
  const row = ctx.ks.getTyped(args[1], TYPE.string);
  if (!row) return r.int(bit === 1 ? -1 : 0);
  const v = row.value ?? new Uint8Array(0);
  if (v.length === 0) return r.int(-1);
  const len = isBit ? v.length * 8 : v.length;
  const range = normalizeRange(len, startArg, endGiven ? endArg : len - 1, false);
  if (!range) return r.int(-1);
  const bitStart = isBit ? range[0] : range[0] * 8;
  const bitEnd = isBit ? range[1] : range[1] * 8 + 7;
  const skipByte = bit === 1 ? 0 : 0xff;
  for (let pos = bitStart; pos <= bitEnd; ) {
    if ((pos & 7) === 0 && pos + 7 <= bitEnd && v[pos >>> 3] === skipByte) {
      pos += 8;
      continue;
    }
    const found = (v[pos >>> 3] & (0x80 >> (pos & 7))) !== 0 ? 1 : 0;
    if (found === bit) return r.int(pos);
    pos++;
  }
  return r.int(bit === 0 && !endGiven ? v.length * 8 : -1);
}

function parseBitOp(raw: Uint8Array): BitOp {
  const s = opt(raw);
  if (!BITOPS.has(s)) throw new RedisError(ERR.syntax);
  switch (s) {
    case "AND":
    case "OR":
    case "XOR":
    case "NOT":
    case "DIFF":
    case "DIFF1":
    case "ANDOR":
    case "ONE":
      return s;
    default:
      throw new RedisError(ERR.syntax);
  }
}

function computeBitOpByte(op: BitOp, srcs: Array<Uint8Array>, idx: number): number {
  const b0 = idx < srcs[0].length ? srcs[0][idx] : 0;
  if (op === "NOT") return (~b0) & 0xff;
  if (op === "AND" || op === "OR" || op === "XOR") {
    let acc = b0;
    for (let k = 1; k < srcs.length; k++) {
      const b = idx < srcs[k].length ? srcs[k][idx] : 0;
      if (op === "AND") acc &= b;
      else if (op === "OR") acc |= b;
      else acc ^= b;
    }
    return acc;
  }
  if (op === "ONE") {
    let once = 0;
    let multi = 0;
    for (const s of srcs) {
      const b = idx < s.length ? s[idx] : 0;
      multi |= once & b;
      once ^= b;
    }
    return once & (~multi & 0xff);
  }
  let rest = 0;
  for (let k = 1; k < srcs.length; k++) {
    const b = idx < srcs[k].length ? srcs[k][idx] : 0;
    rest |= b;
  }
  if (op === "DIFF") return b0 & (~rest & 0xff);
  if (op === "DIFF1") return (~b0 & 0xff) & rest;
  return b0 & rest;
}

function bitop(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const op = parseBitOp(args[1]);
  const dest = args[2];
  const srcKeys = args.slice(3);
  if (op === "NOT" && srcKeys.length > 1) throw new RedisError("ERR BITOP NOT must be called with a single source key.");
  if ((op === "DIFF" || op === "DIFF1" || op === "ANDOR") && srcKeys.length < 2) {
    throw new RedisError(`ERR BITOP ${op} must be called with at least two source keys.`);
  }
  const srcs = srcKeys.map((k) => ctx.ks.getTyped(k, TYPE.string)?.value ?? new Uint8Array(0));
  const maxLen = Math.max(0, ...srcs.map((s) => s.length));
  if (maxLen === 0) {
    ctx.ks.delete(dest);
    return r.int(0);
  }
  const out = new Uint8Array(maxLen);
  for (let i = 0; i < maxLen; i++) out[i] = computeBitOpByte(op, srcs, i);
  ctx.ks.setString(dest, out);
  return r.int(maxLen);
}

function parseBitfieldType(arg: Uint8Array): BitfieldType {
  const s = text(arg);
  if (s.length < 2) throw new RedisError(BITFIELD_TYPE_ERR);
  const prefix = s[0];
  if (prefix !== "i" && prefix !== "u") throw new RedisError(BITFIELD_TYPE_ERR);
  const rest = s.slice(1);
  if (!/^[1-9]\d*$/.test(rest)) throw new RedisError(BITFIELD_TYPE_ERR);
  const bits = Number(rest);
  const signed = prefix === "i";
  if (bits < 1 || (signed ? bits > 64 : bits > 63)) throw new RedisError(BITFIELD_TYPE_ERR);
  return { signed, bits };
}

function parseBitfieldOffset(arg: Uint8Array, bits: number): number {
  const s = text(arg);
  if (!s.startsWith("#")) return parseBitOffset(arg);
  const n = toInt64(arg.subarray(1));
  if (n === undefined || n < 0n) throw new RedisError(BIT_OFFSET_ERR);
  const bitOffset = n * BigInt(bits);
  if (bitOffset > MAX_BIT_OFFSET) throw new RedisError(BIT_OFFSET_ERR);
  return Number(bitOffset);
}

function parseOverflow(raw: Uint8Array): Overflow {
  const s = opt(raw);
  if (!OVERFLOWS.has(s)) throw new RedisError("ERR Invalid OVERFLOW type specified");
  switch (s) {
    case "WRAP":
    case "SAT":
    case "FAIL":
      return s;
    default:
      throw new RedisError("ERR Invalid OVERFLOW type specified");
  }
}

function parseBitfieldOps(args: Array<Uint8Array>, readonly: boolean): Array<BitfieldOp> {
  const ops: Array<BitfieldOp> = [];
  let overflow: Overflow = "WRAP";
  let i = 2;
  while (i < args.length) {
    const sub = opt(args[i++]);
    if (sub === "GET") {
      if (i + 2 > args.length) throw new RedisError(ERR.syntax);
      const type = parseBitfieldType(args[i++]);
      const offset = parseBitfieldOffset(args[i++], type.bits);
      ops.push({ kind: "GET", type, offset });
    } else if (sub === "SET") {
      if (readonly) throw new RedisError(BITFIELD_RO_ERR);
      if (i + 3 > args.length) throw new RedisError(ERR.syntax);
      const type = parseBitfieldType(args[i++]);
      const offset = parseBitfieldOffset(args[i++], type.bits);
      const value = int64(args[i++]);
      ops.push({ kind: "SET", type, offset, value, overflow });
    } else if (sub === "INCRBY") {
      if (readonly) throw new RedisError(BITFIELD_RO_ERR);
      if (i + 3 > args.length) throw new RedisError(ERR.syntax);
      const type = parseBitfieldType(args[i++]);
      const offset = parseBitfieldOffset(args[i++], type.bits);
      const incr = int64(args[i++]);
      ops.push({ kind: "INCRBY", type, offset, incr, overflow });
    } else if (sub === "OVERFLOW") {
      if (i + 1 > args.length) throw new RedisError(ERR.syntax);
      overflow = parseOverflow(args[i++]);
    } else {
      throw new RedisError(ERR.syntax);
    }
  }
  return ops;
}

function readBits(buf: Uint8Array, offset: number, type: BitfieldType): bigint {
  let val = 0n;
  for (let i = 0; i < type.bits; i++) {
    const p = offset + i;
    const byteIdx = Math.floor(p / 8);
    const bit = byteIdx < buf.length && (buf[byteIdx] & (0x80 >> (p % 8))) !== 0 ? 1n : 0n;
    val = (val << 1n) | bit;
  }
  return type.signed ? BigInt.asIntN(type.bits, val) : val;
}

function writeBits(buf: Uint8Array, offset: number, bits: number, val: bigint) {
  for (let i = 0; i < bits; i++) {
    const p = offset + i;
    const byteIdx = Math.floor(p / 8);
    const mask = 0x80 >> (p % 8);
    const bit = (val >> BigInt(bits - 1 - i)) & 1n;
    if (bit !== 0n) buf[byteIdx] |= mask;
    else buf[byteIdx] &= ~mask;
  }
}

function typeRange(type: BitfieldType): [bigint, bigint] {
  if (type.signed) {
    const half = 1n << BigInt(type.bits - 1);
    return [-half, half - 1n];
  }
  return [0n, (1n << BigInt(type.bits)) - 1n];
}

function applyOverflow(val: bigint, type: BitfieldType, overflow: Overflow): bigint | null {
  const [min, max] = typeRange(type);
  if (val >= min && val <= max) return val;
  if (overflow === "FAIL") return null;
  if (overflow === "SAT") return val < min ? min : max;
  return type.signed ? BigInt.asIntN(type.bits, val) : BigInt.asUintN(type.bits, val);
}

function bitfield(ctx: Ctx, args: Array<Uint8Array>, readonly: boolean): Reply {
  const ops = parseBitfieldOps(args, readonly);
  const key = args[1];
  const row = ctx.ks.getTyped(key, TYPE.string);
  if (ops.length === 0) return r.array([]);
  const old = row?.value ?? new Uint8Array(0);
  let maxWriteBytes = 0;
  let hasWrite = false;
  for (const op of ops) {
    if (op.kind === "GET") continue;
    hasWrite = true;
    const bytesNeeded = Math.floor((op.offset + op.type.bits - 1) / 8) + 1;
    if (bytesNeeded > maxWriteBytes) maxWriteBytes = bytesNeeded;
  }
  let buf = old;
  if (hasWrite) {
    const needed = Math.max(old.length, maxWriteBytes);
    checkGrowth(key, needed);
    buf = new Uint8Array(needed);
    buf.set(old);
  }
  const replies: Array<Reply> = [];
  for (const op of ops) {
    const cur = readBits(buf, op.offset, op.type);
    if (op.kind === "GET") {
      replies.push(r.int(cur));
      continue;
    }
    if (op.kind === "SET") {
      const candidate = op.type.signed ? op.value : BigInt.asUintN(64, op.value);
      const next = applyOverflow(candidate, op.type, op.overflow);
      if (next === null) {
        replies.push(r.nil);
      } else {
        writeBits(buf, op.offset, op.type.bits, next);
        replies.push(r.int(cur));
      }
      continue;
    }
    const next = applyOverflow(cur + op.incr, op.type, op.overflow);
    if (next === null) {
      replies.push(r.nil);
    } else {
      writeBits(buf, op.offset, op.type.bits, next);
      replies.push(r.int(next));
    }
  }
  if (hasWrite) writeString(ctx, key, row, buf);
  return r.array(replies);
}

function bitrangeintarray(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const startArg = int(args[2]);
  const endArg = int(args[3]);
  let isBit = false;
  let zeros = false;
  let limit: number | null = null;
  for (let i = 4; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "BYTE") isBit = false;
    else if (o === "BIT") isBit = true;
    else if (o === "ZEROS") zeros = true;
    else if (o === "LIMIT" && i + 1 < args.length) {
      limit = int(args[++i]);
      if (limit < 0) throw new RedisError("ERR LIMIT can't be negative");
    } else throw new RedisError(ERR.syntax);
  }
  const v = ctx.ks.getTyped(args[1], TYPE.string)?.value;
  if (!v || v.length === 0 || limit === 0) return r.array([]);
  const range = normalizeRange(isBit ? v.length * 8 : v.length, startArg, endArg, true);
  if (!range) return r.array([]);
  const target = zeros ? 0 : 1;
  const out: Array<Reply> = [];
  if (!isBit) {
    for (let bIdx = range[0]; bIdx <= range[1]; bIdx++) {
      const byte = v[bIdx];
      const base = bIdx * 8;
      for (let b = 0; b < 8; b++) {
        if (((byte >> (7 - b)) & 1) === target) out.push(r.int(base + b));
      }
      if (limit !== null && out.length >= limit) break;
    }
    return r.array(out);
  }
  for (let pos = range[0]; pos <= range[1]; pos++) {
    const bit = (v[pos >>> 3] & (0x80 >> (pos & 7))) !== 0 ? 1 : 0;
    if (bit === target) {
      out.push(r.int(pos));
      if (limit !== null && out.length >= limit) break;
    }
  }
  return r.array(out);
}

export const bitmaps: Table = {
  setbit: spec(4, ["write"], setbit),
  getbit: spec(3, ["readonly", "fast"], getbit),
  bitcount: spec(-2, ["readonly"], bitcount),
  bitpos: spec(-3, ["readonly"], bitpos),
  bitop: spec(-4, ["write"], bitop, [2, -1, 1]),
  bitfield: spec(-2, ["write"], (ctx, args) => bitfield(ctx, args, false)),
  bitfield_ro: spec(-2, ["readonly", "fast"], (ctx, args) => bitfield(ctx, args, true)),
  bitrangeintarray: spec(-4, ["readonly"], bitrangeintarray),
};
