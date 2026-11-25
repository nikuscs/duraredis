import { expect, test } from "bun:test";
import { addFloats } from "../src/commands/numbers";
import { Parser, splitArgs } from "../src/resp/parser";
import { Encoder, r } from "../src/resp/reply";
import type { Reply } from "../src/resp/reply";
import { globMatch } from "../src/store/glob";

const enc = new TextEncoder();
const dec = new TextDecoder();
const words = (cmd: Array<Uint8Array> | undefined) => cmd?.map((a) => dec.decode(a));

test("parses multibulk commands split across chunks", () => {
  const p = new Parser();
  const wire = "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$5\r\nhe\r\no\r\n*1\r\n$4\r\nPING\r\n";
  for (const ch of wire.slice(0, 20)) p.push(enc.encode(ch));
  expect(p.next()).toBeUndefined();
  p.push(enc.encode(wire.slice(20)));
  expect(words(p.next())).toEqual(["SET", "k", "he\r\no"]);
  expect(words(p.next())).toEqual(["PING"]);
  expect(p.next()).toBeUndefined();
});

test("parses inline commands with quotes and escapes", () => {
  const p = new Parser();
  p.push(enc.encode("set k \"a b\\x41\\n\" 'it\\'s'\r\n\r\nping\n"));
  expect(words(p.next())).toEqual(["set", "k", "a bA\n", "it's"]);
  expect(words(p.next())).toEqual(["ping"]);
  expect(() => splitArgs(enc.encode('get "oops'))).toThrow("unbalanced quotes");
});

test("rejects bad multibulk framing", () => {
  const p = new Parser();
  p.push(enc.encode("*1\r\n+PING\r\n"));
  expect(() => p.next()).toThrow("expected '$', got '+'");
});

const encode = (reply: Reply, proto: 2 | 3) => dec.decode(new Encoder(proto).write(reply).take());

test("encodes RESP2 and RESP3 shapes", () => {
  const m = r.map([[r.bulk("a"), r.int(1)]]);
  expect(encode(m, 2)).toBe("*2\r\n$1\r\na\r\n:1\r\n");
  expect(encode(m, 3)).toBe("%1\r\n$1\r\na\r\n:1\r\n");
  expect(encode(r.nil, 2)).toBe("$-1\r\n");
  expect(encode(r.nilArray, 2)).toBe("*-1\r\n");
  expect(encode(r.nil, 3)).toBe("_\r\n");
  expect(encode(r.double(1.5), 3)).toBe(",1.5\r\n");
  expect(encode(r.double(1.5), 2)).toBe("$3\r\n1.5\r\n");
  expect(encode(r.bool(true), 2)).toBe(":1\r\n");
  expect(encode(r.verbatim("hi"), 3)).toBe("=6\r\ntxt:hi\r\n");
  expect(encode(r.error("ERR a\r\nb"), 2)).toBe("-ERR a b\r\n");
});

const m = (p: string, s: string) => globMatch(enc.encode(p), enc.encode(s));

test("glob matching follows Redis rules", () => {
  expect(m("*", "")).toBe(true);
  expect(m("h?llo", "hello")).toBe(true);
  expect(m("h[ae]llo", "hallo")).toBe(true);
  expect(m("h[^e]llo", "hello")).toBe(false);
  expect(m("h[a-b]llo", "hbllo")).toBe(true);
  expect(m(String.raw`h\*llo`, "h*llo")).toBe(true);
  expect(m(String.raw`h\*llo`, "hello")).toBe(false);
  expect(m("user:*:name", "user:42:name")).toBe(true);
  expect(m("a*a*a*a*a*a*a*a*b", "a".repeat(40))).toBe(false);
});

test("float addition prints like INCRBYFLOAT", () => {
  expect(addFloats("10.5", "0.1")).toBe("10.6");
  expect(addFloats("0.1", "0.2")).toBe("0.3");
  expect(addFloats("5.0e3", "2.0e2")).toBe("5200");
  expect(addFloats("3", "-3")).toBe("0");
  expect(addFloats("-1.5", "0.25")).toBe("-1.25");
  expect(() => addFloats("1e308", "1e308")).toThrow("NaN or Infinity");
});
