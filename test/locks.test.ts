import { afterEach, expect, test } from "bun:test";
import Redis from "ioredis";
import Redlock from "redlock";
import { freshDb, serverHost, serverPort } from "./setup";

const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

const opened: Array<Redis> = [];

function client(db: string): Redis {
  const redis = new Redis({ host: serverHost(), port: serverPort(), username: db, password: "lock-pass", maxRetriesPerRequest: 2 });
  opened.push(redis);
  return redis;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.quit().catch(() => {})));
});

async function acquire(redis: Redis, key: string, token: string, ttlMs: number) {
  while ((await redis.set(key, token, "PX", ttlMs, "NX")) !== "OK") await Bun.sleep(2);
}

test("SET NX PX lets exactly one of many concurrent clients take the lock", async () => {
  const db = freshDb("lock-race");
  const clients = Array.from({ length: 30 }, () => client(db));
  const results = await Promise.all(clients.map((c, i) => c.set("lock", `t${i}`, "PX", 5000, "NX")));
  expect(results.filter((r) => r === "OK")).toHaveLength(1);
});

test("a lock protects a read-modify-write section across clients", async () => {
  const db = freshDb("lock-section");
  const workers = Array.from({ length: 10 }, () => client(db));
  let inside = 0;
  let overlaps = 0;
  await Promise.all(workers.map(async (redis, w) => {
    for (let i = 0; i < 10; i++) {
      const token = `w${w}-${i}`;
      await acquire(redis, "lock", token, 5000);
      inside++;
      if (inside > 1) overlaps++;
      const current = Number((await redis.get("counter")) ?? "0");
      await Bun.sleep(1);
      await redis.set("counter", String(current + 1));
      inside--;
      expect(await redis.eval(RELEASE, 1, "lock", token)).toBe(1);
    }
  }));
  expect(overlaps).toBe(0);
  expect(await workers[0].get("counter")).toBe("100");
  expect(await workers[0].exists("lock")).toBe(0);
});

test("an expired lock can be taken over and the old holder cannot release it", async () => {
  const db = freshDb("lock-expiry");
  const [a, b] = [client(db), client(db)];
  expect(await a.set("lock", "a", "PX", 200, "NX")).toBe("OK");
  expect(await b.set("lock", "b", "PX", 200, "NX")).toBeNull();
  await Bun.sleep(300);
  expect(await b.set("lock", "b", "PX", 5000, "NX")).toBe("OK");
  expect(await a.eval(RELEASE, 1, "lock", "a")).toBe(0);
  expect(await a.get("lock")).toBe("b");
  expect(await b.pttl("lock")).toBeGreaterThan(4000);
});

test("WATCH/MULTI/EXEC retries give every optimistic increment exactly once", async () => {
  const db = freshDb("lock-watch");
  const workers = Array.from({ length: 8 }, () => client(db));
  let retries = 0;
  await Promise.all(workers.map(async (redis) => {
    for (let i = 0; i < 15; i++) {
      for (;;) {
        await redis.watch("n");
        const current = Number((await redis.get("n")) ?? "0");
        const result = await redis.multi().set("n", String(current + 1)).exec();
        if (result) break;
        retries++;
      }
    }
  }));
  expect(await workers[0].get("n")).toBe("120");
  expect(retries).toBeGreaterThan(0);
});

test("Redlock serializes work and extends locks", async () => {
  const db = freshDb("redlock");
  const redlocks = Array.from({ length: 5 }, () => new Redlock([client(db)], { retryCount: -1, retryDelay: 5, retryJitter: 5 }));
  const counter = client(db);
  let inside = 0;
  let overlaps = 0;
  await Promise.all(redlocks.map(async (redlock) => {
    for (let i = 0; i < 5; i++) {
      await redlock.using(["resource"], 2000, async () => {
        inside++;
        if (inside > 1) overlaps++;
        await counter.incr("done");
        await Bun.sleep(2);
        inside--;
      });
    }
  }));
  expect(overlaps).toBe(0);
  expect(await counter.get("done")).toBe("25");

  const lock = await redlocks[0].acquire(["extend-me"], 300);
  const extended = await lock.extend(5000);
  expect(await counter.pttl("extend-me")).toBeGreaterThan(4000);
  await extended.release();
  expect(await counter.exists("extend-me")).toBe(0);
});

test("INCR hands out unique fencing tokens under contention", async () => {
  const db = freshDb("lock-fence");
  const clients = Array.from({ length: 20 }, () => client(db));
  const tokens = await Promise.all(clients.flatMap((c) => Array.from({ length: 10 }, () => c.incr("fence"))));
  expect(new Set(tokens).size).toBe(200);
  expect(Math.max(...tokens)).toBe(200);
});
