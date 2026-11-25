import { afterAll, beforeAll, expect, test } from "bun:test";
import Redis from "ioredis";
import { startServer } from "./server";
import type { Server } from "./server";

const MAX_CONNECTIONS = 50;

let server: Server;
beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server?.stop());

const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const client = (db: string) => new Redis({ host: server.host, port: server.port, username: db, password: "load-pass", maxRetriesPerRequest: 20 });
const quitAll = (clients: Array<Redis>) => Promise.all(clients.map((c) => c.quit().catch(() => c.disconnect())));

test("200 clients across 5 databases count every increment exactly once", async () => {
  const dbs = Array.from({ length: 5 }, () => unique("load"));
  const clients = dbs.flatMap((db) => Array.from({ length: 40 }, () => client(db)));
  try {
    await Promise.all(clients.map(async (c) => {
      for (let i = 0; i < 25; i++) await c.incr("counter");
    }));
    const totals = await Promise.all(dbs.map((_, i) => clients[i * 40].get("counter")));
    expect(totals).toEqual(dbs.map(() => "1000"));
  } finally {
    await quitAll(clients);
  }
});

test("a work queue under contention hands each job to exactly one worker", async () => {
  const db = unique("queue");
  const producers = Array.from({ length: 5 }, () => client(db));
  const workers = Array.from({ length: 10 }, () => client(db));
  const seen: Array<string> = [];
  try {
    const consuming = workers.map(async (w) => {
      for (;;) {
        const job = await w.brpop("jobs", 2);
        if (!job) return;
        seen.push(job[1]);
      }
    });
    await Promise.all(producers.map(async (p, i) => {
      for (let j = 0; j < 100; j++) await p.lpush("jobs", `${i}-${j}`);
    }));
    await Promise.all(consuming);
    expect(seen).toHaveLength(500);
    expect(new Set(seen).size).toBe(500);
  } finally {
    await quitAll([...producers, ...workers]);
  }
});

test("pub/sub delivers every message to every subscriber in order", async () => {
  const db = unique("pubsub");
  const subscribers = Array.from({ length: 20 }, () => client(db));
  const publishers = Array.from({ length: 10 }, () => client(db));
  const got = subscribers.map(() => new Map<string, Array<number>>());
  try {
    await Promise.all(subscribers.map(async (s, i) => {
      s.on("message", (_channel: string, message: string) => {
        const [from, n] = message.split(":");
        const list = got[i].get(from) ?? [];
        list.push(Number(n));
        got[i].set(from, list);
      });
      await s.subscribe("news");
    }));
    await Promise.all(publishers.map(async (p, i) => {
      for (let n = 0; n < 50; n++) await p.publish("news", `${i}:${n}`);
    }));
    await Bun.sleep(500);
    const ordered = Array.from({ length: 50 }, (_, n) => n);
    for (const perSubscriber of got) {
      expect(perSubscriber.size).toBe(10);
      for (const list of perSubscriber.values()) expect(list).toEqual(ordered);
    }
  } finally {
    await quitAll([...subscribers, ...publishers]);
  }
});

test("the connection cap holds under a burst of new connections", async () => {
  const db = unique("cap");
  const clients = Array.from({ length: MAX_CONNECTIONS + 10 }, () => new Redis({
    host: server.host, port: server.port, username: db, password: "load-pass", maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: true,
  }));
  for (const c of clients) c.on("error", () => {});
  try {
    const results = await Promise.allSettled(clients.map((c) => c.connect().then(() => c.ping())));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(MAX_CONNECTIONS);
  } finally {
    for (const c of clients) c.disconnect();
  }
});

test("data and clients survive a server restart", async () => {
  const db = unique("restart");
  const writer = client(db);
  const waiter = client(db);
  try {
    const pipeline = writer.pipeline();
    for (let i = 0; i < 500; i++) pipeline.set(`k${i}`, `v${i}`);
    await pipeline.exec();
    await writer.hset("h", "f", "v");
    await writer.zadd("z", 1, "a");
    await writer.xadd("s", "1-0", "f", "v");

    await server.restart();

    const values = await writer.mget(Array.from({ length: 500 }, (_, i) => `k${i}`));
    expect(values).toEqual(Array.from({ length: 500 }, (_, i) => `v${i}`));
    expect(await writer.hget("h", "f")).toBe("v");
    expect(await writer.zscore("z", "a")).toBe("1");
    expect(await writer.xlen("s")).toBe(1);

    const popped = waiter.blpop("after", 10);
    await Bun.sleep(300);
    await writer.rpush("after", "job");
    expect(await popped).toEqual(["after", "job"]);
  } finally {
    await quitAll([writer, waiter]);
  }
});
