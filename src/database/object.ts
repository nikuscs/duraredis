import { DurableObject } from "cloudflare:workers";
import { Keyspace } from "../store/keyspace";
import { Connection } from "./connection";
import { Hub } from "./hub";
import { checkPassword } from "./guard";
import type { AuthResult } from "./guard";
import { changePassword, createDatabase, ensureSchema, readMeta } from "./lifecycle";
import { readPreamble } from "./preamble";
import { chunkOf, closeQuietly, refuse } from "./socket";

export class RedisDO extends DurableObject<Env> {
  private readonly closers = new Map<Connection, () => Promise<void>>();
  private readonly hub: Hub;
  private deleting = false;
  private nextId = 1;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (readMeta(ctx.storage)) ensureSchema(ctx.storage);
    const access = { authenticate: (password: string, client: string) => this.authenticate(password, client), setPassword: (password: string | null) => this.setPassword(password), commandsPerSecond: env.LIMITS.commandsPerSecond };
    this.hub = new Hub(new Keyspace(ctx.storage.sql), ctx.id.name ?? "", Date.now(), (fn) => ctx.storage.transactionSync(fn), access);
  }

  private authenticate(password: string, client: string): AuthResult {
    const meta = readMeta(this.ctx.storage);
    if (meta) return checkPassword(this.ctx.storage.sql, meta, password, client);
    createDatabase(this.ctx.storage, this.name, this.env.LIMITS.ttlSeconds, password);
    return "ok";
  }

  private setPassword(password: string | null) {
    const meta = readMeta(this.ctx.storage);
    if (meta) changePassword(this.ctx.storage, meta, password);
  }

  private get name(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("RedisDO must be addressed by name");
    return name;
  }

  private refusal(maxConnections: number): string | undefined {
    if (this.deleting) return "ERR duraredis: the database is being deleted, try again";
    if (this.closers.size >= maxConnections) return "ERR max number of clients reached";
    return undefined;
  }

  async connect(socket: Socket): Promise<void> {
    const { idleSeconds, maxConnections } = this.env.LIMITS;
    const reader = socket.readable.getReader();
    const opened = await readPreamble(reader).catch(() => undefined);
    if (!opened) {
      reader.releaseLock();
      return closeQuietly(socket);
    }
    const refusal = this.refusal(maxConnections);
    if (refusal) {
      reader.releaseLock();
      return refuse(socket, refusal);
    }
    const writer = socket.writable.getWriter();
    let closed = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let writing = Promise.resolve();
    const send = (bytes: Uint8Array) => {
      writing = writing.then(() => writer.write(bytes)).catch(() => {});
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      await writing;
      await writer.close().catch(() => {});
      await closeQuietly(socket);
    };
    const conn = new Connection(this.hub, this.nextId++, this.name, opened.client, send, () => void close());
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => (conn.waiting ? touch() : void close()), idleSeconds * 1000);
    };
    this.closers.set(conn, close);
    this.hub.connectionSet.add(conn);
    touch();

    try {
      if (opened.rest.length) {
        conn.receive(opened.rest);
        await writing;
      }
      while (!closed && !this.deleting && !conn.session.closing) {
        const next: ReadableStreamReadResult<unknown> = await reader.read();
        if (next.done) break;
        touch();
        conn.receive(chunkOf(next.value));
        await writing;
      }
    } catch {
      conn.session.closing = true;
    } finally {
      conn.close();
      this.hub.connectionSet.delete(conn);
      this.closers.delete(conn);
      reader.releaseLock();
      await close();
    }
  }

  async alarm() {
    const meta = readMeta(this.ctx.storage);
    if (!meta || meta.expiresAt === null) return;
    if (Date.now() < meta.expiresAt) return this.ctx.storage.setAlarm(meta.expiresAt);
    this.deleting = true;
    try {
      await Promise.all([...this.closers.values()].map((close) => close()));
      await this.ctx.storage.deleteAll();
    } finally {
      this.deleting = false;
    }
  }
}
