import { afterAll, beforeAll, expect, test } from "bun:test";
import Redis from "ioredis";
import { freshDb, serverHttp } from "./setup";

const BRIDGE_PORT = 16_380 + Math.floor(Math.random() * 1000);
let bridge: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  bridge = Bun.spawn(["bun", "scripts/bridge.ts", serverHttp(), String(BRIDGE_PORT)], { stdout: "pipe", stderr: "inherit" });
  const reader = bridge.stdout instanceof ReadableStream ? bridge.stdout.getReader() : undefined;
  await reader?.read();
  reader?.releaseLock();
});

afterAll(() => bridge.kill());

const client = (db: string) => new Redis({ host: "127.0.0.1", port: BRIDGE_PORT, username: db, password: "ws-pass", maxRetriesPerRequest: 2 });

test("plain HTTP gets usage text", async () => {
  const res = await fetch(serverHttp());
  expect(res.status).toBe(426);
  expect(await res.text()).toContain("bridge");
});

test("clients work through the WebSocket bridge", async () => {
  const db = freshDb("ws");
  const [a, b] = [client(db), client(db)];
  try {
    expect(await a.set("k", "v")).toBe("OK");
    expect(await b.get("k")).toBe("v");
    const pipeline = a.pipeline();
    for (let i = 0; i < 50; i++) pipeline.incr("n");
    await pipeline.exec();
    expect(await b.get("n")).toBe("50");
    const big = "x".repeat(200_000);
    await a.set("big", big);
    expect(await b.get("big")).toBe(big);
    const popped = b.blpop("q", 5);
    await Bun.sleep(100);
    await a.rpush("q", "job");
    expect(await popped).toEqual(["q", "job"]);
  } finally {
    await Promise.all([a.quit(), b.quit()]);
  }
});

test("only one of many bridged clients takes a lock", async () => {
  const db = freshDb("ws-lock");
  const clients = Array.from({ length: 20 }, () => client(db));
  try {
    const results = await Promise.all(clients.map((c, i) => c.set("lock", `t${i}`, "PX", 5000, "NX")));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
  } finally {
    await Promise.all(clients.map((c) => c.quit()));
  }
});

test("a wrong password is refused through the bridge", async () => {
  const db = freshDb("ws-auth");
  const owner = client(db);
  await owner.ping();
  const intruder = new Redis({ host: "127.0.0.1", port: BRIDGE_PORT, username: db, password: "wrong", maxRetriesPerRequest: 0, retryStrategy: () => null });
  intruder.on("error", () => {});
  await expect(intruder.ping()).rejects.toThrow(/WRONGPASS/);
  intruder.disconnect();
  await owner.quit();
});
