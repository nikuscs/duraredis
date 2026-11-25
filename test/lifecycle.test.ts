import { afterAll, beforeAll, expect, test } from "bun:test";
import { openRaw } from "./raw";
import { startServer } from "./server";
import type { Server } from "./server";

const TTL_SECONDS = 30;
const IDLE_SECONDS = 6;
const MAX_CONNECTIONS = 3;

let server: Server;
beforeAll(async () => {
  server = await startServer("test");
});
afterAll(() => server?.stop());

const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}`;

const open = () => openRaw(server.host, server.port);

test("commands before AUTH get NOAUTH and the connection stays usable", async () => {
  const c = await open();
  expect((await c.send("GET k"))[0]).toStartWith("-NOAUTH Authentication required.");
  expect((await c.send("HELLO 3"))[0]).toStartWith("-NOAUTH");
  expect(await c.send(`AUTH ${unique("pre")} x`)).toEqual(["+OK"]);
  expect(await c.send("PING")).toEqual(["+PONG"]);
  c.close();
});

test("invalid database names are refused without closing the connection", async () => {
  const c = await open();
  for (const bad of ["ab", "Upper", "under_score", "-leading", "x".repeat(64)]) {
    expect((await c.send(`AUTH ${bad} x`))[0]).toStartWith("-WRONGPASS duraredis: invalid database name");
  }
  expect(await c.send(`AUTH ${unique("good")} x`)).toEqual(["+OK"]);
  c.close();
});

test("AUTH to another database on a bound connection is an error", async () => {
  const c = await open();
  const name = unique("bound");
  await c.send(`AUTH ${name} x`);
  expect((await c.send("AUTH other-db x"))[0]).toStartWith(`-ERR duraredis: this connection is bound to database "${name}"`);
  expect(await c.send(`AUTH ${name} x`)).toEqual(["+OK"]);
  c.close();
});

test("the first password protects the database", async () => {
  const name = unique("secret");
  const owner = await open();
  expect(await owner.send(`AUTH ${name} s3cret`)).toEqual(["+OK"]);
  expect(await owner.send("SET k v")).toEqual(["+OK"]);
  owner.close();

  const intruder = await open();
  expect(await intruder.send(`AUTH ${name} wrong`)).toEqual(["-WRONGPASS invalid username-password pair or user is disabled."]);
  expect(await intruder.send("GET k")).toEqual(["-NOAUTH Authentication required."]);
  expect((await intruder.send("HELLO 3"))[0]).toStartWith("-NOAUTH HELLO must be called with the client already authenticated");
  for (let i = 0; i < 3; i++) await intruder.send(`AUTH ${name} wrong${i}`);
  expect((await intruder.send(`AUTH ${name} wrong3`))[0]).toStartWith("-WRONGPASS duraredis: too many wrong passwords from this address");
  intruder.close();

  const again = await open();
  expect((await again.send(`AUTH ${name} s3cret`))[0]).toStartWith("-WRONGPASS duraredis: too many wrong passwords from this address");
  again.close();
});

test("a database created without a password stays open", async () => {
  const name = unique("open");
  const first = await open();
  expect(await first.send(`AUTH ${name}`)).toEqual(["+OK"]);
  first.close();
  const second = await open();
  expect(await second.send(`AUTH default ${name}`)).toEqual(["+OK"]);
  second.close();
});

test("the first connect creates the database and the TTL deletes it", async () => {
  const name = unique("ttl");
  const first = await open();
  await first.send(`AUTH ${name} x`);
  expect(await first.send("SET k v")).toEqual(["+OK"]);
  first.close();

  const again = await open();
  await again.send(`AUTH ${name} x`);
  expect(await again.send("GET k", 2)).toEqual(["$1", "v"]);
  again.close();

  await Bun.sleep((TTL_SECONDS + 3) * 1000);
  const expired = await open();
  await expired.send(`AUTH ${name} x`);
  expect(await expired.send("GET k")).toEqual(["$-1"]);
  expired.close();
});

test("idle connections are closed", async () => {
  const c = await open();
  await c.send(`AUTH ${unique("idle")} x`);
  await Bun.sleep((IDLE_SECONDS + 2) * 1000);
  expect(c.isClosed()).toBe(true);
});

test("the per-database connection cap refuses extras and frees slots on close", async () => {
  const name = unique("cap");
  const held = [];
  for (let i = 0; i < MAX_CONNECTIONS; i++) {
    const c = await open();
    expect(await c.send(`AUTH ${name} x`)).toEqual(["+OK"]);
    held.push(c);
  }
  const extra = await open();
  expect(await extra.send(`AUTH ${name} x`)).toEqual(["-ERR max number of clients reached"]);
  held.pop()!.close();
  await Bun.sleep(200);
  const again = await open();
  expect(await again.send(`AUTH ${name} x`)).toEqual(["+OK"]);
  for (const c of [...held, again]) c.close();
});

test("too many new connections from one address are refused", async () => {
  let refused: string | undefined;
  for (let i = 0; i < 40 && !refused; i++) {
    const c = await open();
    const [reply] = await c.send(`AUTH ${unique(`burst-${i}`)} x`);
    if (reply.startsWith("-ERR duraredis: too many new connections")) refused = reply;
    c.close();
  }
  expect(refused).toBeDefined();
});
