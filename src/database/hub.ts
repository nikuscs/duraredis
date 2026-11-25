import type { Server, Session } from "../commands/types";
import { r } from "../resp/reply";
import { globMatch } from "../store/glob";
import { keyString } from "../store/keyspace";
import type { Keyspace } from "../store/keyspace";
import type { Connection } from "./connection";
import type { AuthResult } from "./guard";

export interface Access {
  authenticate: (password: string, client: string) => AuthResult;
  setPassword: (password: string | null) => void;
  commandsPerSecond: number;
}

export type ChannelKind = "channel" | "pattern" | "shard";

interface Channel {
  name: Uint8Array;
  subscribers: Set<Connection>;
}

export class Hub implements Server {
  readonly connectionSet = new Set<Connection>();
  readonly watchers = new Map<string, Set<Connection>>();
  private readonly waiting = new Map<string, Array<Connection>>();
  private readonly ready = new Set<string>();
  private readonly subscriptions: Record<ChannelKind, Map<string, Channel>> = { channel: new Map(), pattern: new Map(), shard: new Map() };
  private serving = false;
  private tokens: number;
  private refilledAt = Date.now();

  constructor(
    readonly ks: Keyspace,
    readonly database: string,
    readonly startedAt: number,
    readonly atomic: <T>(fn: () => T) => T,
    private readonly access: Access,
  ) {
    this.tokens = access.commandsPerSecond;
    ks.onChange = (key) => this.changed(key);
    ks.beforeFlush = () => this.flushing();
  }

  authenticate(password: string, client: string): AuthResult {
    return this.access.authenticate(password, client);
  }

  setPassword(password: string | null) {
    this.access.setPassword(password);
  }

  get commandsPerSecond(): number {
    return this.access.commandsPerSecond;
  }

  admit(now = Date.now()): boolean {
    const rate = this.access.commandsPerSecond;
    this.tokens = Math.min(rate, this.tokens + ((now - this.refilledAt) * rate) / 1000);
    this.refilledAt = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }

  connections(): Array<Session> {
    return [...this.connectionSet].map((c) => c.session);
  }

  private changed(key: Uint8Array) {
    const k = keyString(key);
    for (const c of this.watchers.get(k) ?? []) c.dirty = true;
    if (this.waiting.has(k)) this.ready.add(k);
  }

  private flushing() {
    for (const c of this.connectionSet) {
      for (const key of c.watchedKeys()) if (this.ks.exists(key)) c.dirty = true;
    }
  }

  wait(key: string, conn: Connection) {
    const queue = this.waiting.get(key);
    if (queue) queue.push(conn);
    else this.waiting.set(key, [conn]);
  }

  unwait(key: string, conn: Connection) {
    const queue = this.waiting.get(key)?.filter((c) => c !== conn);
    if (queue?.length) this.waiting.set(key, queue);
    else this.waiting.delete(key);
  }

  serveBlocked() {
    if (this.serving) return;
    this.serving = true;
    try {
      for (const key of this.ready) {
        this.ready.delete(key);
        for (const conn of (this.waiting.get(key) ?? []).slice()) conn.retry();
      }
    } finally {
      this.serving = false;
    }
  }

  unblock(id: number, error: boolean): boolean {
    for (const c of this.connectionSet) {
      if (c.session.id === id) return c.cancelBlock(error);
    }
    return false;
  }

  subscribe(kind: ChannelKind, name: Uint8Array, conn: Connection) {
    const k = keyString(name);
    const channel = this.subscriptions[kind].get(k);
    if (channel) channel.subscribers.add(conn);
    else this.subscriptions[kind].set(k, { name, subscribers: new Set([conn]) });
  }

  unsubscribe(kind: ChannelKind, name: Uint8Array, conn: Connection) {
    const k = keyString(name);
    const channel = this.subscriptions[kind].get(k);
    if (!channel) return;
    channel.subscribers.delete(conn);
    if (!channel.subscribers.size) this.subscriptions[kind].delete(k);
  }

  publish(channel: Uint8Array, message: Uint8Array, shard: boolean): number {
    if (shard) return this.deliver(this.subscriptions.shard.get(keyString(channel)), (c) => c.push(r.push([r.bulk("smessage"), r.bulk(channel), r.bulk(message)])));
    let receivers = this.deliver(this.subscriptions.channel.get(keyString(channel)), (c) => c.push(r.push([r.bulk("message"), r.bulk(channel), r.bulk(message)])));
    for (const pattern of this.subscriptions.pattern.values()) {
      if (!globMatch(pattern.name, channel)) continue;
      receivers += this.deliver(pattern, (c) => c.push(r.push([r.bulk("pmessage"), r.bulk(pattern.name), r.bulk(channel), r.bulk(message)])));
    }
    return receivers;
  }

  private deliver(channel: Channel | undefined, send: (c: Connection) => void): number {
    if (!channel) return 0;
    for (const c of channel.subscribers) send(c);
    return channel.subscribers.size;
  }

  channels(pattern: Uint8Array | null, shard: boolean): Array<Uint8Array> {
    const names = [...this.subscriptions[shard ? "shard" : "channel"].values()].map((c) => c.name);
    return pattern ? names.filter((n) => globMatch(pattern, n)) : names;
  }

  subscribers(channel: Uint8Array, shard: boolean): number {
    return this.subscriptions[shard ? "shard" : "channel"].get(keyString(channel))?.subscribers.size ?? 0;
  }

  patterns(): number {
    return this.subscriptions.pattern.size;
  }
}
