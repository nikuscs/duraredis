import { RedisError } from "../resp/reply";
import { ERR } from "./args";

const DECIMALS = 17;

interface Decimal {
  m: bigint;
  scale: number;
}

function decimal(s: string): Decimal | undefined {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!match) return undefined;
  const [, sign, whole, frac = "", exp = "0"] = match;
  if (!whole && !frac) return undefined;
  const e = Number(exp);
  if (Math.abs(e) > 5000) return undefined;
  const scale = frac.length - e;
  const digits = BigInt((whole || "0") + frac);
  const m = scale < 0 ? digits * 10n ** BigInt(-scale) : digits;
  return { m: sign === "-" ? -m : m, scale: Math.max(scale, 0) };
}

function round(abs: bigint, scale: number): [bigint, number] {
  if (scale <= DECIMALS) return [abs, scale];
  const div = 10n ** BigInt(scale - DECIMALS);
  const q = abs / div;
  return [(abs % div) * 2n >= div ? q + 1n : q, DECIMALS];
}

export function addFloats(a: string, b: string): string {
  const x = decimal(a);
  const y = decimal(b);
  if (!x || !y || !Number.isFinite(Number(a) + Number(b))) throw new RedisError(ERR.nanInf);
  const scale = Math.max(x.scale, y.scale);
  const sum = x.m * 10n ** BigInt(scale - x.scale) + y.m * 10n ** BigInt(scale - y.scale);
  const [abs, s] = round(sum < 0n ? -sum : sum, scale);
  const digits = abs.toString().padStart(s + 1, "0");
  const out = s ? `${digits.slice(0, -s)}.${digits.slice(-s)}`.replace(/0+$/, "").replace(/\.$/, "") : digits;
  return sum < 0n && out !== "0" ? `-${out}` : out;
}
