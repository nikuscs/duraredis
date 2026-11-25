import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";

const LIVE_URL = process.env.DURAREDIS_LIVE_URL;
const BRIDGE_PORT = 17_380 + Math.floor(Math.random() * 1000);

const unique = (prefix: string) => `live-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const client = (db: string, password = "live-pass") =>
  new Redis({ host: "127.0.0.1", port: BRIDGE_PORT, username: db, password, maxRetriesPerRequest: 3 });
const quitAll = (clients: Array<Redis>) => Promise.all(clients.map((c) => c.quit().catch(() => c.disconnect())));

describe.skipIf(!LIVE_URL)("deployed Worker", () => {
  let bridge: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    bridge = Bun.spawn(["bun", "scripts/bridge.ts", LIVE_URL ?? "", String(BRIDGE_PORT)], { stdout: "pipe", stderr: "inherit" });
    const reader = bridge.stdout instanceof ReadableStream ? bridge.stdout.getReader() : undefined;
    await reader?.read();
    reader?.releaseLock();
  });

  afterAll(() => bridge?.kill());

  test("reports Redis 8 and round-trips data types", async () => {
    const c = client(unique("basics"));
    try {
      expect(await c.info("server")).toContain("redis_version:8.12.0");
      await c.set("s", "v");
      await c.hset("h", "f", "v");
      await c.call("JSON.SET", "j", "$", '{"a":1}');
      expect(await c.get("s")).toBe("v");
      expect(await c.hget("h", "f")).toBe("v");
      expect(await c.call("JSON.GET", "j")).toBe('{"a":1}');
      await c.flushdb();
    } finally {
      await quitAll([c]);
    }
  });

  test("only one of many clients takes a lock, and counters stay exact", async () => {
    const db = unique("lock");
    const clients = Array.from({ length: 20 }, () => client(db));
    try {
      const results = await Promise.all(clients.map((c, i) => c.set("lock", `t${i}`, "PX", 5000, "NX")));
      expect(results.filter((r) => r === "OK")).toHaveLength(1);
      await Promise.all(clients.map(async (c) => {
        for (let i = 0; i < 10; i++) await c.incr("counter");
      }));
      expect(await clients[0].get("counter")).toBe("200");
      await clients[0].flushdb();
    } finally {
      await quitAll(clients);
    }
  });

  test("blocking pops and pub/sub work across connections", async () => {
    const db = unique("wake");
    const [a, b, sub] = [client(db), client(db), client(db)];
    try {
      const popped = b.blpop("q", 10);
      await Bun.sleep(300);
      await a.rpush("q", "job");
      expect(await popped).toEqual(["q", "job"]);
      const message = new Promise<string>((resolve) => {
        sub.on("message", (_channel: string, m: string) => resolve(m));
      });
      await sub.subscribe("news");
      await a.publish("news", "hello");
      expect(await message).toBe("hello");
    } finally {
      await quitAll([a, b, sub]);
    }
  });

  test("wrong passwords get blocked and the password can be changed", async () => {
    const db = unique("auth");
    const owner = client(db, "first-pass");
    try {
      await owner.ping();
      expect(await owner.call("ACL", "SETUSER", db, ">second-pass")).toBe("OK");
      const fresh = client(db, "second-pass");
      expect(await fresh.ping()).toBe("PONG");
      await quitAll([fresh]);

      const replies: Array<string> = [];
      for (let i = 0; i < 6; i++) {
        const guess = new Redis({ host: "127.0.0.1", port: BRIDGE_PORT, username: db, password: `wrong${i}`, maxRetriesPerRequest: 0, retryStrategy: () => null });
        guess.on("error", () => {});
        replies.push(await guess.ping().then(() => "ok", String));
        guess.disconnect();
      }
      expect(replies.slice(0, 4).every((r) => r.includes("invalid username-password"))).toBe(true);
      expect(replies.slice(4).every((r) => r.includes("too many wrong passwords"))).toBe(true);
    } finally {
      await quitAll([owner]);
    }
  });
});
