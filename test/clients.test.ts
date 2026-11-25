import { RedisClient } from "bun";
import { describe, expect, test } from "bun:test";
import Redis from "ioredis";
import type { RedisOptions as IoredisOptions } from "ioredis";
import { freshDb, serverHost, serverPort, serverUrl } from "./setup";

const NO_RETRY: IoredisOptions = { retryStrategy: () => null, maxRetriesPerRequest: 1 };

async function withBun<T>(url: string, fn: (c: RedisClient) => Promise<T>, options?: Bun.RedisOptions): Promise<T> {
  const c = new RedisClient(url, options);
  try {
    await c.connect();
    return await fn(c);
  } finally {
    c.close();
  }
}

async function withIo<T>(url: string, fn: (c: Redis) => Promise<T>, options: IoredisOptions = {}): Promise<T> {
  const c = new Redis(url, options);
  c.on("error", () => {});
  try {
    return await fn(c);
  } finally {
    c.disconnect();
  }
}

describe("real clients vs Duraredis", () => {
  describe("Bun.RedisClient", () => {
    test("URL forms and database isolation", async () => {
      const [host, port, dbA, dbB] = [serverHost(), serverPort(), freshDb("bun-a"), freshDb("bun-b")];
      await withBun(`redis://:${dbA}@${host}:${port}`, async (c) => {
        expect(c.connected).toBe(true);
        expect(await c.ping()).toBe("PONG");
        await c.set("shared", "from-pass-only");
      });
      await withBun(`redis://${dbA}@${host}:${port}`, async (c) => {
        expect(await c.get("shared")).toBe("from-pass-only");
        await c.set("from-user-only", "yes");
      });
      await withBun(serverUrl(dbA), async (c) => {
        expect(await c.get("shared")).toBe("from-pass-only");
        expect(await c.get("from-user-only")).toBe("yes");
      });
      await withBun(serverUrl(dbB), async (c) => {
        expect(await c.get("shared")).toBeNull();
        await c.set("shared", "in-b");
        expect(await c.get("shared")).toBe("in-b");
      });
      await withBun(serverUrl(dbA), async (c) => expect(await c.get("shared")).toBe("from-pass-only"));
    });

    test("strings, hashes, and binary buffers", () => withBun(serverUrl(freshDb("bun-ops")), async (c) => {
      expect(await c.set("greeting", "hello")).toBe("OK");
      expect(await c.get("greeting")).toBe("hello");
      expect(await c.exists("greeting")).toBe(true);
      expect(await c.exists("missing")).toBe(false);
      expect(await c.incr("counter")).toBe(1);
      expect(await c.incrby("counter", 41)).toBe(42);
      expect(await c.decr("counter")).toBe(41);
      expect(await c.hset("user:1", { name: "ada", role: "admin" })).toBe(2);
      expect(await c.hget("user:1", "name")).toBe("ada");
      expect(await c.hmget("user:1", ["name", "missing", "role"])).toEqual(["ada", null, "admin"]);
      expect({ ...(await c.hgetall("user:1")) }).toEqual({ name: "ada", role: "admin" });
      const bin = new Uint8Array([0x00, 0x01, 0x0d, 0x0a, 0x80, 0xff]);
      await c.set("bin", bin);
      expect(await c.getBuffer("bin")).toEqual(bin);
    }));

    test("auto-pipelining concurrent commands", () => withBun(serverUrl(freshDb("bun-pipe")), async (c) => {
      const results = await Promise.all([
        c.ping(), c.set("p:str", "alpha"), c.incr("p:cnt"), c.incr("p:cnt"), c.incrby("p:cnt", 8),
        c.get("p:str"), c.get("p:cnt"), c.hset("p:h", "f1", "v1", "f2", "v2"), c.hget("p:h", "f1"), c.hgetall("p:h"),
        c.set("p:tmp", "gone"), c.del("p:tmp"), c.get("p:tmp"),
        ...Array.from({ length: 7 }, (_, i) => c.ping(String(i + 1))),
      ]);
      expect({ ...results[9] }).toEqual({ f1: "v1", f2: "v2" });
      expect([...results.slice(0, 9), ...results.slice(10)]).toEqual([
        "PONG", "OK", 1, 2, 10, "alpha", "10", 2, "v1", "OK", 1, null, "1", "2", "3", "4", "5", "6", "7",
      ]);
    }, { enableAutoPipelining: true }));

    test("transactions: MULTI/EXEC, DISCARD, WATCH conflict", () => {
      const url = serverUrl(freshDb("bun-tx"));
      return withBun(url, async (c) => {
        expect(await c.send("MULTI", [])).toBe("OK");
        expect(await c.send("SET", ["txk", "10"])).toBe("QUEUED");
        expect(await c.send("INCR", ["txk"])).toBe("QUEUED");
        expect(await c.send("GET", ["txk"])).toBe("QUEUED");
        expect(await c.send("EXEC", [])).toEqual(["OK", 11, "11"]);
        expect(await c.send("MULTI", [])).toBe("OK");
        expect(await c.send("SET", ["txk", "999"])).toBe("QUEUED");
        expect(await c.send("DISCARD", [])).toBe("OK");
        expect(await c.get("txk")).toBe("11");
        await withBun(url, async (peer) => {
          expect(await c.send("WATCH", ["txk"])).toBe("OK");
          await peer.set("txk", "interfered");
          expect(await c.send("MULTI", [])).toBe("OK");
          expect(await c.send("SET", ["txk", "lost"])).toBe("QUEUED");
          expect(await c.send("EXEC", [])).toBeNull();
          expect(await c.get("txk")).toBe("interfered");
        }, { enableAutoPipelining: false });
      }, { enableAutoPipelining: false });
    });

    test("errors: WRONGTYPE, non-int INCR, unknown command, invalid db", async () => {
      await withBun(serverUrl(freshDb("bun-err")), async (c) => {
        await c.hset("hashk", "f", "1");
        await expect(c.get("hashk")).rejects.toThrow(/WRONGTYPE/);
        await c.set("strk", "not-an-integer");
        await expect(c.incr("strk")).rejects.toThrow(/not an integer/);
        await expect(c.send("NO_SUCH_CMD", ["a"])).rejects.toThrow(/unknown command/i);
      });
      const bad = new RedisClient(`redis://ab:x@${serverHost()}:${serverPort()}`, { autoReconnect: false, maxRetries: 0 });
      try {
        await expect(bad.connect()).rejects.toThrow(/Connection closed/i);
        expect(bad.connected).toBe(false);
      } finally {
        bad.close();
      }
    });
  });

  describe("ioredis", () => {
    test("URL forms and database isolation", async () => {
      const [host, port, dbA, dbB] = [serverHost(), serverPort(), freshDb("io-a"), freshDb("io-b")];
      await withIo(`redis://:${dbA}@${host}:${port}`, async (c) => {
        expect(await c.ping()).toBe("PONG");
        await c.set("k", "from-pass-only");
      });
      await withIo(serverUrl(dbA), async (c) => expect(await c.get("k")).toBe("from-pass-only"));
      await withIo(serverUrl(dbB), async (c) => {
        expect(await c.get("k")).toBeNull();
        await c.set("k", "in-b");
        expect(await c.get("k")).toBe("in-b");
      });
      await withIo(serverUrl(dbA), async (c) => expect(await c.get("k")).toBe("from-pass-only"));
    });

    test("readyCheck and basic operations", () => withIo(serverUrl(freshDb("io-ready")), async (c) => {
      await new Promise<void>((resolve, reject) => {
        if (c.status === "ready") {
          resolve();
          return;
        }
        c.once("ready", resolve).once("error", reject);
      });
      expect(c.status).toBe("ready");
      expect(await c.ping()).toBe("PONG");
      expect(await c.set("hello", "world")).toBe("OK");
      expect(await c.get("hello")).toBe("world");
      expect(await c.hset("h", "a", "1", "b", "2")).toBe(2);
      expect(await c.hgetall("h")).toEqual({ a: "1", b: "2" });
    }, { enableReadyCheck: true }));

    test("pipelining with 20+ commands including inline error", () => withIo(serverUrl(freshDb("io-pipe")), async (c) => {
      const pipe = c.pipeline();
      pipe.set("s1", "hello").set("n1", "10").incr("n1").incrby("n1", 5).get("n1").incr("s1")
        .hset("h1", "k1", "v1", "k2", "v2").hgetall("h1");
      for (let i = 0; i < 15; i++) pipe.ping(`p${i}`);
      const res = await pipe.exec();
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.length).toBe(23);
      expect(res[5][0]).toBeInstanceOf(Error);
      expect(res[5][0]?.message).toMatch(/not an integer/);
      expect([...res.slice(0, 5), ...res.slice(6)]).toEqual([
        [null, "OK"], [null, "OK"], [null, 11], [null, 16], [null, "16"],
        [null, 2], [null, { k1: "v1", k2: "v2" }],
        ...Array.from({ length: 15 }, (_, i): [null, string] => [null, `p${i}`]),
      ]);
    }));

    test("transactions: MULTI/EXEC, runtime error, DISCARD, WATCH conflict", () => {
      const url = serverUrl(freshDb("io-tx"));
      return withIo(url, async (c) => {
        expect(await c.multi().set("k", "5").incr("k").get("k").exec()).toEqual([[null, "OK"], [null, 6], [null, "6"]]);
        await c.set("bad", "abc");
        const partial = await c.multi().set("before", "1").incr("bad").set("after", "2").exec();
        expect(partial).not.toBeNull();
        if (partial) {
          expect(partial[0]).toEqual([null, "OK"]);
          expect(partial[1][0]).toBeInstanceOf(Error);
          expect(partial[1][0]?.message).toMatch(/not an integer/);
          expect(partial[2]).toEqual([null, "OK"]);
        }
        expect(await c.mget("before", "after")).toEqual(["1", "2"]);
        expect(await c.multi({ pipeline: false })).toBe("OK");
        await c.set("k", "999");
        expect(await c.discard()).toBe("OK");
        expect(await c.get("k")).toBe("6");
        await withIo(url, async (peer) => {
          expect(await c.watch("k")).toBe("OK");
          await peer.set("k", "peer");
          expect(await c.multi().set("k", "aborted").exec()).toBeNull();
          expect(await c.get("k")).toBe("peer");
        });
      });
    });

    test("errors: WRONGTYPE, non-int INCR, unknown command, invalid db, missing auth", async () => {
      await withIo(serverUrl(freshDb("io-err")), async (c) => {
        await c.hset("hk", "f", "1");
        await expect(c.get("hk")).rejects.toThrow(/WRONGTYPE/);
        await c.set("sk", "xyz");
        await expect(c.incr("sk")).rejects.toThrow(/not an integer/);
        await expect(c.call("NO_SUCH_CMD", "x")).rejects.toThrow(/unknown command/i);
      }, NO_RETRY);
      const [host, port] = [serverHost(), serverPort()];
      await withIo(`redis://ab:x@${host}:${port}`, async (bad) => { await expect(bad.ping()).rejects.toThrow(/invalid database name|WRONGPASS/i); }, NO_RETRY);
      await withIo(`redis://${host}:${port}`, async (noauth) => { await expect(noauth.ping()).rejects.toThrow(/NOAUTH/); }, NO_RETRY);
    });
  });
});
