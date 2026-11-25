import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { RdbFormatError, verifyDumpPayload } from "../store/rdb/codec";
import { decodeDumpObject, dumpKey, restoreObject } from "../store/rdb/dump";
import { ERR, int64, INT64_MAX, opt } from "./args";
import { spec } from "./types";
import type { Ctx, Table } from "./types";

interface RestoreOptions {
  replace: boolean;
  absttl: boolean;
}

function parseRestoreOptions(args: Array<Uint8Array>): RestoreOptions {
  let replace = false;
  let absttl = false;
  let hasIdletime = false;
  let hasFreq = false;
  for (let i = 4; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "REPLACE") {
      replace = true;
    } else if (o === "ABSTTL") {
      absttl = true;
    } else if (o === "IDLETIME" && i + 1 < args.length) {
      const idle = int64(args[++i]);
      if (idle < 0n) throw new RedisError("ERR Invalid IDLETIME value, must be >= 0");
      hasIdletime = true;
    } else if (o === "FREQ" && i + 1 < args.length) {
      const freq = int64(args[++i]);
      if (freq < 0n || freq > 255n) throw new RedisError("ERR Invalid FREQ value, must be >= 0 and <= 255");
      hasFreq = true;
    } else {
      throw new RedisError(ERR.syntax);
    }
  }
  if (hasIdletime && hasFreq) throw new RedisError(ERR.syntax);
  return { replace, absttl };
}

function parseRestoreExpiry(ctx: Ctx, cmdName: string, ttlArg: Uint8Array, absttl: boolean): number | null {
  const ttl = int64(ttlArg);
  if (ttl < 0n) throw new RedisError("ERR Invalid TTL value, must be >= 0");
  if (ttl === 0n) return null;
  if (absttl) return ttl > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(ttl);
  const target = BigInt(ctx.now) + ttl;
  if (target > INT64_MAX) throw new RedisError(`ERR invalid expire time in '${cmdName}' command`);
  return target > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(target);
}

function dumpCmd(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const row = ctx.ks.get(key);
  if (!row) return r.nil;
  return r.bulk(dumpKey(ctx, row));
}

function restoreCmd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, ttlArg, payload] = args;
  const { replace, absttl } = parseRestoreOptions(args);
  if (!replace && ctx.ks.exists(key)) throw new RedisError("BUSYKEY Target key name already exists.");
  const expiresAt = parseRestoreExpiry(ctx, text(args[0]).toLowerCase(), ttlArg, absttl);
  const verified = verifyDumpPayload(payload);
  if (!verified) throw new RedisError("ERR DUMP payload version or checksum are wrong");
  let obj: ReturnType<typeof decodeDumpObject>;
  try {
    obj = decodeDumpObject(verified.reader);
  } catch (error: unknown) {
    if (error instanceof RdbFormatError) throw new RedisError("ERR Bad data format");
    throw error;
  }
  restoreObject(ctx, key, expiresAt, replace, obj);
  return r.ok;
}

export const dumps: Table = {
  dump: spec(2, ["readonly"], dumpCmd),
  restore: spec(-4, ["write"], restoreCmd),
  "restore-asking": spec(-4, ["write"], restoreCmd),
};
