import { RedisError, text } from "../resp/reply";
import type { Command } from "../resp/parser";
import type { Reply } from "../resp/reply";
import type { Ctx, Outcome } from "./types";

export function timeoutArg(b: Uint8Array): number {
  const s = text(b);
  const n = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? Number(s) : Number.NaN;
  if (Number.isNaN(n)) throw new RedisError("ERR timeout is not a float or out of range");
  if (n < 0) throw new RedisError("ERR timeout is negative");
  if (!Number.isFinite(n) || n * 1000 > Number.MAX_SAFE_INTEGER) throw new RedisError("ERR timeout is out of range");
  return Math.round(n * 1000);
}

export function block(ctx: Ctx, keys: Array<Uint8Array>, timeoutMs: number, onTimeout: Reply, retry?: Command): Outcome {
  if (ctx.mode !== "client") return onTimeout;
  return { t: "block", keys, timeoutMs, onTimeout, retry };
}
