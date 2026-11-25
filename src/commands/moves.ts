import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { sameBytes } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { ERR, opt } from "./args";
import { block, timeoutArg } from "./blocking";
import { endArg, length, list, listOrCreate, popItems, pushItems } from "./lists";
import type { End } from "./lists";
import { parseMembers } from "./members";
import { boundArg, put, remove, score, select, zsetId } from "./zsets";
import type { Entry, Query } from "./zsets";
import { spec } from "./types";
import type { Ctx, Outcome, Table } from "./types";

const COUNT_ERROR = "ERR count should be greater than 0";

function countArg(b: Uint8Array | undefined): number {
  const n = b && /^\d+$/.test(text(b)) ? Number(text(b)) : 0;
  if (n <= 0) throw new RedisError(COUNT_ERROR);
  return n;
}

interface ListMove {
  from: End;
  to: End;
  count: number;
  exact: boolean;
  bulk: boolean;
}

function listMoveArgs(from: Uint8Array, to: Uint8Array, rest: Array<Uint8Array>): ListMove {
  const move: ListMove = { from: endArg(from), to: endArg(to), count: 1, exact: false, bulk: false };
  if (!rest.length) return move;
  const selector = opt(rest[0]);
  if ((selector !== "COUNT" && selector !== "EXACTLY") || rest.length !== 3) throw new RedisError(ERR.syntax);
  move.count = countArg(rest[1]);
  move.exact = selector === "EXACTLY";
  const ordering = opt(rest[2]);
  if (ordering !== "OBO" && ordering !== "BULK") throw new RedisError(ERR.syntax);
  move.bulk = ordering === "BULK";
  return move;
}

function moveList(ctx: Ctx, source: Uint8Array, destination: Uint8Array, m: ListMove): Array<Uint8Array> | undefined {
  const src = list(ctx, source);
  ctx.ks.getTyped(destination, TYPE.list);
  if (!src || (m.exact && length(ctx, src) < m.count)) return undefined;
  const popped = popItems(ctx, src, m.from, m.count);
  const dst = listOrCreate(ctx, destination);
  if (!m.bulk) {
    pushItems(ctx, dst, m.to, popped);
    return m.to === "right" ? popped : popped.toReversed();
  }
  const ordered = m.from === "left" ? popped : popped.toReversed();
  pushItems(ctx, dst, m.to, m.to === "right" ? ordered : ordered.toReversed());
  return ordered;
}

function lmovem(ctx: Ctx, [, source, destination, from, to, ...rest]: Array<Uint8Array>): Reply {
  const moved = moveList(ctx, source, destination, listMoveArgs(from, to, rest));
  return moved ? r.bulks(moved) : r.nilArray;
}

function blmovem(ctx: Ctx, [, source, destination, from, to, timeout, ...rest]: Array<Uint8Array>): Outcome {
  const m = listMoveArgs(from, to, rest);
  const ms = timeoutArg(timeout);
  const moved = moveList(ctx, source, destination, m);
  return moved ? r.bulks(moved) : block(ctx, [source], ms, r.nilArray);
}

const pairs = (entries: Array<Entry>): Reply => r.array(entries.map((e) => r.array([r.bulk(e.member), r.double(e.score)])));

function transfer(ctx: Ctx, source: Uint8Array, sourceId: number, destination: Uint8Array, entries: Array<Entry>): Reply {
  if (!entries.length) return r.nilArray;
  const dst = zsetId(ctx, destination) ?? ctx.ks.create(destination, TYPE.zset);
  for (const e of entries) put(ctx, destination, dst, e.member, e.score);
  ctx.ks.onChange(destination);
  remove(ctx, source, sourceId, entries.map((e) => e.member));
  return pairs(entries);
}

function zmoveQuery(args: Array<Uint8Array>): Query {
  const where = opt(args[0]);
  const count = (at: number) => {
    if (args.length === at) return undefined;
    if (args.length !== at + 2 || opt(args[at]) !== "COUNT") throw new RedisError(ERR.syntax);
    return countArg(args[at + 1]);
  };
  if (where === "MIN" || where === "MAX") {
    const n = count(1) ?? 1;
    return { by: "rank", start: 0, stop: n - 1, rev: where === "MAX" };
  }
  if (where !== "BYSCORE" || args.length < 3) throw new RedisError(ERR.syntax);
  return { by: "score", min: boundArg(args[1]), max: boundArg(args[2]), rev: false, offset: 0, count: count(3) ?? -1 };
}

function zmove(ctx: Ctx, [, source, destination, ...rest]: Array<Uint8Array>): Reply {
  const query = zmoveQuery(rest);
  const src = zsetId(ctx, source);
  zsetId(ctx, destination);
  if (src === undefined || sameBytes(source, destination)) return r.nilArray;
  return transfer(ctx, source, src, destination, select(ctx, src, query));
}

function bzmove(ctx: Ctx, [, source, destination, where, timeout, ...rest]: Array<Uint8Array>): Outcome {
  const w = opt(where);
  if (w !== "MIN" && w !== "MAX") throw new RedisError(ERR.syntax);
  const ms = timeoutArg(timeout);
  const query = zmoveQuery([where, ...rest]);
  const src = zsetId(ctx, source);
  zsetId(ctx, destination);
  if (sameBytes(source, destination)) return r.nilArray;
  if (src === undefined) return block(ctx, [source], ms, r.nilArray);
  return transfer(ctx, source, src, destination, select(ctx, src, query));
}

function zmovemember(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, source, destination] = args;
  const flags = new Set<string>();
  let at = 3;
  while (at < args.length && (opt(args[at]) === "NX" || opt(args[at]) === "XX")) flags.add(opt(args[at++]));
  if (flags.size > 1) throw new RedisError("ERR XX and NX options at the same time are not compatible");
  const members = parseMembers(args, at, "MEMBERS");
  const src = zsetId(ctx, source);
  const dst = zsetId(ctx, destination);
  if (src === undefined || sameBytes(source, destination)) return r.nilArray;
  const entries = members.flatMap((m) => {
    const s = score(ctx, src, m);
    if (s === undefined) return [];
    const present = dst !== undefined && score(ctx, dst, m) !== undefined;
    if ((flags.has("NX") && present) || (flags.has("XX") && !present)) return [];
    return [{ member: m, score: s }];
  });
  return transfer(ctx, source, src, destination, entries);
}

export const moves: Table = {
  lmovem: spec(-5, ["write"], lmovem, [1, 2, 1]),
  blmovem: spec(-6, ["write", "blocking"], blmovem, [1, 2, 1]),
  zmove: spec(-4, ["write"], zmove, [1, 2, 1]),
  bzmove: spec(-5, ["write", "blocking"], bzmove, [1, 2, 1]),
  zmovemember: spec(-6, ["write"], zmovemember, [1, 2, 1]),
};
