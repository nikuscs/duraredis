import { RedisError, text } from "../resp/reply";

export const ERR = {
  int: "ERR value is not an integer or out of range",
  float: "ERR value is not a valid float",
  syntax: "ERR syntax error",
  overflow: "ERR increment or decrement would overflow",
  nanInf: "ERR increment would produce NaN or Infinity",
} as const;

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

export function toInt64(b: Uint8Array): bigint | undefined {
  const s = text(b);
  if (!/^(0|-?[1-9]\d{0,19})$/.test(s)) return undefined;
  const n = BigInt(s);
  if (n < INT64_MIN || n > INT64_MAX) return undefined;
  return n;
}

export function int64(b: Uint8Array, error: string = ERR.int): bigint {
  const n = toInt64(b);
  if (n === undefined) throw new RedisError(error);
  return n;
}

export function int(b: Uint8Array, error: string = ERR.int): number {
  return Number(int64(b, error));
}

export function toFloat(b: Uint8Array): number | undefined {
  const s = text(b);
  if (/^[+-]?inf(inity)?$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return undefined;
  return Number(s);
}

export function float(b: Uint8Array, error: string = ERR.float): number {
  const n = toFloat(b);
  if (n === undefined) throw new RedisError(error);
  return n;
}

export const opt = (b: Uint8Array) => text(b).toUpperCase();
