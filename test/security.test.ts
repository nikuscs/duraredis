import { afterAll, beforeAll, expect, test } from "bun:test";
import { openRaw } from "./raw";
import { startServer } from "./server";
import type { Server } from "./server";

const COMMANDS_PER_SECOND = 100;
const BLOCKED = "-WRONGPASS duraredis: too many wrong passwords from this address";

let server: Server;
beforeAll(async () => {
  server = await startServer("test");
});
afterAll(() => server?.stop());

const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}`;
const open = () => openRaw(server.host, server.port);

test("wrong passwords block the address after five tries, across connections", async () => {
  const name = unique("guess");
  const owner = await open();
  expect(await owner.send(`AUTH ${name} right`)).toEqual(["+OK"]);

  const first = await open();
  for (let i = 0; i < 3; i++) expect(await first.send(`AUTH ${name} wrong${i}`)).toEqual(["-WRONGPASS invalid username-password pair or user is disabled."]);
  first.close();
  const second = await open();
  expect(await second.send(`AUTH ${name} wrong3`)).toEqual(["-WRONGPASS invalid username-password pair or user is disabled."]);
  expect((await second.send(`AUTH ${name} wrong4`))[0]).toStartWith(BLOCKED);
  expect(await second.send("GET k")).toEqual(["-NOAUTH Authentication required."]);
  second.close();

  const third = await open();
  expect((await third.send(`AUTH ${name} right`))[0]).toStartWith(BLOCKED);
  third.close();

  expect(await owner.send("PING")).toEqual(["+PONG"]);
  owner.close();
});

test("a right password clears earlier wrong tries", async () => {
  const name = unique("clear");
  const c = await open();
  expect(await c.send(`AUTH ${name} right`)).toEqual(["+OK"]);
  for (let i = 0; i < 4; i++) await c.send(`AUTH ${name} wrong${i}`);
  expect(await c.send(`AUTH ${name} right`)).toEqual(["+OK"]);
  for (let i = 0; i < 4; i++) expect(await c.send(`AUTH ${name} wrong${i}`)).toEqual(["-WRONGPASS invalid username-password pair or user is disabled."]);
  c.close();
});

test("ACL SETUSER changes the database password", async () => {
  const name = unique("rotate");
  const owner = await open();
  expect(await owner.send(`AUTH ${name} old-pass`)).toEqual(["+OK"]);
  expect(await owner.send("SET k v")).toEqual(["+OK"]);
  expect((await owner.send("ACL SETUSER someone >x"))[0]).toStartWith("-ERR duraredis: the only user is the database name");
  expect((await owner.send(`ACL SETUSER ${name} +@all`))[0]).toStartWith("-ERR duraredis: ACL SETUSER supports");
  expect(await owner.send(`ACL SETUSER ${name} on resetpass >new-pass`)).toEqual(["+OK"]);
  expect(await owner.send("GET k", 2)).toEqual(["$1", "v"]);

  const stale = await open();
  expect(await stale.send(`AUTH ${name} old-pass`)).toEqual(["-WRONGPASS invalid username-password pair or user is disabled."]);
  stale.close();
  const fresh = await open();
  expect(await fresh.send(`AUTH ${name} new-pass`)).toEqual(["+OK"]);
  expect(await fresh.send(`ACL SETUSER ${name} nopass`)).toEqual(["+OK"]);
  fresh.close();
  owner.close();

  const anyone = await open();
  expect(await anyone.send(`AUTH ${name} whatever`)).toEqual(["+OK"]);
  anyone.close();
});

test("a database answers a limited number of commands per second", async () => {
  const name = unique("flood");
  const c = await open();
  expect(await c.send(`AUTH ${name} x`)).toEqual(["+OK"]);
  const burst = Array.from({ length: COMMANDS_PER_SECOND * 2 }, () => "*1\r\n$4\r\nPING").join("\r\n");
  const replies = await c.send(burst, COMMANDS_PER_SECOND * 2);
  expect(replies.filter((r) => r === "+PONG").length).toBeLessThanOrEqual(COMMANDS_PER_SECOND + 5);
  expect(replies.some((r) => r.startsWith(`-ERR duraredis: this database is limited to ${COMMANDS_PER_SECOND} commands per second`))).toBe(true);
  await Bun.sleep(1100);
  expect(await c.send("PING")).toEqual(["+PONG"]);
  c.close();
});
