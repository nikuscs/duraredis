# 🧱 Duraredis

> Redis 8 on Cloudflare Durable Objects. Point any Redis client at it, and every database name gets its own durable, SQLite-backed Redis.

Running Redis means a server to size, patch and back up, even for a small app. Duraredis speaks the Redis protocol from a Cloudflare Worker and stores each database in its own Durable Object, so a database appears the first time you connect to it and keeps its data with no server to run.

The idea comes from [Duragres](https://github.com/jaypopat/duragres) by [@jaypopat](https://github.com/jaypopat), which does the same for Postgres.

## ✨ Features

- 🔌 **Any Redis client**: RESP2 and RESP3 over TCP, or over WebSocket through a small local bridge, tested with ioredis, Bun's Redis client, BullMQ and Redlock.
- 🗄️ **One database per name**: the username picks the database, the first connection creates it, and the password it was created with protects it.
- 🧪 **Matches Redis 8.12**: the tests send the same commands to Duraredis and to a real `redis:8` and compare the raw replies byte for byte.
- 🧩 **Redis 8 data types**: JSON, Bloom and Cuckoo filters, Count-Min Sketch, Top-K, t-digest, time series, vector sets and arrays, plus hash field and set member expiry.
- 🔒 **Safe concurrency**: one Durable Object runs one command at a time, like Redis's single thread, and each command is its own SQLite transaction, so a failed command leaves nothing half-written.
- 📜 **Real Lua**: Redis's own Lua 5.1 with cjson, cmsgpack, struct and bit, compiled to WebAssembly, for `EVAL` and `FUNCTION`.
- ⏳ **Blocking and pub/sub**: `BLPOP`, `XREAD BLOCK` and the other blocking commands, plus channels, work across connections to the same database.
- 📦 **DUMP and RESTORE**: payloads move between Duraredis and Redis 8 for strings, lists, sets, sorted sets, hashes and streams.

## 🧰 Built with

[Cloudflare Workers](https://developers.cloudflare.com/workers/) · [Durable Objects](https://developers.cloudflare.com/durable-objects/) · [Spectrum](https://developers.cloudflare.com/spectrum/) · [Lua 5.1](https://www.lua.org) · [Emscripten](https://emscripten.org) · [Bun](https://bun.sh) · [Oxlint](https://oxc.rs)

## 🚀 Run it in 3 steps

**You need:** [Bun](https://bun.sh), and Docker if you want the comparison tests.

**1. Install**

```sh
git clone https://github.com/nikuscs/duraredis && cd duraredis && bun install --frozen-lockfile
```

**2. Start the local server**

```sh
bun run dev
```

It listens on port 6380 (`DURAREDIS_PORT` changes it).

**3. Connect with the database name as the username**

```sh
redis-cli -u redis://mydb:my-password@localhost:6380
```

```ts
const redis = new Bun.RedisClient("redis://mydb:my-password@localhost:6380");
await redis.set("hello", "world");
```

Any name works in place of `mydb` (3 to 63 characters, `a-z`, `0-9` and `-`).

- The first connection to a name creates the database, and its password becomes the database password. Later connections need the same password or get `WRONGPASS`.
- Five wrong passwords from one address within 15 minutes block that address from the database for 15 minutes, across all its connections, even with the right password. A right password before that clears the count.
- Change the password from a logged-in connection with `ACL SETUSER mydb >new-password` (`nopass` opens the database to anyone). Open connections stay logged in.
- A database created without a password (`redis://mydb@host`) stays open to anyone who knows the name. ioredis skips `AUTH` when there is no password, so give it one.

## ☁️ Deploy to Cloudflare

```sh
bun run deploy
```

Clients reach the deployed Worker in one of two ways.

**Over WebSocket, on any plan.** The Worker accepts encrypted WebSocket connections on its `workers.dev` URL. Run the bridge where your app runs; it listens on a local port and forwards each Redis connection over its own WebSocket:

```sh
bun run bridge https://duraredis.<your-subdomain>.workers.dev 6380
redis-cli -u redis://mydb:my-password@127.0.0.1:6380
```

**Over plain TCP, with a Pro or Business domain.** Free zones can't send TCP to a Worker. Create a Spectrum application for the zone with **Workers (tcp)** as the type, a subdomain, one TCP port such as `6379`, and this Worker as the origin. Clients connect with `redis://<name>:<password>@<subdomain>.<your-domain>:6379`, no bridge needed.

> [!WARNING]
> Spectrum on Pro and Business zones allows one Worker TCP application per zone, and that traffic is **not encrypted**: passwords and data cross the internet in plain text. TLS (`rediss://`) needs Spectrum Enterprise with TLS termination turned on. The WebSocket route is encrypted.

`cloudflare.config.ts` holds the limits:

| Setting | What it does |
| --- | --- |
| `ttlSeconds` | Delete databases this long after creation. `0` keeps them forever (the default) |
| `idleSeconds` | Close idle connections. Subscribers and blocked clients are exempt |
| `maxConnections` | Connections per database |
| `commandsPerSecond` | Commands per second per database; extra commands get an error |
| `CONNECT_LIMIT` | New connections per client IP per minute |

## 📚 Commands

Duraredis reports itself as Redis 8.12 and covers what `redis:8` ships, except Search (`FT.*`).

| Group | Commands |
| --- | --- |
| Strings | `GET SET SETNX SETEX PSETEX GETSET GETDEL GETEX MGET MSET MSETNX MSETEX APPEND STRLEN INCR DECR INCRBY DECRBY INCRBYFLOAT INCREX GETRANGE SUBSTR SETRANGE LCS DIGEST DELEX`, and `SET ... IFEQ IFNE IFDEQ IFDNE` |
| Bitmaps, HyperLogLog | `SETBIT GETBIT BITCOUNT BITPOS BITOP BITFIELD BITFIELD_RO BITRANGEINTARRAY PFADD PFCOUNT PFMERGE PFDEBUG PFSELFTEST` |
| Hashes | `HSET HSETNX HMSET HGET HMGET HDEL HEXISTS HLEN HSTRLEN HKEYS HVALS HGETALL HINCRBY HINCRBYFLOAT HRANDFIELD HSCAN HGETDEL HGETEX HSETEX HIMPORT HEXPIRE HPEXPIRE HEXPIREAT HPEXPIREAT HTTL HPTTL HEXPIRETIME HPEXPIRETIME HPERSIST` |
| Lists | `LPUSH RPUSH LPUSHX RPUSHX LPOP RPOP LLEN LRANGE LINDEX LSET LINSERT LREM LTRIM LPOS LMOVE LMOVEM RPOPLPUSH LMPOP BLPOP BRPOP BLMOVE BLMOVEM BRPOPLPUSH BLMPOP` |
| Sets | `SADD SADDEX SREM SMEMBERS SISMEMBER SMISMEMBER SCARD SPOP SRANDMEMBER SMOVE SINTER SUNION SDIFF SINTERSTORE SUNIONSTORE SDIFFSTORE SINTERCARD SDIFFCARD SUNIONCARD SSCAN SEXPIRE SPEXPIRE SEXPIREAT SPEXPIREAT STTL SPTTL SEXPIRETIME SPEXPIRETIME SPERSIST` |
| Sorted sets | `ZADD ZINCRBY ZREM ZCARD ZSCORE ZMSCORE ZCOUNT ZLEXCOUNT ZRANGE ZREVRANGE ZRANGEBYSCORE ZREVRANGEBYSCORE ZRANGEBYLEX ZREVRANGEBYLEX ZRANGESTORE ZRANK ZREVRANK ZPOPMIN ZPOPMAX BZPOPMIN BZPOPMAX ZMPOP BZMPOP ZREMRANGEBYRANK ZREMRANGEBYSCORE ZREMRANGEBYLEX ZUNIONSTORE ZINTERSTORE ZDIFFSTORE ZUNION ZINTER ZDIFF ZINTERCARD ZRANDMEMBER ZSCAN ZMOVE BZMOVE ZMOVEMEMBER` |
| Geo | `GEOADD GEODIST GEOHASH GEOPOS GEORADIUS GEORADIUS_RO GEORADIUSBYMEMBER GEORADIUSBYMEMBER_RO GEOSEARCH GEOSEARCHSTORE` |
| Streams | `XADD XLEN XRANGE XREVRANGE XDEL XDELEX XTRIM XSETID XREAD XGROUP XREADGROUP XACK XACKDEL XNACK XPENDING XCLAIM XAUTOCLAIM XINFO XCFGSET XIDMPRECORD` |
| Arrays | `ARSET ARGET ARMSET ARMGET ARDEL ARDELRANGE ARGETRANGE ARINSERT ARLEN ARCOUNT ARGREP AROP ARINFO ARLASTITEMS ARNEXT ARRING ARSCAN ARSEEK` |
| JSON, probabilistic, time series | `JSON.*` · `BF.* CF.* CMS.* TOPK.* TDIGEST.*` · `TS.*` |
| Vector sets | `VADD VCARD VDIM VEMB VGETATTR VINFO VISMEMBER VLINKS VRANDMEMBER VRANGE VREM VSETATTR VSIM` |
| Keys | `DEL UNLINK EXISTS TOUCH TYPE KEYS SCAN RANDOMKEY RENAME RENAMENX COPY MOVE EXPIRE PEXPIRE EXPIREAT PEXPIREAT TTL PTTL EXPIRETIME PEXPIRETIME PERSIST DBSIZE FLUSHDB FLUSHALL SORT SORT_RO DUMP RESTORE OBJECT` |
| Transactions, scripting | `MULTI EXEC DISCARD WATCH UNWATCH` · `EVAL EVALSHA EVAL_RO EVALSHA_RO SCRIPT FUNCTION FCALL FCALL_RO` |
| Pub/sub | `SUBSCRIBE UNSUBSCRIBE PSUBSCRIBE PUNSUBSCRIBE SSUBSCRIBE SUNSUBSCRIBE PUBLISH SPUBLISH PUBSUB` |
| Connection, server | `AUTH HELLO PING ECHO QUIT RESET SELECT CLIENT COMMAND INFO CONFIG TIME WAIT WAITAOF LASTSAVE ACL MEMORY SLOWLOG LATENCY MODULE ROLE SAVE BGSAVE BGREWRITEAOF SWAPDB LOLWUT` |

The server commands answer as a single-node Redis with nothing to report: one user (the database name), an empty slow log, saves that finish at once. Replication, cluster, `MONITOR`, `DEBUG`, `SHUTDOWN`, `BACKUP`, `BLESS` and `HOTKEYS` return an error.

## ⚙️ How it works

| Path | What it does |
| --- | --- |
| `src/gateway.ts` | Accepts TCP connections, and `src/websocket.ts` WebSocket ones. Reads commands until `AUTH` or `HELLO ... AUTH` names the database, answers anything earlier with `NOAUTH`, then pipes the connection to that database's Durable Object |
| `src/database/` | The Durable Object: connections, create-on-connect, expiry, per-connection state (protocol, `MULTI`, `WATCH`, subscriptions), and the hub that wakes blocked clients and delivers messages |
| `src/resp/` | Parses requests (multibulk and inline) and encodes replies for RESP2 or RESP3 |
| `src/store/` | Keys in SQLite: one row per key, a table per type for its members, and the RDB codec for `DUMP` |
| `src/commands/` | One file per command group |
| `src/lua/` | Lua compiled to WebAssembly; `scripts/build-lua.sh` rebuilds it with Docker |

Keys expire lazily when touched, and a small sweep after each write removes a few expired keys, like Redis's active expiry. Blocking commands park the connection, and a write to a key someone waits on wakes the oldest waiter after the command finishes. Pub/sub channels are scoped to one database.

## ✅ Check it works

```sh
bun run typecheck
bun run lint
bun run test
```

The tests start their own Workers on free ports. Locking, load, restart, BullMQ, client library, security and lifecycle tests check results directly. The comparison tests start a `redis:8` container and are skipped when Docker is not running.

To run the end-to-end checks against a deployed Worker through the bridge:

```sh
DURAREDIS_LIVE_URL=https://duraredis.<your-subdomain>.workers.dev bun run test:live
```

## ⚠️ Limits

| Limit | Detail |
| --- | --- |
| Encryption | The WebSocket route is encrypted; direct TCP is plain unless Spectrum Enterprise terminates TLS in front |
| Databases | One per name; `SELECT` accepts only `0` |
| Value size | A key plus its value, or one member, must fit in a 2 MB SQLite row |
| Latency | A network hop plus SQLite: milliseconds, not microseconds |
| Idle connections | Close after an hour, except subscribers and blocked clients |
| Scripts | Stop after 5 seconds and roll back, since no other client can send `SCRIPT KILL` while a Durable Object is busy |
| Client-side caching | `CLIENT TRACKING` and `CLIENT REPLY OFF` are not supported |
| Vector sets | Duraredis builds its own HNSW graph, so approximate `VSIM` and `VLINKS` can differ from Redis; `VSIM ... TRUTH` matches exactly |
| Module dumps | `DUMP` of JSON, probabilistic, time series, vector set and array keys only restores into Duraredis |

## 📄 License

[MIT](LICENSE).

Credits: the idea comes from [Duragres](https://github.com/jaypopat/duragres) by [@jaypopat](https://github.com/jaypopat). `vendor/lua` is Lua 5.1 and the Lua libraries shipped with Redis 7.2 (BSD 3-Clause, see `vendor/lua/REDIS_COPYING` and `vendor/lua/COPYRIGHT`), with fpconv under its own license (`vendor/lua/FPCONV_LICENSE.txt`).
