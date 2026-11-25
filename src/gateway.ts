import { credentials as login } from "./commands/server";
import { DB_NAME } from "./database/lifecycle";
import { chunkOf, closeQuietly, refuse } from "./database/socket";
import { Parser } from "./resp/parser";
import type { Command } from "./resp/parser";
import { Encoder, r, RedisError, text } from "./resp/reply";
import type { Reply } from "./resp/reply";

const MAX_PREAUTH_COMMANDS = 16;
const PREAUTH_TIMEOUT_MS = 10_000;
const NOAUTH = "NOAUTH Authentication required. Duraredis picks the database from the username: connect with redis://<database>:<anything>@host or redis://:<database>@host";
const RATE_LIMITED = "ERR duraredis: too many new connections from this address, try again in a minute";

interface Bound {
  database: string;
  bytes: Uint8Array;
}

type Step = { bound: Bound } | { reply: Reply; stop?: boolean };

const hostOf = (address: string) => address.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");

function credentials(args: Command): string | undefined {
  const name = text(args[0]).toLowerCase();
  if (name === "auth" && args.length === 2) return login(undefined, text(args[1])).database;
  if (name === "auth" && args.length === 3) return login(text(args[1]), text(args[2])).database;
  if (name !== "hello") return undefined;
  const at = args.findIndex((a, i) => i > 0 && text(a).toUpperCase() === "AUTH");
  if (at < 0 || at + 2 >= args.length) return undefined;
  return login(text(args[at + 1]), text(args[at + 2])).database;
}

function step(args: Command, raw: Uint8Array): Step {
  const database = credentials(args);
  const name = text(args[0]).toLowerCase();
  if (database !== undefined && DB_NAME.test(database)) return { bound: { database, bytes: raw } };
  if (database !== undefined) {
    return { reply: r.error(`WRONGPASS duraredis: invalid database name "${database}" (3-63 chars, a-z 0-9 and "-", starting with a letter or digit)`) };
  }
  if (name === "quit") return { reply: r.ok, stop: true };
  if (name === "hello") return { reply: r.error(`${NOAUTH} (HELLO needs the AUTH option)`) };
  return { reply: r.error(NOAUTH) };
}

async function bind(reader: ReadableStreamDefaultReader, writer: WritableStreamDefaultWriter, allowed: () => Promise<boolean>): Promise<Bound | undefined> {
  const parser = new Parser();
  let answered = 0;
  let checked = false;
  for (;;) {
    const next: ReadableStreamReadResult<unknown> = await reader.read();
    if (next.done) return undefined;
    if (!checked && !(await allowed())) return undefined;
    checked = true;
    parser.push(chunkOf(next.value));
    const out = new Encoder(2);
    for (;;) {
      const raw = parser.rest().slice();
      let args: Command | undefined;
      try {
        args = parser.next();
      } catch (error) {
        await writer.write(out.write(r.error(error instanceof RedisError ? error.message : "ERR Protocol error")).take());
        return undefined;
      }
      if (!args) break;
      const next = step(args, raw);
      if ("bound" in next) {
        if (!out.empty) await writer.write(out.take());
        return next.bound;
      }
      out.write(next.reply);
      if (next.stop || ++answered >= MAX_PREAUTH_COMMANDS) {
        await writer.write(out.take());
        return undefined;
      }
    }
    if (!out.empty) await writer.write(out.take());
  }
}

async function pipe(socket: Socket, upstream: Socket, first: Uint8Array) {
  const down = upstream.readable.pipeTo(socket.writable);
  const writer = upstream.writable.getWriter();
  const sent = await writer.write(first).then(() => true, () => false);
  writer.releaseLock();
  const up = sent ? socket.readable.pipeTo(upstream.writable) : Promise.resolve();
  await Promise.allSettled([down, up]);
  await Promise.all([closeQuietly(socket), closeQuietly(upstream)]);
}

export async function connect(socket: Socket, env: Env) {
  const { remoteAddress = "" } = await socket.opened;
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), PREAUTH_TIMEOUT_MS);
  let limited = false;
  const allowed = async () => {
    limited = !(await env.CONNECT_LIMIT.limit({ key: hostOf(remoteAddress) })).success;
    return !limited;
  };
  const bound = await bind(reader, writer, allowed).catch(() => undefined);
  clearTimeout(timer);
  reader.releaseLock();
  writer.releaseLock();
  if (limited) return refuse(socket, RATE_LIMITED);
  if (!bound) return closeQuietly(socket);
  const upstream = env.REDIS.getByName(bound.database).connect("redis:6379", { allowHalfOpen: true, secureTransport: "off" });
  await upstream.opened;
  await pipe(socket, upstream, bound.bytes);
}
