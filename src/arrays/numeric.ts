import { text } from "../resp/reply";
import { INT64_MAX } from "../commands/args";

export type BigFloat =
  | { kind: "nan" }
  | { kind: "inf"; neg: boolean }
  | { kind: "zero"; neg: boolean }
  | { kind: "fin"; neg: boolean; sig: bigint; exp: number };

const SIG_MIN = 1n << 112n;
const SIG_CARRY = 1n << 113n;
const EXP_MAX = 16_383;
const EXP_SUB_MIN = -16_494;
const LN2_OVER_LN10 = Math.LN2 / Math.LN10;
const TEN_16 = 10n ** 16n;
const TEN_17 = 10n ** 17n;

const TOP_BITS = [0, 1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4];

function bitLen(n: bigint): number {
  const hex = n.toString(16);
  return (hex.length - 1) * 4 + TOP_BITS[Number.parseInt(hex[0], 16)];
}

function divRoundEven(num: bigint, den: bigint): bigint {
  const q = num / den;
  const r2 = (num % den) * 2n;
  return r2 > den || (r2 === den && (q & 1n) === 1n) ? q + 1n : q;
}

function normalizeToFin(neg: boolean, num: bigint, den: bigint, pow2Offset: number): BigFloat | undefined {
  let k = bitLen(num) - bitLen(den);
  const lhs = k < 0 ? num << BigInt(-k) : num;
  const rhs = k > 0 ? den << BigInt(k) : den;
  if (lhs < rhs) k--;
  let exp = k + pow2Offset;
  if (exp > EXP_MAX + 1 || exp < EXP_SUB_MIN - 1) return undefined;
  const shift = 112 - k;
  const sNum = shift >= 0 ? num << BigInt(shift) : num;
  const sDen = shift < 0 ? den << BigInt(-shift) : den;
  let sig = divRoundEven(sNum, sDen);
  if (sig === SIG_CARRY) {
    sig >>= 1n;
    exp++;
  }
  if (exp > EXP_MAX || exp < EXP_SUB_MIN) return undefined;
  return { kind: "fin", neg, sig, exp };
}

export function parseLongDouble(b: Uint8Array): BigFloat | undefined {
  if (b.length === 0 || b.includes(0)) return undefined;
  const s = text(b);
  if (s !== s.trim()) return undefined;
  const inf = /^([+-]?)(?:inf|infinity)$/i.exec(s);
  if (inf) return { kind: "inf", neg: inf[1] === "-" };
  const hex = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/.exec(s);
  if (hex) {
    const [, sign, whole, frac = "", pExp = "0"] = hex;
    if (!whole && !frac) return undefined;
    const digits = BigInt(`0x${whole}${frac}`);
    const neg = sign === "-";
    if (digits === 0n) return { kind: "zero", neg };
    const p = Number(pExp);
    const rawExp = p - frac.length * 4;
    const approx = bitLen(digits) - 1 + rawExp;
    if (approx > EXP_MAX + 1 || approx < EXP_SUB_MIN - 1) return undefined;
    return normalizeToFin(neg, digits, 1n, rawExp);
  }
  const dec = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!dec) return undefined;
  const [, sign, whole, frac = "", eExp = "0"] = dec;
  if (!whole && !frac) return undefined;
  const rawDigits = `${whole}${frac}`.replace(/^0+/, "");
  const neg = sign === "-";
  if (!rawDigits) return { kind: "zero", neg };
  const trimmed = rawDigits.replace(/0+$/, "");
  const zeros = rawDigits.length - trimmed.length;
  const exp10 = Number(eExp) - frac.length + zeros;
  const approxExp10 = exp10 + trimmed.length - 1;
  if (approxExp10 > 4933 || approxExp10 < -4966) return undefined;
  const d = BigInt(trimmed);
  const num = exp10 >= 0 ? d * 10n ** BigInt(exp10) : d;
  const den = exp10 < 0 ? 10n ** BigInt(-exp10) : 1n;
  return normalizeToFin(neg, num, den, 0);
}

export function addBigFloat(a: BigFloat, b: BigFloat): BigFloat {
  if (a.kind === "nan" || b.kind === "nan") return { kind: "nan" };
  if (a.kind === "inf" && b.kind === "inf") return a.neg !== b.neg ? { kind: "nan" } : a;
  if (a.kind === "inf") return a;
  if (b.kind === "inf") return b;
  if (a.kind === "zero" && b.kind === "zero") return { kind: "zero", neg: a.neg && b.neg };
  if (a.kind === "zero") return b;
  if (b.kind === "zero") return a;
  const [hi, lo] = a.exp > b.exp || (a.exp === b.exp && a.sig >= b.sig) ? [a, b] : [b, a];
  const diff = hi.exp - lo.exp;
  if (diff > 115) return hi;
  const shift = BigInt(diff);
  const sum = hi.neg === lo.neg ? (hi.sig << shift) + lo.sig : (hi.sig << shift) - lo.sig;
  if (sum === 0n) return { kind: "zero", neg: false };
  const bl = bitLen(sum);
  let exp = lo.exp + (bl - 113);
  const drop = bl - 113;
  let sig: bigint;
  if (drop <= 0) {
    sig = sum << BigInt(-drop);
  } else {
    const q = sum >> BigInt(drop);
    const rem = sum & ((1n << BigInt(drop)) - 1n);
    const half = 1n << BigInt(drop - 1);
    sig = rem > half || (rem === half && (q & 1n) === 1n) ? q + 1n : q;
    if (sig === SIG_CARRY) {
      sig >>= 1n;
      exp++;
    }
  }
  if (exp > EXP_MAX) return { kind: "inf", neg: hi.neg };
  if (exp < EXP_SUB_MIN) return { kind: "zero", neg: hi.neg };
  return { kind: "fin", neg: hi.neg, sig, exp };
}

export function cmpBigFloat(a: BigFloat, b: BigFloat): number {
  const rank = (v: BigFloat): number => {
    if (v.kind === "inf") return v.neg ? -2 : 2;
    if (v.kind === "zero") return 0;
    if (v.kind === "fin") return v.neg ? -1 : 1;
    return 0;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (a.kind !== "fin" || b.kind !== "fin") return 0;
  if (a.exp !== b.exp) return (a.exp < b.exp ? -1 : 1) * (a.neg ? -1 : 1);
  if (a.sig === b.sig) return 0;
  return (a.sig < b.sig ? -1 : 1) * (a.neg ? -1 : 1);
}

export function bigFloatToInt64(v: BigFloat): bigint | undefined {
  if (v.kind === "zero") return 0n;
  if (v.kind !== "fin") return undefined;
  if (v.exp < 0) return 0n;
  if (v.exp > 63) return undefined;
  if (v.exp === 63) return v.neg && v.sig === SIG_MIN ? -(2n ** 63n) : undefined;
  const shift = BigInt(112 - v.exp);
  const intPart = v.sig >> shift;
  const frac = v.sig & ((1n << shift) - 1n);
  if (!v.neg && intPart === INT64_MAX && frac !== 0n) return undefined;
  return v.neg ? -intPart : intPart;
}

function cmpPow10(sig: bigint, exp: number, dExp: number): number {
  const p2 = exp - 112;
  let lhs = p2 >= 0 ? sig << BigInt(p2) : sig;
  let rhs = p2 < 0 ? 1n << BigInt(-p2) : 1n;
  if (dExp >= 0) rhs *= 10n ** BigInt(dExp);
  else lhs *= 10n ** BigInt(-dExp);
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function formatG17(v: BigFloat): string {
  if (v.kind === "nan") return "nan";
  if (v.kind === "inf") return v.neg ? "-inf" : "inf";
  if (v.kind === "zero") return v.neg ? "-0" : "0";
  let dExp = Math.floor(v.exp * LN2_OVER_LN10);
  if (cmpPow10(v.sig, v.exp, dExp) < 0) dExp--;
  else if (cmpPow10(v.sig, v.exp, dExp + 1) >= 0) dExp++;
  const p2 = v.exp - 112;
  const p10 = 16 - dExp;
  let num = p2 >= 0 ? v.sig << BigInt(p2) : v.sig;
  let den = p2 < 0 ? 1n << BigInt(-p2) : 1n;
  if (p10 >= 0) num *= 10n ** BigInt(p10);
  else den *= 10n ** BigInt(-p10);
  let digits = divRoundEven(num, den);
  if (digits === TEN_17) {
    digits = TEN_16;
    dExp++;
  }
  const trimmed = digits.toString().replace(/0+$/, "");
  const sign = v.neg ? "-" : "";
  if (dExp < -4 || dExp >= 17) {
    const mant = trimmed.length === 1 ? trimmed : `${trimmed[0]}.${trimmed.slice(1)}`;
    const eSign = dExp < 0 ? "-" : "+";
    return `${sign}${mant}e${eSign}${String(Math.abs(dExp)).padStart(2, "0")}`;
  }
  if (dExp < 0) return `${sign}0.${"0".repeat(-dExp - 1)}${trimmed}`;
  if (trimmed.length <= dExp + 1) return `${sign}${trimmed}${"0".repeat(dExp + 1 - trimmed.length)}`;
  return `${sign}${trimmed.slice(0, dExp + 1)}.${trimmed.slice(dExp + 1)}`;
}
