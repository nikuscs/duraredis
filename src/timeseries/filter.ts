import type { Ctx } from "../commands/types";
import { bytes, RedisError, text } from "../resp/reply";
import { blob, fromBlob } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { TS_ERR } from "./format";

export type FilterMatcher =
  | { kind: "eq"; label: Uint8Array; value: Uint8Array }
  | { kind: "neq"; label: Uint8Array; value: Uint8Array }
  | { kind: "missing"; label: Uint8Array }
  | { kind: "exists"; label: Uint8Array }
  | { kind: "in"; label: Uint8Array; values: Array<Uint8Array> }
  | { kind: "notin"; label: Uint8Array; values: Array<Uint8Array> };

function isPositiveMatcher(m: FilterMatcher): boolean {
  return m.kind === "eq" || m.kind === "exists" || m.kind === "in";
}

function parseValueList(raw: string): Array<Uint8Array> | undefined {
  if (!raw.startsWith("(") || !raw.endsWith(")")) return undefined;
  const inner = raw.slice(1, -1);
  if (!inner.length) return [];
  return inner.split(",").map((v) => bytes(v));
}

export function parseFilterExpr(arg: Uint8Array): FilterMatcher {
  const s = text(arg);
  const neqIdx = s.indexOf("!=");
  const eqIdx = s.indexOf("=");
  const isNeq = neqIdx !== -1 && (eqIdx === -1 || neqIdx <= eqIdx);
  const opIdx = isNeq ? neqIdx : eqIdx;
  if (opIdx <= 0) throw new RedisError(TS_ERR.badFilterLabels);
  const label = bytes(s.slice(0, opIdx));
  const rhs = s.slice(opIdx + (isNeq ? 2 : 1));
  if (rhs === "") return isNeq ? { kind: "exists", label } : { kind: "missing", label };
  const list = parseValueList(rhs);
  if (list !== undefined) {
    if (!list.length) throw new RedisError(TS_ERR.badFilterLabels);
    return isNeq ? { kind: "notin", label, values: list } : { kind: "in", label, values: list };
  }
  return isNeq ? { kind: "neq", label, value: bytes(rhs) } : { kind: "eq", label, value: bytes(rhs) };
}

export function parseFilters(args: Array<Uint8Array>, requirePositive = true): Array<FilterMatcher> {
  if (!args.length) throw new RedisError(TS_ERR.needMatcher);
  const matchers = args.map(parseFilterExpr);
  if (requirePositive && !matchers.some(isPositiveMatcher)) throw new RedisError(TS_ERR.needMatcher);
  return matchers;
}

export interface MatchedSeries {
  id: number;
  key: Uint8Array;
}

export function matchSeries(ctx: Ctx, matchers: Array<FilterMatcher>): Array<MatchedSeries> {
  const clauses: Array<string> = ["k.type = ?", "(k.expires_at IS NULL OR k.expires_at > ?)"];
  const params: Array<number | ArrayBuffer> = [TYPE.timeseries, ctx.now];
  for (const m of matchers) {
    switch (m.kind) {
      case "eq":
        clauses.push("EXISTS (SELECT 1 FROM ts_labels tl WHERE tl.key_id = k.id AND tl.label = ? AND tl.value = ?)");
        params.push(blob(m.label), blob(m.value));
        break;
      case "neq":
        clauses.push("NOT EXISTS (SELECT 1 FROM ts_labels tl WHERE tl.key_id = k.id AND tl.label = ? AND tl.value = ?)");
        params.push(blob(m.label), blob(m.value));
        break;
      case "missing":
        clauses.push("NOT EXISTS (SELECT 1 FROM ts_labels tl WHERE tl.key_id = k.id AND tl.label = ?)");
        params.push(blob(m.label));
        break;
      case "exists":
        clauses.push("EXISTS (SELECT 1 FROM ts_labels tl WHERE tl.key_id = k.id AND tl.label = ?)");
        params.push(blob(m.label));
        break;
      case "in":
        clauses.push(`EXISTS (SELECT 1 FROM ts_labels tl WHERE tl.key_id = k.id AND tl.label = ? AND tl.value IN (${m.values.map(() => "?").join(", ")}))`);
        params.push(blob(m.label), ...m.values.map(blob));
        break;
      case "notin":
        clauses.push(`NOT EXISTS (SELECT 1 FROM ts_labels tl WHERE tl.key_id = k.id AND tl.label = ? AND tl.value IN (${m.values.map(() => "?").join(", ")}))`);
        params.push(blob(m.label), ...m.values.map(blob));
        break;
    }
  }
  const sql = `SELECT k.id, k.key FROM keys k WHERE ${clauses.join(" AND ")} ORDER BY k.key ASC`;
  return ctx.ks.sql.exec<{ id: number; key: ArrayBuffer }>(sql, ...params).toArray().map((row) => ({ id: row.id, key: fromBlob(row.key) }));
}
