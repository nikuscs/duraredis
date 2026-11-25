import { afterAll, beforeAll, describe, expect } from "bun:test";
import { checkDocker, startRedisContainer } from "./redis-container";
import type { RedisContainer } from "./redis-container";
import { freshDb, serverHost, serverPort } from "./setup";
import { decodeResp, formatBytes, WireClient } from "./wire";
import type { RespArg, RespValue } from "./wire";

export type Proto = 2 | 3;

const describeLabel = (args: Array<RespArg>) => args.map((a) => (typeof a === "string" ? a : formatBytes(a))).join(" ");
const dec = new TextDecoder();

function same(proto: Proto, label: string, redis: Uint8Array, dura: Uint8Array) {
  if (formatBytes(redis) === formatBytes(dura)) return;
  throw new Error(`[RESP${proto}] ${label}\n  Redis    : ${formatBytes(redis)}\n  Duraredis: ${formatBytes(dura)}`);
}

function canonical(v: RespValue): string {
  if (v.kind === "map") return `map{${v.entries.map(([k, x]) => `${canonical(k)}=${canonical(x)}`).toSorted().join(",")}}`;
  if (v.kind !== "array" && v.kind !== "set" && v.kind !== "push") return `${v.kind}:${"value" in v ? String(v.value instanceof Uint8Array ? [...v.value] : v.value) : ""}`;
  return `${v.kind}[${v.items.map(canonical).toSorted().join(",")}]`;
}

async function collectScan(client: WireClient, prefix: Array<RespArg>, extra: Array<RespArg>, paired: boolean): Promise<Array<string>> {
  const seen = new Map<string, string>();
  let cursor = "0";
  for (let step = 0; step < 500; step++) {
    const val = decodeResp(await client.cmd(...prefix, cursor, ...extra));
    expect(val.kind).toBe("array");
    if (val.kind !== "array") break;
    expect(val.items.length).toBe(2);
    const [nextVal, listVal] = val.items;
    expect(nextVal.kind).toBe("bulk");
    expect(listVal.kind).toBe("array");
    if (nextVal.kind !== "bulk" || listVal.kind !== "array") break;
    cursor = dec.decode(nextVal.value);
    expect(cursor).toMatch(/^\d+$/);
    if (paired) {
      expect(listVal.items.length % 2).toBe(0);
      for (let i = 0; i < listVal.items.length; i += 2) {
        seen.set(canonical(listVal.items[i]), canonical(listVal.items[i + 1]));
      }
    } else {
      for (const item of listVal.items) seen.set(canonical(item), "");
    }
    if (cursor === "0") return [...seen.entries()].map(([k, v]) => `${k}=${v}`).toSorted();
  }
  throw new Error(`${String(prefix[0])} exceeded 500 iterations`);
}

export class Pair {
  private readonly extra: Array<Pair> = [];

  constructor(
    readonly proto: Proto,
    readonly db: string,
    readonly redis: WireClient,
    readonly dura: WireClient,
    private readonly container: RedisContainer,
  ) {}

  static async open(proto: Proto, db: string, container: RedisContainer): Promise<Pair> {
    const [redis, dura] = await Promise.all([WireClient.connect(container.host, container.port), WireClient.connect(serverHost(), serverPort())]);
    await dura.cmd("AUTH", db, "x");
    if (proto === 3) await Promise.all([redis.cmd("HELLO", "3"), dura.cmd("HELLO", "3")]);
    return new Pair(proto, db, redis, dura, container);
  }

  async cmd(...args: Array<RespArg>): Promise<Uint8Array> {
    const [r, d] = await Promise.all([this.redis.cmd(...args), this.dura.cmd(...args)]);
    same(this.proto, describeLabel(args), r, d);
    return r;
  }

  async script(commands: Array<Array<RespArg>>) {
    for (const c of commands) await this.cmd(...c);
  }

  async unordered(...args: Array<RespArg>) {
    const [r, d] = await Promise.all([this.redis.cmd(...args), this.dura.cmd(...args)]);
    expect(canonical(decodeResp(d))).toBe(canonical(decodeResp(r)));
  }

  async shape(...args: Array<RespArg>): Promise<[RespValue, RespValue]> {
    const [r, d] = await Promise.all([this.redis.cmd(...args), this.dura.cmd(...args)]);
    const [rv, dv] = [decodeResp(r), decodeResp(d)];
    expect(dv.kind).toBe(rv.kind);
    return [rv, dv];
  }

  async pipeline(commands: Array<Array<RespArg>>) {
    const [r, d] = await Promise.all([this.redis.pipeline(commands), this.dura.pipeline(commands)]);
    expect(d.length).toBe(r.length);
    for (let i = 0; i < commands.length; i++) same(this.proto, `pipeline[${i}] ${describeLabel(commands[i])}`, r[i], d[i]);
  }

  async inline(line: RespArg) {
    const [r, d] = await Promise.all([this.redis.inline(line), this.dura.inline(line)]);
    same(this.proto, `inline ${describeLabel([line])}`, r, d);
  }

  async rawPipeline(payload: Uint8Array, count: number) {
    const [r, d] = await Promise.all([this.redis.rawPipeline(payload, count), this.dura.rawPipeline(payload, count)]);
    expect(d.length).toBe(r.length);
    for (let i = 0; i < count; i++) same(this.proto, `rawPipeline[${i}]`, r[i], d[i]);
  }

  async approx(tolerance: number, ...args: Array<RespArg>) {
    const [r, d] = await Promise.all([this.redis.cmd(...args), this.dura.cmd(...args)]);
    const [rv, dv] = [decodeResp(r), decodeResp(d)];
    expect(rv.kind).toBe("int");
    expect(dv.kind).toBe("int");
    if (rv.kind !== "int" || dv.kind !== "int") return;
    if (rv.value < 0n) {
      same(this.proto, describeLabel(args), r, d);
      return;
    }
    expect(Math.abs(Number(rv.value - dv.value))).toBeLessThanOrEqual(tolerance);
  }

  async scan(prefix: Array<RespArg>, extra: Array<RespArg> = [], paired = false) {
    const [r, d] = await Promise.all([collectScan(this.redis, prefix, extra, paired), collectScan(this.dura, prefix, extra, paired)]);
    expect(d).toEqual(r);
  }

  async send(...args: Array<RespArg>) {
    await Promise.all([this.redis.send(args), this.dura.send(args)]);
  }

  async next(label: string) {
    const [r, d] = await Promise.all([this.redis.readReply(), this.dura.readReply()]);
    same(this.proto, label, r, d);
  }

  async peer(): Promise<Pair> {
    const p = await Pair.open(this.proto, this.db, this.container);
    this.extra.push(p);
    return p;
  }

  async close() {
    await Promise.all([this.redis.close(), this.dura.close(), ...this.extra.map((p) => p.close())]);
  }
}

export function describeDual(name: string, body: (run: (fn: (p: Pair) => Promise<void>) => Promise<void>, proto: Proto) => void) {
  const docker = checkDocker();
  describe.skipIf(!docker.available)(name, () => {
    let container: RedisContainer;
    beforeAll(async () => {
      container = await startRedisContainer("redis:8");
    });
    afterAll(() => container?.stop());

    for (const proto of [2, 3] as const) {
      describe(`RESP${proto}`, () => {
        body(async (fn) => {
          const pair = await Pair.open(proto, freshDb(`d${proto}`), container);
          try {
            await pair.redis.cmd("FLUSHALL");
            await fn(pair);
          } finally {
            await pair.close();
          }
        }, proto);
      });
    }
  });
}
