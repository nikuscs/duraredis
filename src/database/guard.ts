import { hashPassword } from "./lifecycle";
import type { Meta } from "./lifecycle";
import { constantTimeEqual } from "../store/sha256";

export type AuthResult = "ok" | "wrong" | "blocked";

export const MAX_FAILURES = 5;
export const BLOCK_MS = 15 * 60 * 1000;

function recentFailures(sql: SqlStorage, client: string, now: number): number {
  return sql.exec<{ n: number }>("SELECT count(*) AS n FROM auth_failures WHERE client = ? AND at > ?", client, now - BLOCK_MS).one().n;
}

export function checkPassword(sql: SqlStorage, meta: Meta, password: string, client: string, now = Date.now()): AuthResult {
  sql.exec("DELETE FROM auth_failures WHERE at <= ?", now - BLOCK_MS);
  if (meta.passwordHash === null) return "ok";
  if (recentFailures(sql, client, now) >= MAX_FAILURES) return "blocked";
  if (constantTimeEqual(hashPassword(meta.salt, password), meta.passwordHash)) {
    sql.exec("DELETE FROM auth_failures WHERE client = ?", client);
    return "ok";
  }
  sql.exec("INSERT INTO auth_failures (client, at) VALUES (?, ?)", client, now);
  return recentFailures(sql, client, now) >= MAX_FAILURES ? "blocked" : "wrong";
}
