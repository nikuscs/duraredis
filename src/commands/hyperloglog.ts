import {
  assertValidHll,
  createSparseHll,
  denseGetRegister,
  denseSetRegister,
  HLL_DENSE,
  HLL_REGISTERS,
  HLL_SPARSE,
  hllAdd,
  hllCount,
  hllCountFromRegisters,
  hllDecodeSparse,
  hllMergeInto,
  hllSelfTest,
  hllSetRegister,
  invalidateCache,
  isCacheValid,
  readCachedCard,
  sparseToDense,
  writeCachedCard,
} from "../bits/hll";
import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { blob, WRONGTYPE } from "../store/keyspace";
import type { KeyRow } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { opt } from "./args";
import { keyless, spec } from "./types";
import type { Ctx, Table } from "./types";

function hllRow(ctx: Ctx, key: Uint8Array): KeyRow | undefined {
  const row = ctx.ks.getTyped(key, TYPE.string);
  if (row) assertValidHll(row.value ?? new Uint8Array(0));
  return row;
}

function pfadd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const row = hllRow(ctx, key);
  let buf = row?.value ? row.value.slice() : createSparseHll();
  let updated = !row;
  for (let i = 2; i < args.length; i++) {
    const res = hllAdd(buf, args[i]);
    buf = res.buf;
    if (res.updated) updated = true;
  }
  if (!row) ctx.ks.create(key, TYPE.string, buf);
  else if (updated) ctx.ks.updateValue(row.id, key, buf);
  return r.int(updated ? 1 : 0);
}

function pfcount(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length === 2) {
    const row = hllRow(ctx, args[1]);
    if (!row) return r.int(0);
    const v = row.value ?? new Uint8Array(0);
    if (isCacheValid(v)) return r.int(readCachedCard(v));
    const card = hllCount(v);
    const cached = v.slice();
    writeCachedCard(cached, BigInt(card));
    ctx.ks.sql.exec("UPDATE keys SET value = ? WHERE id = ?", blob(cached), row.id);
    return r.int(card);
  }
  const rows: Array<Uint8Array> = [];
  for (let i = 1; i < args.length; i++) {
    const row = hllRow(ctx, args[i]);
    if (row?.value) rows.push(row.value);
  }
  if (rows.length === 0) return r.int(0);
  const max = new Uint8Array(HLL_REGISTERS);
  for (const buf of rows) hllMergeInto(max, buf);
  return r.int(hllCountFromRegisters(max));
}

function pfmerge(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const dest = args[1];
  const destRow = hllRow(ctx, dest);
  const sources: Array<Uint8Array> = [];
  let useDense = destRow?.value?.[4] === HLL_DENSE;
  if (destRow?.value) sources.push(destRow.value);
  for (let i = 2; i < args.length; i++) {
    const row = hllRow(ctx, args[i]);
    if (!row?.value) continue;
    if (row.value[4] === HLL_DENSE) useDense = true;
    sources.push(row.value);
  }
  const max = new Uint8Array(HLL_REGISTERS);
  for (const s of sources) hllMergeInto(max, s);
  let buf = destRow?.value ? destRow.value.slice() : createSparseHll();
  if (useDense) {
    if (buf[4] === HLL_SPARSE) buf = sparseToDense(buf);
    for (let j = 0; j < HLL_REGISTERS; j++) denseSetRegister(buf, j, max[j]);
  } else {
    for (let j = 0; j < HLL_REGISTERS; j++) {
      if (max[j] === 0) continue;
      buf = hllSetRegister(buf, j, max[j]).buf;
    }
  }
  invalidateCache(buf);
  if (destRow) ctx.ks.updateValue(destRow.id, dest, buf);
  else ctx.ks.create(dest, TYPE.string, buf);
  return r.ok;
}

function pfdebug(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[2];
  const row = ctx.ks.get(key);
  if (!row) throw new RedisError("ERR The specified key does not exist");
  if (row.type !== TYPE.string) throw new RedisError(WRONGTYPE);
  const v = row.value ?? new Uint8Array(0);
  assertValidHll(v);
  const sub = opt(args[1]);
  if (sub === "ENCODING") return r.simple(v[4] === HLL_DENSE ? "dense" : "sparse");
  if (sub === "DECODE") {
    if (v[4] !== HLL_SPARSE) throw new RedisError("ERR HLL encoding is not sparse");
    return r.bulk(hllDecodeSparse(v));
  }
  if (sub === "TODENSE") {
    if (v[4] === HLL_DENSE) return r.int(0);
    ctx.ks.updateValue(row.id, key, sparseToDense(v));
    return r.int(1);
  }
  if (sub === "GETREG") {
    let dense = v;
    if (v[4] === HLL_SPARSE) {
      dense = sparseToDense(v);
      ctx.ks.updateValue(row.id, key, dense);
    }
    const regs: Array<Reply> = [];
    for (let i = 0; i < HLL_REGISTERS; i++) regs.push(r.int(denseGetRegister(dense, i)));
    return r.array(regs);
  }
  throw new RedisError(`ERR Unknown PFDEBUG subcommand '${text(args[1])}'`);
}

function pfselftest(): Reply {
  hllSelfTest();
  return r.ok;
}

export const hyperloglog: Table = {
  pfadd: spec(-2, ["write", "fast"], pfadd),
  pfcount: spec(-2, ["readonly"], pfcount, [1, -1, 1]),
  pfmerge: spec(-2, ["write"], pfmerge, [1, -1, 1]),
  pfdebug: spec(3, ["write"], pfdebug, [2, 2, 1]),
  pfselftest: keyless(1, [], pfselftest),
};
